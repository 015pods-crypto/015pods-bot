const express = require('express');
const cron = require('node-cron');
const { Anthropic } = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// Token do bot vem SÓ de env var (nada hardcoded no repo — que é público).
// Sem a env, o servidor NÃO sobe: checagem no bloco main, no fim do arquivo.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
// Base da API do Telegram sobrescrevível por env (usado só em teste local para
// capturar as mensagens em vez de enviá-las de verdade); default = produção.
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const TELEGRAM_API = `${TELEGRAM_API_BASE}/bot${TELEGRAM_TOKEN}`;
// Dois grupos: VENDAS (só baixas -) e REPOSIÇÃO (só entradas +). IDs vêm de env
// vars do Render; os defaults são os grupos reais (não são segredo).
const VENDAS_CHAT_ID = String(process.env.VENDAS_CHAT_ID || '-4938589018');
const REPOSICAO_CHAT_ID = String(process.env.REPOSICAO_CHAT_ID || '-5332904723');
// Privado do Lucas: comandos de consulta também funcionam no DM dele.
const LUCAS_USER_ID = String(process.env.LUCAS_USER_ID || '5984124812');
// Dono: único que pode anular/desanular comissão (/anular, /desanular).
const ADMIN_USER_ID = String(process.env.ADMIN_USER_ID || '5984124812');
// Rodrigo: além do dono, pode corrigir uma venda com /atacado. Sem a env
// definida, só o dono — e a recusa mostra o id de quem tentou, que é como se
// descobre o número pra cadastrar (não tem outro jeito de pegar o id dele).
const ROD_USER_ID = String(process.env.ROD_USER_ID || '');

// Commit que está rodando (o Render injeta RENDER_GIT_COMMIT no deploy).
// Existe pra responder "que versão está no ar?" sem abrir o painel: um deploy
// velho faz comando novo simplesmente não existir, e isso é indistinguível de
// bug no código se não dá pra ver a versão.
const COMMIT = String(process.env.RENDER_GIT_COMMIT || 'desconhecido').slice(0, 7);

// Só pra diagnóstico: o que ESTA versão conhece. Se um comando não está aqui,
// ele também não está na cadeia de ifs do webhook (manter os dois em sincronia).
const COMANDOS = [
  '/start', '/ajuda', '/estoque', '/zerados', '/baixo', '/relatorio',
  '/semana', '/reposicao', '/comissao', '/despesas', '/dinheiro', '/geral',
  '/anular', '/desanular', '/adicionar', '/refazerfechamento', '/versao',
  '/chatid', '/setgrupopedidos', '/fornecedor', '/apelido', '/pedido',
  '/atacado', '/desatacado', '/caixa',
  '/setgrupofaturamento', '/faturamento', '/lembrete-teste',
  '/setgrupotraducao', '/traduzir',
  '/setgrupoatualizacoes', '/nova', '/lista', '/feito', '/feitas', '/reabrir',
  '/apagar', '/instrucoes', '/fechamento',
];

// Estoque agora vive no Supabase. Toda leitura/escrita passa por RPCs:
//   bot_ler_estoque       -> leitura (comandos /estoque, /zerados, etc.)
//   bot_movimentar_estoque -> baixa/entrada (mensagens - / +)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_SYNC_TOKEN = process.env.BOT_SYNC_TOKEN;

async function callRpc(fn, body) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('SUPABASE_URL/SUPABASE_ANON_KEY não definidos');
  if (!BOT_SYNC_TOKEN) throw new Error('BOT_SYNC_TOKEN não definido');
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const texto = await resp.text();
  let data = null;
  try { data = texto ? JSON.parse(texto) : null; } catch (_) { /* resposta não-JSON */ }
  if (!resp.ok) {
    const detalhe = data && (data.message || data.error) ? (data.message || data.error) : texto.slice(0, 200);
    throw new Error(`Supabase ${fn} HTTP ${resp.status}: ${detalhe}`);
  }
  return data;
}

function splitMessage(text, max = 3800) {
  if (text.length <= max) return [text];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > max) {
      parts.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function escapeMd(s) {
  return (s || '').toString().replace(/([_*`\[\]])/g, '\\$1');
}

async function sendTelegram(chatId, text) {
  const fetch = (await import('node-fetch')).default;
  for (const chunk of splitMessage(text)) {
    const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
    });
    if (!resp.ok) {
      // Markdown malformado derruba o envio: reenvia como texto puro. Os dois
      // erros agora VÃO PRO LOG — antes sumiam em silêncio, e o bot mudo não
      // deixava rastro nenhum pra investigar.
      const motivo = await resp.text().catch(() => '');
      console.error(`sendTelegram markdown falhou (${resp.status}): ${motivo.slice(0, 200)}`);
      const retry = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
      if (!retry.ok) {
        const motivo2 = await retry.text().catch(() => '');
        console.error(`sendTelegram texto puro falhou (${retry.status}): ${motivo2.slice(0, 200)}`);
      }
    }
  }
}

// Lê o estoque da RPC bot_ler_estoque (retorno agrupado por modelo) e achata
// para a lista { modelo, sabor, qtd } que os handlers de leitura consomem.
async function readEstoque() {
  const data = await callRpc('bot_ler_estoque', { p_token: BOT_SYNC_TOKEN });
  const produtos = [];
  for (const grupo of data || []) {
    const modelo = (grupo.modelo || '').toString().trim();
    // Marca do modelo ("Tabacaria", "Complementos", "Ignite"). Só o /estoque
    // usa, pra separar pod do resto; vazia quando o banco não mandar.
    const marca = (grupo.marca ?? '').toString().trim();
    for (const s of grupo.sabores || []) {
      produtos.push({
        modelo,
        marca,
        sabor: (s.sabor || '').toString().trim(),
        qtd: parseInt(s.qty, 10) || 0,
      });
    }
  }
  return produtos.filter(p => p.modelo || p.sabor);
}

// ---------------------------------------------------------------------------
// Registros do Rod: DESPESA ("+25 ENTREGA") e DINHEIRO ("+100 DINHEIRO"),
// e os ESTORNOS dos dois com o mesmo formato no negativo ("-50 DINHEIRO",
// "-25 ENTREGA erro de digitação"). Estorno é o MESMO lançamento com valor
// negativo: os totais são soma da coluna, então saem líquidos sozinhos.
//
// COLISÃO DE PREFIXO: "+" é a reposição de estoque e "-" é a BAIXA DE VENDA —
// o comando mais usado do bot. Nos dois casos o desempate é a PRIMEIRA PALAVRA
// depois do número, e só ela:
//   1. DINHEIRO (palavra reservada, categoria própria)  -> tipo 'dinheiro'
//   2. linha terminada em ROD isolado (formato antigo)  -> tipo 'despesa'
//   3. palavra na lista `bot_despesa_palavras` do banco -> tipo 'despesa'
//   4. qualquer outra coisa                             -> estoque (inalterado)
// Produto com typo cai no caso 4 e continua respondendo "não encontrado": a
// regra NUNCA transforma erro de digitação de produto em despesa silenciosa —
// e isso vale em dobro no "-", onde a linha engolida seria uma VENDA.
//
// O caso 2 (sufixo ROD) é de propósito só do "+": era um formato de despesa,
// nunca de venda. Estender ele ao "-" criaria mais um jeito de uma linha de
// venda virar estorno, sem ninguém ter pedido.
//
// Os dois sinais contábeis são opostos e por isso não podem virar o mesmo tipo:
// despesa = a loja DEVE ao Rod; dinheiro = o Rod está COM dinheiro da loja.
// ---------------------------------------------------------------------------

const RE_DESPESA_ROD = /^\+\s*(\d+(?:[.,]\d{1,2})?)\s+(\S.*?)\s+rod\s*$/i;
// "+25 ROD" (valor sem descrição): não é estoque nem despesa válida — vira aviso
// de uso, senão o estoque responderia "produto não encontrado: ROD".
const RE_DESPESA_ROD_SEM_DESC = /^\+\s*\d+(?:[.,]\d{1,2})?\s+rod\s*$/i;
// "±VALOR PALAVRA [complemento livre]" — sinal m[1], palavra m[3], resto m[4].
const RE_VALOR_PALAVRA = /^([+-])\s*(\d+(?:[.,]\d{1,2})?)\s+(\S+)(?:\s+(.*\S))?\s*$/;

// Palavra reservada do dinheiro em mãos. NÃO entra em bot_despesa_palavras.
const PALAVRA_DINHEIRO = 'DINHEIRO';

// Rede de segurança: se o config sumir ou o banco estiver fora do ar, estas
// palavras continuam valendo. Tipo NOVO de despesa é update no config (sem
// deploy) — esta lista existe só pra não deixar o Rod sem registrar nada.
const PALAVRAS_DESPESA_PADRAO = ['ENTREGA', 'UBER', 'GASOLINA'];

// Cache das chaves de configuração (~1 min). A falha TAMBÉM é cacheada: desde
// que o "-" entrou na rota das despesas, toda linha de venda passa por aqui, e
// sem cachear o erro o bot pagaria um round-trip morto a cada baixa com o banco
// fora do ar. Recuperar em até 1 min é o mesmo prazo de uma mudança no config.
const CONFIG_TTL_MS = 60 * 1000;
const cacheConfig = new Map(); // key -> { at, valor }

// Valor de uma chave da integration_config. Nunca lança: erro vira '' (e o
// chamador decide o fallback).
async function lerConfig(key) {
  const cache = cacheConfig.get(key);
  if (cache && Date.now() - cache.at < CONFIG_TTL_MS) return cache.valor;
  let valor = '';
  try {
    const d = await callRpc('bot_config', { p_token: BOT_SYNC_TOKEN, p_key: key });
    if (d && d.ok !== false) valor = String(d.valor ?? '');
  } catch (err) {
    console.error(`bot_config ${key}:`, err.message);
  }
  cacheConfig.set(key, { at: Date.now(), valor });
  return valor;
}

// Grava uma chave e já invalida o cache — senão o /setgrupopedidos levaria até
// um minuto pra valer, e o dono testaria no grupo achando que não funcionou.
async function gravarConfig(key, valor) {
  try {
    const d = await callRpc('bot_config_set', {
      p_token: BOT_SYNC_TOKEN, p_key: key, p_valor: String(valor),
    });
    if (!d || d.ok === false) return false;
    cacheConfig.set(key, { at: Date.now(), valor: String(valor) });
    return true;
  } catch (err) {
    console.error(`bot_config_set ${key}:`, err.message);
    return false;
  }
}

async function palavrasDespesa() {
  const csv = await lerConfig('bot_despesa_palavras');
  const doBanco = csv.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  return doBanco.length ? doBanco : PALAVRAS_DESPESA_PADRAO;
}

// Só pro teste: todo estado de módulo que atravessa mensagens (cache de
// config, lista de fornecedor pendente, última marcação de atacado) vaza de um
// caso pro outro e faz teste passar — ou falhar — pelo motivo errado.
function _resetEstadoTeste() {
  cacheConfig.clear();
  fornecedorPendente.clear();
  ultimaMarcacao.clear();
  caixaListado.clear();
  lembreteChipsEnviado = '';
  cacheGrupoTarefas = null;
  ultimaFixada = null;
}

// Só pro teste: espera a atualização da fixada que um comando deixou rodando,
// senão ela cai no meio do teste seguinte.
function _esperarFixadaTeste() {
  return filaFixada;
}

// `palavras` é a lista já resolvida (o parser é síncrono de propósito: o
// webhook busca a lista uma vez por mensagem e reusa em todas as linhas).
function parseRegistroRod(line, palavras) {
  const raw = (line || '').trim();
  const sinal = raw.charAt(0);
  if (sinal !== '+' && sinal !== '-') return null;
  if (RE_DESPESA_ROD_SEM_DESC.test(raw)) return { invalid: true, raw };

  const m = raw.match(RE_VALOR_PALAVRA);
  const palavra = m ? m[3].toUpperCase() : null;
  // Estorno é o mesmo lançamento com o valor negativo — não existe RPC nem
  // tipo separado pra ele.
  const bruto = m ? parseFloat(m[2].replace(',', '.')) : null;
  const valor = bruto ? (m[1] === '-' ? -bruto : bruto) : null;
  const resto = m ? [m[3], m[4]].filter(Boolean).join(' ').trim() : '';

  // 1. DINHEIRO tem prioridade sobre tudo: é palavra reservada.
  if (palavra === PALAVRA_DINHEIRO) {
    if (!valor) return { invalid: true, raw };
    return { tipo: 'dinheiro', valor, descricao: resto, raw };
  }

  // 2. Formato antigo "+25 ENTREGA ROD" (só no "+", ver cabeçalho) — antes da
  //    lista, senão "Uber rod" guardaria a descrição com o "rod" grudado no fim.
  const rod = sinal === '+' ? raw.match(RE_DESPESA_ROD) : null;
  if (rod) {
    const v = parseFloat(rod[1].replace(',', '.'));
    const desc = rod[2].trim();
    if (!v || v <= 0 || !desc) return { invalid: true, raw };
    return { tipo: 'despesa', valor: v, descricao: desc, raw };
  }

  // 3. Primeira palavra na lista de despesa (case-insensitive).
  if (palavra && palavras.includes(palavra)) {
    if (!valor) return { invalid: true, raw };
    return { tipo: 'despesa', valor, descricao: resto, raw };
  }

  return null; // 4. estoque
}

// Venda de atacado: a palavra "atacado" em qualquer posição da linha. Ela é
// ARRANCADA da descrição antes da busca do produto — senão "elfbar 30000 cherry
// atacado" não acharia nada, e uma palavra de controle viraria erro de produto.
const RE_ATACADO = /\batacado\b/gi;

function extrairAtacado(desc) {
  if (!RE_ATACADO.test(desc)) { RE_ATACADO.lastIndex = 0; return { atacado: false, desc }; }
  RE_ATACADO.lastIndex = 0;
  return { atacado: true, desc: desc.replace(RE_ATACADO, ' ').replace(/\s+/g, ' ').trim() };
}

function parseMovimentoLine(line) {
  const raw = line.trim();
  if (!raw) return null;
  const c = raw.charAt(0);
  if (c === '-') {
    const m = raw.match(/^-(\d+)\s+(.+)$/) || raw.match(/^-(.+)$/);
    if (!m) return null;
    const qtd = m[2] ? parseInt(m[1], 10) : 1;
    const bruta = m[2] ? m[2].trim() : m[1].trim();
    const { atacado, desc } = extrairAtacado(bruta);
    // "-6 atacado" (só a palavra de controle) não é venda de nada.
    if (!desc || !qtd || qtd <= 0) return { op: 'baixa', invalid: true, raw };
    return { op: 'baixa', qtd, desc, atacado, raw };
  }
  if (c === '+') {
    const m = raw.match(/^\+(\d+)\s+(.+)$/);
    if (!m) return { op: 'entrada', invalid: true, raw };
    const qtd = parseInt(m[1], 10);
    // Entrada não é venda: a palavra sai da descrição, mas não marca nada.
    const { desc } = extrairAtacado(m[2].trim());
    if (!desc || !qtd || qtd <= 0) return { op: 'entrada', invalid: true, raw };
    return { op: 'entrada', qtd, desc, raw };
  }
  return null;
}

// Grupo de REPOSIÇÃO aceita linha SEM prefixo como entrada: "Elfbar 40000 ice king 5"
// = +5. Só vira entrada se a linha terminar com número — o resto é conversa (ignora).
function parseLinhaReposicaoSemPrefixo(line) {
  const m = line.trim().match(/^([^+\-/].*?)\s+(\d+)$/);
  if (!m) return null;
  const desc = m[1].trim();
  const qtd = parseInt(m[2], 10);
  if (!desc || !qtd || qtd <= 0) return null;
  return `+${qtd} ${desc}`;
}

function buildResumoSingle(r) {
  if (!r.ok) return `❌ ${r.msg}`;
  if (r.op === 'baixa') {
    const aviso = r.restante <= 0 ? '\n🔴 _Estoque zerado!_' : r.restante === 1 ? '\n🟡 _Estoque baixo!_' : '';
    const titulo = r.atacado ? '✅ *Baixa registrada (ATACADO)!*' : '✅ *Baixa registrada!*';
    return `${titulo}\n📦 ${r.modelo} – ${r.sabor}\n➖ Saiu: *${r.qtd}*\n📊 Restante: *${r.restante}*${aviso}`;
  }
  return `✅ *Entrada registrada!*\n📦 ${r.modelo} – ${r.sabor}\n➕ Entrou: *${r.qtd}*\n📊 Total agora: *${r.restante}*`;
}

function buildResumoMulti(results) {
  const baixas = results.filter(r => r.ok && r.op === 'baixa');
  const entradas = results.filter(r => r.ok && r.op === 'entrada');
  const erros = results.filter(r => !r.ok);
  const out = [];
  if (baixas.length) {
    out.push('✅ *Baixas registradas:*');
    for (const r of baixas) {
      const marca = r.atacado ? ' _(atacado)_' : '';
      out.push(`📦 ${r.modelo} – ${r.sabor}: -${r.qtd} (restante: ${r.restante})${marca}`);
    }
  }
  if (entradas.length) {
    if (out.length) out.push('');
    out.push('✅ *Entradas registradas:*');
    for (const r of entradas) out.push(`📦 ${r.modelo} – ${r.sabor}: +${r.qtd} (total: ${r.restante})`);
  }
  if (erros.length) {
    if (out.length) out.push('');
    out.push('❌ *Não processados:*');
    for (const r of erros) out.push(`• ${r.msg}`);
  }
  return out.join('\n');
}

// Converte um item de `resultados[]` da RPC bot_movimentar_estoque no formato
// { ok, op, modelo, sabor, qtd, restante } / { ok:false, op, msg } que os
// builders de resposta (buildResumoSingle/Multi) consomem. `opFallback` é a
// operação que o usuário digitou (baixa/entrada), usada quando o resultado de
// erro não traz a direção.
function mapResultado(r, opFallback) {
  const status = r && r.status;
  const input = (r && r.input) || '(item)';

  if (status === 'ok') {
    const op = r.direction === 'entrada' ? 'entrada' : 'baixa';
    // sale_id vem em todo item ok de BAIXA (entrada não tem: não é venda).
    // É ele que permite marcar atacado na venda certa — cada baixa cria uma
    // venda própria, então numa mensagem com 3 baixas são 3 ids diferentes.
    return {
      ok: true, op, modelo: r.model, sabor: r.flavor, qtd: r.qty,
      restante: r.stock_after,
      saleId: r.sale_id != null ? String(r.sale_id) : undefined,
    };
  }
  if (status === 'nao_encontrado') {
    return { ok: false, op: opFallback, msg: `Produto não encontrado: "${input}"` };
  }
  if (status === 'ambiguo') {
    // A RPC pode devolver a lista de candidatos sob nomes diferentes; tenta os
    // mais prováveis e monta a lista de matches quando existir.
    const matches = r.matches || r.opcoes || r.candidatos || r.candidates || [];
    let msg = `Produto ambíguo: encontrei mais de um match para "${input}". Seja mais específico.`;
    if (Array.isArray(matches) && matches.length) {
      const lista = matches.map(m => {
        if (typeof m === 'string') return m;
        const mod = m.model || m.modelo || '';
        const fla = m.flavor || m.sabor || '';
        return `${mod} – ${fla}`.trim().replace(/^–\s*/, '');
      });
      msg += '\n' + lista.map(x => `• ${x}`).join('\n');
    }
    return { ok: false, op: opFallback, msg };
  }
  if (status === 'qtd_invalida') {
    return { ok: false, op: opFallback, msg: `Quantidade inválida para "${input}"` };
  }
  if (status === 'estoque_insuficiente') {
    const nome = (r.model || r.flavor) ? `${r.model} – ${r.flavor}` : `"${input}"`;
    const tem = r.stock_before != null ? r.stock_before : 0;
    const msg = tem <= 0
      ? `${nome} já está zerado`
      : `${nome} sem estoque suficiente (tem ${tem}, pediu ${r.qty})`;
    return { ok: false, op: opFallback, msg };
  }
  return { ok: false, op: opFallback, msg: `Não processado: "${input}" (${status || 'sem status'})` };
}

async function handleMovimentos(chatId, lines, messageId, forcarAtacado, msgComprovante) {
  const parsed = lines.map(parseMovimentoLine).filter(Boolean);
  if (!parsed.length) return;

  // TRAVA DE COMPROVANTE REPETIDO: com foto junto, o comprovante é registrado
  // ANTES da baixa. Se o banco disser que o MESMO CÓDIGO de transação já
  // entrou, nada é baixado — é o golpe de reenviar o comprovante de ontem pra
  // levar pedido novo. Repetido só por VALOR (outro código, ou sem código) não
  // trava: duas vendas de R$ 100 em poucos minutos são normais. A baixa sai e
  // o bot pede pra conferir. Isso custa
  // a latência do Gemini na frente da baixa, e é de propósito: baixar primeiro
  // e descobrir o repetido depois deixaria o estoque já mexido.
  // Foto que não deu pra ler não trava nada: a baixa sai e o bot avisa.
  let textoComprovanteFinal = null;
  if (msgComprovante) {
    let comp = null;
    try {
      comp = await registrarComprovante(chatId, msgComprovante);
    } catch (err) {
      // Rede de segurança: a baixa não pode cair por causa da foto.
      console.error('comprovante junto da baixa:', err.message);
    }
    if (comp && comp.duplicado && comp.motivo === 'codigo') {
      const quando = comp.quando ? ` em ${escapeMd(comp.quando)}` : '';
      await sendTelegram(chatId, `⚠️ Esse comprovante já foi registrado${quando}. Nenhuma baixa feita.`);
      return;
    }
    if (comp && comp.duplicado) {
      textoComprovanteFinal = '⚠️ Já entrou um comprovante de mesmo valor há pouco. Confira se não é repetido.';
    } else {
      textoComprovanteFinal = comp && comp.lido
        ? comp.texto
        : '🤔 Não consegui ler o comprovante — a baixa foi feita normalmente. Confere o valor.';
    }
  }

  // Linhas que o parser entendeu viram itens { produto, qty } para a RPC; qty
  // negativo = baixa, positivo = entrada. Linhas com formato inválido (sem dar
  // pra extrair produto/qtd) são respondidas localmente, sem ir à RPC.
  // ATACADO é da MENSAGEM inteira, não da linha: a palavra em qualquer lugar
  // marca TODAS as baixas daquela mensagem. Marcar só a linha onde a palavra
  // aparece deixaria as outras como varejo sem ninguém perceber.
  // `forcarAtacado` é o caso do cabeçalho ("/atacado" + pedido colado embaixo).
  const pediuAtacado = !!forcarAtacado || parsed.some(i => i.atacado);

  const items = [];
  const plan = [];
  for (const item of parsed) {
    if (item.invalid) {
      plan.push({ invalid: true, op: item.op, raw: item.raw });
    } else {
      plan.push({ op: item.op, itemIndex: items.length, atacado: pediuAtacado && item.op === 'baixa' });
      items.push({ produto: item.desc, qty: item.op === 'baixa' ? -item.qtd : item.qtd });
    }
  }

  let resultados = [];
  if (items.length) {
    const data = await callRpc('bot_movimentar_estoque', {
      p_token: BOT_SYNC_TOKEN,
      p_items: items,
      // `atacado` aqui é só procedência: a marca que a bot_comissao lê é a
      // palavra no `notes`, gravada pela bot_marcar_atacado logo abaixo.
      p_meta: { chat_id: chatId, message_id: messageId, atacado: pediuAtacado || undefined },
    });
    resultados = (data && data.resultados) || [];
  }

  const results = [];
  for (const p of plan) {
    if (p.invalid) {
      const exemplo = p.op === 'entrada' ? '+1 Ignite 5500 Grape Ice' : '-1 Ignite 5500 Grape Ice';
      results.push({ op: p.op, ok: false, msg: `Formato inválido: \`${p.raw}\` — use \`${exemplo}\`` });
      continue;
    }
    const mapped = mapResultado(resultados[p.itemIndex], p.op);
    if (p.atacado) mapped.atacado = true;
    // Mantém o resumo diário de vendas (cron 23:50) funcionando: cada baixa ok
    // é registrada por modelo, como era feito na lógica antiga da planilha.
    if (mapped.ok && mapped.op === 'baixa') registrarVenda(mapped.modelo, mapped.qtd);
    results.push(mapped);
  }

  const linhasMsg = [results.length === 1 ? buildResumoSingle(results[0]) : buildResumoMulti(results)];

  // A marca só faz sentido nas baixas que de fato entraram: numa baixa que
  // falhou, marcar acertaria a venda ANTERIOR.
  const aMarcar = results.filter(r => r.ok && r.op === 'baixa' && r.atacado);
  if (aMarcar.length) linhasMsg.push(...(await marcarVendasAtacado(chatId, aMarcar)));

  if (textoComprovanteFinal) linhasMsg.push('', textoComprovanteFinal);

  await sendTelegram(chatId, linhasMsg.join('\n'));
}

