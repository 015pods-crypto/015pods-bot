const express = require('express');
const { google } = require('googleapis');

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

async function sendTelegram(chatId, text) {
  const fetch = (await import('node-fetch')).default;
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
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

async function updateQtd(rowIndex, qtd) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[qtd]] },
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

function scoreMatch(queryTokens, produto) {
  const haystack = normalize(`${produto.modelo} ${produto.sabor}`);
  const haySet = new Set(tokens(haystack));
  let hits = 0;
  for (const t of queryTokens) {
    if (haySet.has(t)) { hits += 1; continue; }
    if (haystack.includes(t)) hits += 0.5;
  }
  return hits;
}

function findProduto(produtos, desc) {
  const qTokens = tokens(desc);
  if (!qTokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const p of produtos) {
    const s = scoreMatch(qTokens, p);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (!best || bestScore < Math.max(1, qTokens.length * 0.5)) return null;
  return best;
}

async function handleBaixa(chatId, desc, qtd) {
  const produtos = await readEstoque();
  const p = findProduto(produtos, desc);
  if (!p) {
    await sendTelegram(chatId, `❌ Produto não encontrado: "${desc}"`);
    return;
  }
  if (p.qtd <= 0) {
    await sendTelegram(chatId, `⚠️ *${p.modelo} – ${p.sabor}* já está com estoque zerado.`);
    return;
  }
  const novoTotal = p.qtd - qtd;
  await updateQtd(p.rowIndex, novoTotal);
  const aviso = novoTotal <= 0 ? '\n🔴 _Estoque zerado!_' : novoTotal === 1 ? '\n🟡 _Estoque baixo!_' : '';
  await sendTelegram(chatId, `✅ *Baixa registrada!*\n📦 ${p.modelo} – ${p.sabor}\n➖ Saiu: *${qtd}*\n📊 Restante: *${Math.max(novoTotal, 0)}*${aviso}`);
}

async function handleEntrada(chatId, desc, qtd) {
  const produtos = await readEstoque();
  const p = findProduto(produtos, desc);
  if (!p) {
    await sendTelegram(chatId, `❌ Produto não encontrado: "${desc}"`);
    return;
  }
  const novoTotal = p.qtd + qtd;
  await updateQtd(p.rowIndex, novoTotal);
  await sendTelegram(chatId, `✅ *Entrada registrada!*\n📦 ${p.modelo} – ${p.sabor}\n➕ Entrou: *${qtd}*\n📊 Total agora: *${novoTotal}*`);
}

function agruparPorModelo(produtos) {
  const map = new Map();
  for (const p of produtos) {
    if (!map.has(p.modelo)) map.set(p.modelo, []);
    map.get(p.modelo).push(p);
  }
  return map;
}

async function handleEstoque(chatId) {
  const produtos = await readEstoque();
  if (!produtos.length) { await sendTelegram(chatId, '📦 Planilha vazia.'); return; }
  const grupos = agruparPorModelo(produtos);
  const linhas = ['📦 *Estoque atual*', ''];
  for (const [modelo, itens] of grupos) {
    const total = itens.reduce((s, i) => s + i.qtd, 0);
    linhas.push(`*${modelo}* — total ${total}`);
    for (const i of itens) {
      const ico = i.qtd <= 0 ? '🔴' : i.qtd === 1 ? '🟡' : '🟢';
      linhas.push(`  ${ico} ${i.sabor}: ${i.qtd}`);
    }
    linhas.push('');
  }
  await sendTelegram(chatId, linhas.join('\n').trim());
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
    const text = (msg.text || '').trim();
    if (!text) return;
    const cmd = text.split(' ')[0].toLowerCase().split('@')[0];

    if (text.charAt(0) === '-') {
      const m = text.match(/^-(\d+)\s+(.+)$/) || text.match(/^-(.+)$/);
      if (!m) return;
      const qtd = m[2] ? parseInt(m[1], 10) : 1;
      const desc = m[2] ? m[2].trim() : m[1].trim();
      await handleBaixa(chatId, desc, qtd);
      return;
    }

    if (text.charAt(0) === '+') {
      const m = text.match(/^\+(\d+)\s+(.+)$/);
      if (!m) { await sendTelegram(chatId, '❌ Use: `+1 Ignite 5500 Grape Ice`'); return; }
      const qtd = parseInt(m[1], 10);
      const desc = m[2].trim();
      await handleEntrada(chatId, desc, qtd);
      return;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
