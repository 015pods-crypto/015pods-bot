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
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
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
    return [
      `🔒 *FECHAMENTO DO PERÍODO ${escapeMd(String(d.mes ?? ''))}*`,
      `Total: *${d.unidades_mes ?? 0}* produtos`,
      `Faixa final: R$ ${fmtBR(d.taxa_atual)}/produto`,
      `💰 Comissão a pagar: *R$ ${fmtBR(d.comissao)}*`,
      '_(amanhã começa o novo período)_',
    ].join('\n');
  }
  return formatComissao(d);
}

async function handleComissao(chatId) {
  await sendTelegram(chatId, await textoComissao());
}

const AJUDA = '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Ver estoque\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n♻️ */reposicao* — Reposição (30 min)\n💰 */comissao* — Comissão do mês\n\n➖ *Baixa (grupo de vendas):* `-1 Ignite 5500 Grape Ice`\n➕ *Entrada (grupo de reposição):* `+1 Ignite 5500 Grape Ice`';

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
    const isVendas = chatKey === VENDAS_CHAT_ID;
    const isReposicao = chatKey === REPOSICAO_CHAT_ID;
    const isPrivadoLucas =
      msg.chat.type === 'private' && String(msg.from && msg.from.id) === LUCAS_USER_ID;
    if (!isVendas && !isReposicao && !isPrivadoLucas) return;

    // Movimentos com prefixo: cada grupo aceita só o seu sinal.
    //   VENDAS: só baixa (-). REPOSIÇÃO: só entrada (+). Privado: os dois.
    if (text.charAt(0) === '-' || text.charAt(0) === '+') {
      const linhas = text.split('\n').map(l => l.trim());
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
    if (cmd === '/reposicao') { await handleReposicao(chatId); return; }
    if (cmd === '/comissao') { await handleComissao(chatId); return; }
  } catch (err) {
    console.error(err);
    try {
      const chatId = (req.body.message || req.body.edited_message || {}).chat?.id;
      if (chatId) await sendTelegram(chatId, `❌ Erro: ${err.message}`);
    } catch (_) {}
  }
});

app.get('/', (req, res) => res.send('015 Pods Bot online!'));
app.get('/ping', (req, res) => res.status(200).send('OK'));

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
  textoComissao,
  textoComissaoRelatorio,
  handleMovimentos,
  parseMovimentoLine,
  parseLinhaReposicaoSemPrefixo,
  enviarResumoVendas,
  mapResultado,
  buildResumoSingle,
  buildResumoMulti,
};