// Marca cada venda pelo SEU id — uma chamada por baixa, porque cada baixa cria
// uma venda própria. Uma falha isolada não derruba as outras nem desfaz venda
// nenhuma: o estoque já saiu, e o que fica pendente é só a marca, item a item.
async function marcarVendasAtacado(chatId, baixas) {
  const marcadas = [];
  const idsMarcados = [];
  const jaEstavam = [];
  const falhas = [];
  for (const r of baixas) {
    const m = await marcarAtacado(r.saleId);
    // `msg` é texto NOSSO, já com a formatação certa — escapar de novo viraria
    // "bot\\_marcar\\_atacado" na tela. Só o nome do produto passa pelo escapeMd.
    if (!m.ok) falhas.push({ nome: `${r.modelo} – ${r.sabor}`, msg: m.msg });
    else if (m.ja_marcada) jaEstavam.push(`${r.modelo} – ${r.sabor}`);
    else { marcadas.push(`${r.qtd}x ${r.modelo} – ${r.sabor}`); idsMarcados.push(r.saleId); }
  }

  const out = [];
  if (marcadas.length) {
    lembrarMarcacao(chatId, idsMarcados, marcadas.join(', '));
    out.push(`🏷️ *ATACADO:* ${marcadas.map(escapeMd).join(', ')}`);
    out.push(`_${AVISO_DESFAZER}_`);
  }
  if (jaEstavam.length) out.push(`🏷️ _Já estava marcada: ${jaEstavam.map(escapeMd).join(', ')}_`);
  for (const f of falhas) {
    out.push(`⚠️ Não marquei *${escapeMd(f.nome)}*: ${f.msg} Use /atacado.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pods x acompanhamentos
//
// O estoque tem chiclete, Fini, Kitkat, essência, pilha — coisas que não são
// pod. Somadas junto, o "total geral" vira um número que não serve pra decidir
// compra nem pra conferir contagem.
//
// A lista vem de integration_config ('bot_nao_pods'), CSV: acompanhamento novo
// é update no config, sem deploy. Um modelo é acompanhamento quando o NOME
// contém qualquer uma das palavras, OU quando a MARCA dele é uma das marcas
// que não são pod (seda, filtro, isqueiro não têm palavra comum no nome, mas
// estão todos em Tabacaria/Complementos). Marca vazia: vale só a lista.
// ---------------------------------------------------------------------------

const MARCAS_NAO_PODS = ['tabacaria', 'complementos', 'complemento'];

// Rede de segurança pro config fora do ar: sem isso o /estoque voltaria a
// somar tudo junto, calado, que é exatamente o problema que estamos tirando.
const NAO_PODS_PADRAO = [
  'fini', 'kitkat', 'trident', 'stikadinho', 'essencia', 'blvk',
  'chocolate', 'bala', 'doce', 'pilha', 'carregador',
];

async function palavrasNaoPods() {
  const csv = await lerConfig('bot_nao_pods');
  const lista = csv.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return lista.length ? lista : NAO_PODS_PADRAO;
}

function ehAcompanhamento(modelo, palavras, marca) {
  const m = semAcento(String(marca || '')).toLowerCase().trim();
  if (m && MARCAS_NAO_PODS.includes(m)) return true;
  const nome = semAcento(String(modelo || '')).toLowerCase();
  return palavras.some(p => nome.includes(semAcento(p).toLowerCase()));
}

// Sabores de um modelo na ordem de quem precisa de atenção: zerado primeiro,
// depois o que está acabando, depois o resto. Ordenar por quantidade já dá
// exatamente isso — e o nome desempata pra lista não dançar entre chamadas.
function ordenarSabores(sabores) {
  return [...sabores].sort((a, b) => a.qtd - b.qtd || a.sabor.localeCompare(b.sabor, 'pt-BR'));
}

function iconeSabor(qtd) {
  if (qtd <= 0) return '❌ ';
  if (qtd === 1) return '⚠️ ';
  return '';
}

// Um bloco de texto por modelo. Blocos são a unidade da quebra em mensagens:
// modelo cortado no meio é ilegível.
function blocoModeloDetalhado(modelo, sabores) {
  const total = sabores.reduce((s, p) => s + p.qtd, 0);
  const linhas = [`📦 *${escapeMd(modelo)}* · ${total} un`];
  for (const p of ordenarSabores(sabores)) {
    linhas.push(`${iconeSabor(p.qtd)}${escapeMd(p.sabor)} · ${p.qtd}`);
  }
  return linhas.join('\n');
}

// Agrupa { modelo, sabor, qtd } por modelo, na ordem de maior total.
function porModeloOrdenado(produtos) {
  const mapa = new Map();
  for (const p of produtos) {
    const modelo = p.modelo || '(sem modelo)';
    if (!mapa.has(modelo)) mapa.set(modelo, []);
    mapa.get(modelo).push(p);
  }
  return [...mapa.entries()]
    .map(([modelo, sabores]) => ({
      modelo,
      sabores,
      marca: (sabores.find(x => x.marca) || {}).marca || '',
      total: sabores.reduce((s, x) => s + x.qtd, 0),
    }))
    .sort((a, b) => b.total - a.total || a.modelo.localeCompare(b.modelo, 'pt-BR'));
}

// Linha única dos acompanhamentos: eles não entram na conta de pods, mas some
// da tela também não pode — é estoque que alguém comprou.
function linhaAcompanhamentos(grupos) {
  if (!grupos.length) return null;
  const total = grupos.reduce((s, g) => s + g.total, 0);
  const itens = grupos.map(g => `${escapeMd(g.modelo)} ${g.total}`).join(' · ');
  return `🍬 Acompanhamentos: ${itens} (total ${total})`;
}

async function handleEstoque(chatId, text) {
  const arg = (text || '').trim().split(/\s+/)[1];
  const detalhado = arg && /^detalhad|^detalhe/i.test(arg);

  const produtos = await readEstoque();
  if (!produtos.length) { await sendTelegram(chatId, '📦 Estoque vazio.'); return; }

  const palavras = await palavrasNaoPods();
  const grupos = porModeloOrdenado(produtos);
  const pods = grupos.filter(g => !ehAcompanhamento(g.modelo, palavras, g.marca));
  const acomp = grupos.filter(g => ehAcompanhamento(g.modelo, palavras, g.marca));
  const totalPods = pods.reduce((s, g) => s + g.total, 0);

  if (!detalhado) {
    const linhas = ['📦 *Estoque atual* (por modelo)', ''];
    for (const g of pods) {
      const ico = g.total <= 0 ? '🔴' : g.total <= 5 ? '🟡' : '🟢';
      linhas.push(`${ico} *${escapeMd(g.modelo)}*: ${g.total}`);
    }
    if (!pods.length) linhas.push('_Nenhum pod em estoque._');
    linhas.push('', `🧮 Total de pods: *${totalPods}*`);
    const acompLinha = linhaAcompanhamentos(acomp);
    if (acompLinha) linhas.push('', acompLinha);
    for (const parte of splitMessage(linhas.join('\n'))) await sendTelegram(chatId, parte);
    return;
  }

  const blocos = [`📦 *Estoque detalhado* · ${totalPods} pods`, ...pods.map(g => blocoModeloDetalhado(g.modelo, g.sabores))];
  if (acomp.length) {
    const totalAcomp = acomp.reduce((s, g) => s + g.total, 0);
    blocos.push(`🍬 *Acompanhamentos* · ${totalAcomp} un`);
    blocos.push(...acomp.map(g => blocoModeloDetalhado(g.modelo, g.sabores)));
  }
  for (const parte of dividirBlocos(blocos)) await sendTelegram(chatId, parte);
}

async function handleZerados(chatId) {
  const produtos = (await readEstoque()).filter(p => p.qtd <= 0);
  if (!produtos.length) { await sendTelegram(chatId, '🟢 Nenhum produto zerado.'); return; }
  const linhas = ['🔴 *Produtos zerados*', ''];
  for (const p of produtos) linhas.push(`• ${p.modelo} – ${p.sabor}`);
  await sendTelegram(chatId, linhas.join('\n'));
}

async function handleBaixo(chatId) {
  const produtos = (await readEstoque()).filter(p => p.qtd === 1);
  if (!produtos.length) { await sendTelegram(chatId, '🟢 Nenhum produto com estoque baixo.'); return; }
  const linhas = ['🟡 *Estoque baixo (=1)*', ''];
  for (const p of produtos) linhas.push(`• ${p.modelo} – ${p.sabor}`);
  await sendTelegram(chatId, linhas.join('\n'));
}

async function handleRelatorio(chatId) {
  const produtos = await readEstoque();
  const total = produtos.reduce((s, p) => s + p.qtd, 0);
  const zerados = produtos.filter(p => p.qtd <= 0).length;
  const baixo = produtos.filter(p => p.qtd === 1).length;
  const ok = produtos.filter(p => p.qtd > 1).length;
  const modelos = new Set(produtos.map(p => p.modelo)).size;
  const linhas = [
    '📊 *Relatório de estoque*',
    '',
    `📦 Itens cadastrados: *${produtos.length}*`,
    `🏷️ Modelos distintos: *${modelos}*`,
    `🟢 Em estoque (>1): *${ok}*`,
    `🟡 Estoque baixo (=1): *${baixo}*`,
    `🔴 Zerados: *${zerados}*`,
    `🧮 Total de unidades: *${total}*`,
  ];
  await sendTelegram(chatId, linhas.join('\n'));
}

// Reposição: quanto ENTROU por modelo nos últimos 30 min (RPC bot_resumo_reposicao).
// Só leitura. O retorno já vem ordenado por total desc.
async function handleReposicao(chatId) {
  const dados = await callRpc('bot_resumo_reposicao', { p_token: BOT_SYNC_TOKEN, p_minutos: 30 });
  const itens = Array.isArray(dados) ? dados : [];
  if (!itens.length) {
    await sendTelegram(chatId, 'Nenhuma reposição nos últimos 30 minutos.');
    return;
  }
  const linhas = ['📦 *REPOSIÇÃO (últimos 30 min)*', ''];
  let totalGeral = 0;
  for (const it of itens) {
    // exibição sem o sufixo entre parênteses (só aqui; outros comandos mantêm o nome completo)
    const modelo = (it.modelo || '').replace(/\s*\(.*?\)\s*$/, '');
    linhas.push(`- ${escapeMd(modelo)}: +${it.total}`);
    totalGeral += Number(it.total) || 0;
  }
  linhas.push('', `*Total geral: +${totalGeral} unidades*`);
  await sendTelegram(chatId, linhas.join('\n'));
}

// Número em formato brasileiro (vírgula decimal).
function fmtBR(n, dec = 2) {
  return Number(n ?? 0).toLocaleString('pt-BR', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

// Dinheiro para o texto do grupo: inteiro sai sem centavos ("R$ 25"), quebrado
// sai no formato BR ("R$ 18,50").
function fmtValor(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : fmtBR(v);
}

// Busca os dados da RPC bot_comissao. Nunca lança: erro vira null.
// `mes` é o período ("01/10 → 31/10"); `fecha_hoje` = último dia do período.
// O bot NÃO sabe onde o ciclo começa ou termina: quem decide é a RPC (era
// 21 → 20, virou mês cheio a partir de outubro/2026). Nada aqui tem dia fixo.
async function dadosComissao(pMes) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    if (pMes) body.p_mes = pMes;
    const d = await callRpc('bot_comissao', body);
    return d && d.ok !== false ? d : null;
  } catch (err) {
    console.error('comissao:', err.message);
    return null;
  }
}

// Formato padrão (usado pelo /comissao e pelo relatório em dias normais).
// Quebra varejo/atacado. Devolve null quando não houve atacado no ciclo — aí
// o extrato fica no formato de sempre, sem linha de "0 atacado" pra ler.
//
// O TOTAL exibido é sempre o `comissao` da RPC, nunca a soma feita aqui: as
// duas linhas são só a memória de cálculo, e quem decide quanto o Rod recebe
// é o banco.
function linhasQuebraAtacado(d) {
  const atacado = Number(d.unidades_atacado) || 0;
  if (!atacado) return null;
  const varejo = Number(d.unidades_varejo) || 0;
  const taxa = Number(d.taxa_atual) || 0;
  const valorAtacado = Number(d.valor_atacado) || 0;
  return [
    `Unidades: *${d.unidades_mes ?? 0}* (${varejo} varejo + ${atacado} atacado)`,
    `Varejo: ${varejo} × R$ ${fmtBR(taxa)} = R$ ${fmtBR(varejo * taxa)}`,
    `Atacado: ${atacado} × R$ ${fmtBR(valorAtacado)} = R$ ${fmtBR(atacado * valorAtacado)}`,
  ];
}

function formatComissao(d) {
  const quebra = linhasQuebraAtacado(d);
  const linhas = [
    `📊 *Comissão — ${escapeMd(String(d.mes ?? ''))}*`,
    `Hoje: *${d.unidades_hoje ?? 0}* produtos`,
    ...(quebra || [
      `Acumulado: *${d.unidades_mes ?? 0}* produtos`,
      `Faixa atual: R$ ${fmtBR(d.taxa_atual)}/produto`,
    ]),
    `💰 Comissão: *R$ ${fmtBR(d.comissao)}*`,
  ];
  if (d.faltam_para_proxima == null) {
    linhas.push('🏆 Faixa máxima atingida!');
  } else {
    linhas.push(`🎯 Faltam *${d.faltam_para_proxima}* p/ faixa de R$ ${fmtBR(d.proxima_taxa)}`);
  }
  return linhas.join('\n');
}

// Texto do /comissao (formato padrão, sempre).
async function textoComissao() {
  const d = await dadosComissao();
  return d ? formatComissao(d) : '⚠️ Erro ao consultar comissão.';
}

// Bloco do resumo diário: no último dia do período (fecha_hoje=true) vira
// cabeçalho de FECHAMENTO; nos demais dias é o formato padrão.
// `dia` (ISO) é o dia que o resumo fecha. O resumo roda às 3h, quando o dia
// novo já começou: sem ele a RPC contaria o dia que mal começou.
async function textoComissaoRelatorio(dia) {
  const d = await dadosComissao(dia);
  if (!d) return '⚠️ Erro ao consultar comissão.';
  if (d.fecha_hoje) {
    return montarFechamento(d, await dadosRegistrosRod(dia), await dadosRegistrosRod(dia, 'dinheiro'), { ref: dia });
  }
  return formatComissao(d);
}

// Acerto do ciclo: dinheiro em mãos do Rod − (comissão + despesas).
//   positivo -> sobra dinheiro da loja com o Rod: ele repassa a diferença.
//   negativo -> a loja ainda deve: paga a diferença ao Rod.
// (Convenção do sistema; trocar o sinal é trocar estas duas linhas.)
function linhaAcerto(dinheiro, aPagar) {
  const acerto = Number(dinheiro) - Number(aPagar);
  if (Math.abs(acerto) < 0.005) return '⚖️ Acerto: *zerado* (nada a repassar)';
  return acerto > 0
    ? `⚖️ Acerto: *Rod repassa R$ ${fmtBR(acerto)}* no fechamento`
    : `⚖️ Acerto: *Loja paga R$ ${fmtBR(-acerto)} ao Rod*`;
}

// ---------------------------------------------------------------------------
// Fixo mensal do Rod
//
// Nunca esteve no banco: é pago junto com a comissão, e o fechamento só somava
// comissão + despesas. Mês cheio (dia 1 ao último dia) paga o fixo inteiro;
// ciclo que não é mês cheio (o de transição 21/09 → 30/09) paga proporcional:
// FIXO ÷ 30 × dias. O proporcional nunca passa do fixo inteiro — um ciclo
// antigo 21 → 20 de 31 dias, refeito pelo /refazerfechamento, paga 3.200 e
// não 3.306,67.
//
// Os dias saem do período que a bot_comissao devolve em `mes` ("21/09 →
// 30/09"), então o bot continua sem dia de ciclo fixo no código.
// ---------------------------------------------------------------------------

const FIXO_MENSAL = 3200;

// "21/09 → 30/09" (com ou sem ano) -> { inicio: Date, fim: Date } em UTC puro
// (só data). O ano, quando não vem, é o de `refISO`; se o início tem mês
// maior que o fim (dez → jan), o início é do ano anterior. Null se não casar.
function periodoDoCiclo(mes, refISO = hojeISO()) {
  // Retorno da RPC com as datas separadas ({ ciclo_inicio, ciclo_fim } ou
  // { inicio, fim }, ISO): vale mais que o rótulo, que é texto pra gente ler.
  if (mes && typeof mes === 'object') {
    const ini = mes.ciclo_inicio || mes.inicio;
    const fim = mes.ciclo_fim || mes.fim;
    const iso = x => /^\d{4}-\d{2}-\d{2}/.test(String(x || '')) ? new Date(`${String(x).slice(0, 10)}T00:00:00Z`) : null;
    const pi = iso(ini), pf = iso(fim);
    if (pi && pf && pf >= pi) return { inicio: pi, fim: pf };
    return periodoDoCiclo(mes.mes, refISO);
  }
  const m = String(mes || '').match(
    /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:→|->|a|até|-)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (!m) return null;
  const anoRef = parseInt(String(refISO).slice(0, 4), 10);
  const [di, mi, df, mf] = [m[1], m[2], m[4], m[5]].map(x => parseInt(x, 10));
  const anoFim = m[6] ? parseInt(m[6], 10) : anoRef;
  const anoIni = m[3] ? parseInt(m[3], 10) : (mi > mf ? anoFim - 1 : anoFim);
  const inicio = new Date(Date.UTC(anoIni, mi - 1, di));
  const fim = new Date(Date.UTC(anoFim, mf - 1, df));
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim < inicio) return null;
  return { inicio, fim };
}

function diasEntre(a, b) {
  return Math.round((b - a) / 864e5) + 1; // inclusivo
}

// { valor, dias, cheio } do fixo de um ciclo; null se o período não for lido
// (aí o fechamento avisa em vez de pagar um total errado).
function fixoDoCiclo(mes, refISO) {
  const p = periodoDoCiclo(mes, refISO);
  if (!p) return null;
  const dias = diasEntre(p.inicio, p.fim);
  const ultimoDoMes = new Date(Date.UTC(p.inicio.getUTCFullYear(), p.inicio.getUTCMonth() + 1, 0));
  const cheio = p.inicio.getUTCDate() === 1 &&
    p.fim.getUTCFullYear() === ultimoDoMes.getUTCFullYear() &&
    p.fim.getUTCMonth() === ultimoDoMes.getUTCMonth() &&
    p.fim.getUTCDate() === ultimoDoMes.getUTCDate();
  const valor = cheio ? FIXO_MENSAL : Math.min(FIXO_MENSAL, Math.round(FIXO_MENSAL / 30 * dias * 100) / 100);
  return { valor, dias, cheio: cheio || valor === FIXO_MENSAL };
}

function linhaFixo(fixo) {
  return fixo.cheio
    ? `📌 Fixo: R$ ${fmtBR(fixo.valor)}`
    : `📌 Fixo proporcional (${fixo.dias} dias): R$ ${fmtBR(fixo.valor)}`;
}

const AVISO_FIXO = '⚠️ _Não consegui ler o período do ciclo pra calcular o fixo — confira antes de pagar._';

// Fechamento = comissão + fixo + despesas do Rod + dinheiro em mãos do mesmo ciclo.
// `desp`/`dinh` null = a RPC falhou: o total NÃO é somado e o texto avisa,
// porque um total silenciosamente menor viraria pagamento errado.
// `opts` troca título/rodapé — é como o /refazerfechamento publica a correção
// sem se passar por um fechamento novo. `opts.ref` (ISO) é a data de
// referência do ciclo, de onde sai o ano do período.
function montarFechamento(d, desp, dinh, opts = {}) {
  const comissao = Number(d.comissao) || 0;
  const fixo = fixoDoCiclo(d, opts.ref);
  const titulo = opts.titulo || `🔒 *FECHAMENTO DO PERÍODO ${escapeMd(String(d.mes ?? ''))}*`;
  const rodape = opts.rodape || '_(o novo período já começou)_';
  const quebra = linhasQuebraAtacado(d);
  const linhas = [
    titulo,
    ...(quebra || [
      `Total: *${d.unidades_mes ?? 0}* produtos`,
      `Faixa final: R$ ${fmtBR(d.taxa_atual)}/produto`,
    ]),
    `💰 Comissão: *R$ ${fmtBR(comissao)}*`,
  ];
  if (fixo) linhas.push(linhaFixo(fixo));
  else linhas.push(AVISO_FIXO);
  let aPagar = null;
  if (!desp) {
    linhas.push('⚠️ _Não consegui somar as entregas/despesas do Rod — confira antes de pagar._');
  } else if (fixo) {
    const despesas = Number(desp.total) || 0;
    aPagar = comissao + fixo.valor + despesas;
    linhas.push(`🛵 Entregas/despesas Rod: R$ ${fmtBR(despesas)}`);
    linhas.push(`🧾 *Total a pagar: R$ ${fmtBR(aPagar)}*`);
  }
  if (!dinh) {
    linhas.push('⚠️ _Não consegui somar o dinheiro em mãos do Rod — confira antes de acertar._');
  } else {
    const dinheiro = Number(dinh.total) || 0;
    linhas.push(`💵 Dinheiro em mãos (Rod): R$ ${fmtBR(dinheiro)}`);
    if (aPagar != null) linhas.push(linhaAcerto(dinheiro, aPagar));
  }
  linhas.push(rodape);
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------
// Registros do Rod (despesa + dinheiro em mãos)
// "+25 ENTREGA" / "+100 DINHEIRO" no grupo → linha em despesas_rod (coluna
// `tipo`), amarrada ao ciclo vigente — que o banco define (bot_ciclo), não o bot.
// Persistido no banco, nunca em memória: o Render reinicia o processo a
// qualquer momento.
// ---------------------------------------------------------------------------

// Lê o acumulado do ciclo (RPC bot_despesas_rod). Nunca lança: erro vira null.
// `ref` (ISO YYYY-MM-DD) consulta o ciclo de outra data — usado ao refazer um
// fechamento passado. `tipo` = 'despesa' (padrão) ou 'dinheiro'.
async function dadosRegistrosRod(ref, tipo) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    // p_ref é timestamptz: "2026-09-30" puro vira meia-noite UTC = 21h do dia
    // 29 em São Paulo, o dia ERRADO. Meio-dia de SP cai no dia da loja certo.
    if (ref) body.p_ref = /^\d{4}-\d{2}-\d{2}$/.test(ref) ? `${ref}T12:00:00-03:00` : ref;
    if (tipo) body.p_tipo = tipo;
    const d = await callRpc('bot_despesas_rod', body);
    return d && d.ok !== false ? d : null;
  } catch (err) {
    console.error('despesas_rod:', err.message);
    return null;
  }
}

const USO_REGISTRO_ROD =
  'Uso: `+25 ENTREGA` (valor + palavra de despesa) ou `+100 DINHEIRO`. ' +
  'Pra estornar, o mesmo no negativo: `-25 ENTREGA`, `-50 DINHEIRO`.';

// Registra cada lançamento e responde com o acumulado do ciclo — é essa linha
// que dá visibilidade do total sem ninguém precisar somar na mão.
async function handleRegistrosRod(chatId, registros, meta) {
  const respostas = [];
  for (const d of registros) {
    if (d.invalid) {
      respostas.push(`❌ Não entendi \`${escapeMd(d.raw)}\`. ${USO_REGISTRO_ROD}`);
      continue;
    }
    let r = null;
    try {
      r = await callRpc('bot_despesa_rod_registrar', {
        p_token: BOT_SYNC_TOKEN,
        p_valor: d.valor,
        p_descricao: d.descricao,
        p_tipo: d.tipo,
        p_meta: meta || {},
      });
    } catch (err) {
      console.error('bot_despesa_rod_registrar:', err.message);
    }
    if (!r || r.ok === false) {
      respostas.push(`⚠️ Não consegui anotar \`${escapeMd(d.raw)}\`. Tente de novo em instantes.`);
      continue;
    }
    // `estorno` vem da RPC; se o Run novo ainda não estiver aplicado o campo
    // não vem, e o sinal que NÓS mandamos decide — nunca fica sem resposta.
    const estorno = r.estorno != null ? !!r.estorno : d.valor < 0;
    const total = `R$ ${fmtValor(r.total_ciclo)}`;
    const quanto = `R$ ${fmtValor(Math.abs(d.valor))}`;
    if (estorno) {
      respostas.push(
        d.tipo === 'dinheiro'
          ? `↩️ Estornado: ${quanto} de DINHEIRO — total em mãos no ciclo: ${total}`
          : `↩️ Estornado: ${quanto} de ${escapeMd(d.descricao)} — total do ciclo: ${total}`,
      );
    } else {
      respostas.push(
        d.tipo === 'dinheiro'
          ? `💵 Anotado: ${quanto} em DINHEIRO — total em mãos no ciclo: ${total}`
          : `📝 Anotado: ${quanto} ${escapeMd(d.descricao)} — total do ciclo: ${total}`,
      );
    }
  }
  if (respostas.length) await sendTelegram(chatId, respostas.join('\n'));
}

// Lista de lançamentos de um tipo no ciclo vigente (/despesas e /dinheiro).
async function handleListaRod(chatId, tipo) {
  const dinheiro = tipo === 'dinheiro';
  const d = await dadosRegistrosRod(null, tipo);
  if (!d) {
    await sendTelegram(chatId, dinheiro
      ? '⚠️ Erro ao consultar o dinheiro em mãos.'
      : '⚠️ Erro ao consultar as despesas do Rod.');
    return;
  }
  const itens = Array.isArray(d.itens) ? d.itens : [];
  const cabecalho = dinheiro
    ? `💵 *Dinheiro em mãos (Rod) — ${escapeMd(String(d.ciclo ?? ''))}*`
    : `🛵 *Entregas/despesas Rod — ${escapeMd(String(d.ciclo ?? ''))}*`;
  const linhas = [cabecalho, ''];
  if (!itens.length) {
    linhas.push('Nenhum lançamento neste ciclo.');
  } else {
    for (const it of itens) {
      const desc = escapeMd(String(it.descricao ?? '')).trim();
      linhas.push(`• ${escapeMd(String(it.data ?? ''))} — R$ ${fmtValor(it.valor)}${desc ? ' ' + desc : ''}`);
    }
    linhas.push('', dinheiro
      ? `*Total em mãos no ciclo: R$ ${fmtValor(d.total)}*`
      : `*Total do ciclo: R$ ${fmtValor(d.total)}*`);
  }
  await sendTelegram(chatId, linhas.join('\n'));
}

// /geral — painel do ciclo vigente: comissão, despesas, dinheiro e o acerto.
// As três fontes são independentes; se uma falhar o painel diz QUAL falhou em
// vez de mostrar um número errado (o acerto só sai com as três disponíveis).
async function handleGeral(chatId) {
  const [com, desp, dinh] = await Promise.all([
    dadosComissao(),
    dadosRegistrosRod(null, 'despesa'),
    dadosRegistrosRod(null, 'dinheiro'),
  ]);

  const ciclo = (com && com.mes) || (desp && desp.ciclo) || (dinh && dinh.ciclo) || '';
  const linhas = [`📋 *Geral — ${escapeMd(String(ciclo))}*`, ''];

  const comissao = com ? Number(com.comissao) || 0 : null;
  if (!com) {
    linhas.push('💰 *Comissão*: ⚠️ não consegui consultar');
  } else {
    linhas.push('💰 *Comissão*');
    linhas.push(`Unidades: *${com.unidades_mes ?? 0}* · faixa R$ ${fmtBR(com.taxa_atual)}/un`);
    linhas.push(`Total: *R$ ${fmtBR(comissao)}*`);
  }

  const fixo = com ? fixoDoCiclo(com) : null;
  linhas.push('');
  if (fixo) linhas.push(linhaFixo(fixo));
  else linhas.push('📌 *Fixo*: ⚠️ não consegui calcular');

  const despesas = desp ? Number(desp.total) || 0 : null;
  linhas.push('');
  if (!desp) {
    linhas.push('🛵 *Despesas Rod*: ⚠️ não consegui consultar');
  } else {
    const n = Array.isArray(desp.itens) ? desp.itens.length : 0;
    linhas.push('🛵 *Despesas Rod*');
    linhas.push(`${n} lançamento(s) → *R$ ${fmtBR(despesas)}*`);
  }

  const dinheiro = dinh ? Number(dinh.total) || 0 : null;
  linhas.push('');
  if (!dinh) {
    linhas.push('💵 *Dinheiro em mãos*: ⚠️ não consegui consultar');
  } else {
    const n = Array.isArray(dinh.itens) ? dinh.itens.length : 0;
    linhas.push('💵 *Dinheiro em mãos*');
    linhas.push(`${n} lançamento(s) → *R$ ${fmtBR(dinheiro)}*`);
  }

  linhas.push('');
  if (comissao == null || despesas == null || dinheiro == null || !fixo) {
    linhas.push('⚖️ *Acerto*: ⚠️ falta dado acima — não dá pra fechar a conta.');
  } else {
    linhas.push(`🧾 A pagar: comissão + fixo + despesas = *R$ ${fmtBR(comissao + fixo.valor + despesas)}*`);
    linhas.push(linhaAcerto(dinheiro, comissao + fixo.valor + despesas));
  }

  await sendTelegram(chatId, linhas.join('\n'));
}

