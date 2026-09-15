const express = require('express');
const cron = require('node-cron');

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
    for (const s of grupo.sabores || []) {
      produtos.push({
        modelo,
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

  // Dispara a leitura do comprovante JÁ, sem await: ela corre junto com as RPCs
  // de estoque em vez de somar a latência do Gemini na frente da baixa.
  const lendoComprovante = msgComprovante
    ? lerERegistrarComprovante(chatId, msgComprovante).catch(err => {
        // Rede de segurança: a baixa não pode cair por causa da foto.
        console.error('comprovante junto da baixa:', err.message);
        return PEDE_VALOR;
      })
    : null;

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

  if (lendoComprovante) {
    const texto = await lendoComprovante;
    if (texto) linhasMsg.push('', texto);
  }

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

function totaisPorModelo(produtos) {
  const map = new Map();
  for (const p of produtos) {
    const modelo = p.modelo || '(sem modelo)';
    map.set(modelo, (map.get(modelo) || 0) + p.qtd);
  }
  return map;
}

async function handleEstoque(chatId) {
  const produtos = await readEstoque();
  if (!produtos.length) { await sendTelegram(chatId, '📦 Estoque vazio.'); return; }
  const totais = totaisPorModelo(produtos);
  const ordenado = [...totais.entries()].sort((a, b) => b[1] - a[1]);
  const linhas = ['📦 *Estoque atual* (por modelo)', ''];
  let totalGeral = 0;
  for (const [modelo, total] of ordenado) {
    const ico = total <= 0 ? '🔴' : total <= 5 ? '🟡' : '🟢';
    linhas.push(`${ico} *${escapeMd(modelo)}*: ${total}`);
    totalGeral += total;
  }
  linhas.push('', `🧮 Total geral: *${totalGeral}*`);
  await sendTelegram(chatId, linhas.join('\n'));
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
// `mes` é o período ("20/07 → 19/08"); `fecha_hoje` = último dia do período.
async function dadosComissao() {
  try {
    const d = await callRpc('bot_comissao', { p_token: BOT_SYNC_TOKEN });
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
async function textoComissaoRelatorio() {
  const d = await dadosComissao();
  if (!d) return '⚠️ Erro ao consultar comissão.';
  if (d.fecha_hoje) {
    return montarFechamento(d, await dadosRegistrosRod(), await dadosRegistrosRod(null, 'dinheiro'));
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

// Fechamento = comissão + despesas do Rod + dinheiro em mãos do mesmo ciclo.
// `desp`/`dinh` null = a RPC falhou: o total NÃO é somado e o texto avisa,
// porque um total silenciosamente menor viraria pagamento errado.
// `opts` troca título/rodapé — é como o /refazerfechamento publica a correção
// sem se passar por um fechamento novo.
function montarFechamento(d, desp, dinh, opts = {}) {
  const comissao = Number(d.comissao) || 0;
  const titulo = opts.titulo || `🔒 *FECHAMENTO DO PERÍODO ${escapeMd(String(d.mes ?? ''))}*`;
  const rodape = opts.rodape || '_(amanhã começa o novo período)_';
  const quebra = linhasQuebraAtacado(d);
  const linhas = [
    titulo,
    ...(quebra || [
      `Total: *${d.unidades_mes ?? 0}* produtos`,
      `Faixa final: R$ ${fmtBR(d.taxa_atual)}/produto`,
    ]),
    `💰 Comissão: *R$ ${fmtBR(comissao)}*`,
  ];
  let aPagar = null;
  if (!desp) {
    linhas.push('⚠️ _Não consegui somar as entregas/despesas do Rod — confira antes de pagar._');
  } else {
    const despesas = Number(desp.total) || 0;
    aPagar = comissao + despesas;
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
// `tipo`), amarrada ao ciclo vigente (21/mm → 20/mm+1, corte 20 às 23:59).
// Persistido no banco, nunca em memória: o Render reinicia o processo a
// qualquer momento.
// ---------------------------------------------------------------------------

// Lê o acumulado do ciclo (RPC bot_despesas_rod). Nunca lança: erro vira null.
// `ref` (ISO YYYY-MM-DD) consulta o ciclo de outra data — usado ao refazer um
// fechamento passado. `tipo` = 'despesa' (padrão) ou 'dinheiro'.
async function dadosRegistrosRod(ref, tipo) {
  try {
    const body = { p_token: BOT_SYNC_TOKEN };
    if (ref) body.p_ref = ref;
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
  if (comissao == null || despesas == null || dinheiro == null) {
    linhas.push('⚖️ *Acerto*: ⚠️ falta dado acima — não dá pra fechar a conta.');
  } else {
    linhas.push(linhaAcerto(dinheiro, comissao + despesas));
  }

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
  const anoCorrente = new Date()
    .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/')[2];
  const ano = m[3] || anoCorrente;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

async function handleRefazerFechamento(chatId, text, userId) {
  if (!ehDono(userId)) { await sendTelegram(chatId, '⛔ Só o dono pode refazer o fechamento.'); return; }
  const data = parseDataComando(text);
  if (!data) {
    await sendTelegram(chatId, 'Uso: /refazerfechamento 20/08 (data de corte do ciclo)');
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
    rodape: `_Novo corte: ${dia}/${mes} às 23:59. Substitui o fechamento anterior._`,
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

// Devolve [{ modelo, sabor }]. Sabor antes do primeiro modelo é descartado:
// sem modelo não dá pra dizer de que produto ele é.
function parseListaFornecedor(texto) {
  const itens = [];
  const vistos = new Set();
  let modelo = null;

  for (const bruta of String(texto || '').split('\n')) {
    const linha = bruta.trim();
    if (!linha || RE_SEPARADOR.test(linha)) continue;

    const ehBullet = RE_BULLET.test(linha);
    if (ehRuidoFornecedor(linha, ehBullet)) continue;

    if (RE_LINHA_MODELO.test(linha)) {
      const nome = limparNome(linha);
      if (nome) modelo = nome;
      continue;
    }

    if (ehBullet) {
      if (!modelo) continue;
      const sabor = limparNome(linha.replace(RE_BULLET, ''));
      if (!sabor) continue;
      const chave = `${modelo} ${sabor}`.toLowerCase();
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      itens.push({ modelo, sabor });
    }
  }
  return itens;
}

// Heurística de "isto é a lista, não conversa": lista de fornecedor tem dezenas
// de linhas. O piso alto é de propósito — mensagem curta solta no grupo não
// pode ser confundida com lista.
function pareceListaFornecedor(texto) {
  const t = String(texto || '');
  const linhas = t.split('\n').filter(l => l.trim()).length;
  return linhas >= 5 && t.length >= 200;
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

async function handleFornecedor(chatId, texto, from) {
  if (!ehDono(from && from.id)) {
    await sendTelegram(chatId, '⛔ Só o dono pode importar a lista do fornecedor.');
    return;
  }

  const itens = parseListaFornecedor(texto);
  if (!itens.length) {
    await sendTelegram(chatId,
      '❌ Não achei nenhum item nessa lista.\nA lista precisa ter os modelos marcados com \u{1F0CF} (ou \u{1F531}) e os sabores em `•`, `*` ou `-`.');
    return;
  }

  let r = null;
  try {
    r = await callRpc('bot_fornecedor_importar', { p_token: BOT_SYNC_TOKEN, p_itens: itens });
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

  // Contrato da RPC: { casaram, nao_casaram, modelos_novos[], sabores_novos[] }.
  // O total não vem pronto — é a soma dos dois contadores.
  const casaram = Number(r.casaram) || 0;
  const naoCasaram = Number(r.nao_casaram) || 0;
  const total = casaram + naoCasaram;
  const pct = total ? Math.round((casaram * 100) / total) : 0;
  const modelosNovos = Array.isArray(r.modelos_novos) ? r.modelos_novos : [];
  // sabores_novos vem truncado em 30; quem conta de verdade é o nao_casaram.
  const saboresNovos = Array.isArray(r.sabores_novos) ? r.sabores_novos : [];

  const linhas = [`✅ *Lista importada* — ${casaram} de ${total} itens casaram (${pct}%)`];

  if (modelosNovos.length) {
    linhas.push(`⚠️ Modelos que você não tem cadastrado: ${modelosNovos.map(rotuloItem).map(escapeMd).join(', ')}`);
  }
  if (naoCasaram) {
    const exemplos = saboresNovos.slice(0, 10).map(rotuloItem).map(escapeMd).join(' · ');
    const reticencia = saboresNovos.length > 10 || naoCasaram > saboresNovos.length ? ' …' : '';
    linhas.push(`⚠️ ${naoCasaram} sabores sem cadastro${exemplos ? ` (ex.: ${exemplos}${reticencia})` : ''}`);
  }
  if (modelosNovos.length || naoCasaram) linhas.push('', DICA_APELIDO);

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
  const arquivo = arquivoComprovante(msg);
  if (!arquivo) return null;

  if (arquivo.size > COMPROVANTE_MAX_BYTES) {
    return `📎 Esse arquivo é grande demais pra eu ler. ${PEDE_VALOR}`;
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
    return PEDE_VALOR;
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
    return rpcAusente(err.message)
      ? '⚠️ A RPC `bot_comprovante_registrar` não existe no banco — falta rodar o SQL do comprovante.'
      : `⚠️ Li R$ ${fmtBR(valor)}, mas não consegui registrar. Tente reenviar em instantes.`;
  }
  if (!r || r.ok === false) {
    const detalhe = r && (r.erro || r.msg);
    return `⚠️ ${detalhe || `Li R$ ${fmtBR(valor)}, mas não consegui registrar.`}`;
  }

  return textoComprovante(r, valor);
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
// é o modo do resumo das 23:59, que já é uma mensagem longa. Nunca lança.
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

async function handleCaixa(chatId, text) {
  const arg = (text || '').trim().split(/\s+/)[1];
  if (arg && !parseDataComando(text)) {
    await sendTelegram(chatId, 'Uso: /caixa (hoje) ou /caixa 15/09');
    return;
  }
  await sendTelegram(chatId, await textoCaixa(parseDataComando(text)));
}

const AJUDA = '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Ver estoque\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n📅 */semana* — Relatório da semana (auto: domingo 14h)\n♻️ */reposicao* — Reposição (30 min)\n💰 */comissao* — Comissão do mês\n🛵 */despesas* — Entregas/despesas do Rod no ciclo\n💵 */dinheiro* — Dinheiro em mãos no ciclo\n📋 */geral* — Painel do ciclo (comissão + despesas + dinheiro + acerto)\n➕ */adicionar N* — Soma N na comissão do ciclo (só o dono)\n\n➖ *Baixa (grupo de vendas):* `-1 Ignite 5500 Grape Ice`\n🏷️ *Atacado:* `-6 Elfbar 30000 Cherry atacado`, ou `/atacado` numa linha com o pedido colado embaixo\n↩️ *Desfazer atacado:* `/desatacado`\n💵 */caixa* — o que entrou de dinheiro hoje (ou `/caixa 15/09`)\n📸 *Comprovante:* mande a foto/PDF no grupo de vendas que eu leio o valor\n➕ *Entrada (grupo de reposição):* `+1 Ignite 5500 Grape Ice`\n🛵 *Despesa do Rod:* `+25 ENTREGA` (ou `+18 UBER centro`)\n💵 *Dinheiro recebido:* `+100 DINHEIRO`\n↩️ *Estorno (lançou errado):* mesmo formato no negativo — `-25 ENTREGA`, `-50 DINHEIRO`\n\n📋 *Pedidos (grupo de pedidos):*\n`/fornecedor` — importar a lista do fornecedor\n`/apelido TE 30K = Elfbar 30000` — casar nome do fornecedor com o do sistema\n`/pedido` · `/pedido 15000` · `/pedido 15000 8` — montar a compra (só sugestão)';

const vendasDoDia = {};

function registrarVenda(modelo, qtd) {
  const key = modelo || '(sem modelo)';
  vendasDoDia[key] = (vendasDoDia[key] || 0) + qtd;
  console.log(`[venda] +${qtd} ${key} | total dia: ${vendasDoDia[key]} | vendasDoDia=${JSON.stringify(vendasDoDia)}`);
}

function resetVendasDoDia() {
  for (const k of Object.keys(vendasDoDia)) delete vendasDoDia[k];
}

async function enviarResumoVendas() {
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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
  linhas.push('', await textoComissaoRelatorio());
  linhas.push('', await textoCaixa(null, { compacto: true }));
  await sendTelegram(VENDAS_CHAT_ID, linhas.join('\n'));
}

cron.schedule('59 23 * * *', async () => {
  try { await enviarResumoVendas(); }
  catch (err) { console.error('Erro no resumo de vendas:', err); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 0 * * *', () => {
  resetVendasDoDia();
  console.log('vendasDoDia resetado');
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

cron.schedule('*/10 0-2,10-23 * * *', async () => {
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

    // Os dois grupos, o privado do Lucas e o grupo de pedidos são atendidos;
    // o resto é ignorado.
    const pedidosId = await chatPedidos();
    const isVendas = chatKey === VENDAS_CHAT_ID;
    const isReposicao = chatKey === REPOSICAO_CHAT_ID;
    const isPrivadoLucas =
      msg.chat.type === 'private' && String(msg.from && msg.from.id) === LUCAS_USER_ID;
    const isPedidos = !!pedidosId && chatKey === String(pedidosId);
    if (!isVendas && !isReposicao && !isPrivadoLucas && !isPedidos) return;

    // Comprovante: foto/PDF no grupo de VENDAS.
    //   sem legenda          -> só o comprovante
    //   legenda de movimento -> a baixa E o comprovante, numa resposta só
    //                           (é o caso mais comum: o atendente manda a foto
    //                           já com a baixa escrita na legenda)
    //   legenda de comando   -> o comando manda; a foto é só anexo
    const temComprovante = !!(isVendas && arquivoComprovante(msg));
    if (temComprovante && !text) {
      await handleComprovante(chatId, msg);
      return;
    }

    if (!text) return;

    // A foto viaja junto pro fluxo de movimento; comando (/) não leva.
    const msgComprovante = temComprovante && !cmd.startsWith('/') ? msg : null;

    // Onde /fornecedor, /apelido e /pedido valem.
    const pedidosAqui = podePedidos(chatKey, isPrivadoLucas, pedidosId);

    // A lista colada depois do /fornecedor vem ANTES de tudo: ela tem dezenas
    // de linhas em bullet, e várias começam com "-" — no fluxo normal a
    // primeira delas cairia direto na rota de baixa de estoque.
    if (!cmd.startsWith('/') && consumirFornecedorPendente(chatKey, fromId, text)) {
      await handleFornecedor(chatId, text, msg.from);
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
      return;
    }
    // Cabeçalho de atacado com texto que não é item nenhum: explicar, nunca
    // ficar mudo nem cair na venda anterior.
    if (controleAtacado) {
      await sendTelegram(chatId,
        '🤔 Não reconheci item nenhum nessa mensagem.\n' +
        'Pra lançar: `/atacado` e as linhas de baixa embaixo (`-2 Elfbar 30000 Cherry`).\n' +
        'Pra corrigir a última venda: mande `/atacado` sozinho.');
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
    if (cmd === '/estoque') { await handleEstoque(chatId); return; }
    if (cmd === '/zerados') { await handleZerados(chatId); return; }
    if (cmd === '/baixo') { await handleBaixo(chatId); return; }
    if (cmd === '/relatorio') { await handleRelatorio(chatId); return; }
    if (cmd === '/semana') { await handleRelatorioSemanal(chatId); return; }
    if (cmd === '/reposicao') { await handleReposicao(chatId); return; }
    if (cmd === '/comissao') { await handleComissao(chatId); return; }
    if (cmd === '/despesas') { await handleListaRod(chatId, 'despesa'); return; }
    if (cmd === '/dinheiro') { await handleListaRod(chatId, 'dinheiro'); return; }
    if (cmd === '/geral') { await handleGeral(chatId); return; }
    // /anular é liberado (registra o autor); /desanular e /refazerfechamento
    // continuam só do dono — a checagem é feita dentro dos handlers.
    if (cmd === '/anular') { await handleAnular(chatId, text, msg.from); return; }
    if (cmd === '/desanular') { await handleDesanular(chatId, text, fromId); return; }
    if (cmd === '/adicionar') { await handleAdicionar(chatId, text, msg.from); return; }
    if (cmd === '/refazerfechamento') { await handleRefazerFechamento(chatId, text, fromId); return; }
    if (cmd === '/atacado') { await handleAtacado(chatId, msg.from); return; }
    if (cmd === '/desatacado') { await handleDesatacado(chatId, msg.from); return; }
    if (cmd === '/caixa') { await handleCaixa(chatId, text); return; }
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
      if (pareceListaFornecedor(lista)) { await handleFornecedor(chatId, lista, msg.from); return; }
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
  parseListaFornecedor,
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
