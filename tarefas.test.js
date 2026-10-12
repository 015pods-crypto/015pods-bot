// Teste local do bot de TAREFAS. Telegram falso (captura o que o bot manda)
// e um Supabase falso que roda o db/tarefas.sql de verdade num Postgres em
// memória (PGlite): os testes cobrem o bot E as funções do banco.
//
// Rodar: node tarefas.test.js   (não precisa de rede nem de token real)

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const express = require('express');
const { ligar, segredoWebhook, parsePrazo, parseNumeros, ehDaPessoa, CAMINHO_WEBHOOK } = require('./tarefas');

const TOKEN = '424242:token-de-teste';
const GRUPO = -1001111;
const GRUPO2 = -1002222;
const FORA = -1009999;
const BOT_ID = 424242;
const ANA = { id: 1, first_name: 'Ana', last_name: 'Lima' };
const BRUNO = { id: 2, first_name: 'Bruno', username: 'brunao' };

const enviadas = [];      // { metodo, body } de cada chamada ao Telegram
let db = null;            // PGlite
let bancoFora = false;    // simula o Supabase fora do ar
let relogio = new Date('2026-10-11T12:00:00-03:00');

function servidor(handler) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => handler(req, raw, res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const responderJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function subirFalsos() {
  const telegram = await servidor((req, raw, res) => {
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    enviadas.push({ metodo: req.url.split('/').pop(), body });
    responderJson(res, 200, { ok: true, result: { message_id: 9000 + enviadas.length } });
  });

  // PostgREST de bolso: POST /rest/v1/rpc/fn {params} -> select fn(p => $1, ...)
  const supabase = await servidor(async (req, raw, res) => {
    if (bancoFora) { responderJson(res, 503, { message: 'fora do ar' }); return; }
    const fn = req.url.split('/').pop();
    const params = JSON.parse(raw || '{}');
    const nomes = Object.keys(params);
    const valores = nomes.map(k => (params[k] !== null && typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]));
    const args = nomes.map((k, i) => `${k} => $${i + 1}`).join(', ');
    try {
      const r = await db.query(`select public.${fn}(${args}) as r`, valores);
      responderJson(res, 200, r.rows[0].r);
    } catch (err) {
      const ausente = /does not exist/.test(err.message);
      responderJson(res, ausente ? 404 : 400, { message: ausente ? `Could not find the function public.${fn}` : err.message });
    }
  });

  const url = s => `http://127.0.0.1:${s.address().port}`;
  return { telegram: url(telegram), supabase: url(supabase), fechar: () => { telegram.close(); supabase.close(); } };
}

let updateId = 1;
let msgId = 100;
function msgDe(text, { from = ANA, chat = GRUPO, reply, photo, caption, thread } = {}) {
  const message = { message_id: ++msgId, from, chat: { id: chat, type: 'supergroup' }, date: 0 };
  if (text != null) message.text = text;
  if (caption != null) message.caption = caption;
  if (photo) message.photo = [{ file_id: 'foto-peq', file_size: 10 }, { file_id: photo, file_size: 999 }];
  if (reply) message.reply_to_message = reply;
  if (thread) { message.is_topic_message = true; message.message_thread_id = thread; }
  return message;
}

// Manda o update pelo webhook (com o segredo) e devolve o que o bot mandou.
async function mandar(ctx, message, { segredo = segredoWebhook(TOKEN), espera = true } = {}) {
  const antes = enviadas.length;
  const resp = await fetch(ctx.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': segredo },
    body: JSON.stringify({ update_id: updateId++, message }),
  });
  ctx.ultimoStatus = resp.status;
  if (!espera) { await new Promise(r => setTimeout(r, 150)); return enviadas.slice(antes); }
  const limite = Date.now() + 3000;
  while (enviadas.length === antes && Date.now() < limite) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(enviadas.length > antes, `sem resposta para: ${message.text || message.caption}`);
  return enviadas.slice(antes);
}
const texto = (env) => env.filter(e => e.metodo === 'sendMessage').map(e => e.body.text).join('\n');
// Mensagem do bot, pra testar "feito" respondendo a ela.
const doBot = (text) => ({ message_id: ++msgId, from: { id: BOT_ID, is_bot: true, first_name: 'Tarefas' }, chat: { id: GRUPO }, text });