// /fechamento — PARCIAL do ciclo vigente, no formato do fechamento, sem
// fechar nada (não grava, não publica em outro grupo). Mesmas permissões do
// /geral: onde ele responde, este responde.
function despesasPorTipo(itens) {
  const mapa = new Map();
  for (const it of itens || []) {
    const tipo = (String(it.descricao ?? '').trim().split(/\s+/)[0] || 'OUTROS').toUpperCase();
    mapa.set(tipo, (mapa.get(tipo) || 0) + (Number(it.valor) || 0));
  }
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
}

async function handleFechamentoParcial(chatId) {
  const [com, desp, dinh] = await Promise.all([
    dadosComissao(),
    dadosRegistrosRod(null, 'despesa'),
    dadosRegistrosRod(null, 'dinheiro'),
  ]);
  if (!com) { await sendTelegram(chatId, '⚠️ Erro ao consultar comissão — não dá pra montar a parcial.'); return; }

  const linhas = [`⏳ *FECHAMENTO PARCIAL — ${escapeMd(String(com.mes ?? ''))}*`, '_Até agora. Nada foi fechado._'];
  const periodo = periodoDoCiclo(com);
  if (periodo) {
    const total = diasEntre(periodo.inicio, periodo.fim);
    const hoje = new Date(`${hojeISO()}T00:00:00Z`);
    const passados = Math.max(0, Math.min(total, diasEntre(periodo.inicio, hoje)));
    linhas.push(`📅 Dia ${passados} de ${total} do ciclo`);
  }
  linhas.push('');

  const comissao = Number(com.comissao) || 0;
  linhas.push(...(linhasQuebraAtacado(com) || [
    `Pods até agora: *${com.unidades_mes ?? 0}*`,
    `Faixa atual: R$ ${fmtBR(com.taxa_atual)}/produto`,
  ]));
  linhas.push(`💰 Comissão: *R$ ${fmtBR(comissao)}*`);

  const fixo = fixoDoCiclo(com);
  linhas.push(fixo ? linhaFixo(fixo) : AVISO_FIXO);

  let despesas = null;
  if (!desp) {
    linhas.push('⚠️ _Não consegui somar as entregas/despesas do Rod._');
  } else {
    despesas = Number(desp.total) || 0;
    const tipos = despesasPorTipo(desp.itens);
    linhas.push(`🛵 Despesas extras: R$ ${fmtBR(despesas)}`);
    for (const [tipo, valor] of tipos) linhas.push(`   • ${escapeMd(tipo)}: R$ ${fmtBR(valor)}`);
  }

  let aPagar = null;
  if (despesas != null && fixo) {
    aPagar = comissao + fixo.valor + despesas;
    linhas.push(`🧾 *Total a pagar até agora: R$ ${fmtBR(aPagar)}*`);
  }

  if (!dinh) {
    linhas.push('⚠️ _Não consegui somar o dinheiro em mãos do Rod._');
  } else {
    const dinheiro = Number(dinh.total) || 0;
    linhas.push(`💵 Dinheiro com o Rod: R$ ${fmtBR(dinheiro)}`);
    if (aPagar != null) linhas.push(linhaAcerto(dinheiro, aPagar));
  }
  linhas.push('', '_Parcial: os números ainda mudam até o fechamento das 3h depois do último dia._');
  await sendTelegram(chatId, linhas.join('\n'));
}

async function handleComissao(chatId) {
  await sendTelegram(chatId, await textoComissao());
}

// ---------------------------------------------------------------------------
// /refazerfechamento DD/MM — republica um fechamento com a janela corrigida.
// Existe porque o bot já anunciou no grupo um fechamento com o corte velho
// (dia 19): a correção tem que ser visível, não um segundo fechamento calado.
// A comissão não é armazenada — a RPC recalcula a partir das vendas —, então
// basta apontar a data de corte do ciclo. Só o dono.
// ---------------------------------------------------------------------------

// "20/08" ou "20/08/2026" -> "2026-08-20" (ano padrão = ano corrente em SP).
function parseDataComando(text) {
  const arg = (text || '').trim().split(/\s+/)[1];
  if (!arg) return null;
  const m = arg.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
  const anoCorrente = hojeISO().slice(0, 4);
  const ano = m[3] || anoCorrente;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

async function handleRefazerFechamento(chatId, text, userId) {
  if (!ehDono(userId)) { await sendTelegram(chatId, '⛔ Só o dono pode refazer o fechamento.'); return; }
  const data = parseDataComando(text);
  if (!data) {
    await sendTelegram(chatId, 'Uso: /refazerfechamento 30/09 (data de corte do ciclo)');
    return;
  }

  let d = null;
  try {
    d = await callRpc('bot_comissao', { p_token: BOT_SYNC_TOKEN, p_mes: data });
  } catch (err) {
    console.error('refazerfechamento:', err.message);
  }
  if (!d || d.ok === false) {
    await sendTelegram(chatId, '⚠️ Não consegui recalcular o fechamento dessa data.');
    return;
  }

  const [, mes, dia] = data.split('-');
  const texto = montarFechamento(d, await dadosRegistrosRod(data), await dadosRegistrosRod(data, 'dinheiro'), {
    titulo: `🔁 *FECHAMENTO CORRIGIDO — ${escapeMd(String(d.mes ?? ''))}*`,
    rodape: `_Novo corte: fim do dia ${dia}/${mes} (2h59 da madrugada seguinte). Substitui o fechamento anterior._`,
    ref: data,
  });

  await sendTelegram(VENDAS_CHAT_ID, texto);
  if (String(chatId) !== VENDAS_CHAT_ID) {
    await sendTelegram(chatId, '✅ Correção publicada no grupo de vendas.');
  }
}

// ---------------------------------------------------------------------------
// Anulação de comissão
// Baixa que não é venda (troca, uso interno) não deve gerar comissão. As RPCs
// bot_anular_comissao / bot_desanular_comissao só marcam/desmarcam as últimas N
// unidades baixadas: o ESTOQUE não é tocado e /comissao já ignora as anuladas.
//
// QUEM PODE: /anular é de QUALQUER membro — anular só REDUZ a comissão do Rod,
// então o pior caso é ele se descontar sozinho. /desanular continua só do dono
// (ADMIN_USER_ID) porque AUMENTA a comissão, e isso fica na mão do Lucas.
// Todo /anular grava o autor no ajuste (bot_anular_comissao_autor) — auditoria
// simples de "quem apertou".
// ---------------------------------------------------------------------------

const ANULAR_MIN = 1;
const ANULAR_MAX = 50;

// Extrai o N de "/anular 10". null se faltar, não for número ou sair de 1..50.
function parseUnidadesComando(text) {
  const arg = (text || '').trim().split(/\s+/)[1];
  if (!arg || !/^\d+$/.test(arg)) return null;
  const n = parseInt(arg, 10);
  if (!n || n < ANULAR_MIN || n > ANULAR_MAX) return null;
  return n;
}

function ehDono(userId) {
  return String(userId ?? '') === ADMIN_USER_ID;
}

// Nome LEGÍVEL do autor: "Rodrigo Silva" ou "@rodrigo". String vazia quando o
// Telegram não mandou nenhum dos dois — de propósito: "(por 5984124812)" no
// grupo é ruído, não informação. O id não se perde, vai no meta do registro.
function nomeAutor(from) {
  if (!from) return '';
  const nome = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (nome) return nome;
  return from.username ? `@${from.username}` : '';
}

// Erro de RPC que ainda não existe no banco (Run não aplicado). É o que separa
// "falta rodar o SQL" de "o servidor caiu" — no primeiro caso dá pra cair no
// fallback sem autor em vez de deixar o /anular quebrado.
function rpcAusente(mensagem) {
  return /HTTP 404|schema cache|Could not find the function|does not exist/i.test(mensagem || '');
}

// Chama a RPC de (des)anulação sem nunca lançar: devolve { ok, data, msg }.
// `meta` (opcional) vira p_meta — o registro de quem pediu a anulação.
async function chamarRpcComissao(fn, unidades, meta) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN, p_unidades: unidades };
    if (meta) body.p_meta = meta;
    const data = await callRpc(fn, body);
    if (!data || data.ok === false) {
      const detalhe = data && (data.erro || data.msg || data.aviso);
      return { ok: false, msg: `⚠️ ${detalhe || 'Não foi possível concluir a operação.'}` };
    }
    return { ok: true, data };
  } catch (err) {
    console.error(`${fn}:`, err.message);
    return {
      ok: false,
      ausente: rpcAusente(err.message),
      msg: '⚠️ Erro ao falar com o servidor. Tente de novo em instantes.',
    };
  }
}

async function handleAnular(chatId, text, from) {
  const unidades = parseUnidadesComando(text);
  if (unidades == null) {
    await sendTelegram(chatId, `Uso: /anular 10 (${ANULAR_MIN} a ${ANULAR_MAX})`);
    return;
  }
  const autor = nomeAutor(from);
  const meta = { user_id: from && from.id != null ? String(from.id) : null, nome: autor };

  // Preferimos a versão que carimba o autor no ajuste. Se o Run dela ainda não
  // foi aplicado, a anulação AINDA ACONTECE pela RPC antiga — perder auditoria
  // é ruim, deixar o Rod sem conseguir anular venda errada é pior.
  let r = await chamarRpcComissao('bot_anular_comissao_autor', unidades, meta);
  if (!r.ok && r.ausente) {
    console.error('bot_anular_comissao_autor ausente — caindo na RPC sem autor');
    r = await chamarRpcComissao('bot_anular_comissao', unidades);
  }
  if (!r.ok) { await sendTelegram(chatId, r.msg); return; }

  // A RPC é um contador puro: devolve só { ok, unidades_anuladas }.
  const porQuem = autor ? ` (por ${escapeMd(autor)})` : '';
  await sendTelegram(chatId, `✂️ ${r.data.unidades_anuladas ?? 0} unidade(s) descontada(s) da comissão.${porQuem}`);
}

// Só o dono: adicionar AUMENTA a comissão, mesma regra do /desanular.
// Serve pra venda que entrou fora do bot ou ajuste manual a favor do Rod.
async function handleAdicionar(chatId, text, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode adicionar comissão.');
    return;
  }
  const unidades = parseUnidadesComando(text);
  if (unidades == null) {
    await sendTelegram(chatId, `Uso: /adicionar 10 (${ANULAR_MIN} a ${ANULAR_MAX})`);
    return;
  }
  const autor = nomeAutor(from);
  const meta = { user_id: from && from.id != null ? String(from.id) : null, nome: autor };

  const r = await chamarRpcComissao('bot_adicionar_comissao', unidades, meta);
  if (!r.ok) { await sendTelegram(chatId, r.msg); return; }

  const porQuem = autor ? ` (por ${escapeMd(autor)})` : '';
  const partes = [
    `➕ ${r.data.unidades_adicionadas ?? unidades} unidade(s) adicionada(s) à comissão.${porQuem}`,
  ];
  // Extrato logo abaixo: é onde se vê a adição já refletida. Sai do mesmo
  // bot_comissao que alimenta o /comissao, então os dois não têm como divergir.
  const d = await dadosComissao();
  partes.push('', d ? formatComissao(d) : '⚠️ _Adição registrada, mas não consegui puxar o extrato agora._');
  await sendTelegram(chatId, partes.join('\n'));
}

// ---------------------------------------------------------------------------
// Atacado
// Venda de atacado paga valor fixo por unidade (integration_config
// .comissao_atacado_valor) em vez da taxa da faixa, mas as unidades CONTAM
// para o volume do ciclo. Quem faz essa conta é a bot_comissao; o papel do bot
// é só marcar a venda — a marca é a palavra "atacado" no `notes`.
//
// SEMPRE POR ID: a bot_marcar_atacado exige o sale_id. "A última venda" é uma
// mira que se move sozinha — entre registrar e marcar, outra venda entra e leva
// a marca no lugar da certa. O único lugar que ainda parte de "a última" é o
// /atacado (correção manual), e lá o id é ESCOLHIDO antes, confirmado pelo
// usuário, e só então disparado.
// ---------------------------------------------------------------------------

// Nunca lança. { ok, ja_marcada, unidades, quando, msg }.
async function marcarAtacado(saleId) {
  try {
    const d = await callRpc('bot_marcar_atacado', {
      p_token: BOT_SYNC_TOKEN, p_sale_id: saleId != null ? String(saleId) : null,
    });
    if (!d || d.ok === false) {
      return { ok: false, msg: (d && (d.erro || d.msg)) || 'Não consegui marcar a venda como atacado.' };
    }
    return { ok: true, ja_marcada: !!d.ja_marcada, unidades: d.unidades, quando: d.quando };
  } catch (err) {
    console.error('bot_marcar_atacado:', err.message);
    return {
      ok: false,
      msg: rpcAusente(err.message)
        ? 'A RPC `bot_marcar_atacado` não existe no banco — falta rodar o SQL do atacado.'
        : 'Erro ao falar com o servidor.',
    };
  }
}

// A RPC devolve `itens` já legível ("6x Elfbar 30000 Cherry"). O fallback pra
// unidades existe só pra uma venda sem item; nunca mostrar "undefined" no grupo.
function descricaoVenda(d) {
  const itens = d && d.itens;
  if (Array.isArray(itens) && itens.length) return itens.join(', ');
  if (typeof itens === 'string' && itens.trim()) return itens.trim();
  return `${d && d.unidades != null ? d.unidades : '?'} unidade(s)`;
}

// Candidato da correção manual: última venda do bot dentro da janela. Não marca
// nada — só diz qual é.
async function ultimaVenda() {
  try {
    const d = await callRpc('bot_ultima_venda', {
      p_token: BOT_SYNC_TOKEN, p_minutos: ATACADO_JANELA_MIN,
    });
    if (!d || d.ok === false) {
      return { ok: false, msg: (d && (d.erro || d.msg)) || 'Não achei a última venda.' };
    }
    return { ok: true, ...d };
  } catch (err) {
    console.error('bot_ultima_venda:', err.message);
    return {
      ok: false,
      msg: rpcAusente(err.message)
        ? 'A RPC `bot_ultima_venda` não existe no banco — falta rodar o SQL do atacado.'
        : 'Erro ao falar com o servidor.',
    };
  }
}

// Quem pode corrigir: o dono e o Rodrigo. Sem ROD_USER_ID configurado só o
// dono passa — e a recusa mostra o id de quem tentou, que é justamente como o
// Lucas descobre o número do Rodrigo pra cadastrar no Render.
function podeMarcarAtacado(userId) {
  const id = String(userId ?? '');
  return ehDono(id) || (!!ROD_USER_ID && id === ROD_USER_ID);
}

// Janela da correção manual: "esqueci a palavra agora há pouco". Venda de
// ontem se corrige no sistema, não por um comando que aponta pro que estiver
// por último.
const ATACADO_JANELA_MIN = 30;

// Palavra de controle no COMEÇO de uma linha, com ou sem barra: "/atacado",
// "atacado", "/atacado@bot". Prefixo e não linha inteira de propósito — assim
// "/atacado -2 elfbar cherry" (tudo na mesma linha) também funciona, e
// "/atacado bom dia" não escorrega pro comando de correção.
// O \b impede casar com "atacadao"; e como exige começar em "atacado",
// "/desatacado" não casa.
const RE_CONTROLE_ATACADO = /^\/?atacado(@\S+)?\b[ \t]*/i;

// Separa a palavra de controle do resto da mensagem.
// -> { controle: bool, linhas: [...] } com as linhas já sem a palavra.
function separarControleAtacado(texto) {
  let controle = false;
  const linhas = [];
  for (const bruta of String(texto || '').split('\n')) {
    const linha = bruta.trim();
    if (!linha) continue;
    const m = linha.match(RE_CONTROLE_ATACADO);
    if (!m) { linhas.push(linha); continue; }
    controle = true;
    const resto = linha.slice(m[0].length).trim();
    if (resto) linhas.push(resto);
  }
  return { controle, linhas };
}

// Última marcação feita em cada chat, pro /desatacado saber o que desfazer.
// Guarda os IDs, não "a última venda" — desfazer também precisa de alvo fixo.
const ultimaMarcacao = new Map(); // chatKey -> { saleIds, texto, at }

function lembrarMarcacao(chatId, saleIds, texto) {
  const ids = (saleIds || []).filter(Boolean).map(String);
  if (!ids.length) return;
  ultimaMarcacao.set(String(chatId), { saleIds: ids, texto, at: Date.now() });
}

const AVISO_DESFAZER = 'Se não era essa, responda `/desatacado`.';

// Sem confirmação em duas etapas: marca direto e oferece o desfazer. Pedir
// "responda ok" no meio do expediente só fazia a correção morrer pela metade —
// e uma marcação errada tem volta, então travar antes custava mais que desfazer.
async function handleAtacado(chatId, from) {
  const userId = from && from.id;
  if (!podeMarcarAtacado(userId)) {
    await sendTelegram(chatId,
      `⛔ Só o dono e o Rodrigo podem marcar atacado.\n_(seu id: \`${userId}\` — pra liberar, cadastre em ROD\\_USER\\_ID no Render)_`);
    return;
  }

  const venda = await ultimaVenda();
  if (!venda.ok) {
    await sendTelegram(chatId,
      `⚠️ ${venda.msg}\n_Pra lançar um pedido de atacado agora, mande \`/atacado\` e cole as linhas de baixa embaixo._`);
    return;
  }

  const texto = `${descricaoVenda(venda)} (${String(venda.quando ?? '')})`;
  if (venda.ja_marcada) {
    lembrarMarcacao(chatId, [venda.sale_id], texto);
    await sendTelegram(chatId, `🏷️ A última venda já estava marcada como atacado: *${escapeMd(texto)}*.\n${AVISO_DESFAZER}`);
    return;
  }

  const marca = await marcarAtacado(venda.sale_id);
  if (!marca.ok) { await sendTelegram(chatId, `⚠️ ${marca.msg}`); return; }

  lembrarMarcacao(chatId, [venda.sale_id], texto);
  await sendTelegram(chatId, `🏷️ Marquei como atacado: *${escapeMd(texto)}*.\n${AVISO_DESFAZER}`);
}

// /desatacado — tira a marca da última venda (ou vendas) que ESTE chat marcou.
async function handleDesatacado(chatId, from) {
  const userId = from && from.id;
  if (!podeMarcarAtacado(userId)) {
    await sendTelegram(chatId, '⛔ Só o dono e o Rodrigo podem desfazer a marca de atacado.');
    return;
  }
  const m = ultimaMarcacao.get(String(chatId));
  if (!m) {
    await sendTelegram(chatId, '🤷 Não tenho marcação recente pra desfazer neste chat.');
    return;
  }

  const desfeitas = [];
  const falhas = [];
  for (const id of m.saleIds) {
    let d = null;
    try {
      d = await callRpc('bot_desmarcar_atacado', { p_token: BOT_SYNC_TOKEN, p_sale_id: String(id) });
    } catch (err) {
      console.error('bot_desmarcar_atacado:', err.message);
      falhas.push(rpcAusente(err.message)
        ? 'a RPC `bot_desmarcar_atacado` não existe no banco — falta rodar o SQL do atacado'
        : 'erro ao falar com o servidor');
      continue;
    }
    if (!d || d.ok === false) { falhas.push((d && (d.erro || d.msg)) || 'não consegui desfazer'); continue; }
    desfeitas.push(id);
  }

  if (desfeitas.length) ultimaMarcacao.delete(String(chatId));
  const linhas = [];
  if (desfeitas.length) {
    linhas.push(`↩️ Marca de atacado removida: *${escapeMd(m.texto)}*. Voltou a valer como varejo.`);
  }
  for (const f of falhas) linhas.push(`⚠️ Não consegui desfazer: ${f}.`);
  await sendTelegram(chatId, linhas.join('\n'));
}

// Diagnóstico: qual commit está no ar e quais comandos ESTA versão conhece.
// Só o dono, pra não virar ruído nos grupos.
async function handleVersao(chatId, userId) {
  if (!ehDono(userId)) return;
  await sendTelegram(chatId, `🔖 *Versão no ar*\nCommit: \`${COMMIT}\`\nComandos: ${COMANDOS.join(' ')}`);
}

// Só o dono: desanular AUMENTA a comissão (ao contrário do /anular, liberado).
async function handleDesanular(chatId, text, userId) {
  if (!ehDono(userId)) { await sendTelegram(chatId, '⛔ Só o dono pode desanular comissão.'); return; }
  const unidades = parseUnidadesComando(text);
  if (unidades == null) {
    await sendTelegram(chatId, `Uso: /desanular 10 (${ANULAR_MIN} a ${ANULAR_MAX})`);
    return;
  }
  const r = await chamarRpcComissao('bot_desanular_comissao', unidades);
  if (!r.ok) { await sendTelegram(chatId, r.msg); return; }

  const partes = [`↩️ ${r.data.unidades_reativadas ?? 0} unidade(s) de volta na comissão.`];
  if (r.data.aviso) partes.push(`⚠️ ${escapeMd(String(r.data.aviso))}`);
  await sendTelegram(chatId, partes.join('\n'));
}

// ---------------------------------------------------------------------------
// Relatório semanal (domingo 14:00 no grupo de VENDAS, ou /semana na hora).
//
// Todo o cálculo é da RPC bot_relatorio_semanal — que já soma as DUAS lojas e
// não devolve nada em R$. Aqui é só formatação: se um número aparecer neste
// bloco sem ter vindo da RPC, é bug.
//
// Seção vazia some inteira; a única exceção é PARADOS, que fala explicitamente
// que não há parado — "nenhum pod parado" é notícia boa, e sumir com a seção
// leria como "esqueci de calcular".
// ---------------------------------------------------------------------------

const SEMANA_TOP_MODELOS = 6;
const SEMANA_TOP_SABORES = 8;
const SEMANA_REPOR = 8;
const SEMANA_PARADOS = 6;
const SEMANA_PARADOS_EXTRA = 5;

// Domingo (0) às 14:00. Timezone vai no schedule, como nos outros crons.
const CRON_RELATORIO_SEMANAL = '0 14 * * 0';

// Comparação com a semana anterior: 🔥 vendeu mais, 📉 menos, ➡️ igual.
function setaTendencia(atual, anterior) {
  const a = Number(atual) || 0;
  const b = Number(anterior) || 0;
  if (a > b) return '🔥';
  if (a < b) return '📉';
  return '➡️';
}

async function dadosRelatorioSemanal() {
  try {
    const d = await callRpc('bot_relatorio_semanal', { p_token: BOT_SYNC_TOKEN });
    return d && d.ok !== false ? d : null;
  } catch (err) {
    console.error('relatorio_semanal:', err.message);
    return null;
  }
}

function montarRelatorioSemanal(d) {
  const lista = v => (Array.isArray(v) ? v : []);
  const total = Number(d.total) || 0;
  const anterior = Number(d.total_anterior) || 0;

  const linhas = [
    `📊 *RELATÓRIO DA SEMANA (${escapeMd(String(d.periodo ?? ''))})*`,
    `*${total}* unidades vendidas (semana anterior: ${anterior}) ${setaTendencia(total, anterior)}`,
  ];

  const top = lista(d.top).slice(0, SEMANA_TOP_MODELOS);
  if (top.length) {
    linhas.push('', '🏆 *TOP MODELOS*');
    top.forEach((m, i) => {
      const qtd = Number(m.qtd) || 0;
      const estoque = Number(m.estoque) || 0;
      // ⚠️ só quando o estoque não cobre o que a semana vendeu.
      const alerta = estoque < qtd ? ' ⚠️' : '';
      linhas.push(
        `${i + 1}. ${escapeMd(String(m.modelo ?? ''))} — ${qtd} un (${Number(m.qtd_ant) || 0}) ` +
        `${setaTendencia(qtd, m.qtd_ant)} · estoque ${estoque}${alerta}`,
      );
      const sabores = lista(m.sabores)
        .map(s => `${escapeMd(String(s.sabor ?? ''))} ${Number(s.qtd) || 0}`)
        .join(' · ');
      if (sabores) linhas.push(`   ${sabores}`);
    });
  }

  const sabores = lista(d.top_sabores).slice(0, SEMANA_TOP_SABORES);
  if (sabores.length) {
    linhas.push('', '🍬 *TOP SABORES DA SEMANA*');
    sabores.forEach((s, i) => {
      linhas.push(
        `${i + 1}. ${escapeMd(String(s.sabor ?? ''))} — ${Number(s.qtd) || 0} un ` +
        `(${escapeMd(String(s.modelo ?? ''))})`,
      );
    });
  }

  const repor = lista(d.repor).slice(0, SEMANA_REPOR);
  if (repor.length) {
    linhas.push('', '⚠️ *REPOR* (vendeu mais do que tem)');
    for (const r of repor) {
      linhas.push(`· ${escapeMd(String(r.modelo ?? ''))} — vendeu ${Number(r.vendeu) || 0}, tem ${Number(r.estoque) || 0}`);
    }
  }

  const parados = lista(d.parados).slice(0, SEMANA_PARADOS);
  linhas.push('', '📉 *PARADOS* (2+ semanas sem vender)');
  if (parados.length) {
    for (const p of parados) {
      linhas.push(`· ${escapeMd(String(p.modelo ?? ''))} — ${Number(p.estoque) || 0} un`);
    }
  } else {
    linhas.push('· nenhum pod parado 👏');
  }

  // Doces/acompanhamentos: uma linha só, que não é pod e não merece seção.
  const extra = lista(d.parados_extra).slice(0, SEMANA_PARADOS_EXTRA);
  if (extra.length) {
    const itens = extra
      .map(p => `${escapeMd(String(p.modelo ?? ''))} ${Number(p.estoque) || 0}`)
      .join(' · ');
    linhas.push('', `🍬 Encalhados: ${itens}`);
  }

  return linhas.join('\n');
}

