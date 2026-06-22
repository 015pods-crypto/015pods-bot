const express = require('express');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = '8656191252:AAEYGvtP8lwHASzW-QZExYGkr2nArigm1ec';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SPREADSHEET_ID = '15eKhLTOovsix8Ep4nWVnh6UCBMstswLQDUfA9hDuII4';
const SHEET_NAME = 'Página1';
const CHAT_GROUP_ID = '-4938589018';
const DATA_RANGE = `${SHEET_NAME}!A2:C`;

let sheetsClient = null;

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw) throw new Error('GOOGLE_CREDENTIALS_JSON não definido');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
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

async function readEstoque() {
  const sheets = await getSheets();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: DATA_RANGE,
  });
  const rows = resp.data.values || [];
  return rows.map((row, idx) => ({
    rowIndex: idx + 2,
    modelo: (row[0] || '').toString().trim(),
    sabor: (row[1] || '').toString().trim(),
    qtd: parseInt(row[2], 10) || 0,
  })).filter(p => p.modelo || p.sabor);
}

async function batchUpdateQtd(updates) {
  if (!updates.length) return;
  const sheets = await getSheets();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates.map(({ rowIndex, qtd }) => ({
        range: `${SHEET_NAME}!C${rowIndex}`,
        values: [[qtd]],
      })),
    },
  });
}

function normalize(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(str) {
  return normalize(str).split(' ').filter(Boolean);
}

// Retorna { produto } se achou exatamente um, { ambiguous: true } se houver
// empate entre vários, ou null se não encontrou nada.
function findProduto(produtos, desc) {
  const qNorm = normalize(desc);
  const qTokens = tokens(desc);
  if (!qTokens.length) return null;

  // 1) MATCH EXATO — o sabor (ou nome completo) bate exatamente com o input.
  const exatos = produtos.filter(p => {
    const sabor = normalize(p.sabor);
    const full = normalize(`${p.modelo} ${p.sabor}`);
    return sabor === qNorm || full === qNorm;
  });
  if (exatos.length === 1) return { produto: exatos[0] };
  if (exatos.length > 1) return { ambiguous: true };

  // 2) MATCH PARCIAL — só se não houve match exato. Exige que TODAS as
  // palavras do input estejam no nome do produto (modelo + sabor).
  const parciais = [];
  for (const p of produtos) {
    const haySet = new Set(tokens(`${p.modelo} ${p.sabor}`));
    const todasPresentes = qTokens.every(t => haySet.has(t));
    if (todasPresentes) {
      // Menos palavras "extras" = match mais específico = score maior.
      const score = qTokens.length - (haySet.size - qTokens.length);
      parciais.push({ produto: p, score });
    }
  }
  if (!parciais.length) return null;

  const melhorScore = Math.max(...parciais.map(p => p.score));
  const topo = parciais.filter(p => p.score === melhorScore);
  // 3) Ambiguidade — mais de um produto com o mesmo score máximo.
  if (topo.length > 1) return { ambiguous: true };
  return { produto: topo[0].produto };
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

async function handleMovimentos(chatId, lines) {
  const parsed = lines.map(parseMovimentoLine).filter(Boolean);
  if (!parsed.length) return;

  const produtos = await readEstoque();
  const updates = [];
  const results = [];

  for (const item of parsed) {
    if (item.invalid) {
      const exemplo = item.op === 'entrada' ? '+1 Ignite 5500 Grape Ice' : '-1 Ignite 5500 Grape Ice';
      results.push({ op: item.op, ok: false, msg: `Formato inválido: \`${item.raw}\` — use \`${exemplo}\`` });
      continue;
    }
    const match = findProduto(produtos, item.desc);
    if (match && match.ambiguous) {
      results.push({ op: item.op, ok: false, msg: `Produto ambíguo: encontrei mais de um match para "${item.desc}". Seja mais específico.` });
      continue;
    }
    if (!match) {
      results.push({ op: item.op, ok: false, msg: `Produto não encontrado: "${item.desc}"` });
      continue;
    }
    const p = match.produto;
    if (item.op === 'baixa') {
      if (p.qtd <= 0) {
        results.push({ op: 'baixa', ok: false, msg: `${p.modelo} – ${p.sabor} já está zerado` });
        continue;
      }
      const novo = p.qtd - item.qtd;
      p.qtd = novo;
      updates.push({ rowIndex: p.rowIndex, qtd: novo });
      registrarVenda(p.modelo, item.qtd);
      results.push({ op: 'baixa', ok: true, modelo: p.modelo, sabor: p.sabor, qtd: item.qtd, restante: Math.max(novo, 0) });
    } else {
      const novo = p.qtd + item.qtd;
      p.qtd = novo;
      updates.push({ rowIndex: p.rowIndex, qtd: novo });
      results.push({ op: 'entrada', ok: true, modelo: p.modelo, sabor: p.sabor, qtd: item.qtd, restante: novo });
    }
  }

  await batchUpdateQtd(updates);
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
  if (!produtos.length) { await sendTelegram(chatId, '📦 Planilha vazia.'); return; }
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

const AJUDA = '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Ver estoque\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n\n➖ *Baixa:* `-1 Ignite 5500 Grape Ice`\n➕ *Entrada:* `+1 Ignite 5500 Grape Ice`';

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
  await sendTelegram(CHAT_GROUP_ID, linhas.join('\n'));
}

cron.schedule('50 23 * * *', async () => {
  try { await enviarResumoVendas(); }
  catch (err) { console.error('Erro no resumo de vendas:', err); }
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 0 * * *', () => {
  resetVendasDoDia();
  console.log('vendasDoDia resetado');
}, { timezone: 'America/Sao_Paulo' });

const LEMBRETE_SEMANAL = '📸 *FECHAMENTO SEMANAL – 015 PODS*\nÉ terça-feira! Hora de atualizar as fotos do estoque.\n\nPor favor, envie a foto de cada modelo em estoque e depois mande /estoque para conferir a lista.';

cron.schedule('0 10 * * 2', async () => {
  try { await sendTelegram(CHAT_GROUP_ID, LEMBRETE_SEMANAL); }
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

    if (text.charAt(0) === '-' || text.charAt(0) === '+') {
      const movLines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('-') || l.startsWith('+'));
      if (movLines.length) { await handleMovimentos(chatId, movLines); return; }
    }

    if (cmd === '/start' || cmd === '/ajuda') { await sendTelegram(chatId, AJUDA); return; }
    if (cmd === '/estoque') { await handleEstoque(chatId); return; }
    if (cmd === '/zerados') { await handleZerados(chatId); return; }
    if (cmd === '/baixo') { await handleBaixo(chatId); return; }
    if (cmd === '/relatorio') { await handleRelatorio(chatId); return; }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
