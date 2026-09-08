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
  '/anular', '/desanular', '/refazerfechamento', '/versao',
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

// Cache da lista vinda do banco (~1 min). O fallback TAMBÉM é cacheado: desde
// que o "-" entrou na rota, toda linha de venda passa por aqui, e sem cachear a
// falha o bot pagaria um round-trip morto a cada baixa com o banco fora do ar.
// Recuperar em até 1 min é o mesmo prazo de uma palavra nova no config.
let cachePalavras = { at: 0, lista: null };
const PALAVRAS_TTL_MS = 60 * 1000;

async function palavrasDespesa() {
  if (cachePalavras.lista && Date.now() - cachePalavras.at < PALAVRAS_TTL_MS) {
    return cachePalavras.lista;
  }
  let lista = null;
  try {
    const d = await callRpc('bot_config', { p_token: BOT_SYNC_TOKEN, p_key: 'bot_despesa_palavras' });
    const csv = d && d.ok !== false ? String(d.valor ?? '') : '';
    const doBanco = csv.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    if (doBanco.length) lista = doBanco;
  } catch (err) {
    console.error('bot_config bot_despesa_palavras:', err.message);
  }
  cachePalavras = { at: Date.now(), lista: lista || PALAVRAS_DESPESA_PADRAO };
  return cachePalavras.lista;
}

// Só pro teste: como o cache agora guarda também o fallback, sem zerar ele
// entre casos o teste da lista do banco passaria sem nunca consultar o banco.
function _resetCachePalavras() {
  cachePalavras = { at: 0, lista: null };
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

function parseMovimentoLine(line) {
  const raw = line.trim();
  if (!raw) return null;
  const c = raw.charAt(0);
  if (c === '-') {
    const m = raw.match(/^-(\d+)\s+(.+)$/) || raw.match(/^-(.+)$/);
    if (!m) return null;
    const qtd = m[2] ? parseInt(m[1], 10) : 1;
    const desc = m[2] ? m[2].trim() : m[1].trim();
    if (!desc || !qtd || qtd <= 0) return { op: 'baixa', invalid: true, raw };
    return { op: 'baixa', qtd, desc, raw };
  }
  if (c === '+') {
    const m = raw.match(/^\+(\d+)\s+(.+)$/);
    if (!m) return { op: 'entrada', invalid: true, raw };
    const qtd = parseInt(m[1], 10);
    const desc = m[2].trim();
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
    return `✅ *Baixa registrada!*\n📦 ${r.modelo} – ${r.sabor}\n➖ Saiu: *${r.qtd}*\n📊 Restante: *${r.restante}*${aviso}`;
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
    for (const r of baixas) out.push(`📦 ${r.modelo} – ${r.sabor}: -${r.qtd} (restante: ${r.restante})`);
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
    return { ok: true, op, modelo: r.model, sabor: r.flavor, qtd: r.qty, restante: r.stock_after };
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

async function handleMovimentos(chatId, lines, messageId) {
  const parsed = lines.map(parseMovimentoLine).filter(Boolean);
  if (!parsed.length) return;

  // Linhas que o parser entendeu viram itens { produto, qty } para a RPC; qty
  // negativo = baixa, positivo = entrada. Linhas com formato inválido (sem dar
  // pra extrair produto/qtd) são respondidas localmente, sem ir à RPC.
  const items = [];
  const plan = [];
  for (const item of parsed) {
    if (item.invalid) {
      plan.push({ invalid: true, op: item.op, raw: item.raw });
    } else {
      plan.push({ op: item.op, itemIndex: items.length });
      items.push({ produto: item.desc, qty: item.op === 'baixa' ? -item.qtd : item.qtd });
    }
  }

  let resultados = [];
  if (items.length) {
    const data = await callRpc('bot_movimentar_estoque', {
      p_token: BOT_SYNC_TOKEN,
      p_items: items,
      p_meta: { chat_id: chatId, message_id: messageId },
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
    // Mantém o resumo diário de vendas (cron 23:50) funcionando: cada baixa ok
    // é registrada por modelo, como era feito na lógica antiga da planilha.
    if (mapped.ok && mapped.op === 'baixa') registrarVenda(mapped.modelo, mapped.qtd);
    results.push(mapped);
  }

  const msg = results.length === 1 ? buildResumoSingle(results[0]) : buildResumoMulti(results);
  await sendTelegram(chatId, msg);
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
function formatComissao(d) {
  const linhas = [
    `📊 *Comissão — ${escapeMd(String(d.mes ?? ''))}*`,
    `Hoje: *${d.unidades_hoje ?? 0}* produtos`,
    `Acumulado: *${d.unidades_mes ?? 0}* produtos`,
    `Faixa atual: R$ ${fmtBR(d.taxa_atual)}/produto`,
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
  const linhas = [
    titulo,
    `Total: *${d.unidades_mes ?? 0}* produtos`,
    `Faixa final: R$ ${fmtBR(d.taxa_atual)}/produto`,
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

const AJUDA = '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Ver estoque\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n📅 */semana* — Relatório da semana (auto: domingo 14h)\n♻️ */reposicao* — Reposição (30 min)\n💰 */comissao* — Comissão do mês\n🛵 */despesas* — Entregas/despesas do Rod no ciclo\n💵 */dinheiro* — Dinheiro em mãos no ciclo\n📋 */geral* — Painel do ciclo (comissão + despesas + dinheiro + acerto)\n\n➖ *Baixa (grupo de vendas):* `-1 Ignite 5500 Grape Ice`\n➕ *Entrada (grupo de reposição):* `+1 Ignite 5500 Grape Ice`\n🛵 *Despesa do Rod:* `+25 ENTREGA` (ou `+18 UBER centro`)\n💵 *Dinheiro recebido:* `+100 DINHEIRO`\n↩️ *Estorno (lançou errado):* mesmo formato no negativo — `-25 ENTREGA`, `-50 DINHEIRO`';

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
  // Bloco final: comissão (com cabeçalho de FECHAMENTO no último dia do período).
  linhas.push('', await textoComissaoRelatorio());
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
    if (!text) return;
    const cmd = text.split(/\s+/)[0].toLowerCase().split('@')[0];

    // Só os dois grupos e o privado do Lucas são atendidos; o resto é ignorado.
    const chatKey = String(chatId);
    const fromId = msg.from && msg.from.id;
    const isVendas = chatKey === VENDAS_CHAT_ID;
    const isReposicao = chatKey === REPOSICAO_CHAT_ID;
    const isPrivadoLucas =
      msg.chat.type === 'private' && String(msg.from && msg.from.id) === LUCAS_USER_ID;
    if (!isVendas && !isReposicao && !isPrivadoLucas) return;

    // Movimentos com prefixo: cada grupo aceita só o seu sinal.
    //   VENDAS: só baixa (-). REPOSIÇÃO: só entrada (+). Privado: os dois.
    if (text.charAt(0) === '-' || text.charAt(0) === '+') {
      const todas = text.split('\n').map(l => l.trim());

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
      if (permitidas.length) await handleMovimentos(chatId, permitidas, msg.message_id);
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
    if (cmd === '/refazerfechamento') { await handleRefazerFechamento(chatId, text, fromId); return; }
    if (cmd === '/versao') { await handleVersao(chatId, fromId); return; }

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
  _resetCachePalavras,
  montarFechamento,
  linhaAcerto,
  nomeAutor,
  fmtValor,
  handleRefazerFechamento,
  parseDataComando,
  handleAnular,
  handleDesanular,
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