// Um caminho só para o cron e para o /semana: RPC fora do ar vira aviso, nunca
// silêncio — semanal demais para alguém notar a ausência sozinho.
async function textoRelatorioSemanal() {
  const d = await dadosRelatorioSemanal();
  return d
    ? montarRelatorioSemanal(d)
    : '⚠️ Não consegui montar o relatório da semana. Tente de novo em instantes.';
}

async function handleRelatorioSemanal(chatId) {
  await sendTelegram(chatId, await textoRelatorioSemanal());
}

async function enviarRelatorioSemanal() {
  await sendTelegram(VENDAS_CHAT_ID, await textoRelatorioSemanal());
}

// ---------------------------------------------------------------------------
// Grupo de PEDIDOS + lista do fornecedor + sugestão de compra
//
// O dono cria um grupo novo, chama /chatid lá dentro e guarda o id com
// /setgrupopedidos. O id mora em integration_config ('telegram_grupo_pedidos'),
// não em env var: assim trocar de grupo não pede deploy.
//
// ENQUANTO A CHAVE NÃO EXISTIR os três comandos respondem em qualquer chat que
// o bot já atende — senão o /setgrupopedidos seria impossível de usar (o bot
// ignoraria o grupo novo e o dono não teria como configurar de lá).
// ---------------------------------------------------------------------------

const CONFIG_GRUPO_PEDIDOS = 'telegram_grupo_pedidos';

// Chat de pedidos configurado ('' quando ainda não foi). Cacheado junto com o
// resto da config.
async function chatPedidos() {
  return (await lerConfig(CONFIG_GRUPO_PEDIDOS)).trim();
}

// Onde os comandos de pedido valem. Sem chave configurada, valem onde forem
// chamados (ver cabeçalho); com chave, só no grupo de pedidos e no privado.
function podePedidos(chatKey, isPrivadoLucas, pedidosId) {
  if (!pedidosId) return true;
  return String(chatKey) === String(pedidosId) || isPrivadoLucas;
}

// /chatid - id do chat atual. Só o dono, e liberado em QUALQUER chat (é o
// único jeito de descobrir o id de um grupo que o bot ainda não atende).
async function handleChatId(chatId, msg) {
  if (!ehDono(msg && msg.from && msg.from.id)) return;
  const chat = (msg && msg.chat) || {};
  const nome = chat.title || chat.username || '(privado)';
  await sendTelegram(chatId,
    `\u{1F194} *Chat atual*\nid: \`${chatId}\`\ntipo: ${chat.type || '?'}\nnome: ${escapeMd(String(nome))}` +
    '\n\nPra usar este chat como grupo de pedidos: /setgrupopedidos');
}

// /setgrupopedidos [id] - sem argumento usa o chat atual (é o caso normal:
// o dono manda de dentro do grupo novo). Também liberado em qualquer chat.
async function handleSetGrupoPedidos(chatId, text, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode definir o grupo de pedidos.');
    return;
  }
  const arg = (text || '').trim().split(/\s+/)[1];
  const alvo = arg ? arg.trim() : String(chatId);
  if (!/^-?\d+$/.test(alvo)) {
    await sendTelegram(chatId, 'Uso: /setgrupopedidos (no grupo desejado) ou /setgrupopedidos -1001234567890');
    return;
  }
  const ok = await gravarConfig(CONFIG_GRUPO_PEDIDOS, alvo);
  if (!ok) {
    await sendTelegram(chatId, '⚠️ Não consegui gravar a configuração. Tente de novo em instantes.');
    return;
  }
  await sendTelegram(chatId,
    `✅ Grupo de pedidos definido: \`${alvo}\`\n/fornecedor, /apelido e /pedido passam a valer aqui e no seu privado.`);
}

// ---------------------------------------------------------------------------
// Parser da lista do fornecedor
//
// A lista vem colada do WhatsApp: modelos marcados com carta/tridente, sabores
// em bullet, e um monte de recado no meio. Três regras, nesta ordem — ruído
// primeiro, senão um "RECADOS" com emoji viraria modelo e levaria os sabores
// seguintes junto.
// ---------------------------------------------------------------------------

const RE_EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;
const RE_LINHA_MODELO = /[\u{1F0CF}\u{1F531}]/u;   // carta 🃏 ou tridente 🔱
const RE_BULLET = /^[•*\-–—]\s*/;
// Linha só de traço/igual/emoji: separador visual, não tem conteúdo.
const RE_SEPARADOR = /^[\s━─—–\-=_*•~.]+$/;

// Recados e chamadas de venda que aparecem no meio da lista. Comparados sem
// acento e em maiúsculas, então bastam as formas simples aqui.
const RUIDO_FORNECEDOR = [
  'RECADOS', 'QUERIDOS CLIENTES', 'NAO ACEITAMOS', 'AGRADECEMOS',
  'NOVIDADES', 'MELHORES', 'OBRIGADO', 'OBRIGADA', 'FACA SEU PEDIDO',
  'PROMOCAO', 'PROMOCOES', 'ATENCAO', 'PEDIDO MINIMO',
];

function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036F]/g, '');
}

function limparNome(s) {
  return (s || '')
    .replace(RE_EMOJI, ' ')
    .replace(/[*_`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// `ehBullet` afrouxa a regra do preço: uma linha de sabor com preço colado no
// fim ainda é um sabor. Recado continua sendo recado mesmo em bullet.
function ehRuidoFornecedor(linha, ehBullet) {
  const limpa = semAcento(limparNome(linha)).toUpperCase();
  if (!limpa) return true;
  if (RUIDO_FORNECEDOR.some(p => limpa.includes(p))) return true;
  if (!ehBullet && /R\$/.test(linha)) return true;
  return false;
}

// "🍇 2- Grape Pop / Peach Ice": quantidade, traço, sabor. O emoji da frente
// já saiu no limparNome.
const RE_QTD_TRACO = /^(\d+)\s*[-–—]\s*(\S.*)$/;
// Preço colado no fim do sabor: "Grape Ice R$ 45" / "Grape Ice - 45,00".
const RE_PRECO_FIM = /\s*(?:[-–—|]\s*)?R?\$\s*\d+(?:[.,]\d{1,2})?\s*$/i;

// Linha só de maiúsculas (com pelo menos duas letras): título de modelo
// ("IGNITE V400 MIX", "RABBEATS RC50K"). Número no meio é permitido — é o que
// todo nome de modelo tem; o que não pode é COMEÇAR com quantidade.
function ehLinhaMaiuscula(limpa) {
  const letras = limpa.replace(/[^\p{L}]/gu, '');
  return letras.length >= 2 && letras === letras.toUpperCase() && !/^\d/.test(limpa);
}

// Leitura SEM IA (o plano B quando a API falha ou não tem chave). Devolve
// [{ modelo, sabor }] — com `qtd` quando a linha diz quanto tem. Regras, na
// ordem: ruído e separador saem; 🃏/🔱 é modelo; "2- sabor" é sabor com
// quantidade; bullet é sabor; linha toda em maiúsculas é modelo. Sabor antes
// do primeiro modelo é descartado: sem modelo não dá pra dizer de que produto
// ele é.
function parseListaFornecedor(texto) {
  const itens = [];
  const vistos = new Set();
  let modelo = null;

  const pushItem = (sabor, qtd) => {
    if (!modelo || !sabor) return;
    const chave = `${modelo} ${sabor}`.toLowerCase();
    if (vistos.has(chave)) return;
    vistos.add(chave);
    itens.push(qtd == null ? { modelo, sabor } : { modelo, sabor, qtd });
  };

  for (const bruta of String(texto || '').split('\n')) {
    const linha = bruta.trim();
    if (!linha || RE_SEPARADOR.test(linha)) continue;
    const limpa = limparNome(linha);
    // Sem letra nem número ("⸻", "🎉"): separador que o RE_SEPARADOR não conhece.
    if (!/[\p{L}\d]/u.test(limpa)) continue;

    const mQtd = limpa.match(RE_QTD_TRACO);
    const ehBullet = RE_BULLET.test(linha);
    if (ehRuidoFornecedor(linha, ehBullet || !!mQtd)) continue;

    if (RE_LINHA_MODELO.test(linha)) {
      if (limpa) modelo = limpa;
      continue;
    }

    if (mQtd) {
      pushItem(limparNome(mQtd[2].replace(RE_PRECO_FIM, '')), parseInt(mQtd[1], 10));
      continue;
    }

    if (ehBullet) {
      pushItem(limparNome(linha.replace(RE_BULLET, '')));
      continue;
    }

    if (ehLinhaMaiuscula(limpa)) modelo = limpa;
  }
  return itens;
}

// Heurística de "isto é a lista, não conversa": pelo menos um modelo e dois
// sabores, ou seja, 3 linhas com conteúdo. Era 5 linhas e 200 caracteres,
// mas lista de fornecedor pequeno ("IGNITE V400 MIX" + 4 sabores) ficava
// abaixo disso e o bot pedia a lista de novo. Conversa ("beleza, já mando")
// continua de fora: é uma linha só.
function pareceListaFornecedor(texto) {
  return String(texto || '').split('\n').filter(l => l.trim()).length >= 3;
}

// /fornecedor sem lista junto arma a espera: a PRÓXIMA mensagem longa daquele
// mesmo chat/autor é tratada como a lista. Expira sozinho.
const FORNECEDOR_PENDENTE_MS = 10 * 60 * 1000;
const fornecedorPendente = new Map(); // chatKey -> { at, userId }

function armarFornecedorPendente(chatKey, userId) {
  fornecedorPendente.set(String(chatKey), { at: Date.now(), userId: String(userId ?? '') });
}

function consumirFornecedorPendente(chatKey, userId, texto) {
  const p = fornecedorPendente.get(String(chatKey));
  if (!p) return false;
  if (Date.now() - p.at > FORNECEDOR_PENDENTE_MS) {
    fornecedorPendente.delete(String(chatKey));
    return false;
  }
  if (p.userId && p.userId !== String(userId ?? '')) return false;
  if (!pareceListaFornecedor(texto)) return false;
  fornecedorPendente.delete(String(chatKey));
  return true;
}

// Itens sem cadastro podem vir como string ou como {modelo, sabor}.
function rotuloItem(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  const mod = x.modelo || x.model || '';
  const sab = x.sabor || x.flavor || '';
  return [mod, sab].filter(Boolean).join(' · ') || String(x);
}

const DICA_APELIDO =
  '_Se quiser vender algum, cadastre no sistema. Para corrigir nome: /apelido NOME DO FORNECEDOR = Nome no sistema_';

// ---------------------------------------------------------------------------
// Leitura da lista com IA (Claude Haiku)
//
// Cada fornecedor manda a lista de um jeito, e o formato muda sem aviso. Regra
// fixa quebrava calada: "Não achei nenhum item", a lista salva ficava velha e
// o /pedido deixava de fora o que o fornecedor tem. A IA lê qualquer formato;
// o parser de regras fica de plano B (API fora, sem chave, resposta ruim).
//
// A chave vem de ANTHROPIC_API_KEY (Render > Environment). Sem ela o bot não
// quebra: lê pelas regras e avisa.
// ---------------------------------------------------------------------------

// Modelo em env var, como o do Gemini: trocar não pode depender de deploy.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

let clienteAnthropic = null;

// Criado na primeira chamada (não no topo do módulo): a chave pode não existir.
function clienteIA() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!clienteAnthropic) {
    // Uma nova tentativa só: quem mandou a lista está esperando a resposta.
    clienteAnthropic = new Anthropic({ maxRetries: 1, timeout: 90 * 1000 });
  }
  return clienteAnthropic;
}

// Uma chamada com saída em JSON garantida pelo schema (structured outputs).
// Lança em erro de API, resposta cortada ou recusa — o chamador decide o
// plano B.
async function iaJson(cli, system, conteudo, schema, maxTokens = 16000) {
  const resp = await cli.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: conteudo }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  if (resp.stop_reason !== 'end_turn') throw new Error(`resposta incompleta (${resp.stop_reason})`);
  const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(texto);
}

const QTD_OU_NULL = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

const SCHEMA_LISTA = {
  type: 'object',
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: { modelo: { type: 'string' }, sabor: { type: 'string' }, qtd: QTD_OU_NULL },
        required: ['modelo', 'sabor', 'qtd'],
        additionalProperties: false,
      },
    },
  },
  required: ['itens'],
  additionalProperties: false,
};

const PROMPT_LISTA = [
  'Você lê listas de estoque que fornecedores de pods (cigarro eletrônico) mandam por WhatsApp.',
  'Cada fornecedor escreve de um jeito: o modelo vem numa linha (às vezes com emoji, negrito, traços ou o puff count como "50K"),',
  'e os sabores vêm embaixo, um por linha, às vezes com a quantidade disponível na frente ("2- Grape Ice", "2x Grape Ice", "Grape Ice (2)").',
  'Devolva um item para cada sabor, ligado ao modelo da linha de título acima dele.',
  '- "modelo": o nome do modelo como o fornecedor escreveu, sem emojis nem enfeites. Não traduza nem complete.',
  '- "sabor": o nome do sabor como está escrito, sem emoji, sem quantidade e sem preço. Sabor duplo fica inteiro ("Grape Pop / Peach Ice").',
  '- "qtd": quantas unidades o fornecedor tem daquele sabor, se a lista disser; null se não disser.',
  'Ignore emojis soltos, separadores, preços, títulos de seção, saudações, recados, regras de pedido e propaganda.',
  'Não invente item que não está no texto. Se não houver nenhum sabor, devolva {"itens": []}.',
].join('\n');

// Normaliza o que a IA devolveu: tira vazio, emoji que escapou, repetido e
// quantidade que não é inteiro >= 0. A IA não é confiável só por ter respondido.
function limparItensIA(itens) {
  const vistos = new Set();
  const out = [];
  for (const it of Array.isArray(itens) ? itens : []) {
    const modelo = limparNome(String(it && it.modelo || ''));
    const sabor = limparNome(String(it && it.sabor || ''));
    if (!modelo || !sabor) continue;
    const chave = `${modelo} ${sabor}`.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const qtd = Number.isInteger(it.qtd) && it.qtd >= 0 ? it.qtd : null;
    out.push({ modelo, sabor, qtd });
  }
  return out;
}

// { itens, viaIA, motivo } — motivo diz por que caiu no plano B.
async function lerListaFornecedor(texto) {
  const cli = clienteIA();
  let motivo = 'sem ANTHROPIC_API_KEY';
  if (cli) {
    try {
      const r = await iaJson(cli, PROMPT_LISTA, `<lista>\n${texto}\n</lista>`, SCHEMA_LISTA);
      const itens = limparItensIA(r && r.itens);
      if (itens.length) return { itens, viaIA: true };
      motivo = 'a IA não achou item';
    } catch (err) {
      console.error('fornecedor IA (leitura):', err.message);
      motivo = 'a IA falhou';
    }
  }
  const itens = parseListaFornecedor(texto).map(it => ({ ...it, qtd: it.qtd ?? null }));
  return { itens, viaIA: false, motivo };
}

// ---------------------------------------------------------------------------
// Ligar nome do fornecedor -> cadastro do sistema
//
// Antes isso era só no banco (bot_fornecedor_importar + /apelido), por nome
// quase exato. Agora o bot liga primeiro e manda o NOME DO SISTEMA pro banco:
//   1. comparação normalizada (sem maiúscula, acento, emoji, espaço e
//      pontuação; "50K" = "50000"; código V do nome "(V400Mix)");
//   2. o que sobrar vai pra IA junto com o cadastro, e só vale ligação com
//      certeza "alta" que aponte um nome que EXISTE no cadastro.
// O que nenhum dos dois ligar vai com o nome original — o banco ainda tenta
// pelos apelidos cadastrados.
// ---------------------------------------------------------------------------

// "THE BLACK SHEEP 40K — DUAL FLAVOR" -> "theblacksheep40000dualflavor"
function chaveNome(s) {
  return semAcento(String(s || ''))
    .replace(RE_EMOJI, ' ')
    .toLowerCase()
    .replace(/(\d)\s*k(?![a-z])/g, '$1000')
    .replace(/[^a-z0-9]/g, '');
}

// Chaves de um modelo do sistema. "Ignite 40000 Mix (V400Mix)" também vale
// como "ignite" + "v400mix" — é como o fornecedor escreve ("IGNITE V400 MIX").
function chavesModeloSistema(nome) {
  const chaves = new Set([chaveNome(nome)]);
  const semParen = String(nome).replace(/\([^)]*\)/g, ' ');
  chaves.add(chaveNome(semParen));
  const codigo = (String(nome).match(/\(([^)]+)\)/) || [])[1];
  const marca = semParen.trim().split(/\s+/)[0];
  if (codigo && marca) chaves.add(chaveNome(`${marca} ${codigo}`));
  chaves.delete('');
  return chaves;
}

// chave -> nome, só quando a chave aponta UM nome (ambíguo não liga).
function indiceUnico(nomes, chavesDe) {
  const mapa = new Map();
  for (const nome of nomes) {
    for (const k of chavesDe(nome)) {
      if (!mapa.has(k)) mapa.set(k, new Set());
      mapa.get(k).add(nome);
    }
  }
  const unico = new Map();
  for (const [k, set] of mapa) if (set.size === 1) unico.set(k, [...set][0]);
  return unico;
}

function ligarModeloNormalizado(nomeFornecedor, indice) {
  for (const k of [chaveNome(nomeFornecedor), chaveNome(String(nomeFornecedor).replace(/\([^)]*\)/g, ' '))]) {
    if (k && indice.has(k)) return indice.get(k);
  }
  return null;
}

const CERTEZA = { type: 'string', enum: ['alta', 'media', 'baixa'] };

const SCHEMA_LIGA_MODELOS = {
  type: 'object',
  properties: {
    ligacoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fornecedor: { type: 'string' },
          sistema: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          certeza: CERTEZA,
        },
        required: ['fornecedor', 'sistema', 'certeza'],
        additionalProperties: false,
      },
    },
  },
  required: ['ligacoes'],
  additionalProperties: false,
};

const SCHEMA_LIGA_SABORES = {
  type: 'object',
  properties: {
    ligacoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          sistema: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          certeza: CERTEZA,
        },
        required: ['id', 'sistema', 'certeza'],
        additionalProperties: false,
      },
    },
  },
  required: ['ligacoes'],
  additionalProperties: false,
};

const PROMPT_LIGA = [
  'Você liga nomes de produtos (pods) escritos por um fornecedor aos nomes do cadastro de uma loja.',
  'Os nomes nunca são iguais: abreviação, erro de digitação ("DINER" = "Dinner"), puff count escrito como "50K" = "50000",',
  'palavras coladas ou separadas, ordem diferente. Para cada nome do fornecedor, aponte o nome do cadastro que é o MESMO produto.',
  'Copie o nome do cadastro exatamente como está na lista de opções.',
  'certeza "alta" só quando não houver dúvida razoável de que é o mesmo produto (mesma marca, mesmo modelo, mesmo puff count).',
  'Se dois nomes do cadastro forem plausíveis, ou se nenhum for, use sistema null e certeza "baixa". Nunca chute.',
].join('\n');

// Liga os modelos que a normalização não ligou. Devolve Map fornecedor -> sistema.
async function ligarModelosIA(cli, pendentes, modelosSistema) {
  const out = new Map();
  if (!cli || !pendentes.length) return out;
  const r = await iaJson(cli, PROMPT_LIGA,
    `<cadastro>\n${modelosSistema.join('\n')}\n</cadastro>\n<fornecedor>\n${pendentes.join('\n')}\n</fornecedor>`,
    SCHEMA_LIGA_MODELOS, 8000);
  const validos = new Set(modelosSistema);
  const pedidos = new Set(pendentes);
  for (const l of (r && r.ligacoes) || []) {
    if (l.certeza === 'alta' && pedidos.has(l.fornecedor) && validos.has(l.sistema)) out.set(l.fornecedor, l.sistema);
  }
  return out;
}

// Liga sabores dentro do modelo já ligado. `pendentes`: [{ id, modelo, sabor,
// opcoes }]. Devolve Map id -> sabor do sistema.
async function ligarSaboresIA(cli, pendentes) {
  const out = new Map();
  if (!cli || !pendentes.length) return out;
  const blocos = pendentes.map(p =>
    `<item id="${p.id}" modelo="${p.modelo}">\nfornecedor: ${p.sabor}\nopções do cadastro:\n${p.opcoes.join('\n')}\n</item>`);
  const r = await iaJson(cli, PROMPT_LIGA, blocos.join('\n'), SCHEMA_LIGA_SABORES, 8000);
  const porId = new Map(pendentes.map(p => [p.id, p]));
  for (const l of (r && r.ligacoes) || []) {
    const p = porId.get(l.id);
    if (p && l.certeza === 'alta' && p.opcoes.includes(l.sistema)) out.set(l.id, l.sistema);
  }
  return out;
}

// Cadastro { modelo -> [sabores] } lido do estoque (zerados inclusos).
async function lerCadastro() {
  const produtos = await readEstoque();
  const cadastro = new Map();
  for (const p of produtos) {
    if (!p.modelo) continue;
    if (!cadastro.has(p.modelo)) cadastro.set(p.modelo, []);
    if (p.sabor && !cadastro.get(p.modelo).includes(p.sabor)) cadastro.get(p.modelo).push(p.sabor);
  }
  return cadastro;
}

// Itens do fornecedor -> cada um com `sistema: { modelo, sabor } | null`.
async function ligarAoCadastro(itens, cadastro) {
  const cli = clienteIA();
  const modelosSistema = [...cadastro.keys()];
  const indiceModelos = indiceUnico(modelosSistema, chavesModeloSistema);

  // 1) modelos: normalização, depois IA no que sobrou
  const nomesFornecedor = [...new Set(itens.map(it => it.modelo))];
  const modeloDe = new Map();
  for (const n of nomesFornecedor) {
    const m = ligarModeloNormalizado(n, indiceModelos);
    if (m) modeloDe.set(n, m);
  }
  const semModelo = nomesFornecedor.filter(n => !modeloDe.has(n));
  try {
    for (const [f, sis] of await ligarModelosIA(cli, semModelo, modelosSistema)) modeloDe.set(f, sis);
  } catch (err) {
    console.error('fornecedor IA (modelos):', err.message);
  }

  // 2) sabores dentro do modelo ligado: normalização, depois IA
  const ligados = itens.map(it => ({ ...it, sistema: null }));
  const pendentes = [];
  ligados.forEach((it, id) => {
    const modelo = modeloDe.get(it.modelo);
    if (!modelo) return;
    const opcoes = cadastro.get(modelo) || [];
    const sabor = indiceUnico(opcoes, s => [chaveNome(s)]).get(chaveNome(it.sabor));
    if (sabor) it.sistema = { modelo, sabor };
    else if (opcoes.length) pendentes.push({ id, modelo, sabor: it.sabor, opcoes });
  });
  try {
    for (const [id, sabor] of await ligarSaboresIA(cli, pendentes)) {
      ligados[id].sistema = { modelo: modeloDe.get(ligados[id].modelo), sabor };
    }
  } catch (err) {
    console.error('fornecedor IA (sabores):', err.message);
  }
  // Modelo ligado sem sabor ligado: vai com o modelo do sistema e o sabor
  // original — o banco ainda tenta pelo apelido.
  for (const it of ligados) it.modeloSistema = modeloDe.get(it.modelo) || null;
  return ligados;
}

const MAX_NAO_RECONHECIDOS = 40;

async function handleFornecedor(chatId, texto, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode importar a lista do fornecedor.');
    return;
  }

  const { itens, viaIA, motivo } = await lerListaFornecedor(texto);
  if (!itens.length) {
    await sendTelegram(chatId,
      `❌ Não achei nenhum item nessa lista${viaIA ? '' : ` (li sem IA: ${motivo})`}.\nConfere se colou a lista inteira, com os nomes dos modelos e os sabores.`);
    return;
  }

  // Sem cadastro não dá pra ligar nada: manda como veio (o banco ainda casa
  // pelo nome e pelos apelidos) e avisa.
  let ligados = null;
  try {
    ligados = await ligarAoCadastro(itens, await lerCadastro());
  } catch (err) {
    console.error('fornecedor: cadastro:', err.message);
  }

  const pItens = (ligados || itens.map(it => ({ ...it, sistema: null, modeloSistema: null }))).map(it => ({
    modelo: it.sistema ? it.sistema.modelo : (it.modeloSistema || it.modelo),
    sabor: it.sistema ? it.sistema.sabor : it.sabor,
    qtd: it.qtd ?? null,
  }));

  let r = null;
  try {
    r = await callRpc('bot_fornecedor_importar', { p_token: BOT_SYNC_TOKEN, p_itens: pItens });
  } catch (err) {
    console.error('bot_fornecedor_importar:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_fornecedor_importar` não existe no banco — falta rodar o SQL do fornecedor.'
      : '⚠️ Erro ao importar a lista. Tente de novo em instantes.');
    return;
  }
  if (!r || r.ok === false) {
    const detalhe = r && (r.erro || r.msg);
    await sendTelegram(chatId, `⚠️ ${detalhe || 'Não consegui importar a lista.'}`);
    return;
  }

  const casaramBanco = Number(r.casaram) || 0;
  const linhas = [];
  if (ligados) {
    const ok = ligados.filter(it => it.sistema);
    const modelos = new Set(ok.map(it => it.sistema.modelo)).size;
    linhas.push(`✅ *${ok.length} ${ok.length === 1 ? 'sabor reconhecido' : 'sabores reconhecidos'} em ${modelos} ${modelos === 1 ? 'modelo' : 'modelos'}*`);
    // O banco ainda liga pelos apelidos o que o bot não ligou.
    if (casaramBanco > ok.length) linhas.push(`🔗 +${casaramBanco - ok.length} ligados pelos apelidos cadastrados`);
    if (casaramBanco < ok.length) linhas.push(`⚠️ O banco só confirmou ${casaramBanco} — confira o cadastro.`);
    linhas.push(viaIA ? '_Lista lida com IA._' : `_Lista lida sem IA (${escapeMd(motivo)})._`);

    const falta = ligados.filter(it => !it.sistema);
    if (falta.length) {
      linhas.push('', `⚠️ *Não reconhecidos (${falta.length}):*`);
      for (const it of falta.slice(0, MAX_NAO_RECONHECIDOS)) {
        linhas.push(`• ${escapeMd(it.modelo)} · ${escapeMd(it.sabor)}${it.modeloSistema ? ' _(modelo ok, sabor não)_' : ''}`);
      }
      if (falta.length > MAX_NAO_RECONHECIDOS) linhas.push(`… e mais ${falta.length - MAX_NAO_RECONHECIDOS}`);
      linhas.push('', DICA_APELIDO);
    }
  } else {
    linhas.push(`✅ *Lista importada* — ${casaramBanco} de ${itens.length} itens casaram pelo nome`);
    linhas.push('⚠️ Não consegui ler o cadastro pra ligar os nomes; mandei a lista como veio.');
    linhas.push(viaIA ? '_Lista lida com IA._' : `_Lista lida sem IA (${escapeMd(motivo)})._`);
  }

  await sendTelegram(chatId, linhas.join('\n'));
}