const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

// ---------------------------------------------------------------------------

teste('sem TAREFAS_BOT_TOKEN o bot não liga (e não registra rota)', async () => {
  const app = express();
  assert.strictEqual(ligar(app, {}, { agendar: false }), null);
  assert.strictEqual(ligar(app, { TAREFAS_BOT_TOKEN: 'x:y' }, { agendar: false }), null, 'sem as outras variáveis também não');
});

teste('sem TAREFAS_GRUPOS o bot liga, mas só o /idgrupo responde', async () => {
  const app = express();
  const bot = ligar(app, { TAREFAS_BOT_TOKEN: '1:x', TAREFAS_SYNC_TOKEN: 's', SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'a' }, { agendar: false });
  assert.ok(bot, 'devia ligar');
});

teste('webhook sem o segredo certo é recusado e nada é processado', async (ctx) => {
  const env = await mandar(ctx, msgDe('/tarefa invasão'), { segredo: 'errado', espera: false });
  assert.strictEqual(ctx.ultimoStatus, 401);
  assert.strictEqual(env.length, 0);
  assert.strictEqual((await db.query('select count(*)::int n from tarefas_itens')).rows[0].n, 0);
});

teste('/idgrupo responde em qualquer chat, até fora dos autorizados', async (ctx) => {
  const env = await mandar(ctx, msgDe('/idgrupo', { chat: FORA }));
  assert.strictEqual(texto(env), `🆔 ID deste chat: <code>${FORA}</code>`);
});

teste('grupo não autorizado: /tarefa é ignorado', async (ctx) => {
  const env = await mandar(ctx, msgDe('/tarefa algo', { chat: FORA }), { espera: false });
  assert.strictEqual(env.length, 0);
  assert.strictEqual((await db.query('select count(*)::int n from tarefas_itens')).rows[0].n, 0);
});

teste('/tarefa registra com número, quem pediu e data; numeração por grupo', async (ctx) => {
  assert.strictEqual(texto(await mandar(ctx, msgDe('/tarefa Comprar fita <dupla>'))), '📌 <b>#1 registrada</b>\n<b>Comprar fita &lt;dupla&gt;</b>');
  assert.strictEqual(texto(await mandar(ctx, msgDe('/tarefa@TarefasBot Ligar pro contador', { from: BRUNO }))), '📌 <b>#2 registrada</b>\n<b>Ligar pro contador</b>');
  assert.strictEqual(texto(await mandar(ctx, msgDe('/tarefa Outro grupo', { chat: GRUPO2 }))), '📌 <b>#1 registrada</b>\n<b>Outro grupo</b>');
  const r = (await db.query(`select * from tarefas_itens where chat_id = $1 and numero = 1`, [String(GRUPO)])).rows[0];
  assert.strictEqual(r.pedido_por_nome, 'Ana Lima');
  assert.strictEqual(r.pedido_por_id, '1');
  assert.ok(r.criada_em, 'faltou a data');
});

teste('/tarefa sem texto mostra o uso', async (ctx) => {
  assert.ok(texto(await mandar(ctx, msgDe('/tarefa'))).startsWith('Uso:'));
});

teste('foto com legenda /tarefa guarda a foto maior', async (ctx) => {
  const env = await mandar(ctx, msgDe(null, { caption: '/tarefa Trocar a lâmpada', photo: 'foto-grande' }));
  assert.strictEqual(texto(env), '📌 <b>#1 registrada</b>\n<b>Trocar a lâmpada</b>');
  const r = (await db.query(`select foto_file_id from tarefas_itens where numero = 1`)).rows[0];
  assert.strictEqual(r.foto_file_id, 'foto-grande');
});

teste('/tarefa respondendo a uma mensagem usa o texto (e a foto) dela', async (ctx) => {
  const original = msgDe(null, { from: BRUNO, caption: 'O portão está quebrado', photo: 'foto-portao' });
  const env = await mandar(ctx, msgDe('/tarefa', { reply: original }));
  assert.strictEqual(texto(env), '📌 <b>#1 registrada</b>\n<b>O portão está quebrado</b>');
  const r = (await db.query(`select * from tarefas_itens where numero = 1`)).rows[0];
  assert.strictEqual(r.foto_file_id, 'foto-portao');
  assert.strictEqual(Number(r.origem_msg_id), original.message_id);
  assert.strictEqual(r.pedido_por_nome, 'Ana Lima', 'quem pediu é quem mandou o /tarefa');
});

