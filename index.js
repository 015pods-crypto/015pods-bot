const express = require('express');
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = '8656191252:AAEYGvtP8lwHASzW-QZExYGkr2nArigm1ec';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz04ZZLcg2NHJK17--M-Tslk1U3pzBEzPAsW7gU4wCa-fuCEV5x0lkkalDKm0rjs-RJ/exec';

async function sendTelegram(chatId, text) {
  const fetch = (await import('node-fetch')).default;
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

async function callAppsScript(params) {
  const fetch = (await import('node-fetch')).default;
  const url = new URL(APPS_SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url.toString(), { redirect: 'follow' });
  return resp.json();
}

const SS_ID = '15eKhLTOovsix8Ep4nWVnh6UCBMstswLQDUfA9hDuII4';
const CHAT_GROUP_ID = '-4938589018';

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
    const cmd = text.split(' ')[0].toLowerCase();

    // BAIXA: começa com -
    if (text.charAt(0) === '-') {
      const match = text.match(/^-(\d+)\s+(.+)$/) || text.match(/^-(.+)$/);
      if (!match) return;
      const qtd = match[2] ? parseInt(match[1]) : 1;
      const desc = match[2] ? match[2].trim() : match[1].trim();
      const data = await callAppsScript({ action: 'baixa', desc, qtd });
      if (data.ok) {
        await sendTelegram(chatId, `✅ *Baixa registrada!*\n📦 ${data.modelo} – ${data.sabor}\n➖ Saiu: *${qtd}*\n📊 Restante: *${data.restante}*${data.restante === 0 ? '\n🔴 _Estoque zerado!_' : data.restante === 1 ? '\n🟡 _Estoque baixo!_' : ''}`);
      } else {
        await sendTelegram(chatId, `❌ ${data.msg || 'Produto não encontrado: "' + desc + '"'}`);
      }
      return;
    }

    // ENTRADA: começa com +
    if (text.charAt(0) === '+') {
      const match = text.match(/^\+(\d+)\s+(.+)$/);
      if (!match) { await sendTelegram(chatId, '❌ Use: `+1 Ignite 5500 Grape Ice`'); return; }
      const qtd = parseInt(match[1]);
      const desc = match[2].trim();
      const data = await callAppsScript({ action: 'entrada', desc, qtd });
      if (data.ok) {
        await sendTelegram(chatId, `✅ *Entrada registrada!*\n📦 ${data.modelo} – ${data.sabor}\n➕ Entrou: *${qtd}*\n📊 Total agora: *${data.total}*`);
      } else {
        await sendTelegram(chatId, `❌ ${data.msg || 'Produto não encontrado: "' + desc + '"'}`);
      }
      return;
    }

    // COMANDOS
    if (cmd === '/start' || cmd === '/ajuda') {
      await sendTelegram(chatId, '👋 *Bot de Estoque – 015 Pods*\n\n📦 */estoque* — Ver estoque\n🔴 */zerados* — Sem estoque\n🟡 */baixo* — Estoque = 1\n📊 */relatorio* — Resumo\n\n➖ *Baixa:* `-1 Ignite 5500 Grape Ice`\n➕ *Entrada:* `+1 Ignite 5500 Grape Ice`');
      return;
    }

    if (['/estoque', '/zerados', '/baixo', '/relatorio'].includes(cmd)) {
      const data = await callAppsScript({ action: cmd.replace('/', '') });
      if (data.msg) await sendTelegram(chatId, data.msg);
      return;
    }

  } catch (err) {
    console.error(err);
  }
});

app.get('/', (req, res) => res.send('015 Pods Bot online!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot rodando na porta ${PORT}`));