// /apelido TE 30K = Elfbar 30000
async function handleApelido(chatId, text, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode cadastrar apelido.');
    return;
  }
  const corpo = (text || '').replace(/^\/apelido(@\S+)?\s*/i, '');
  const corte = corpo.indexOf('=');
  const apelido = corte >= 0 ? corpo.slice(0, corte).trim() : '';
  const modelo = corte >= 0 ? corpo.slice(corte + 1).trim() : '';
  if (!apelido || !modelo) {
    await sendTelegram(chatId, 'Uso: `/apelido TE 30K = Elfbar 30000`\n(nome do fornecedor = nome no sistema)');
    return;
  }

  let r = null;
  try {
    r = await callRpc('bot_fornecedor_apelido', {
      p_token: BOT_SYNC_TOKEN, p_apelido: apelido, p_modelo: modelo,
    });
  } catch (err) {
    console.error('bot_fornecedor_apelido:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_fornecedor_apelido` não existe no banco — falta rodar o SQL do fornecedor.'
      : '⚠️ Erro ao gravar o apelido. Tente de novo em instantes.');
    return;
  }
  if (!r || r.ok === false) {
    const detalhe = r && (r.erro || r.msg);
    await sendTelegram(chatId, `⚠️ ${detalhe || `Não consegui ligar "${apelido}" a "${modelo}".`}`);
    return;
  }
  await sendTelegram(chatId, `\u{1F517} Apelido gravado: *${escapeMd(apelido)}* → *${escapeMd(modelo)}*`);
}

// ---------------------------------------------------------------------------
// /pedido - sugestão de compra
//
// SÓ SUGESTÃO: não encosta no estoque. Estoque continua mudando só pelo fluxo
// de reposição.
// ---------------------------------------------------------------------------

const PEDIDO_SEMANAS_PADRAO = 4;

// "/pedido", "/pedido 15000", "/pedido 15000 8", "/pedido detalhe 15000".
function parseArgsPedido(text) {
  const tokens = (text || '').trim().split(/\s+/).slice(1);
  let detalhe = false;
  if (tokens.length && /^detalhe$/i.test(tokens[0])) { detalhe = true; tokens.shift(); }
  const nums = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  return {
    detalhe,
    teto: nums.length ? nums[0] : null,
    semanas: nums.length > 1 ? nums[1] : PEDIDO_SEMANAS_PADRAO,
  };
}

// Cada grupo da RPC ({ modelo, itens: [{ sabor, qtd, estoque, vendas }] }) vira
// um bloco de texto. A ORDEM não é mexida aqui: os grupos já vêm por prioridade
// de giro e os itens de cada grupo por quantidade — reordenar seria desfazer o
// cálculo da RPC. O corte em mensagens é por BLOCO, nunca no meio de um: a
// mensagem é encaminhada pro fornecedor inteira.
function blocosPedido(grupos, detalhe) {
  return (grupos || []).map(g => {
    const linhas = [`\u{1F0CF} *${escapeMd(String(g.modelo ?? ''))}* \u{1F0CF}`];
    for (const it of g.itens || []) {
      const qtd = Number(it.qtd) || 0;
      if (!qtd) continue;
      let linha = `${qtd} ${escapeMd(String(it.sabor ?? ''))}`;
      if (detalhe) {
        const tem = it.estoque != null ? it.estoque : '?';
        const vendeu = it.vendas != null ? it.vendas : '?';
        linha += ` (tem ${tem} · vendeu ${vendeu})`;
      }
      linhas.push(linha);
    }
    return linhas.join('\n');
  }).filter(b => b.includes('\n')); // modelo sem nenhum sabor sugerido não entra
}

// Junta os blocos em mensagens de até `max`, sem quebrar bloco. Bloco que
// sozinho passa do limite cai no splitMessage (aí não tem escolha).
function dividirBlocos(blocos, max = 3800) {
  const msgs = [];
  let buf = '';
  for (const bloco of blocos) {
    if (bloco.length > max) {
      if (buf) { msgs.push(buf); buf = ''; }
      msgs.push(...splitMessage(bloco, max));
      continue;
    }
    const candidato = buf ? `${buf}\n\n${bloco}` : bloco;
    if (candidato.length > max) { msgs.push(buf); buf = bloco; }
    else { buf = candidato; }
  }
  if (buf) msgs.push(buf);
  return msgs;
}

async function handlePedido(chatId, text) {
  const { detalhe, teto, semanas } = parseArgsPedido(text);

  let r = null;
  try {
    r = await callRpc('bot_montar_pedido', {
      p_token: BOT_SYNC_TOKEN,
      p_teto: teto,
      p_semanas: semanas,
      p_so_fornecedor: true,
    });
  } catch (err) {
    console.error('bot_montar_pedido:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_montar_pedido` não existe no banco — falta rodar o SQL do pedido.'
      : '⚠️ Erro ao montar o pedido. Tente de novo em instantes.');
    return;
  }
  if (!r || r.ok === false) {
    const detalheErro = r && (r.erro || r.msg);
    await sendTelegram(chatId, `⚠️ ${detalheErro || 'Não consegui montar o pedido.'}`);
    return;
  }

  const blocos = blocosPedido(r.grupos, detalhe);
  if (!blocos.length) {
    await sendTelegram(chatId, '\u{1F4E6} Nada a pedir: nenhum item passou dos critérios (teto, giro e lista do fornecedor).');
    return;
  }

  const unidades = Number(r.unidades) || 0;
  const custo = Number(r.total_custo) || 0;
  const cabecalho = ['\u{1F4E6} *PEDIDO SUGERIDO*', `_${unidades} un · R$ ${fmtBR(custo, 0)} de custo_`];
  // O aviso vai NO TOPO: sem lista ativa a sugestão é do catálogo inteiro e
  // pode conter item que o fornecedor não tem — quem encaminha precisa ver.
  if (r.usou_lista_fornecedor === false) {
    cabecalho.unshift('⚠️ Sem lista de fornecedor ativa — montei com o catálogo inteiro. Use /fornecedor antes.', '');
  }

  const partes = dividirBlocos([`${cabecalho.join('\n')}\n\n${blocos[0]}`, ...blocos.slice(1)]);
  for (const parte of partes) await sendTelegram(chatId, parte);
}

// ---------------------------------------------------------------------------
// Comprovantes de pagamento (foto/PDF no grupo de VENDAS)
//
// Foto entra → Gemini lê o valor → RPC registra e soma no caixa do dia, e de
// quebra acusa comprovante reenviado (mesmo código de transação). É o que pega
// o golpe de reenviar o comprovante de ontem pra levar pedido novo.
//
// REGRA DE OURO: nunca registrar valor sem confiança. Leitura errada de valor
// vira caixa errado, e caixa errado só aparece no fim do dia — quando ninguém
// mais lembra de qual foto era. Na dúvida, o bot pergunta.
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
// Nome do modelo em env var porque ele muda de geração sem avisar; trocar não
// pode depender de deploy.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

// Acima disso não vale a pena tentar: o getFile do Telegram para em 20 MB e o
// Gemini recusa inline data grande. Melhor pedir o valor na hora.
const COMPROVANTE_MAX_BYTES = 15 * 1024 * 1024;

// Valores fora desta faixa entram, mas com aviso: é venda atípica ou erro de
// leitura, e os dois merecem um olho humano.
const COMPROVANTE_MIN = 20;
const COMPROVANTE_MAX = 2000;

const MIMES_COMPROVANTE = ['image/jpeg', 'image/png', 'application/pdf'];

const PEDE_VALOR = '🤔 Não consegui ler o valor desse comprovante. Confere e me diz o valor?';

// Foto ou documento que vale a pena tentar ler. Sticker, vídeo e áudio ficam de
// fora. Da foto pegamos o MAIOR tamanho: o Telegram manda várias resoluções e
// as menores borram o valor.
function arquivoComprovante(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const maior = msg.photo.reduce((a, b) => ((b.file_size || 0) > (a.file_size || 0) ? b : a));
    return { fileId: maior.file_id, mime: 'image/jpeg', size: maior.file_size || 0 };
  }
  const doc = msg.document;
  if (doc && MIMES_COMPROVANTE.includes(String(doc.mime_type || '').toLowerCase())) {
    return { fileId: doc.file_id, mime: String(doc.mime_type).toLowerCase(), size: doc.file_size || 0 };
  }
  return null;
}

// Uma legenda que é comando ou movimento continua sendo comando/movimento: a
// foto vira só um anexo. Sem isso, mandar a foto com "-2 elfbar cherry" na
// legenda deixaria de dar baixa.
function legendaEhComando(texto) {
  const t = (texto || '').trim();
  if (!t) return false;
  const c = t.charAt(0);
  return c === '/' || c === '+' || c === '-';
}

async function baixarArquivoTelegram(fileId) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(`${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!resp.ok) throw new Error(`getFile HTTP ${resp.status}`);
  const data = await resp.json();
  const caminho = data && data.result && data.result.file_path;
  if (!caminho) throw new Error('getFile sem file_path');

  const arq = await fetch(`${TELEGRAM_API_BASE}/file/bot${TELEGRAM_TOKEN}/${caminho}`);
  if (!arq.ok) throw new Error(`download HTTP ${arq.status}`);
  const buf = Buffer.from(await arq.arrayBuffer());
  if (!buf.length) throw new Error('arquivo vazio');
  return buf;
}

const PROMPT_COMPROVANTE = [
  'Você recebe a imagem de um comprovante de pagamento brasileiro (Pix, TED, transferência ou cartão).',
  'Responda SOMENTE com JSON puro, sem texto em volta e sem blocos de código, neste formato:',
  '{"valor": 150.00, "codigo": "E12345...", "pago_em": "2026-09-15T16:42:00", "pagador": "Fulano", "banco": "Nubank", "confianca": "alta"}',
  '- "valor": valor pago em reais, número com ponto decimal e sem separador de milhar.',
  '- "codigo": identificador da transação (E2E do Pix, ID da transação ou autenticação); null se não houver.',
  '- "pago_em": data e hora do pagamento em ISO 8601; null se não houver.',
  '- "pagador": nome de quem pagou; null se não houver.',
  '- "banco": instituição do comprovante; null se não houver.',
  '- "confianca": "alta", "media" ou "baixa".',
  'Se não conseguir ler o valor com segurança, responda {"valor": null, "confianca": "baixa"}.',
  'Se a imagem não for um comprovante de pagamento, responda {"valor": null, "confianca": "baixa"}.',
].join('\n');

// O modelo às vezes embrulha o JSON em ```json apesar do pedido; tirar a cerca
// é mais barato que perder a leitura.
function parseJsonModelo(texto) {
  const limpo = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(limpo); } catch (_) { return null; }
}

// Lê o comprovante. Nunca lança: erro vira null e o chamador pede o valor.
async function lerComprovante(buffer, mime) {
  if (!GEMINI_API_KEY) { console.error('comprovante: GEMINI_API_KEY não definida'); return null; }
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `${GEMINI_API_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT_COMPROVANTE },
            { inline_data: { mime_type: mime, data: buffer.toString('base64') } },
          ],
        }],
        // temperature 0 + responseMimeType: o valor de um comprovante não é
        // lugar pra criatividade, e JSON forçado evita parse de texto solto.
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    if (!resp.ok) {
      const detalhe = await resp.text().catch(() => '');
      console.error(`gemini HTTP ${resp.status}: ${detalhe.slice(0, 300)}`);
      return null;
    }
    const data = await resp.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) { console.error('gemini: resposta sem texto', JSON.stringify(data).slice(0, 300)); return null; }
    return parseJsonModelo(texto);
  } catch (err) {
    console.error('gemini:', err.message);
    return null;
  }
}

// Valor só vale com confiança alta/média E número positivo. "baixa" é o próprio
// modelo dizendo que chutou — registrar isso seria pior que não ler.
function valorConfiavel(lido) {
  if (!lido) return null;
  const conf = String(lido.confianca || '').toLowerCase();
  if (conf !== 'alta' && conf !== 'media' && conf !== 'média') return null;
  const valor = Number(lido.valor);
  if (!Number.isFinite(valor) || valor <= 0) return null;
  return valor;
}

// Lê, registra e DEVOLVE o texto da resposta em vez de enviar. É o que permite
// a baixa e o comprovante saírem numa mensagem só quando a foto vem com a
// legenda do movimento.
// Nunca lança: qualquer erro vira texto pedindo o valor. Isso é o que garante
// que a leitura do comprovante não encoste na baixa.
async function lerERegistrarComprovante(chatId, msg) {
  const r = await registrarComprovante(chatId, msg);
  return r ? r.texto : null;
}

// O mesmo, devolvendo o que aconteceu — é o que a trava de comprovante
// repetido precisa saber ANTES de dar baixa:
//   { texto, lido: false }                  -> não leu o valor (nada gravado)
//   { texto, lido: true, duplicado, quando } -> leu e mandou registrar
// Nunca lança.
async function registrarComprovante(chatId, msg) {
  const arquivo = arquivoComprovante(msg);
  if (!arquivo) return null;

  if (arquivo.size > COMPROVANTE_MAX_BYTES) {
    return { texto: `📎 Esse arquivo é grande demais pra eu ler. ${PEDE_VALOR}`, lido: false };
  }

  let lido = null;
  try {
    const buffer = await baixarArquivoTelegram(arquivo.fileId);
    lido = await lerComprovante(buffer, arquivo.mime);
  } catch (err) {
    console.error('comprovante:', err.message);
  }

  const valor = valorConfiavel(lido);
  if (valor == null) {
    // Inclui imagem que nem é comprovante: sem valor, não registra nada.
    return { texto: PEDE_VALOR, lido: false };
  }

  let r = null;
  try {
    r = await callRpc('bot_comprovante_registrar', {
      p_token: BOT_SYNC_TOKEN,
      p_valor: valor,
      p_codigo: lido.codigo ?? null,
      p_pago_em: lido.pago_em ?? null,
      p_pagador: lido.pagador ?? null,
      p_banco: lido.banco ?? null,
      p_chat_id: chatId,
      p_message_id: msg.message_id,
      p_arquivo_id: arquivo.fileId,
      p_bruto: lido,
    });
  } catch (err) {
    console.error('bot_comprovante_registrar:', err.message);
    return {
      lido: true,
      texto: rpcAusente(err.message)
        ? '⚠️ A RPC `bot_comprovante_registrar` não existe no banco — falta rodar o SQL do comprovante.'
        : `⚠️ Li R$ ${fmtBR(valor)}, mas não consegui registrar. Tente reenviar em instantes.`,
    };
  }
  if (!r || r.ok === false) {
    const detalhe = r && (r.erro || r.msg);
    return { lido: true, texto: `⚠️ ${detalhe || `Li R$ ${fmtBR(valor)}, mas não consegui registrar.`}` };
  }

  return {
    lido: true,
    duplicado: !!r.duplicado,
    motivo: String(r.motivo ?? ''),
    quando: String(r.quando ?? r.anterior_em ?? ''),
    texto: textoComprovante(r, valor),
  };
}

// Foto sozinha: a resposta é só o comprovante.
async function handleComprovante(chatId, msg) {
  const texto = await lerERegistrarComprovante(chatId, msg);
  if (texto) await sendTelegram(chatId, texto);
}

// Monta a resposta do grupo a partir do retorno da RPC.
function textoComprovante(r, valor) {
  const quando = escapeMd(String(r.quando ?? r.anterior_em ?? ''));
  const valorDup = fmtBR(r.valor ?? valor);

  if (r.duplicado) {
    return r.motivo === 'codigo'
      ? `⚠️ *COMPROVANTE JÁ ENVIADO* — esse mesmo código de transação apareceu em ${quando}, no valor de R$ ${valorDup}. Confira antes de liberar o pedido.`
      : `⚠️ Já entrou um comprovante de R$ ${valorDup} há pouco (${quando}). Se for outro pagamento, tudo bem; se não, confira.`;
  }

  const linhas = [
    `💰 Comprovante lido: *R$ ${fmtBR(valor)}* · total do dia: R$ ${fmtBR(r.total_dia)} (${r.qtd_dia ?? 0} comprovantes)`,
  ];
  if (valor > COMPROVANTE_MAX || valor < COMPROVANTE_MIN) {
    linhas.push('⚠️ _valor fora do padrão, confere aí_');
  }
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------
// /caixa — o que entrou de dinheiro no dia
//
// SEM COMPARAÇÃO COM AS VENDAS DO SISTEMA: o total do sistema sai do preço de
// tabela, mas venda real tem desconto e negociação. A "diferença" dava vermelho
// todo santo dia sem nada de errado ter acontecido — número que sempre acusa
// não acusa nada, e o pessoal para de olhar.
// ---------------------------------------------------------------------------

// Acima disso a lista vira parede de texto no grupo; fica só o resumo.
const CAIXA_MAX_LISTA = 15;

// `data` ISO (YYYY-MM-DD) ou null = hoje. `compacto` corta a lista de itens —
// é o modo do resumo das 3h, que já é uma mensagem longa. Nunca lança.
async function textoCaixa(data, { compacto = false } = {}) {
  let d = null;
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    if (data) body.p_data = data;
    d = await callRpc('bot_caixa_dia', body);
  } catch (err) {
    console.error('bot_caixa_dia:', err.message);
    return rpcAusente(err.message)
      ? '⚠️ A RPC `bot_caixa_dia` não existe no banco — falta rodar o SQL do comprovante.'
      : '⚠️ Erro ao consultar o caixa do dia.';
  }
  if (!d || d.ok === false) return `⚠️ ${(d && (d.erro || d.msg)) || 'Erro ao consultar o caixa do dia.'}`;

  const dia = d.dia || d.data || (data ? data.split('-').reverse().slice(0, 2).join('/') : 'hoje');
  const qtd = Number(d.comprovantes_qtd) || 0;
  const linhas = [`💵 *CAIXA DE ${escapeMd(String(dia))}*`];

  if (!qtd) {
    linhas.push('Nenhum comprovante registrado.');
    return linhas.join('\n');
  }

  linhas.push(`Total recebido: *R$ ${fmtBR(d.comprovantes_total)}*`);
  linhas.push(`${qtd} comprovantes · ticket médio R$ ${fmtBR(d.ticket_medio)}`);

  const itens = Array.isArray(d.itens) ? d.itens : [];
  if (!compacto && itens.length && itens.length <= CAIXA_MAX_LISTA) {
    linhas.push('');
    for (const it of itens) {
      linhas.push(`${escapeMd(String(it.hora ?? ''))} · R$ ${fmtBR(it.valor)}`);
    }
  }
  return linhas.join('\n');
}

async function handleCaixa(chatId, text, from) {
  const tokens = (text || '').trim().split(/\s+/).slice(1);
  const sub = (tokens[0] || '').toLowerCase();

  // /caixa corrigir [DD/MM]
  if (sub === 'corrigir') {
    const data = tokens[1] ? parseDataComando(`x ${tokens[1]}`) : null;
    if (tokens[1] && !data) { await sendTelegram(chatId, 'Uso: /caixa corrigir (hoje) ou /caixa corrigir 15/09'); return; }
    await handleCaixaCorrigir(chatId, data);
    return;
  }

  // /caixa apagar N
  if (sub === 'apagar') {
    const n = parseInt(tokens[1], 10);
    if (!n || n < 1) { await sendTelegram(chatId, 'Uso: /caixa apagar 2 (o número vem da lista do `/caixa corrigir`)'); return; }
    await handleCaixaApagar(chatId, n, from);
    return;
  }

  // /caixa valor N 235
  if (sub === 'valor') {
    const n = parseInt(tokens[1], 10);
    const valor = parseValorArg(tokens[2]);
    if (!n || n < 1 || valor == null) {
      await sendTelegram(chatId, 'Uso: /caixa valor 2 235 (número da lista + valor novo)');
      return;
    }
    await handleCaixaValor(chatId, n, valor, from);
    return;
  }

  if (tokens[0] && !parseDataComando(text)) {
    await sendTelegram(chatId, 'Uso: /caixa · /caixa 15/09 · /caixa corrigir');
    return;
  }
  await sendTelegram(chatId, await textoCaixa(parseDataComando(text)));
}

// ---------------------------------------------------------------------------
// Grupo de FATURAMENTO (números do dinheiro, círculo pequeno)
//
// Os comprovantes continuam chegando no grupo de VENDAS — aqui só entram os
// TOTAIS. É a razão de ser do grupo: quem vê faturamento não precisa ver (nem
// deve ver) o fluxo de foto e baixa do dia.
//
// Mesmo mecanismo do grupo de pedidos: o id mora em integration_config
// ('telegram_grupo_faturamento'), então trocar de grupo não pede deploy.
// ---------------------------------------------------------------------------

const CONFIG_GRUPO_FATURAMENTO = 'telegram_grupo_faturamento';

async function chatFaturamento() {
  return (await lerConfig(CONFIG_GRUPO_FATURAMENTO)).trim();
}

// Onde /faturamento e /relatorio mes valem: grupo de faturamento e privado do
// dono. Sem a chave configurada, SÓ o privado do dono — ao contrário dos
// pedidos, que valem em qualquer lugar enquanto não são configurados. Aqui o
// vazamento é o risco: faturamento caindo no grupo de vendas é exatamente o
// que este grupo existe pra evitar.
function podeFaturamento(chatKey, isPrivadoLucas, faturamentoId) {
  if (isPrivadoLucas) return true;
  return !!faturamentoId && String(chatKey) === String(faturamentoId);
}

async function handleSetGrupoFaturamento(chatId, text, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode definir o grupo de faturamento.');
    return;
  }
  const arg = (text || '').trim().split(/\s+/)[1];
  const alvo = arg ? arg.trim() : String(chatId);
  if (!/^-?\d+$/.test(alvo)) {
    await sendTelegram(chatId, 'Uso: /setgrupofaturamento (no grupo desejado) ou /setgrupofaturamento -1001234567890');
    return;
  }
  const ok = await gravarConfig(CONFIG_GRUPO_FATURAMENTO, alvo);
  if (!ok) {
    await sendTelegram(chatId, '⚠️ Não consegui gravar a configuração. Tente de novo em instantes.');
    return;
  }
  await sendTelegram(chatId,
    `✅ Grupo de faturamento definido: \`${alvo}\`\n/faturamento e /relatorio mes passam a valer aqui e no seu privado.\nO resumo automático das 3h (o dia que fechou) vem pra cá.`);
}

// DIA DA LOJA: vira às 3h, não à meia-noite. Tudo entre 3h00 de um dia e 2h59
// do seguinte é o mesmo dia — venda de 1h da manhã do dia 1º ainda é do mês
// que acabou. No banco a mesma regra é a função dia_loja(); aqui é esta.
// Subtrair 3h do instante e pegar a data em São Paulo dá exatamente isso.
const HORA_VIRADA_DIA = 3;

// Dia da loja (ISO YYYY-MM-DD) de um instante. 'en-CA' já devolve nesse
// formato — mais seguro que montar na mão a partir do pt-BR.
function diaLojaISO(instante = new Date()) {
  const t = new Date(new Date(instante).getTime() - HORA_VIRADA_DIA * 3600e3);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// "Hoje" do bot inteiro é o dia da loja.
function hojeISO() {
  return diaLojaISO();
}

// Dia da loja anterior a `diaISO` (padrão: hoje). Às 3h, quando o fechamento
// roda, o dia novo já começou — o dia que acabou é este.
function ontemISO(diaISO = hojeISO()) {
  const d = new Date(`${diaISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// "09/2026" -> "2026-09-01". Null quando não veio ou não casa.
function parseMesComando(text) {
  const arg = (text || '').trim().split(/\s+/)[1];
  if (!arg) return null;
  const m = arg.match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mes = parseInt(m[1], 10);
  if (mes < 1 || mes > 12) return null;
  return `${m[2]}-${String(mes).padStart(2, '0')}-01`;
}

// p_ref do mês pedido. A bot_caixa_mes conta os dias ATÉ p_ref: mandar o dia
// 1º fazia um mês passado parecer ter um dia só (média = total do mês,
// projeção errada, dia a dia só com o dia 1º).
//   mês que já acabou -> último dia dele
//   mês atual         -> null (sem data, como o /faturamento normal)
// Mês futuro também vai com o último dia: dá zero, que é a verdade.
function refMesPedido(inicioMesISO, hoje = hojeISO()) {
  if (!inicioMesISO) return null;
  if (inicioMesISO.slice(0, 7) === hoje.slice(0, 7)) return null;
  const [a, m] = inicioMesISO.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

// "2026-09-12" ou "12/09" -> "12/09". A RPC pode mandar nos dois formatos.
function diaCurto(valor) {
  const s = String(valor ?? '');
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[3]}/${iso[2]}` : s;
}

// Busca o mês na RPC bot_caixa_mes. Nunca lança: erro vira { erro: texto }.
async function dadosFaturamento(ref) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    // p_ref é DATE (dia da loja): vai a data pura. No resumo das 3h é o dia que
    // acabou — é o que deixa a média e a projeção contarem os dias certos, em
    // vez de incluir o dia que mal começou.
    if (ref) body.p_ref = ref;
    const d = await callRpc('bot_caixa_mes', body);
    if (!d || d.ok === false) return { erro: `⚠️ ${(d && (d.erro || d.msg)) || 'Não consegui consultar o faturamento.'}` };
    return { dados: d };
  } catch (err) {
    console.error('bot_caixa_mes:', err.message);
    return {
      erro: rpcAusente(err.message)
        ? '⚠️ A RPC `bot_caixa_mes` não existe no banco — falta rodar o SQL do faturamento.'
        : '⚠️ Erro ao consultar o faturamento.',
    };
  }
}