// criada_em relativo ao relógio do teste (o banco usa o relógio de verdade).
async function criadaHa(numero, dias) {
  await db.query(`update tarefas_itens set criada_em = $1::timestamptz - make_interval(days => $2) where numero = $3`,
    [relogio.toISOString(), dias, numero]);
}

teste('/pendentes: atrasadas, abertas, sem responsável; título em negrito e detalhe embaixo', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa Primeira tarefa com um texto bem comprido que passa de sessenta caracteres fácil fácil'));
  await mandar(ctx, msgDe('/tarefa Segunda', { from: BRUNO }));
  await mandar(ctx, msgDe('/tarefa Terceira & <última>'));
  await mandar(ctx, msgDe('/tarefa Quarta'));
  await criadaHa(1, 4);
  await criadaHa(2, 1);
  await criadaHa(3, 0);
  await criadaHa(4, 2);
  await db.query(`update tarefas_itens set prazo = '2026-10-10', responsavel = 'Ana' where numero = 2`);
  await db.query(`update tarefas_itens set prazo = '2026-10-20', responsavel = 'Bruno' where numero = 4`);
  const t = texto(await mandar(ctx, msgDe('/pendentes')));
  assert.strictEqual(t, [
    '📋 <b>Pendentes (4)</b>',
    '',
    '⚠️ <b>Atrasadas (1)</b>',
    '',
    '#2 · <b>Segunda</b>',
    '<i>👤 Ana · 📅 10/10 (vencida) · há 1 dia · pedida por Bruno</i>',
    '',
    '📌 <b>Abertas (1)</b>',
    '',
    '#4 · <b>Quarta</b>',
    '<i>👤 Bruno · 📅 20/10 · há 2 dias · pedida por Ana Lima</i>',
    '',
    '<b>Sem responsável (2)</b>',
    '',
    '#1 · <b>Primeira tarefa com um texto bem comprido que passa de sess…</b>',
    '<i>há 4 dias · pedida por Ana Lima</i>',
    '',
    '#3 · <b>Terceira &amp; &lt;última&gt;</b>',
    '<i>hoje · pedida por Ana Lima</i>',
  ].join('\n'));
});

teste('/pendentes vazio', async (ctx) => {
  assert.strictEqual(texto(await mandar(ctx, msgDe('/pendentes'))), '🎉 Nenhuma tarefa aberta.');
});

teste('/feito 1 marca com quem fez e quando; repetir avisa; sai do /pendentes', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa Pagar boleto'));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/feito 1', { from: BRUNO }))), '✅ <b>#1 feita</b> por Bruno\n<b>Pagar boleto</b>');
  const r = (await db.query(`select * from tarefas_itens where numero = 1`)).rows[0];
  assert.strictEqual(r.status, 'feita');
  assert.strictEqual(r.feita_por_nome, 'Bruno');
  assert.ok(r.feita_em);
  assert.ok(texto(await mandar(ctx, msgDe('/feito #1'))).startsWith('ℹ️ #1 já estava feita por Bruno em '));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/pendentes'))), '🎉 Nenhuma tarefa aberta.');
});

teste('"feito" respondendo à confirmação do bot marca a tarefa', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa A'));
  await mandar(ctx, msgDe('/tarefa B'));
  const env = await mandar(ctx, msgDe('Feito!', { from: BRUNO, reply: doBot('📌 <b>#2 registrada</b>\n<b>B</b>') }));
  assert.strictEqual(texto(env), '✅ <b>#2 feita</b> por Bruno\n<b>B</b>');
  assert.strictEqual((await db.query(`select status from tarefas_itens where numero = 1`)).rows[0].status, 'aberta');
});