// Mês fechado = o período já acabou. "Hoje" e "projeção" não fazem sentido num
// mês passado: hoje seria sempre 0 e a projeção, o próprio total.
// Mês fechado = o mês CALENDÁRIO já acabou. Usa mes_ate, não `ate`: desde que
// a RPC passou a medir período parcial, `ate` é o fim do que foi MEDIDO, e um
// mês corrente parcial seria lido como mês passado.
// `diaFechado` (ISO): o resumo das 3h fecha esse dia — se ele é o último do
// mês, o mês acabou junto com ele.
function mesFechado(d, diaFechado) {
  const ate = String(d.mes_ate ?? d.ate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(ate)) return false;
  return diaFechado ? ate.slice(0, 10) <= diaFechado : ate.slice(0, 10) < hojeISO();
}

// Total de UM dia, tirado do dia a dia que a própria RPC devolve (mesma
// fonte do total do mês). O `hoje` da RPC não serve às 3h: é o dia que mal
// começou.
function faturamentoDoDia(d, dia) {
  const alvo = diaCurto(dia);
  const it = (Array.isArray(d.dias) ? d.dias : []).find(x => diaCurto(x.dia) === alvo) || {};
  return { total: Number(it.total) || 0, qtd: Number(it.qtd) || 0 };
}

// Período parcial: o registro de comprovantes começou depois do dia 1, então a
// conta não cobre o mês inteiro. Sem isso, uma média de 11 dias apareceria como
// "média do mês" e a projeção sairia de uma base que não existe.
function ehParcial(d) {
  return d.parcial === true;
}

// Cabeçalho do recorte, usado no resumo e no dia a dia: "10/09 a 20/09 (11 dias)".
function rotuloPeriodo(d) {
  const dias = Number(d.dias_contados) || 0;
  const faixa = `${diaCurto(d.de)} a ${diaCurto(d.ate)}`;
  return dias ? `${faixa}* (${dias} dias)` : `${faixa}*`;
}

// A explicação do recorte. Fica de rodapé: é o que responde "por que o total
// está menor do que eu esperava".
function notaParcial(d) {
  return `_Começamos a registrar os comprovantes em ${diaCurto(d.primeiro_registro)}, então este mês ainda não está completo._`;
}

// `opts.dia` (ISO): modo do resumo das 3h — fecha esse dia (que já acabou)
// em vez de mostrar o "hoje" em andamento.
function formatFaturamento(d, opts = {}) {
  const hoje = d.hoje || {};
  const diaFechado = opts.dia || null;
  const fechado = mesFechado(d, diaFechado);
  const parcial = ehParcial(d);
  const linhas = [];

  if (diaFechado) {
    const doDia = faturamentoDoDia(d, diaFechado);
    linhas.push(`💰 *FATURAMENTO · ${escapeMd(diaCurto(diaFechado))}*`);
    linhas.push(`No dia: *R$ ${fmtBR(doDia.total)}* (${doDia.qtd} pagamentos)`);
    linhas.push('');
    if (fechado && !parcial) linhas.push(`📅 *${escapeMd(String(d.mes ?? ''))} fechado*`);
  } else if (fechado) {
    linhas.push(`💰 *FATURAMENTO · ${escapeMd(String(d.mes ?? ''))}*`);
  } else {
    linhas.push(`💰 *FATURAMENTO · ${escapeMd(diaCurto(hojeISO()))}*`);
    linhas.push(`Hoje: *R$ ${fmtBR(hoje.total)}* (${hoje.qtd ?? 0} pagamentos)`);
    linhas.push('');
  }

  if (parcial) {
    linhas.push(`📅 *Período medido: ${rotuloPeriodo(d)}`);
    linhas.push(`Total: *R$ ${fmtBR(d.mes_total)}* (${d.mes_qtd ?? 0} pagamentos)`);
  } else {
    if (!fechado) linhas.push(`📅 *${escapeMd(String(d.mes ?? ''))} até agora*`);
    linhas.push(`Total: *R$ ${fmtBR(d.mes_total)}*`);
  }
  linhas.push(`Média por dia: R$ ${fmtBR(d.media_dia)}`);

  const melhor = d.melhor_dia || {};
  if (melhor.dia) {
    linhas.push(`Melhor dia: ${escapeMd(diaCurto(melhor.dia))} com R$ ${fmtBR(melhor.total)}`);
  }

  // Projeção só com o mês inteiro medido: sem isso ela sairia de uma base
  // parcial e inflaria o número.
  const projecao = Number(d.projecao) || 0;
  if (!fechado && !parcial) linhas.push(`Projeção do mês: R$ ${fmtBR(projecao)}`);

  // Mês anterior zerado (primeiro mês de operação) não vira linha: comparar com
  // nada só ocupa espaço e ainda daria "📈 acima" sempre.
  const anterior = Number(d.mes_anterior) || 0;
  if (anterior > 0) {
    linhas.push('');
    linhas.push(`_Mês passado fechou em R$ ${fmtBR(anterior)}_`);
    // A seta sai num período parcial: 11 dias contra um mês fechado daria
    // "📉 abaixo" sempre, sem a loja ter vendido menos.
    if (!parcial) {
      const comparar = fechado ? Number(d.mes_total) || 0 : projecao;
      linhas.push(comparar >= anterior ? '📈 acima do mês passado' : '📉 abaixo do mês passado');
    }
  }

  if (parcial) {
    linhas.push('');
    linhas.push(notaParcial(d));
  }

  return linhas.join('\n');
}

// /faturamento — resumo do mês. `opts.dia` é o modo do automático das 3h.
async function textoFaturamento(ref, opts = {}) {
  const { dados, erro } = await dadosFaturamento(ref);
  return erro || formatFaturamento(dados, opts);
}

// /relatorio mes — dia a dia. Devolve uma LISTA de mensagens: mês cheio passa
// dos 4096 do Telegram, e a quebra é por linha inteira.
async function textosFaturamentoDetalhe(ref) {
  const { dados, erro } = await dadosFaturamento(ref);
  if (erro) return [erro];

  const dias = Array.isArray(dados.dias) ? dados.dias : [];
  const parcial = ehParcial(dados);
  // Num recorte parcial o cabeçalho diz o período REAL: "SETEMBRO" em cima de
  // uma lista que começa no dia 10 faria o leitor procurar os dias que faltam.
  const cabecalho = parcial
    ? `📅 *Período medido: ${rotuloPeriodo(dados)} · dia a dia*`
    : `📅 *${escapeMd(String(dados.mes ?? '').toUpperCase())} · dia a dia*`;
  const linhas = [cabecalho, ''];
  for (const it of dias) {
    const total = Number(it.total) || 0;
    const qtd = Number(it.qtd) || 0;
    linhas.push(total > 0 || qtd > 0
      ? `${escapeMd(diaCurto(it.dia))} · R$ ${fmtBR(total)} (${qtd})`
      : `${escapeMd(diaCurto(it.dia))} · — sem movimento`);
  }
  linhas.push('');
  linhas.push(`*Total: R$ ${fmtBR(dados.mes_total)} · ${dados.mes_qtd ?? 0} pagamentos*`);
  if (parcial) linhas.push('', notaParcial(dados));
  return splitMessage(linhas.join('\n'));
}

async function handleFaturamento(chatId, text) {
  const tokens = (text || '').trim().split(/\s+/).slice(1);
  const detalhe = tokens.length && /^detalhes?$/i.test(tokens[0]);
  const arg = tokens.find(t => /^\d{1,2}\/\d{4}$/.test(t));
  // parseMesComando lê o 2º token; com "detalhe" na frente, reescreve o texto
  // pra ele achar o mês no lugar certo.
  const ref = arg ? refMesPedido(parseMesComando(`x ${arg}`)) : null;

  if (tokens.length && !detalhe && !arg) {
    await sendTelegram(chatId, 'Uso: /faturamento · /faturamento 09/2026 · /faturamento detalhe');
    return;
  }

  if (detalhe) {
    for (const parte of await textosFaturamentoDetalhe(ref)) await sendTelegram(chatId, parte);
    return;
  }
  await sendTelegram(chatId, await textoFaturamento(ref));
}

// Resumo automático das 3h, só no grupo de faturamento — junto com o
// fechamento, quando o dia da loja vira. Fecha o dia que ACABOU (ontem) e o
// mês dele. Sem grupo configurado não manda nada (não tem pra onde: o
// privado do dono seria spam diário não pedido).
const CRON_FATURAMENTO = '0 3 * * *';

async function enviarFaturamentoDiario(dia = ontemISO()) {
  const grupo = await chatFaturamento();
  if (!grupo) { console.log('faturamento: grupo não configurado, resumo não enviado'); return; }
  await sendTelegram(grupo, await textoFaturamento(dia, { dia }));
}

// ---------------------------------------------------------------------------
// Corrigir comprovante lido errado
//
// Acontece de a foto ser de outra compra e o valor entrar errado no caixa. Até
// aqui só dava pra arrumar por SQL.
//
// SEMPRE PELO ID QUE VEIO DA LISTA: nunca por valor e nunca "o último". Dois
// comprovantes do mesmo valor no dia são comuns, e "o último" muda de alvo
// entre o momento em que a pessoa lê a lista e o momento em que ela digita.
// ---------------------------------------------------------------------------

// Lista numerada do dia, guardada por chat pro /caixa apagar N e /caixa valor N.
// N é a POSIÇÃO na lista; o que viaja pra RPC é o id. Expira junto com a
// memória do processo — o Render reinicia, e aí é só pedir a lista de novo.
const caixaListado = new Map(); // chatKey -> { at, data, itens: [{id, hora, valor}] }

const CAIXA_LISTA_MS = 30 * 60 * 1000;

function guardarListaCaixa(chatId, data, itens) {
  caixaListado.set(String(chatId), { at: Date.now(), data, itens });
}

// Resolve "N" na lista guardada. Devolve { erro } ou { item }.
function itemDaLista(chatId, n) {
  const l = caixaListado.get(String(chatId));
  if (!l || Date.now() - l.at > CAIXA_LISTA_MS) {
    return { erro: '⏳ Não tenho a lista aberta aqui. Mande `/caixa corrigir` primeiro.' };
  }
  const item = l.itens[n - 1];
  if (!item) {
    return { erro: `❌ Não existe o número ${n} na lista. Mande \`/caixa corrigir\` pra ver de novo.` };
  }
  return { item, data: l.data };
}

// Busca os comprovantes de um dia (RPC bot_comprovantes_dia). Nunca lança.
async function comprovantesDoDia(data) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    if (data) body.p_data = data;
    const d = await callRpc('bot_comprovantes_dia', body);
    if (!d || d.ok === false) return { erro: `⚠️ ${(d && (d.erro || d.msg)) || 'Não consegui listar os comprovantes.'}` };
    return { dados: d };
  } catch (err) {
    console.error('bot_comprovantes_dia:', err.message);
    return {
      erro: rpcAusente(err.message)
        ? '⚠️ A RPC `bot_comprovantes_dia` não existe no banco — falta rodar o SQL da correção.'
        : '⚠️ Erro ao listar os comprovantes.',
    };
  }
}

async function handleCaixaCorrigir(chatId, data) {
  const { dados, erro } = await comprovantesDoDia(data);
  if (erro) { await sendTelegram(chatId, erro); return; }

  const itens = (Array.isArray(dados.itens) ? dados.itens : [])
    .filter(it => it && it.id != null)
    .map(it => ({ id: String(it.id), hora: String(it.hora ?? ''), valor: Number(it.valor) || 0 }));

  const dia = dados.dia || dados.data || (data ? diaCurto(data) : 'HOJE');
  if (!itens.length) {
    await sendTelegram(chatId, `💵 *COMPROVANTES DE ${escapeMd(String(dia).toUpperCase())}*\n\nNenhum comprovante registrado.`);
    return;
  }

  guardarListaCaixa(chatId, data, itens);

  const linhas = [`💵 *COMPROVANTES DE ${escapeMd(String(dia).toUpperCase())}*`, ''];
  itens.forEach((it, i) => {
    linhas.push(`${i + 1} · ${escapeMd(it.hora)} · R$ ${fmtBR(it.valor)}`);
  });
  linhas.push('', `_Apagar: /caixa apagar 1 · Corrigir valor: /caixa valor 1 235_`);
  await sendTelegram(chatId, linhas.join('\n'));
}

// Depois de mexer, o total do dia tem que sair na mesma mensagem: é ele que
// diz se a correção resolveu.
async function totalDoDia(data) {
  const { dados } = await comprovantesDoDia(data);
  if (!dados) return null;
  const qtd = Number(dados.comprovantes_qtd ?? (Array.isArray(dados.itens) ? dados.itens.length : 0)) || 0;
  const total = Number(dados.comprovantes_total ?? 0) || 0;
  return `Novo total do dia: *R$ ${fmtBR(total)}* (${qtd} comprovantes)`;
}