teste('"feito" respondendo à mensagem original da tarefa também marca', async (ctx) => {
  const original = msgDe('Precisa limpar a calha', { from: BRUNO });
  await mandar(ctx, msgDe('/tarefa', { reply: original }));
  assert.strictEqual(texto(await mandar(ctx, msgDe('feito', { reply: original }))), '✅ <b>#1 feita</b> por Ana Lima\n<b>Precisa limpar a calha</b>');
});

teste('"feito" respondendo a uma lista com várias tarefas pede o número', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa A'));
  await mandar(ctx, msgDe('/tarefa B'));
  const env = await mandar(ctx, msgDe('feito', { reply: doBot('📋 Pendentes (2)\n#1 · A\n#2 · B') }));
  assert.ok(texto(env).includes('mais de uma tarefa'), texto(env));
  assert.strictEqual((await db.query(`select count(*)::int n from tarefas_itens where status = 'feita'`)).rows[0].n, 0);
});

teste('"feito" sem responder a nada é só conversa: o bot fica quieto', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa A'));
  const env = await mandar(ctx, msgDe('feito'), { espera: false });
  assert.strictEqual(env.length, 0);
});

async function tresTarefas(ctx) {
  for (const t of ['A', 'B', 'C']) await mandar(ctx, msgDe(`/tarefa ${t}`));
}
const feitas = async () => (await db.query(`select numero from tarefas_itens where status = 'feita' order by numero`)).rows.map(r => r.numero);

teste('/feito 1 2 3: resposta única com a lista', async (ctx) => {
  await tresTarefas(ctx);
  const t = texto(await mandar(ctx, msgDe('/feito 1 2 3', { from: BRUNO })));
  assert.strictEqual(t, '✅ <b>3 tarefas feitas</b> por Bruno\n\n#1 · <b>A</b>\n#2 · <b>B</b>\n#3 · <b>C</b>');
  assert.deepStrictEqual(await feitas(), [1, 2, 3]);
});

teste('/feito 1,2,3 e /feito 1-3 também valem', async (ctx) => {
  await tresTarefas(ctx);
  assert.ok(texto(await mandar(ctx, msgDe('/feito 1,3'))).startsWith('✅ <b>2 tarefas feitas</b>'));
  assert.deepStrictEqual(await feitas(), [1, 3]);
  await mandar(ctx, msgDe('/reabrir 1-3'));
  assert.deepStrictEqual(await feitas(), []);
  assert.ok(texto(await mandar(ctx, msgDe('/feito 1 - 3'))).startsWith('✅ <b>3 tarefas feitas</b>'));
});

teste('/feito com número que não existe ou já feito: avisa só desses, faz os outros', async (ctx) => {
  await tresTarefas(ctx);
  await mandar(ctx, msgDe('/feito 2', { from: BRUNO }));
  const t = texto(await mandar(ctx, msgDe('/feito 1 2 3 9')));
  const linhas = t.split('\n');
  assert.strictEqual(linhas[0], '✅ <b>2 tarefas feitas</b> por Ana Lima');
  assert.strictEqual(linhas[2], '#1 · <b>A</b>');
  assert.strictEqual(linhas[3], '#3 · <b>C</b>');
  assert.strictEqual(linhas[5], '❓ Não achei: #9');
  assert.ok(linhas[6].startsWith('ℹ️ #2 já estava feita por Bruno em '), linhas[6]);
  assert.deepStrictEqual(await feitas(), [1, 2, 3]);
});

teste('responder com "feito 2 4" marca as duas', async (ctx) => {
  for (const t of ['A', 'B', 'C', 'D']) await mandar(ctx, msgDe(`/tarefa ${t}`));
  const lista = doBot('📋 Pendentes (4)\n#1 · A\n#2 · B\n#3 · C\n#4 · D');
  const t = texto(await mandar(ctx, msgDe('feito 2 4', { reply: lista })));
  assert.ok(t.startsWith('✅ <b>2 tarefas feitas</b>'), t);
  assert.deepStrictEqual(await feitas(), [2, 4]);
});

teste('/reabrir 1 2: várias de uma vez, avisando a que já estava aberta', async (ctx) => {
  await tresTarefas(ctx);
  await mandar(ctx, msgDe('/feito 1 2'));
  const t = texto(await mandar(ctx, msgDe('/reabrir 1 2 3')));
  assert.strictEqual(t, '🔄 <b>2 tarefas reabertas</b>\n\n#1 · <b>A</b>\n#2 · <b>B</b>\n\nℹ️ #3 já está aberta.');
  assert.deepStrictEqual(await feitas(), []);
});

teste('/feito com lixo nos números mostra o uso e não mexe em nada', async (ctx) => {
  await tresTarefas(ctx);
  for (const c of ['/feito 1 abc', '/feito 1-200']) {
    assert.ok(texto(await mandar(ctx, msgDe(c))).startsWith('Uso:'), c);
  }
  assert.deepStrictEqual(await feitas(), []);
});

teste('números: espaço, vírgula, # e intervalo; sem repetidos; limite de 50', async () => {
  assert.deepStrictEqual(parseNumeros('1 2 3'), [1, 2, 3]);
  assert.deepStrictEqual(parseNumeros('3,1,#2,3'), [3, 1, 2]);
  assert.deepStrictEqual(parseNumeros('5-3 9'), [3, 4, 5, 9]);
  assert.strictEqual(parseNumeros('1 x'), null);
  assert.strictEqual(parseNumeros('1-80'), null);
  assert.strictEqual(parseNumeros(''), null);
});

teste('/reabrir volta pra aberta; reabrir aberta avisa', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa A'));
  await mandar(ctx, msgDe('/feito 1'));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/reabrir 1'))), '🔄 <b>#1 reaberta</b>\n<b>A</b>');
  const r = (await db.query(`select * from tarefas_itens where numero = 1`)).rows[0];
  assert.strictEqual(r.status, 'aberta');
  assert.strictEqual(r.feita_por_nome, null);
  assert.strictEqual(texto(await mandar(ctx, msgDe('/reabrir 1'))), 'ℹ️ #1 já está aberta.');
});

teste('/pra define o responsável; /minhas mostra as com você e as que você pediu', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa Da Ana pro Bruno'));
  await mandar(ctx, msgDe('/tarefa Do Bruno', { from: BRUNO }));
  await mandar(ctx, msgDe('/tarefa Sem dono'));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/pra 1 @brunao'))), '👤 <b>#1</b> → @brunao\n<b>Da Ana pro Bruno</b>');
  const t = texto(await mandar(ctx, msgDe('/minhas', { from: BRUNO })));
  assert.ok(t.startsWith('🙋 <b>Suas tarefas (2)</b>'), t);
  assert.ok(t.includes('👤 <b>Com você (1)</b>\n\n#1 · <b>Da Ana pro Bruno</b>\n<i>👤 @brunao · '), t);
  assert.ok(t.includes('📝 <b>Pedidas por você (1)</b>\n\n#2 · <b>Do Bruno</b>'), t);
  assert.ok(!t.includes('Sem dono'), t);
  assert.ok(texto(await mandar(ctx, msgDe('/pra 1'))).startsWith('Uso:'));
});

teste('responsável casa por primeiro nome, nome completo ou @, sem acento', async () => {
  assert.ok(ehDaPessoa('bruno', BRUNO));
  assert.ok(ehDaPessoa('@Brunao', BRUNO));
  assert.ok(ehDaPessoa('Bruno Souza', BRUNO));
  assert.ok(ehDaPessoa('João', { first_name: 'Joao' }));
  assert.ok(!ehDaPessoa('Ana', BRUNO));
  assert.ok(!ehDaPessoa('', BRUNO));
});

teste('/prazo define, tira e recusa data inválida', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa A'));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/prazo 1 25/10'))), '📅 <b>#1</b> prazo 25/10/2026\n<b>A</b>');
  assert.strictEqual((await db.query(`select prazo::text p from tarefas_itens where numero = 1`)).rows[0].p, '2026-10-25');
  assert.ok(texto(await mandar(ctx, msgDe('/prazo 1 31/02'))).startsWith('Data inválida'));
  assert.strictEqual(texto(await mandar(ctx, msgDe('/prazo 1 sem'))), '📅 <b>#1</b> sem prazo\n<b>A</b>');
  assert.strictEqual((await db.query(`select prazo from tarefas_itens where numero = 1`)).rows[0].prazo, null);
});