async function handleCaixaApagar(chatId, n, from) {
  if (!podeMarcarAtacado(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono e o Rodrigo podem mexer nos comprovantes.');
    return;
  }
  const { item, data, erro } = itemDaLista(chatId, n);
  if (erro) { await sendTelegram(chatId, erro); return; }

  let r = null;
  try {
    r = await callRpc('bot_comprovante_apagar', { p_token: BOT_SYNC_TOKEN, p_id: item.id });
  } catch (err) {
    console.error('bot_comprovante_apagar:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_comprovante_apagar` não existe no banco — falta rodar o SQL da correção.'
      : '⚠️ Erro ao apagar o comprovante.');
    return;
  }
  if (!r || r.ok === false) {
    await sendTelegram(chatId, `⚠️ ${(r && (r.erro || r.msg)) || 'Não consegui apagar esse comprovante.'}`);
    return;
  }

  // A lista guardada acabou de ficar velha: as posições mudaram.
  caixaListado.delete(String(chatId));
  const linhas = [`🗑️ Apagado: ${escapeMd(item.hora)} · R$ ${fmtBR(item.valor)}`];
  const total = await totalDoDia(data);
  if (total) linhas.push(total);
  await sendTelegram(chatId, linhas.join('\n'));
}

async function handleCaixaValor(chatId, n, valor, from) {
  if (!podeMarcarAtacado(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono e o Rodrigo podem mexer nos comprovantes.');
    return;
  }
  const { item, data, erro } = itemDaLista(chatId, n);
  if (erro) { await sendTelegram(chatId, erro); return; }

  let r = null;
  try {
    r = await callRpc('bot_comprovante_valor', {
      p_token: BOT_SYNC_TOKEN, p_id: item.id, p_valor: valor,
    });
  } catch (err) {
    console.error('bot_comprovante_valor:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_comprovante_valor` não existe no banco — falta rodar o SQL da correção.'
      : '⚠️ Erro ao corrigir o valor.');
    return;
  }
  if (!r || r.ok === false) {
    await sendTelegram(chatId, `⚠️ ${(r && (r.erro || r.msg)) || 'Não consegui corrigir esse comprovante.'}`);
    return;
  }

  // O valor mudou; a hora e o id não. Atualiza a lista em vez de jogar fora:
  // corrigir dois seguidos é comum.
  item.valor = valor;
  const linhas = [
    `✏️ Corrigido: ${escapeMd(item.hora)} · R$ ${fmtBR(r.valor_anterior ?? item.valor)} → *R$ ${fmtBR(valor)}*`,
  ];
  const total = await totalDoDia(data);
  if (total) linhas.push(total);
  await sendTelegram(chatId, linhas.join('\n'));
}

// "235", "235.00", "235,00" -> 235. Null quando não é valor.
function parseValorArg(txt) {
  const v = parseFloat(String(txt ?? '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

// ---------------------------------------------------------------------------
// Lembrete mensal dos chips (dia 20, 10:00)
//
// O Telegram não deixa o bot listar os grupos em que está, então os destinos
// são esta lista de ids conhecidos. Os dois grupos novos vêm da config, e não
// hardcoded, pra que um grupo reconfigurado entre sozinho no lembrete.
//
// DISPARA UMA VEZ SÓ: a data do último envio fica gravada na config, então
// reinício do Render no dia 20 não repete a mensagem. O cron roda de hora em
// hora (não só às 10:00) porque o contrário também é problema: se o serviço
// estiver dormindo ou em deploy exatamente às 10:00, o node-cron não dispara
// atrasado e o lembrete se perde por um MÊS. Da segunda hora em diante a trava
// faz o disparo virar no-op.
// ---------------------------------------------------------------------------

const LEMBRETE_CHIPS = '📱 *Recarregar os CHIPS de telefone!!!*';
const CONFIG_LEMBRETE_CHIPS = 'bot_lembrete_chips';
const CRON_LEMBRETE_CHIPS = '0 10-23 20 * *';

// Espelho em memória da data gravada. Segura a repetição de hora em hora
// mesmo quando a config não pode ser gravada (chave fora da lista branca, banco
// fora do ar): aí o pior caso é repetir depois de um restart, não 14 vezes.
let lembreteChipsEnviado = '';

// Todos os destinos conhecidos, sem repetir. O privado do dono entra junto: é
// o único que não é grupo, e o dono também precisa do lembrete.
async function destinosLembrete() {
  const ids = [
    ADMIN_USER_ID,
    VENDAS_CHAT_ID,
    REPOSICAO_CHAT_ID,
    await chatPedidos(),
    await chatFaturamento(),
  ];
  return [...new Set(ids.map(x => String(x || '').trim()).filter(Boolean))];
}

// Manda pra todos. Uma falha não derruba as outras — perder um destino é ruim,
// perder os cinco por causa de um é pior.
async function enviarParaTodos(texto) {
  const destinos = await destinosLembrete();
  const ok = [];
  for (const destino of destinos) {
    try {
      await sendTelegram(destino, texto);
      ok.push(destino);
    } catch (err) {
      console.error(`lembrete: falhou para ${destino}:`, err.message);
    }
  }
  return { destinos, ok };
}

// Roda de hora em hora no dia 20; só o primeiro do dia manda de verdade.
async function enviarLembreteChips() {
  const hoje = hojeISO();
  if (lembreteChipsEnviado === hoje) return false;

  // A config é a trava que sobrevive a restart; a memória sozinha não sabe o
  // que uma instância anterior já fez.
  const gravado = (await lerConfig(CONFIG_LEMBRETE_CHIPS)).trim();
  if (gravado === hoje) { lembreteChipsEnviado = hoje; return false; }

  const { destinos, ok } = await enviarParaTodos(LEMBRETE_CHIPS);
  // Marca ANTES de conferir se gravou: o que não pode acontecer é mandar de
  // novo daqui a uma hora porque a escrita falhou.
  lembreteChipsEnviado = hoje;
  const gravou = await gravarConfig(CONFIG_LEMBRETE_CHIPS, hoje);
  if (!gravou) {
    console.error(`lembrete chips: não consegui gravar ${CONFIG_LEMBRETE_CHIPS} — a trava vale só até o próximo restart`);
  }
  console.log(`lembrete chips enviado para ${ok.length}/${destinos.length} destinos`);
  return true;
}

// /lembrete-teste — dispara na hora, pra conferir os destinos sem esperar o
// dia 20. NÃO mexe na trava: testar no dia 20 não pode cancelar o lembrete
// de verdade.
async function handleLembreteTeste(chatId, from) {
  if (!ehDono(from && from.id)) return;
  const { destinos, ok } = await enviarParaTodos(LEMBRETE_CHIPS);
  const falhas = destinos.filter(d => !ok.includes(d));
  const linhas = [`🧪 Lembrete de teste enviado para *${ok.length}* de ${destinos.length} destino(s).`];
  if (falhas.length) linhas.push(`⚠️ Não entregou em: ${falhas.map(d => `\`${d}\``).join(', ')}`);
  linhas.push('_A trava do dia 20 não foi tocada._');
  await sendTelegram(chatId, linhas.join('\n'));
}

// ---------------------------------------------------------------------------
// /traduzir — lista do fornecedor -> formato do grupo de REPOSIÇÃO
//
// O pedido volta do fornecedor com o modelo abreviado ("V500", "ICE KING 40k")
// e o sabor escrito de qualquer jeito ("apppe peach ice"). O bot de estoque só
// entende o nome exato, então hoje alguém digita tudo de novo à mão — que é
// onde nascem os erros.
//
// SÓ TRADUZ TEXTO: não dá entrada, não mexe em estoque, não registra nada. A
// entrada continua acontecendo quando alguém cola o resultado no grupo de
// REPOSIÇÃO. Isso é de propósito: o passo de conferir antes de colar é o que
// segura um nome traduzido errado.
//
// LEITURA sem depender de asterisco, dois-pontos ou emoji — nem sempre estão
// lá. Linha que COMEÇA COM NÚMERO é sabor (o número é a quantidade); qualquer
// outra linha é o MODELO, e vale até aparecer o próximo.
// ---------------------------------------------------------------------------

const CONFIG_GRUPO_TRADUCAO = 'telegram_grupo_traducao';

async function chatTraducao() {
  return (await lerConfig(CONFIG_GRUPO_TRADUCAO)).trim();
}

// Onde /traduzir vale: grupo de tradução, grupo de pedidos e privado do dono.
function podeTraduzir(chatKey, isPrivadoLucas, traducaoId, pedidosId) {
  if (isPrivadoLucas) return true;
  if (traducaoId && String(chatKey) === String(traducaoId)) return true;
  return !!pedidosId && String(chatKey) === String(pedidosId);
}

async function handleSetGrupoTraducao(chatId, text, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode definir o grupo de tradução.');
    return;
  }
  const arg = (text || '').trim().split(/\s+/)[1];
  const alvo = arg ? arg.trim() : String(chatId);
  if (!/^-?\d+$/.test(alvo)) {
    await sendTelegram(chatId, 'Uso: /setgrupotraducao (no grupo desejado) ou /setgrupotraducao -1001234567890');
    return;
  }
  const ok = await gravarConfig(CONFIG_GRUPO_TRADUCAO, alvo);
  if (!ok) {
    await sendTelegram(chatId, '⚠️ Não consegui gravar a configuração. Tente de novo em instantes.');
    return;
  }
  await sendTelegram(chatId,
    `✅ Grupo de tradução definido: \`${alvo}\`\nCole a lista do fornecedor aqui que eu devolvo no formato da reposição — nem precisa do /traduzir.`);
}

// A lista raramente chega com um item por linha: colada do WhatsApp pro
// Telegram, as quebras se perdem e vira "2 grape ice 2 strawberry banana 2
// pineapple mango" tudo junto — às vezes com o modelo na frente, separado por
// dois-pontos. Por isso a leitura é por TRECHO, não por linha.

// Todos os pares "número + texto" de um trecho. O lookahead é quem fecha o
// sabor: ele termina onde começa o próximo número, ou no fim do trecho.
// `[^\d]+?` de propósito — sabor com número no meio quebraria a conta, e é
// preferível não reconhecer a picotar errado.
const RE_PARES_ITEM = /(\d+)\s+([^\d]+?)(?=\s+\d+\s|\s*$)/g;

// Começa com número, com ou sem marcador na frente: é linha de itens.
const RE_COMECA_NUMERO = /^[•*\-–—]?\s*\d/;
// Marcador sem número: "• grape ice".
const RE_SO_BULLET = /^[•*\-–—]\s*(\S.*)$/;

// Formatação do Telegram sai antes de qualquer decisão: "*V500:*" tem que ser
// lido igual a "V500:".
function limparFormatacao(linha) {
  return String(linha || '').replace(/[*_`]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tira só lixo das PONTAS. O "+" fica: em "2 peach + 2 cherry strazz" ele faz
// parte do nome do primeiro sabor.
function limparSabor(s) {
  return String(s || '').replace(/^[\s.\-–—•]+/, '').replace(/[\s.\-–—•]+$/, '').trim();
}

// Tira marcador e dois-pontos do fim do nome do modelo.
function limparModelo(linha) {
  return limparNome(String(linha).replace(/^[•*\-–—]\s*/, '')).replace(/\s*:\s*$/, '').trim();
}

// Extrai os pares de um trecho e pendura no modelo corrente. Sem modelo, o
// trecho é descartado: não dá pra dizer de que produto ele é.
function itensDoTrecho(trecho, modelo) {
  if (!modelo) return [];
  const achados = [];
  // Regex nova a cada chamada: `g` compartilhado guarda lastIndex entre
  // chamadas e faria a segunda linha começar do meio.
  const re = new RegExp(RE_PARES_ITEM.source, 'g');
  let m;
  while ((m = re.exec(trecho)) !== null) {
    const qtd = parseInt(m[1], 10);
    const sabor = limparSabor(m[2]);
    if (qtd > 0 && sabor) achados.push({ modelo, sabor, qtd });
  }
  return achados;
}

// Devolve [{ modelo, sabor, qtd }]. Sabor antes do primeiro modelo é
// descartado: sem modelo não dá pra dizer de que produto ele é.
function parseListaTraducao(texto) {
  const itens = [];
  let modelo = null;

  for (const bruta of String(texto || '').split('\n')) {
    const linha = limparFormatacao(bruta);
    if (!linha || RE_SEPARADOR.test(linha)) continue;
    // Ruído ANTES de tudo: "PROMOÇÃO: leve 10 por R$ 250" tem dois-pontos e
    // viraria um modelo com um item de 10 unidades.
    if (ehRuidoFornecedor(linha, RE_BULLET.test(linha))) continue;

    // "BC10k TOUCH: 2 blueberry 2 OMG" — modelo e itens na mesma linha. Só
    // vale quando o que vem antes dos dois-pontos não começa com número.
    const corte = linha.indexOf(':');
    if (corte > 0) {
      const antes = linha.slice(0, corte).trim();
      const depois = linha.slice(corte + 1).trim();
      if (antes && !RE_COMECA_NUMERO.test(antes)) {
        const nome = limparModelo(antes);
        if (nome) modelo = nome;
        if (depois) itens.push(...itensDoTrecho(depois, modelo));
        continue;
      }
    }

    if (RE_COMECA_NUMERO.test(linha)) {
      itens.push(...itensDoTrecho(linha, modelo));
      continue;
    }

    // Bullet sem número embaixo de um modelo: sabor de quantidade 1. É a
    // exceção da regra acima — "• grape ice" logo abaixo de um modelo é sabor,
    // não um modelo novo.
    const mBullet = modelo && linha.match(RE_SO_BULLET);
    if (mBullet) {
      const sabor = limparSabor(limparNome(mBullet[1]));
      if (sabor) itens.push({ modelo, sabor, qtd: 1 });
      continue;
    }

    // Sobrou: linha inteira é nome de modelo — mesmo com número no meio
    // ("BC10k TOUCH", "V300 slim").
    const nome = limparModelo(linha);
    if (nome) modelo = nome;
  }
  return itens;
}

// Quebra as linhas em blocos de código de até `max`, sem cortar um item.
// Bloco de código porque no celular um toque copia o conteúdo inteiro — e o
// ponto do comando é justamente colar no outro grupo.
function blocosCodigo(linhas, max = 3800) {
  const blocos = [];
  let buf = [];
  let tam = 0;
  for (const linha of linhas) {
    // +1 da quebra de linha, +8 da cerca ```\n ... \n```
    if (buf.length && tam + linha.length + 1 + 8 > max) {
      blocos.push('```\n' + buf.join('\n') + '\n```');
      buf = []; tam = 0;
    }
    buf.push(linha);
    tam += linha.length + 1;
  }
  if (buf.length) blocos.push('```\n' + buf.join('\n') + '\n```');
  return blocos;
}

const USO_TRADUZIR =
  'Cole a lista do fornecedor junto com o comando:\n\n`/traduzir`\n`V500:`\n`2 green apple`\n`1 grape ice`';

async function handleTraduzir(chatId, texto) {
  const itens = parseListaTraducao(texto);
  if (!itens.length) {
    await sendTelegram(chatId, `🤔 Não achei nenhum item nessa lista.\n${USO_TRADUZIR}`);
    return;
  }

  let r = null;
  try {
    r = await callRpc('bot_traduzir_lista', { p_token: BOT_SYNC_TOKEN, p_itens: itens });
  } catch (err) {
    console.error('bot_traduzir_lista:', err.message);
    await sendTelegram(chatId, rpcAusente(err.message)
      ? '⚠️ A RPC `bot_traduzir_lista` não existe no banco — falta rodar o SQL da tradução.'
      : '⚠️ Erro ao traduzir a lista. Tente de novo em instantes.');
    return;
  }
  if (!r || r.ok === false) {
    await sendTelegram(chatId, `⚠️ ${(r && (r.erro || r.msg)) || 'Não consegui traduzir a lista.'}`);
    return;
  }

  const reconhecidos = Array.isArray(r.itens) ? r.itens : [];
  const faltantes = Array.isArray(r.faltantes) ? r.faltantes : [];

  // Cabeçalho, blocos e rodapé saem em mensagens SEPARADAS: no Telegram um
  // toque no bloco de código copia a mensagem toda, então tudo que não for
  // lista de colar tem que ficar fora dele.
  if (reconhecidos.length) {
    const casaram = Number(r.casaram ?? reconhecidos.length) || 0;
    const unidades = Number(r.unidades) || 0;
    await sendTelegram(chatId,
      `✅ *Lista pronta para o grupo de reposição*\n_${casaram} itens · ${unidades} unidades_`);

    for (const bloco of blocosCodigo(reconhecidos.map(it => String(it.linha ?? '')).filter(Boolean))) {
      await sendTelegram(chatId, bloco);
    }
  }

  const rodape = [];
  if (reconhecidos.length) rodape.push('_Copie o bloco acima e cole no grupo de REPOSIÇÃO._');
  if (faltantes.length) {
    if (rodape.length) rodape.push('');
    rodape.push('⚠️ *Não reconheci estes (confira o nome ou cadastre o produto):*');
    for (const f of faltantes) {
      rodape.push(`${f.qtd ?? 1} ${escapeMd(String(f.modelo ?? ''))} · ${escapeMd(String(f.sabor ?? ''))}`);
    }
  }
  if (!reconhecidos.length && !faltantes.length) {
    rodape.push('🤔 A lista foi lida, mas nenhum item voltou traduzido. Confira os nomes.');
  }
  if (rodape.length) await sendTelegram(chatId, rodape.join('\n'));
}

// ---------------------------------------------------------------------------
// Grupo de ATUALIZAÇÕES — lista de tarefas da equipe
//
// Pedidos como "atualizar foto no site" se perdiam no meio das conversas. Aqui
// cada um vira uma tarefa numerada, e a lista de pendentes fica SEMPRE fixada
// no topo do grupo: é ela que a equipe olha, não o histórico.
//
// Tudo passa pelas RPCs bot_tarefa_* / bot_tarefas_*: o bot não guarda tarefa
// nenhuma, só o texto da última mensagem fixada (pra não editar à toa).
//
// Listas e confirmações saem em HTML (negrito no número, itálico no "há
// quanto tempo"). O texto das tarefas é digitado pela equipe, então TODO ele
// passa por escHtml: um "<" ou "&" solto derrubaria o envio. HTML e não
// Markdown porque no HTML só esses três caracteres são especiais — "_" e "*"
// passam como estão. Avisos sem texto de tarefa continuam em texto puro.
// ---------------------------------------------------------------------------

const TAREFA_CMDS = new Set(['/nova', '/lista', '/feito', '/reabrir', '/apagar', '/feitas', '/instrucoes']);
const CRON_LEMBRETE_TAREFAS = '0 10-23 * * *';
const LIMITE_TELEGRAM = 4096;

const INSTRUCOES_TAREFAS = [
  '📋 COMO USAR O GRUPO DE ATUALIZAÇÕES',
  '',
  '/nova <texto> → anota uma tarefa. Ex: /nova trocar foto do V500 no site',
  'Várias de uma vez: uma por linha, no mesmo /nova',
  'Responder uma mensagem com /nova → transforma aquela mensagem em tarefa',
  '/lista → mostra o que está pendente',
  '/feito <número> → marca como concluída. Dá para várias: /feito 12 15 18',
  '/feitas → mostra as últimas concluídas',
  '/reabrir <número> → volta uma tarefa para a lista',
  '/apagar <número> → remove uma tarefa criada por engano',
  '',
  'A lista atualizada fica sempre fixada no topo do grupo.',
].join('\n');

const RODAPE_TAREFAS = '✅ Concluir: /feito 1   ➕ Nova: /nova texto';

// Chamada crua à API do Telegram: devolve o JSON ({ ok, result, description })
// em vez de lançar, porque aqui o motivo da falha decide o que fazer (editar
// deu "not modified" = sucesso; mensagem sumiu = manda outra).
async function telegramApi(metodo, corpo) {
  const fetch = (await import('node-fetch')).default;
  try {
    const resp = await fetch(`${TELEGRAM_API}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const texto = await resp.text();
    let data = null;
    try { data = texto ? JSON.parse(texto) : null; } catch (_) { /* não-JSON */ }
    if (!data) data = { ok: resp.ok, description: texto.slice(0, 200) };
    if (!resp.ok) data.ok = false;
    return data;
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Volta do HTML pro texto que a pessoa leria — só pro reenvio de emergência.
function htmlParaTexto(html) {
  return String(html).replace(/<\/?[bi]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Quebra nos blocos (linha em branco entre tarefas), nunca no meio de uma
// tarefa. Se o Telegram recusar o HTML, manda o mesmo conteúdo sem formatação
// em vez de ficar mudo.
async function enviarHtml(chatId, html) {
  for (const parte of dividirBlocos(String(html).split('\n\n'))) {
    const r = await telegramApi('sendMessage', { chat_id: chatId, text: parte, parse_mode: 'HTML' });
    if (r.ok) continue;
    console.error(`tarefas: sendMessage HTML falhou: ${r.description || ''}`);
    const r2 = await telegramApi('sendMessage', { chat_id: chatId, text: htmlParaTexto(parte) });
    if (!r2.ok) console.error(`tarefas: sendMessage texto puro falhou: ${r2.description || ''}`);
  }
}

async function enviarTextoPuro(chatId, texto) {
  for (const parte of splitMessage(texto)) {
    const r = await telegramApi('sendMessage', { chat_id: chatId, text: parte });
    if (!r.ok) console.error(`tarefas: sendMessage falhou: ${r.description || ''}`);
  }
}

// --- Qual é o grupo --------------------------------------------------------

// O webhook pergunta isso em TODA mensagem: cache curto, como o lerConfig.
let cacheGrupoTarefas = null; // { at, grupo }

async function estadoTarefas(grava) {
  const body = { p_token: BOT_SYNC_TOKEN };
  if (grava) Object.assign(body, grava);
  const d = await callRpc('bot_tarefas_estado', body);
  if (!d || d.ok === false) throw new Error((d && d.erro) || 'bot_tarefas_estado falhou');
  const grupo = d.grupo == null ? '' : String(d.grupo).trim();
  cacheGrupoTarefas = { at: Date.now(), grupo };
  return { grupo, msgFixada: d.msg_fixada == null ? null : Number(d.msg_fixada) };
}

// Nunca lança: banco fora do ar = grupo desconhecido (e o bot fica quieto lá).
async function chatAtualizacoes() {
  if (cacheGrupoTarefas && Date.now() - cacheGrupoTarefas.at < CONFIG_TTL_MS) return cacheGrupoTarefas.grupo;
  try {
    return (await estadoTarefas()).grupo;
  } catch (err) {
    console.error('bot_tarefas_estado:', err.message);
    cacheGrupoTarefas = { at: Date.now(), grupo: '' };
    return '';
  }
}

async function handleSetGrupoAtualizacoes(chatId, text, from) {
  if (!ehDono(from && from.id)) return;
  const arg = (text || '').trim().split(/\s+/)[1];
  const alvo = arg ? arg.trim() : String(chatId);
  if (!/^-?\d+$/.test(alvo)) {
    await enviarTextoPuro(chatId, 'Uso: /setgrupoatualizacoes (no grupo desejado) ou /setgrupoatualizacoes -1001234567890');
    return;
  }
  try {
    await estadoTarefas({ p_grupo: Number(alvo) });
  } catch (err) {
    console.error('bot_tarefas_estado (gravar):', err.message);
    await enviarTextoPuro(chatId, '⚠️ Não consegui gravar o grupo de atualizações. Tente de novo em instantes.');
    return;
  }
  // Grupo novo: a fixada antiga (se houver) é de outro chat.
  ultimaFixada = null;
  await enviarTextoPuro(chatId, `✅ Grupo de atualizações definido: ${alvo}\nMande /instrucoes para ver como usar.`);
  await atualizarFixadaAvisando(chatId);
}

// --- Formatação ------------------------------------------------------------

// Tarefa com várias linhas vira uma só na lista: a lista é pra bater o olho.
function textoUmaLinha(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Dia da loja (YYYY-MM-DD) de um timestamp — mesma régua do "hoje".
function diaSP(iso) {
  return iso ? diaLojaISO(iso) : '';
}

// "hoje", "ontem", "há 3 dias". Por DIA e não por hora de propósito: a lista
// fixada só é reescrita quando algo muda, e "há 2 h" envelheceria errado.
function haQuanto(iso, hoje = hojeISO()) {
  const dia = diaSP(iso);
  if (!dia) return '';
  const dias = Math.round((Date.parse(hoje) - Date.parse(dia)) / 864e5);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  return `há ${dias} dias`;
}

// Bloco HTML de uma tarefa: número em negrito, texto, e embaixo, em itálico,
// há quanto tempo foi anotada e por quem.
//   <b>12.</b> Trocar foto do V500
//   <i>anotada hoje · Dedé</i>
function blocoTarefa(t, hoje) {
  const ha = haQuanto(t.criado_em, hoje);
  const quando = ha === 'hoje' || ha === 'ontem' ? `anotada ${ha}` : ha;
  const meta = [quando, t.criado_por].filter(Boolean).join(' · ');
  return `<b>${escHtml(t.id)}.</b> ${escHtml(textoUmaLinha(t.texto))}${meta ? `\n<i>${escHtml(meta)}</i>` : ''}`;
}

// Cabeçalho + blocos + rodapé (linha em branco entre cada um), cortando
// blocos do fim até caber no limite do Telegram.
function montarComCorte(cabecalho, blocos, rodape, max = LIMITE_TELEGRAM) {
  const juntar = (bs, resto) => [cabecalho, ...bs, ...(resto ? [resto] : []), rodape].join('\n\n');
  let texto = juntar(blocos);
  if (texto.length <= max) return texto;
  for (let n = blocos.length - 1; n >= 0; n--) {
    texto = juntar(blocos.slice(0, n), `<i>... e mais ${blocos.length - n} (use /lista)</i>`);
    if (texto.length <= max) return texto;
  }
  return texto.slice(0, max);
}

const SEM_PENDENTES = '✅ <b>Nenhuma atualização pendente</b>';

function cabecalhoPendentes(n) {
  return `📋 <b>ATUALIZAÇÕES PENDENTES</b> (${n})`;
}

function textoFixada(pendentes, hoje = hojeISO(), max = LIMITE_TELEGRAM) {
  if (!pendentes.length) return SEM_PENDENTES;
  return montarComCorte(
    cabecalhoPendentes(pendentes.length),
    pendentes.map(t => blocoTarefa(t, hoje)),
    RODAPE_TAREFAS,
    max,
  );
}

// "Fulano" — só o primeiro nome, que é como a equipe se chama no grupo.
function primeiroNome(from) {
  if (!from) return 'alguém';
  return (from.first_name || '').trim().split(/\s+/)[0] || (from.username ? `@${from.username}` : 'alguém');
}

// "/feito 12 15, #18" -> [12, 15, 18], sem repetir.
function parseNumerosTarefa(texto) {
  const resto = String(texto || '').replace(/^\/\S+/, '');
  const ids = (resto.match(/\d+/g) || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  return [...new Set(ids)];
}

function textoDoComando(texto) {
  return String(texto || '').replace(/^\/\S+[ \t]*/, '').trim();
}

// --- Lista fixada ----------------------------------------------------------

// Último texto que ESTA instância pôs na fixada. Só serve pra não editar à
// toa; depois de um restart é null, e aí o "message is not modified" do
// Telegram cobre o caso.
let ultimaFixada = null; // { grupo, msgId, texto }

// Uma atualização por vez: dois comandos juntos, sem isto, veriam os dois
// "não tem fixada" e mandariam duas listas.
let filaFixada = Promise.resolve();

function atualizarFixada() {
  const rodada = filaFixada.then(atualizarFixadaAgora, atualizarFixadaAgora);
  filaFixada = rodada.catch(() => {});
  return rodada;
}

// Devolve { ok, aviso? }. Nunca lança.
async function atualizarFixadaAgora() {
  try {
    const { grupo, msgFixada } = await estadoTarefas();
    if (!grupo) return { ok: false, aviso: '' };

    const d = await callRpc('bot_tarefa_lista', { p_token: BOT_SYNC_TOKEN });
    const pendentes = (d && Array.isArray(d.pendentes)) ? d.pendentes : [];
    const texto = textoFixada(pendentes);

    if (msgFixada) {
      if (ultimaFixada && ultimaFixada.grupo === grupo && ultimaFixada.msgId === msgFixada && ultimaFixada.texto === texto) {
        return { ok: true };
      }
      const r = await telegramApi('editMessageText', { chat_id: grupo, message_id: msgFixada, text: texto, parse_mode: 'HTML' });
      if (r.ok || /message is not modified/i.test(r.description || '')) {
        ultimaFixada = { grupo, msgId: msgFixada, texto };
        return { ok: true };
      }
      console.log(`tarefas: não deu pra editar a fixada ${msgFixada} (${r.description || '?'}) — mandando outra`);
    }

    const env = await telegramApi('sendMessage', { chat_id: grupo, text: texto, parse_mode: 'HTML', disable_notification: true });
    const novoId = env.ok && env.result && env.result.message_id;
    if (!novoId) {
      console.error(`tarefas: não consegui mandar a lista no grupo: ${env.description || '?'}`);
      return { ok: false, aviso: '⚠️ Não consegui publicar a lista no grupo de atualizações.' };
    }
    // Grava ANTES de fixar: se fixar falhar, a próxima rodada ainda edita esta
    // mensagem em vez de mandar mais uma.
    await estadoTarefas({ p_grupo: Number(grupo), p_msg_fixada: novoId });
    ultimaFixada = { grupo, msgId: novoId, texto };

    const pin = await telegramApi('pinChatMessage', { chat_id: grupo, message_id: novoId, disable_notification: true });
    if (!pin.ok) {
      console.error(`tarefas: não consegui fixar: ${pin.description || '?'}`);
      return { ok: true, aviso: '⚠️ Não consegui fixar a lista no topo — o bot precisa ser administrador do grupo (com permissão de fixar mensagens).' };
    }
    return { ok: true };
  } catch (err) {
    console.error('tarefas: atualizar fixada:', err.message);
    return { ok: false, aviso: '' };
  }
}

// Depois de um comando: atualiza a fixada e, se algo deu errado de um jeito
// que alguém precisa resolver (bot sem permissão), avisa quem mandou.
async function atualizarFixadaAvisando(chatId) {
  const r = await atualizarFixada();
  if (r && r.aviso) await enviarTextoPuro(chatId, r.aviso);
}

// --- Comandos --------------------------------------------------------------

// RPC que responde { ok:false, erro } ou lança: devolve { d } ou { erro }.
async function rpcTarefa(fn, body) {
  try {
    const d = await callRpc(fn, { p_token: BOT_SYNC_TOKEN, ...body });
    if (!d || d.ok === false) return { erro: (d && (d.erro || d.msg)) || 'não deu certo' };
    return { d };
  } catch (err) {
    console.error(`${fn}:`, err.message);
    return {
      erro: rpcAusente(err.message)
        ? `a função ${fn} não existe no banco — falta rodar o SQL das tarefas`
        : 'erro ao falar com o banco, tente de novo em instantes',
    };
  }
}

const MAX_TAREFAS_POR_MSG = 20;

// Cada linha vira uma tarefa: "/nova a\n/nova b" eram DUAS, e viravam uma só
// com "/nova b" no meio do texto. Tira de cada linha o "/nova" repetido e o
// marcador de lista ("-", "•", "*", "#", "1.", "1)"). O "1." só sai com
// espaço depois, pra "2.5k" não perder o número.
function linhasTarefa(texto) {
  return String(texto || '').split('\n')
    .map(l => l.trim()
      .replace(/^\/nova(@\S+)?(?=\s|$)/i, '').trim()
      .replace(/^(?:[-•*#]|\d+[.)](?=\s|$))\s*/, '').trim())
    .filter(Boolean);
}

async function handleNovaTarefa(chatId, msg, text) {
  let linhas = linhasTarefa(textoDoComando(text));
  const resp = msg.reply_to_message;
  if (!linhas.length && resp) linhas = linhasTarefa(resp.text || resp.caption || '');
  if (!linhas.length) {
    await enviarTextoPuro(chatId, 'Escreva a tarefa depois do comando. Ex: /nova trocar foto do V500 no site\n(ou responda uma mensagem com /nova)');
    return;
  }
  const excedentes = Math.max(0, linhas.length - MAX_TAREFAS_POR_MSG);
  linhas = linhas.slice(0, MAX_TAREFAS_POR_MSG);

  const from = msg.from || {};
  const criadas = [];
  let falha = '';
  // Uma chamada por linha, na ordem. Se uma falhar, para ali: as de baixo
  // ficam de fora e a resposta diz quais entraram.
  for (const texto of linhas) {
    const { d, erro } = await rpcTarefa('bot_tarefa_nova', {
      p_texto: texto, p_autor: primeiroNome(from), p_autor_id: from.id ?? null,
    });
    if (erro) { falha = erro; break; }
    criadas.push({ id: d.id, texto });
  }

  // Blocos separados por linha em branco: confirmação, depois os avisos.
  const saida = [];
  if (criadas.length === 1) {
    saida.push(`📌 <b>Tarefa ${escHtml(criadas[0].id)} anotada</b>\n${escHtml(criadas[0].texto)}`);
  } else if (criadas.length > 1) {
    saida.push([`📌 <b>${criadas.length} tarefas anotadas</b>`,
      ...criadas.map(t => `<b>${escHtml(t.id)}.</b> ${escHtml(t.texto)}`)].join('\n'));
  }
  if (falha) {
    const faltou = linhas.length - criadas.length;
    saida.push(escHtml(criadas.length
      ? `⚠️ ${faltou} não ${faltou === 1 ? 'foi anotada' : 'foram anotadas'}: ${falha}`
      : `⚠️ Não anotei: ${falha}`));
  }
  if (excedentes) {
    saida.push(`⚠️ Máximo de ${MAX_TAREFAS_POR_MSG} por mensagem: ${excedentes} ${excedentes === 1 ? 'linha ficou' : 'linhas ficaram'} de fora. Mande de novo só ${excedentes === 1 ? 'ela' : 'elas'}.`);
  }
  await enviarHtml(chatId, saida.join('\n\n'));
  // Fixada UMA vez, depois de todas.
  if (criadas.length) await atualizarFixadaAvisando(chatId);
}

async function handleListaTarefas(chatId) {
  const { d, erro } = await rpcTarefa('bot_tarefa_lista', {});
  if (erro) { await enviarTextoPuro(chatId, `⚠️ Não consegui ler a lista: ${erro}`); return; }
  const pendentes = Array.isArray(d.pendentes) ? d.pendentes : [];
  // /lista não corta: é o lugar pra ver tudo (a fixada manda pra cá).
  if (!pendentes.length) { await enviarHtml(chatId, SEM_PENDENTES); return; }
  const hoje = hojeISO();
  await enviarHtml(chatId,
    [cabecalhoPendentes(pendentes.length), ...pendentes.map(t => blocoTarefa(t, hoje)), RODAPE_TAREFAS].join('\n\n'));
}

async function handleFeito(chatId, msg, text) {
  const ids = parseNumerosTarefa(text);
  if (!ids.length) { await enviarTextoPuro(chatId, 'Diga o número. Ex: /feito 12 (ou várias: /feito 12 15 18)'); return; }
  const quem = primeiroNome(msg.from);
  const { d, erro } = await rpcTarefa('bot_tarefa_feito', { p_ids: ids, p_quem: quem });
  if (erro) { await enviarTextoPuro(chatId, `⚠️ Não marquei: ${erro}`); return; }

  const concluidas = Array.isArray(d.concluidas) ? d.concluidas : [];
  const faltam = Array.isArray(d.nao_encontradas) ? d.nao_encontradas : [];
  const blocos = concluidas.map(t =>
    `✅ <b>Tarefa ${escHtml(t.id)} concluída</b>\n${escHtml(textoUmaLinha(t.texto))}\n<i>por ${escHtml(quem)}</i>`);
  if (faltam.length) {
    blocos.push(`⚠️ Não encontrei pendente: ${faltam.map(escHtml).join(', ')} (não existe ou já foi concluída)`);
  }
  await enviarHtml(chatId, blocos.join('\n\n') || '⚠️ Nada foi marcado.');
  if (concluidas.length) await atualizarFixadaAvisando(chatId);
}

// /reabrir e /apagar: um número, mesma forma de resposta.
async function handleTarefaUnica(chatId, text, fn, verbo, emoji) {
  const [id] = parseNumerosTarefa(text);
  if (!id) { await enviarTextoPuro(chatId, `Diga o número. Ex: ${text.split(/\s+/)[0].split('@')[0]} 12`); return; }
  const { d, erro } = await rpcTarefa(fn, { p_id: id });
  if (erro) { await enviarTextoPuro(chatId, `⚠️ Tarefa ${id}: ${erro}`); return; }
  await enviarHtml(chatId, `${emoji} <b>Tarefa ${escHtml(d.id ?? id)} ${verbo}</b>\n${escHtml(textoUmaLinha(d.texto))}`);
  await atualizarFixadaAvisando(chatId);
}

// "28/09 14:30" em São Paulo.
function dataHoraCurta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

async function handleFeitas(chatId) {
  const { d, erro } = await rpcTarefa('bot_tarefas_feitas', { p_limite: 10 });
  if (erro) { await enviarTextoPuro(chatId, `⚠️ Não consegui ler as concluídas: ${erro}`); return; }
  const feitas = Array.isArray(d.feitas) ? d.feitas : [];
  if (!feitas.length) { await enviarTextoPuro(chatId, 'Nenhuma tarefa concluída ainda.'); return; }
  const blocos = feitas.map(t => {
    const meta = [t.feito_por, dataHoraCurta(t.feito_em)].filter(Boolean).join(' · ');
    return `<b>${escHtml(t.id)}.</b> ${escHtml(textoUmaLinha(t.texto))}${meta ? `\n<i>${escHtml(meta)}</i>` : ''}`;
  });
  await enviarHtml(chatId, ['📗 <b>ÚLTIMAS CONCLUÍDAS</b>', ...blocos].join('\n\n'));
}

async function handleComandoTarefa(chatId, cmd, text, msg) {
  if (cmd === '/nova') return handleNovaTarefa(chatId, msg, text);
  if (cmd === '/lista') return handleListaTarefas(chatId);
  if (cmd === '/feito') return handleFeito(chatId, msg, text);
  if (cmd === '/reabrir') return handleTarefaUnica(chatId, text, 'bot_tarefa_reabrir', 'reaberta', '↩️');
  if (cmd === '/apagar') return handleTarefaUnica(chatId, text, 'bot_tarefa_apagar', 'apagada', '🗑️');
  if (cmd === '/feitas') return handleFeitas(chatId);
  if (cmd === '/instrucoes') return enviarTextoPuro(chatId, INSTRUCOES_TAREFAS);
}

// --- Lembrete diário (10h) -------------------------------------------------
//
// Roda de hora em hora das 10h às 23h pelo mesmo motivo do lembrete dos chips
// (serviço dormindo às 10h não pode perder o dia). Quem garante que sai UMA
// vez por dia é o banco: bot_tarefas_lembrete só devolve enviar=true na
// primeira chamada do dia.

async function enviarLembreteTarefas() {
  const grupo = await chatAtualizacoes();
  if (!grupo) return false; // sem grupo não gasta o "enviar" do dia

  const l = await callRpc('bot_tarefas_lembrete', { p_token: BOT_SYNC_TOKEN });
  if (!l || l.ok === false || !l.enviar) return false;

  const d = await callRpc('bot_tarefa_lista', { p_token: BOT_SYNC_TOKEN });
  const pendentes = (d && Array.isArray(d.pendentes)) ? d.pendentes : [];
  if (pendentes.length) {
    const n = pendentes.length;
    const hoje = hojeISO();
    await enviarHtml(grupo, montarComCorte(
      `☀️ <b>Bom dia!</b> Tem ${n} ${n === 1 ? 'atualização esperando' : 'atualizações esperando'}:`,
      pendentes.map(t => blocoTarefa(t, hoje)),
      RODAPE_TAREFAS,
    ));
  }
  // Uma vez por dia a fixada é reescrita mesmo sem mudança: é o que mantém o
  // "há N dias" em dia.
  await atualizarFixada();
  return true;
}

const AJUDA = '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Pods por modelo (acompanhamentos separados)\n🔎 */estoque detalhado* — Com os sabores de cada modelo\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n📅 */semana* — Relatório da semana (auto: domingo 14h)\n♻️ */reposicao* — Reposição (30 min)\n💰 */comissao* — Comissão do mês\n🛵 */despesas* — Entregas/despesas do Rod no ciclo\n💵 */dinheiro* — Dinheiro em mãos no ciclo\n📋 */geral* — Painel do ciclo (comissão + despesas + dinheiro + acerto)\n➕ */adicionar N* — Soma N na comissão do ciclo (só o dono)\n\n➖ *Baixa (grupo de vendas):* `-1 Ignite 5500 Grape Ice`\n🏷️ *Atacado:* `-6 Elfbar 30000 Cherry atacado`, ou `/atacado` numa linha com o pedido colado embaixo\n↩️ *Desfazer atacado:* `/desatacado`\n💵 */caixa* — o que entrou de dinheiro hoje (ou `/caixa 15/09`)\n🛠️ */caixa corrigir* — lista numerada pra `/caixa apagar N` ou `/caixa valor N 235`\n📸 *Comprovante:* mande a foto/PDF no grupo de vendas que eu leio o valor\n➕ *Entrada (grupo de reposição):* `+1 Ignite 5500 Grape Ice`\n🛵 *Despesa do Rod:* `+25 ENTREGA` (ou `+18 UBER centro`)\n💵 *Dinheiro recebido:* `+100 DINHEIRO`\n↩️ *Estorno (lançou errado):* mesmo formato no negativo — `-25 ENTREGA`, `-50 DINHEIRO`\n\n📋 *Pedidos (grupo de pedidos):*\n`/fornecedor` — importar a lista do fornecedor\n`/apelido TE 30K = Elfbar 30000` — casar nome do fornecedor com o do sistema\n`/pedido` · `/pedido 15000` · `/pedido 15000 8` — montar a compra (só sugestão)\n`/traduzir` + a lista do fornecedor — devolve no formato da reposição (não dá entrada)\n\n💰 *Faturamento (grupo de faturamento):*\n`/faturamento` — resumo do mês (auto: 3h, o dia que fechou)\n`/faturamento 09/2026` — de um mês específico\n`/relatorio mes` — dia a dia do mês';

const vendasDoDia = {};

function registrarVenda(modelo, qtd) {
  const key = modelo || '(sem modelo)';
  vendasDoDia[key] = (vendasDoDia[key] || 0) + qtd;
  console.log(`[venda] +${qtd} ${key} | total dia: ${vendasDoDia[key]} | vendasDoDia=${JSON.stringify(vendasDoDia)}`);
}

function resetVendasDoDia() {
  for (const k of Object.keys(vendasDoDia)) delete vendasDoDia[k];
}

// `dia` (ISO) é o dia da loja que está fechando. Às 3h é o de ontem.
async function enviarResumoVendas(dia = ontemISO()) {
  const data = dia.split('-').reverse().join('/');
  const entries = Object.entries(vendasDoDia).sort((a, b) => b[1] - a[1]);
  const linhas = ['📊 *RESUMO DE VENDAS – 015 PODS*', data, ''];
  if (!entries.length) {
    linhas.push('Nenhuma venda registrada hoje.');
  } else {
    linhas.push('Saídas do dia:');
    let total = 0;
    for (const [modelo, qtd] of entries) {
      linhas.push(`📦 ${escapeMd(modelo)} — ${qtd} un`);
      total += qtd;
    }
    linhas.push('', `Total: *${total}* unidades saíram hoje`);
  }
  // Bloco final: comissão (com cabeçalho de FECHAMENTO no último dia do período)
  // e o caixa do dia — é o fechamento de dinheiro ao lado do de unidades.
  linhas.push('', await textoComissaoRelatorio(dia));
  linhas.push('', await textoCaixa(dia, { compacto: true }));
  await sendTelegram(VENDAS_CHAT_ID, linhas.join('\n'));
}

// Fechamento diário às 3h, quando o dia da loja vira. Pede os números do dia
// que ACABOU (ontem) e só depois zera o contador em memória — os dois juntos,
// num cron só: em crons separados, no mesmo minuto, a ordem não é garantida.
const CRON_RESUMO_VENDAS = '0 3 * * *';

cron.schedule(CRON_RESUMO_VENDAS, async () => {
  try { await enviarResumoVendas(ontemISO()); }
  catch (err) { console.error('Erro no resumo de vendas:', err); }
  finally {
    resetVendasDoDia();
    console.log('vendasDoDia resetado');
  }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule(CRON_FATURAMENTO, async () => {
  try { await enviarFaturamentoDiario(ontemISO()); }
  catch (err) { console.error('Erro no faturamento diário:', err); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule(CRON_LEMBRETE_CHIPS, async () => {
  try { await enviarLembreteChips(); }
  catch (err) { console.error('Erro no lembrete dos chips:', err); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule(CRON_LEMBRETE_TAREFAS, async () => {
  try { await enviarLembreteTarefas(); }
  catch (err) { console.error('Erro no lembrete das atualizações:', err); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule(CRON_RELATORIO_SEMANAL, async () => {
  try { await enviarRelatorioSemanal(); }
  catch (err) { console.error('Erro no relatório semanal:', err); }
}, { timezone: 'America/Sao_Paulo' });

const LEMBRETE_SEMANAL = '📸 *FECHAMENTO SEMANAL – 015 PODS*\nÉ terça-feira! Hora de atualizar as fotos do estoque.\n\nPor favor, envie a foto de cada modelo em estoque e depois mande /estoque para conferir a lista.';

cron.schedule('0 10 * * 2', async () => {
  try { await sendTelegram(VENDAS_CHAT_ID, LEMBRETE_SEMANAL); }
  catch (err) { console.error('Erro no lembrete semanal:', err); }
}, { timezone: 'America/Sao_Paulo' });

const KEEPALIVE_URL = 'https://zero15pods-bot.onrender.com/ping';

// Até 3h50: o fechamento das 3h precisa do serviço acordado.
cron.schedule('*/10 0-3,10-23 * * *', async () => {
  try {
    const fetch = (await import('node-fetch')).default;
    const resp = await fetch(KEEPALIVE_URL);
    console.log(`keepalive ${KEEPALIVE_URL} -> ${resp.status}`);
  } catch (err) {
    console.error('Erro no keepalive:', err.message);
  }
}, { timezone: 'America/Sao_Paulo' });

const processedIds = new Set();

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const msg = body.message || body.edited_message;
    if (!msg) return;

    const updateId = body.update_id;
    if (processedIds.has(updateId)) return;
    processedIds.add(updateId);
    if (processedIds.size > 1000) processedIds.clear();

    const chatId = msg.chat.id;
    const text = (msg.text || msg.caption || '').trim();
    // O `if (!text) return` desceu pra depois do gate: comprovante chega SEM
    // legenda, e parar aqui era ignorar a foto inteira.
    const cmd = text ? text.split(/\s+/)[0].toLowerCase().split('@')[0] : '';

    const chatKey = String(chatId);
    const fromId = msg.from && msg.from.id;

    // BOOTSTRAP: estes dois valem em QUALQUER chat, porque são o que permite
    // configurar um grupo que o bot ainda não atende. Seguros por serem só do
    // dono — chat aleatório não faz o bot falar sem ele.
    if (cmd === '/chatid') { await handleChatId(chatId, msg); return; }
    if (cmd === '/setgrupopedidos') {
      if (ehDono(fromId)) { await handleSetGrupoPedidos(chatId, text, msg.from); return; }
      return;
    }
    if (cmd === '/setgrupofaturamento') {
      if (ehDono(fromId)) { await handleSetGrupoFaturamento(chatId, text, msg.from); return; }
      return;
    }
    if (cmd === '/setgrupotraducao') {
      if (ehDono(fromId)) { await handleSetGrupoTraducao(chatId, text, msg.from); return; }
      return;
    }
    if (cmd === '/setgrupoatualizacoes') {
      if (ehDono(fromId)) { await handleSetGrupoAtualizacoes(chatId, text, msg.from); return; }
      return;
    }

    // Tarefas: valem no grupo de atualizações e no privado do dono; em
    // qualquer outro chat, nem são lidas. Mensagem EDITADA não conta: editar
    // um "/nova" criaria a mesma tarefa duas vezes.
    if (TAREFA_CMDS.has(cmd)) {
      const atualizacoesId = await chatAtualizacoes();
      const aqui = (!!atualizacoesId && chatKey === String(atualizacoesId)) ||
        (msg.chat.type === 'private' && ehDono(fromId));
      if (aqui && body.message) await handleComandoTarefa(chatId, cmd, text, msg);
      return;
    }

    // Os dois grupos, o privado do Lucas e o grupo de pedidos são atendidos;
    // o resto é ignorado.
    const pedidosId = await chatPedidos();
    const faturamentoId = await chatFaturamento();
    const traducaoId = await chatTraducao();
    const isVendas = chatKey === VENDAS_CHAT_ID;
    const isReposicao = chatKey === REPOSICAO_CHAT_ID;
    const isPrivadoLucas =
      msg.chat.type === 'private' && String(msg.from && msg.from.id) === LUCAS_USER_ID;
    const isPedidos = !!pedidosId && chatKey === String(pedidosId);
    const isFaturamento = !!faturamentoId && chatKey === String(faturamentoId);
    const isTraducao = !!traducaoId && chatKey === String(traducaoId);
    if (!isVendas && !isReposicao && !isPrivadoLucas && !isPedidos && !isFaturamento && !isTraducao) return;

    // Comprovante: foto/PDF no grupo de VENDAS.
    //   sem legenda          -> só o comprovante
    //   legenda de movimento -> a baixa E o comprovante, numa resposta só
    //                           (é o caso mais comum: o atendente manda a foto
    //                           já com a baixa escrita na legenda)
    //   legenda de comando   -> o comando manda; a foto é só anexo
    // Grupos de PEDIDOS e FATURAMENTO são só de comando: não mexem em estoque
    // nem em caixa. Sem esta barreira a baixa caía no galho do privado lá
    // embaixo (`permitidas`) e era processada como se fosse o grupo de vendas.
    const soComandos = isPedidos || isFaturamento || isTraducao;
    const recusaSoComandos = isPedidos
      ? '⛔ Esse grupo é só para montar pedido ao fornecedor. Baixa de estoque e comprovante vão no grupo de VENDAS.'
      : isTraducao
        ? '⛔ Esse grupo é só para traduzir a lista do fornecedor. Baixa de estoque e comprovante vão no grupo de VENDAS.'
        : '⛔ Esse grupo é só para os números do faturamento. Baixa de estoque e comprovante vão no grupo de VENDAS.';

    // Foto sem legenda de comando nesses grupos: recusa em vez de sumir calado.
    if (soComandos && arquivoComprovante(msg) && !cmd.startsWith('/')) {
      await sendTelegram(chatId, recusaSoComandos);
      return;
    }

    const temComprovante = !!(isVendas && arquivoComprovante(msg));
    if (temComprovante && !text) {
      await handleComprovante(chatId, msg);
      return;
    }

    if (!text) return;

    // A foto viaja junto pro fluxo de movimento; comando (/) não leva.
    // Exceção: legenda começando com "/atacado" — é o jeito de lançar atacado
    // que o /ajuda ensina, e o comprovante sumia calado justamente aí.
    const legendaAtacado = RE_CONTROLE_ATACADO.test(text);
    const msgComprovante = temComprovante && (!cmd.startsWith('/') || legendaAtacado) ? msg : null;

    // Onde /fornecedor, /apelido e /pedido valem.
    const pedidosAqui = podePedidos(chatKey, isPrivadoLucas, pedidosId);
    // Onde /faturamento e /relatorio mes valem.
    const faturamentoAqui = podeFaturamento(chatKey, isPrivadoLucas, faturamentoId);

    // A lista colada depois do /fornecedor vem ANTES de tudo: ela tem dezenas
    // de linhas em bullet, e várias começam com "-" — no fluxo normal a
    // primeira delas cairia direto na rota de baixa de estoque.
    if (!cmd.startsWith('/') && consumirFornecedorPendente(chatKey, fromId, text)) {
      await handleFornecedor(chatId, text, msg.from);
      return;
    }

    // No grupo de tradução, lista colada JÁ BASTA — é um grupo dedicado a isso.
    // Vem antes da rota de movimento porque item em bullet ("- 2 grape ice")
    // começa com "-" e cairia na baixa de estoque. Mensagem sem item nenhum
    // segue o fluxo normal (conversa fica quieta, comando funciona).
    if (isTraducao && !cmd.startsWith('/') && parseListaTraducao(text).length) {
      await handleTraduzir(chatId, text);
      return;
    }

    // "/atacado" (ou "atacado") numa linha própria é CABEÇALHO, não comando,
    // quando a mensagem traz itens embaixo. Era exatamente este o bug: o
    // comando vencia, as linhas de baixa sumiam SEM AVISO e o bot ainda ia
    // mexer na venda ANTERIOR — pedido não debitado e comissão marcada errada.
    const { controle: controleAtacado, linhas: linhasSemControle } = separarControleAtacado(text);
    const temItem = linhasSemControle.some(l => l.charAt(0) === '-' || l.charAt(0) === '+');

    // Movimentos com prefixo: cada grupo aceita só o seu sinal.
    //   VENDAS: só baixa (-). REPOSIÇÃO: só entrada (+). Privado: os dois.
    if (text.charAt(0) === '-' || text.charAt(0) === '+' || (controleAtacado && temItem)) {
      // Antes de qualquer parsing: nesses grupos nada de movimento é aceito —
      // nem baixa, nem entrada, nem despesa/dinheiro (que também usam "+").
      if (soComandos) { await sendTelegram(chatId, recusaSoComandos); return; }

      const todas = linhasSemControle;

      // Despesa ("+25 ENTREGA"), dinheiro ("+100 DINHEIRO") e os estornos dos
      // dois ("-25 ENTREGA", "-50 DINHEIRO") saem da fila ANTES do estoque: as
      // rotas dividem os prefixos "+" e "-", e sem isso o registro viraria
      // "produto não encontrado" (e ainda levaria bronca de grupo errado no
      // VENDAS). A lista de palavras é buscada UMA vez por mensagem.
      const palavras = await palavrasDespesa();
      const linhas = [];
      const registros = [];
      for (const l of todas) {
        const d = parseRegistroRod(l, palavras);
        if (d) registros.push(d); else linhas.push(l);
      }
      if (registros.length) {
        await handleRegistrosRod(chatId, registros, {
          chat_id: chatId, message_id: msg.message_id,
          user_id: fromId, nome: nomeAutor(msg.from),
        });
      }

      const baixas = linhas.filter(l => l.startsWith('-'));
      const entradas = linhas.filter(l => l.startsWith('+'));

      if (isVendas && entradas.length) {
        await sendTelegram(chatId, '➕ Reposição é no grupo de reposição. Aqui só venda (-).');
      }
      if (isReposicao && baixas.length) {
        await sendTelegram(chatId, '➖ Venda é no grupo de vendas. Aqui só reposição (+).');
      }

      const permitidas = isVendas ? baixas : isReposicao ? entradas : [...baixas, ...entradas];
      if (permitidas.length) {
        await handleMovimentos(chatId, permitidas, msg.message_id, controleAtacado, msgComprovante);
      } else if (msgComprovante) {
        // Nenhuma linha passou (regra de grupo, formato), mas a foto está aqui:
        // o comprovante não pode ser descartado junto.
        await handleComprovante(chatId, msg);
      } else if (controleAtacado && !registros.length) {
        // Mensagem com cabeçalho de atacado cujas linhas foram todas barradas
        // pela regra de grupo. Ficar calado aqui é como o bug original passou.
        await sendTelegram(chatId, '⚠️ Não processei nenhum item dessa mensagem (veja o aviso de grupo acima). Nada foi marcado como atacado.');
      }
      return;
    }

    // "/atacado" (ou "atacado") SOZINHO: correção da última venda.
    if (controleAtacado && !linhasSemControle.length) {
      await handleAtacado(chatId, msg.from);
      // Foto junto do "/atacado" sozinho: a correção é da venda anterior, mas
      // o comprovante é dinheiro que entrou — não pode sumir.
      if (msgComprovante) await handleComprovante(chatId, msgComprovante);
      return;
    }
    // Cabeçalho de atacado com texto que não é item nenhum: explicar, nunca
    // ficar mudo nem cair na venda anterior.
    if (controleAtacado) {
      await sendTelegram(chatId,
        '🤔 Não reconheci item nenhum nessa mensagem.\n' +
        'Pra lançar: `/atacado` e as linhas de baixa embaixo (`-2 Elfbar 30000 Cherry`).\n' +
        'Pra corrigir a última venda: mande `/atacado` sozinho.');
      if (msgComprovante) await handleComprovante(chatId, msgComprovante);
      return;
    }

    // Reposição: linha SEM prefixo que termina em número também é entrada
    // ("Elfbar 40000 ice king 5" = +5). Conversa normal é ignorada.
    if (isReposicao && !cmd.startsWith('/')) {
      const sintetizadas = text
        .split('\n')
        .map(parseLinhaReposicaoSemPrefixo)
        .filter(Boolean);
      if (sintetizadas.length) await handleMovimentos(chatId, sintetizadas, msg.message_id);
      return;
    }

    if (cmd === '/start' || cmd === '/ajuda') { await sendTelegram(chatId, AJUDA); return; }
    if (cmd === '/estoque') { await handleEstoque(chatId, text); return; }
    if (cmd === '/zerados') { await handleZerados(chatId); return; }
    if (cmd === '/baixo') { await handleBaixo(chatId); return; }
    // "/relatorio mes" é faturamento, não estoque — e por isso respeita o
    // grupo restrito em vez de responder onde o /relatorio normal responde.
    if (cmd === '/relatorio' && /^mes|^mês/i.test((text.split(/\s+/)[1] || ''))) {
      if (!faturamentoAqui) { await sendTelegram(chatId, '💰 Esse comando é no grupo de faturamento (ou no privado do dono).'); return; }
      for (const parte of await textosFaturamentoDetalhe(null)) await sendTelegram(chatId, parte);
      return;
    }
    if (cmd === '/relatorio') { await handleRelatorio(chatId); return; }
    if (cmd === '/semana') { await handleRelatorioSemanal(chatId); return; }
    if (cmd === '/reposicao') { await handleReposicao(chatId); return; }
    if (cmd === '/comissao') { await handleComissao(chatId); return; }
    if (cmd === '/despesas') { await handleListaRod(chatId, 'despesa'); return; }
    if (cmd === '/dinheiro') { await handleListaRod(chatId, 'dinheiro'); return; }
    if (cmd === '/geral') { await handleGeral(chatId); return; }
    if (cmd === '/fechamento') { await handleFechamentoParcial(chatId); return; }
    // /anular é liberado (registra o autor); /desanular e /refazerfechamento
    // continuam só do dono — a checagem é feita dentro dos handlers.
    if (cmd === '/anular') { await handleAnular(chatId, text, msg.from); return; }
    if (cmd === '/desanular') { await handleDesanular(chatId, text, fromId); return; }
    if (cmd === '/adicionar') { await handleAdicionar(chatId, text, msg.from); return; }
    if (cmd === '/refazerfechamento') { await handleRefazerFechamento(chatId, text, fromId); return; }
    if (cmd === '/atacado') { await handleAtacado(chatId, msg.from); return; }
    if (cmd === '/desatacado') { await handleDesatacado(chatId, msg.from); return; }
    if (cmd === '/traduzir') {
      if (!podeTraduzir(chatKey, isPrivadoLucas, traducaoId, pedidosId)) {
        await sendTelegram(chatId, '📋 Esse comando é no grupo de tradução, no de pedidos ou no privado do dono.');
        return;
      }
      await handleTraduzir(chatId, text.replace(/^\/traduzir(@\S+)?[ \t]*/i, ''));
      return;
    }
    if (cmd === '/caixa') { await handleCaixa(chatId, text, msg.from); return; }
    if (cmd === '/faturamento') {
      if (!faturamentoAqui) { await sendTelegram(chatId, '💰 Esse comando é no grupo de faturamento (ou no privado do dono).'); return; }
      await handleFaturamento(chatId, text);
      return;
    }
    // Aceita as duas grafias: o autocomplete do Telegram não oferece comando
    // com hífen, e quem lembra do nome digita do jeito que quiser.
    if (cmd === '/lembrete-teste' || cmd === '/lembreteteste') {
      await handleLembreteTeste(chatId, msg.from);
      return;
    }
    if (cmd === '/versao') { await handleVersao(chatId, fromId); return; }

    // Pedidos: só no grupo de pedidos e no privado do dono (enquanto a chave
    // não existir, valem onde forem chamados — ver podePedidos).
    if (cmd === '/fornecedor' || cmd === '/apelido' || cmd === '/pedido') {
      if (!pedidosAqui) {
        await sendTelegram(chatId, '📦 Esse comando é no grupo de pedidos (ou no privado do dono).');
        return;
      }
      if (cmd === '/apelido') { await handleApelido(chatId, text, msg.from); return; }
      if (cmd === '/pedido') { await handlePedido(chatId, text); return; }

      // /fornecedor: lista na mesma mensagem, ou arma a espera pela próxima.
      const lista = text.replace(/^\/fornecedor(@\S+)?[ \t]*/i, '');
      // Texto colado junto do comando é a lista, seja do tamanho que for. O
      // piso de linhas só vale pra mensagem SEGUINTE, que pode ser conversa.
      if (lista.trim()) { await handleFornecedor(chatId, lista, msg.from); return; }
      if (!ehDono(fromId)) { await sendTelegram(chatId, '⛔ Só o dono pode importar a lista do fornecedor.'); return; }
      armarFornecedorPendente(chatKey, fromId);
      await sendTelegram(chatId, '📋 Manda a lista do fornecedor na próxima mensagem (colada inteira). Expira em 10 min.');
      return;
    }

    // Nenhum comando bateu. Sem isso o bot fica MUDO em comando desconhecido —
    // que é exatamente como um deploy velho se disfarça de bug no código.
    // Só o dono é avisado, pra não encher os grupos com quem digita "/" à toa.
    if (cmd.startsWith('/') && ehDono(fromId)) {
      await sendTelegram(chatId, `❓ Comando não reconhecido: \`${escapeMd(cmd)}\`\n🔖 No ar: commit \`${COMMIT}\`\n\nDisponíveis: ${COMANDOS.join(' ')}`);
    }
  } catch (err) {
    console.error(err);
    try {
      const chatId = (req.body.message || req.body.edited_message || {}).chat?.id;
      if (chatId) await sendTelegram(chatId, `❌ Erro: ${err.message}`);
    } catch (err2) {
      // Aqui o bot fica mudo de verdade (nem o aviso de erro saiu): logar é a
      // única pista que sobra.
      console.error('falha ao avisar o chat sobre o erro:', err2.message);
    }
  }
});

app.get('/', (req, res) => res.send('015 Pods Bot online!'));
app.get('/ping', (req, res) => res.status(200).send('OK'));
// Mesma info do /versao do Telegram, checável com um curl (sem abrir o Render).
app.get('/versao', (req, res) => res.json({ commit: COMMIT, comandos: COMANDOS }));

// Só sobe o servidor quando executado direto (node index.js). Quando importado
// por um teste, expõe as funções internas sem iniciar o listener.
if (require.main === module) {
  if (!TELEGRAM_TOKEN) {
    console.error('ERRO: env var TELEGRAM_TOKEN não definida (Render > Environment). O bot não sobe sem ela.');
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
}

module.exports = {
  app,
  readEstoque,
  handleEstoque,
  palavrasNaoPods,
  ehAcompanhamento,
  ordenarSabores,
  porModeloOrdenado,
  handleZerados,
  handleBaixo,
  handleRelatorio,
  handleReposicao,
  handleComissao,
  handleRegistrosRod,
  handleListaRod,
  handleGeral,
  parseRegistroRod,
  palavrasDespesa,
  lerConfig,
  gravarConfig,
  _resetEstadoTeste,
  _esperarFixadaTeste,
  parseListaFornecedor,
  lerListaFornecedor,
  ligarAoCadastro,
  chaveNome,
  chavesModeloSistema,
  pareceListaFornecedor,
  podePedidos,
  parseArgsPedido,
  blocosPedido,
  dividirBlocos,
  handleFornecedor,
  handleApelido,
  handlePedido,
  montarFechamento,
  linhaAcerto,
  linhasQuebraAtacado,
  extrairAtacado,
  podeMarcarAtacado,
  handleAtacado,
  marcarVendasAtacado,
  descricaoVenda,
  handleDesatacado,
  separarControleAtacado,
  arquivoComprovante,
  legendaEhComando,
  parseJsonModelo,
  valorConfiavel,
  textoComprovante,
  handleComprovante,
  lerERegistrarComprovante,
  textoCaixa,
  handleCaixa,
  chatFaturamento,
  podeFaturamento,
  parseMesComando,
  refMesPedido,
  formatFaturamento,
  ehParcial,
  textoFaturamento,
  textosFaturamentoDetalhe,
  enviarFaturamentoDiario,
  CRON_FATURAMENTO,
  chatTraducao,
  podeTraduzir,
  parseListaTraducao,
  blocosCodigo,
  handleTraduzir,
  destinosLembrete,
  enviarLembreteChips,
  handleLembreteTeste,
  LEMBRETE_CHIPS,
  CRON_LEMBRETE_CHIPS,
  parseValorArg,
  diaLojaISO,
  hojeISO,
  ontemISO,
  CRON_RESUMO_VENDAS,
  fixoDoCiclo,
  periodoDoCiclo,
  handleFechamentoParcial,
  FIXO_MENSAL,
  chatAtualizacoes,
  textoFixada,
  escHtml,
  haQuanto,
  parseNumerosTarefa,
  atualizarFixada,
  enviarLembreteTarefas,
  INSTRUCOES_TAREFAS,
  CRON_LEMBRETE_TAREFAS,
  handleCaixaCorrigir,
  nomeAutor,
  fmtValor,
  handleRefazerFechamento,
  parseDataComando,
  handleAnular,
  handleDesanular,
  handleAdicionar,
  parseUnidadesComando,
  textoComissao,
  textoComissaoRelatorio,
  handleMovimentos,
  parseMovimentoLine,
  parseLinhaReposicaoSemPrefixo,
  enviarResumoVendas,
  handleRelatorioSemanal,
  enviarRelatorioSemanal,
  montarRelatorioSemanal,
  textoRelatorioSemanal,
  setaTendencia,
  CRON_RELATORIO_SEMANAL,
  mapResultado,
  buildResumoSingle,
  buildResumoMulti,
};