teste('prazo sem ano: este ano, ou o próximo se já passou há muito', async () => {
  assert.strictEqual(parsePrazo('25/10', '2026-10-11'), '2026-10-25');
  assert.strictEqual(parsePrazo('05/10', '2026-10-11'), '2026-10-05', 'atrasado de poucos dias continua neste ano');
  assert.strictEqual(parsePrazo('10/01', '2026-12-20'), '2027-01-10');
  assert.strictEqual(parsePrazo('25/10/27', '2026-10-11'), '2027-10-25');
  assert.strictEqual(parsePrazo('29/02', '2026-10-11'), null);
  assert.strictEqual(parsePrazo('amanhã', '2026-10-11'), null);
});

teste('/ver mostra a tarefa completa, a foto e o histórico', async (ctx) => {
  await mandar(ctx, msgDe(null, { caption: '/tarefa Consertar a pia', photo: 'foto-pia' }));
  await mandar(ctx, msgDe('/pra 1 Bruno'));
  await mandar(ctx, msgDe('/prazo 1 05/10'));
  await mandar(ctx, msgDe('/feito 1', { from: BRUNO }));
  const env = await mandar(ctx, msgDe('/ver 1'));
  const foto = env.find(e => e.metodo === 'sendPhoto');
  assert.ok(foto, 'faltou a foto');
  assert.strictEqual(foto.body.photo, 'foto-pia');
  const t = texto(env);
  assert.ok(t.startsWith('📌 <b>Tarefa #1</b> · ✅ feita\n\n#1 · <b>Consertar a pia</b>\n<i>👤 Bruno · 📅 05/10/2026 · '), t);
  assert.ok(t.includes(' · pedida por Ana Lima</i>'), t);
  assert.ok(!t.includes('vencida'), 'feita não aparece como vencida');
  assert.ok(t.includes('<i>🕐 criada em '), t);
  assert.ok(t.includes('✅ Feita por Bruno em '), t);
  assert.ok(/· criada · Ana Lima/.test(t), t);
  assert.ok(/· responsável → Bruno · Ana Lima/.test(t), t);
  assert.ok(/· prazo 05\/10 · Ana Lima/.test(t), t);
  assert.ok(/· feita · Bruno/.test(t), t);
});

teste('/feito, /ver e /reabrir de tarefa que não existe', async (ctx) => {
  for (const c of ['/ver 99', '/pra 99 Ana', '/prazo 99 25/10']) {
    assert.strictEqual(texto(await mandar(ctx, msgDe(c))), '❓ Não achei a tarefa #99.', c);
  }
  for (const c of ['/feito 99', '/reabrir 99']) {
    assert.strictEqual(texto(await mandar(ctx, msgDe(c))), '❓ Não achei: #99', c);
  }
});

teste('grupo com tópicos: a resposta sai no mesmo tópico', async (ctx) => {
  const env = await mandar(ctx, msgDe('/tarefa No tópico', { thread: 77 }));
  assert.strictEqual(env[0].body.message_thread_id, 77);
});

teste('/ajuda lista os comandos', async (ctx) => {
  const t = texto(await mandar(ctx, msgDe('/ajuda')));
  for (const c of ['/tarefa', '/pendentes', '/minhas', '/feito', '/reabrir', '/pra', '/prazo', '/ver', '/idgrupo']) {
    assert.ok(t.includes(c), `faltou ${c}`);
  }
});

teste('banco fora do ar: avisa no grupo e o processo segue vivo', async (ctx) => {
  bancoFora = true;
  assert.strictEqual(texto(await mandar(ctx, msgDe('/pendentes'))), '⚠️ Erro ao falar com o banco. Tente de novo em instantes.');
  bancoFora = false;
  assert.strictEqual(texto(await mandar(ctx, msgDe('/tarefa Depois'))), '📌 <b>#1 registrada</b>\n<b>Depois</b>');
});

teste('SQL não rodado: diz qual arquivo falta', async (ctx) => {
  await db.query('alter function public.tarefas_listar(text, text, text) rename to tarefas_listar_x');
  try {
    assert.ok(texto(await mandar(ctx, msgDe('/pendentes'))).includes('db/tarefas.sql'));
  } finally {
    await db.query('alter function public.tarefas_listar_x(text, text, text) rename to tarefas_listar');
  }
});

teste('resumo das 10h30: antes nada; às 10h30 destaca atrasadas; uma vez por dia', async (ctx) => {
  await mandar(ctx, msgDe('/tarefa Atrasada'));
  await mandar(ctx, msgDe('/tarefa Em dia'));
  await mandar(ctx, msgDe('/prazo 1 10/10'));
  enviadas.length = 0;

  for (const hora of ['09:00', '10:00', '10:20']) {
    relogio = new Date(`2026-10-11T${hora}:00-03:00`);
    await ctx.bot.rodarResumo();
  }
  assert.strictEqual(enviadas.length, 0, 'antes das 10h30 não manda');

  relogio = new Date('2026-10-11T10:30:00-03:00');
  await ctx.bot.rodarResumo();
  const msgs = enviadas.filter(e => e.metodo === 'sendMessage');
  assert.strictEqual(msgs.length, 1, 'só o grupo com tarefas recebe (GRUPO2 está vazio)');
  assert.strictEqual(String(msgs[0].body.chat_id), String(GRUPO));
  const t = msgs[0].body.text;
  assert.ok(t.startsWith('☀️ <b>Tarefas abertas — 11/10 (2)</b>\n\n⚠️ <b>Atrasadas (1)</b>\n\n#1 · <b>Atrasada</b>\n<i>📅 10/10 (vencida)'), t);
  assert.ok(t.includes('<b>Sem responsável (1)</b>\n\n#2 · <b>Em dia</b>'), t);

  relogio = new Date('2026-10-11T10:40:00-03:00');
  await ctx.bot.rodarResumo();
  assert.strictEqual(enviadas.filter(e => e.metodo === 'sendMessage').length, 1, 'não repete no mesmo dia');

  relogio = new Date('2026-10-12T10:30:00-03:00');
  await ctx.bot.rodarResumo();
  assert.strictEqual(enviadas.filter(e => e.metodo === 'sendMessage').length, 2, 'no dia seguinte manda de novo');
});

teste('resumo sem tarefas abertas não manda nada', async (ctx) => {
  relogio = new Date('2026-10-11T10:30:00-03:00');
  await ctx.bot.rodarResumo();
  assert.strictEqual(enviadas.length, 0);
});

// ---------------------------------------------------------------------------

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const falsos = await subirFalsos();
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'tarefas.sql'), 'utf8');

  const app = express();
  app.use(express.json());
  const env = {
    TAREFAS_BOT_TOKEN: TOKEN,
    TAREFAS_GRUPOS: `${GRUPO}, ${GRUPO2}`,
    SUPABASE_URL: falsos.supabase,
    SUPABASE_ANON_KEY: 'anon',
    TAREFAS_TELEGRAM_API_BASE: falsos.telegram,
  };

  let falhas = 0;
  let bot = null;
  let server = null;
  for (const t of testes) {
    // Banco novo a cada teste: numeração e tarefas sempre do zero.
    db = new PGlite();
    await db.exec('create role anon; create role authenticated;');
    await db.exec(sql);
    if (!bot) {
      bot = ligar(app, { ...env, TAREFAS_SYNC_TOKEN: 'trocado-abaixo' }, { agendar: false, agora: () => relogio });
      server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    }
    // O token muda a cada banco novo; o bot lê do env só na criação, então
    // o banco falso aceita o token "fixo" do bot copiando-o pra config.
    await db.query(`update tarefas_config set valor = 'trocado-abaixo' where chave = 'sync_token'`);
    enviadas.length = 0;
    bancoFora = false;
    relogio = new Date('2026-10-11T12:00:00-03:00');
    const ctx = { webhook: `http://127.0.0.1:${server.address().port}${CAMINHO_WEBHOOK}`, bot };
    try {
      await t.fn(ctx);
      console.log(`✅ ${t.nome}`);
    } catch (err) {
      falhas++;
      console.log(`❌ ${t.nome}\n   ${err.message}`);
    }
    await db.close();
  }
  server.close();
  falsos.fechar();
  console.log(`\n${testes.length - falhas}/${testes.length} testes passaram`);
  process.exit(falhas ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
