// Teste local do bot. Sobe dois servidores falsos — Telegram (captura o que o
// bot mandaria) e Supabase (responde às RPCs) — aponta as env vars para eles e
// dirige o webhook com updates de verdade.
//
// Rodar: node test.js   (não precisa de rede nem de token real)

const http = require('http');
const assert = require('assert');

const enviadas = [];     // mensagens que o bot mandou pro Telegram
const chamadas = [];     // { fn, body } de cada RPC recebida
let respostas = {};      // { [fn]: { status, body } } — o que o Supabase falso devolve

function servidorFalso(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => handler(req, raw, res));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function subirFalsos() {
  const telegram = await servidorFalso((req, raw, res) => {
    try { enviadas.push(JSON.parse(raw)); } catch (_) { enviadas.push({ text: raw }); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });

  const supabase = await servidorFalso((req, raw, res) => {
    const fn = req.url.split('/').pop();
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    chamadas.push({ fn, body });
    const r = respostas[fn] || { status: 200, body: {} };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });

  return {
    telegram: `http://127.0.0.1:${telegram.address().port}`,
    supabase: `http://127.0.0.1:${supabase.address().port}`,
    fechar: () => { telegram.close(); supabase.close(); },
  };
}

// --- IDs usados nos updates ------------------------------------------------
const DONO = 111;
const FUNCIONARIO = 999;
const GRUPO_VENDAS = -100;
const GRUPO_REPOSICAO = -200;

let updateId = 1;

function update(text, { from = DONO, chat = GRUPO_VENDAS, tipo = 'group' } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: from },
      chat: { id: chat, type: tipo },
      text,
    },
  };
}

// Manda o update e espera o bot responder (o webhook devolve 200 antes de
// processar, então esperamos a mensagem aparecer no Telegram falso).
async function mandar(webhookUrl, upd, { esperaResposta = true } = {}) {
  const antes = enviadas.length;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(upd),
  });
  if (!esperaResposta) {
    await new Promise(r => setTimeout(r, 150)); // dá tempo de (não) responder
    return [];
  }
  const limite = Date.now() + 3000;
  while (enviadas.length === antes && Date.now() < limite) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(enviadas.length > antes, `sem resposta do bot para: ${upd.message.text}`);
  return enviadas.slice(antes);
}

// --- Harness ---------------------------------------------------------------
const testes = [];
function teste(nome, fn) { testes.push({ nome, fn }); }

// ---------------------------------------------------------------------------

teste('/anular 2 pelo dono chama a RPC e responde só o contador', async (ctx) => {
  respostas.bot_anular_comissao = { status: 200, body: { ok: true, unidades_anuladas: 2 } };
  const [resp] = await mandar(ctx.webhook, update('/anular 2'));

  const rpc = chamadas.filter(c => c.fn === 'bot_anular_comissao');
  assert.strictEqual(rpc.length, 1, 'deveria chamar bot_anular_comissao uma vez');
  assert.strictEqual(rpc[0].body.p_unidades, 2);
  assert.strictEqual(rpc[0].body.p_token, 'token-de-teste');

  assert.strictEqual(resp.text, '✂️ 2 unidade(s) descontada(s) da comissão.');
});

// A RPC virou contador puro. Se um dia voltar a mandar itens/aviso, o bot
// continua respondendo só a linha do contador.
teste('/anular ignora itens e aviso se a RPC mandar', async (ctx) => {
  respostas.bot_anular_comissao = {
    status: 200,
    body: {
      ok: true,
      unidades_anuladas: 3,
      itens: [{ modelo: 'Ignite 5500', sabor: 'Grape Ice', qtd: 3 }],
      aviso: 'A última baixa tinha 3 unidades; foi anulada inteira.',
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/anular 3'));
  assert.strictEqual(resp.text, '✂️ 3 unidade(s) descontada(s) da comissão.');
});

teste('/anular pelo funcionário é recusado e não chega na RPC', async (ctx) => {
  respostas.bot_anular_comissao = { status: 200, body: { ok: true, unidades_anuladas: 2 } };
  const [resp] = await mandar(ctx.webhook, update('/anular 2', { from: FUNCIONARIO }));
  assert.strictEqual(resp.text, '⛔ Só o dono pode anular comissão.');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao').length, 0);
});

teste('/desanular pelo funcionário é recusado', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/desanular 2', { from: FUNCIONARIO }));
  assert.strictEqual(resp.text, '⛔ Só o dono pode anular comissão.');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_desanular_comissao').length, 0);
});

teste('/anular sem número ou fora de 1..50 mostra o uso', async (ctx) => {
  for (const texto of ['/anular', '/anular abc', '/anular 0', '/anular 51', '/anular -3']) {
    const [resp] = await mandar(ctx.webhook, update(texto));
    assert.strictEqual(resp.text, 'Uso: /anular 10 (1 a 50)', `para: ${texto}`);
  }
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao').length, 0);
});

teste('/desanular sem número mostra o uso', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/desanular'));
  assert.strictEqual(resp.text, 'Uso: /desanular 10 (1 a 50)');
});

teste('/desanular 2 pelo dono devolve as unidades', async (ctx) => {
  respostas.bot_desanular_comissao = { status: 200, body: { ok: true, unidades_reativadas: 2 } };
  const [resp] = await mandar(ctx.webhook, update('/desanular 2'));

  const rpc = chamadas.filter(c => c.fn === 'bot_desanular_comissao');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_unidades, 2);
  assert.strictEqual(resp.text, '↩️ 2 unidade(s) de volta na comissão.');
});

teste('/anular funciona no grupo de reposição e no privado do dono', async (ctx) => {
  respostas.bot_anular_comissao = { status: 200, body: { ok: true, unidades_anuladas: 1 } };
  const esperado = '✂️ 1 unidade(s) descontada(s) da comissão.';

  const [noReposicao] = await mandar(ctx.webhook, update('/anular 1', { chat: GRUPO_REPOSICAO }));
  assert.strictEqual(noReposicao.text, esperado);

  const [noPrivado] = await mandar(ctx.webhook, update('/anular 1', { chat: DONO, tipo: 'private' }));
  assert.strictEqual(noPrivado.text, esperado);
});

teste('erro da RPC vira mensagem amigável e o webhook continua vivo', async (ctx) => {
  respostas.bot_anular_comissao = { status: 500, body: { message: 'boom' } };
  const [erro] = await mandar(ctx.webhook, update('/anular 2'));
  assert.ok(erro.text.includes('Erro ao falar com o servidor'), erro.text);
  assert.ok(!erro.text.includes('boom'), 'não deve vazar o erro cru da RPC');

  // ok:false também é tratado
  respostas.bot_anular_comissao = { status: 200, body: { ok: false, erro: 'nada a anular' } };
  const [recusa] = await mandar(ctx.webhook, update('/anular 2'));
  assert.ok(recusa.text.includes('nada a anular'), recusa.text);

  // e o bot segue respondendo normalmente depois
  respostas.bot_anular_comissao = { status: 200, body: { ok: true, unidades_anuladas: 1 } };
  const [depois] = await mandar(ctx.webhook, update('/anular 1'));
  assert.strictEqual(depois.text, '✂️ 1 unidade(s) descontada(s) da comissão.');
});

// --- Comando desconhecido não pode ficar mudo pro dono ---------------------
// Foi esse silêncio que disfarçou o deploy velho de "bug no /anular".

teste('comando desconhecido responde ao dono, com o commit no ar', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/anularr 24'));
  assert.ok(resp.text.includes('Comando não reconhecido'), resp.text);
  assert.ok(resp.text.includes('/anularr'), resp.text);
  assert.ok(resp.text.includes('commit'), resp.text);
});

teste('comando desconhecido do funcionário segue silencioso (sem ruído no grupo)', async (ctx) => {
  await mandar(ctx.webhook, update('/qualquercoisa', { from: FUNCIONARIO }), { esperaResposta: false });
  assert.strictEqual(enviadas.length, 0, `não devia responder: ${JSON.stringify(enviadas)}`);
});

teste('texto normal no grupo de vendas continua sem resposta', async (ctx) => {
  // Sem o guard de "/" o fallback responderia a conversa normal do dono.
  await mandar(ctx.webhook, update('bom dia pessoal'), { esperaResposta: false });
  assert.strictEqual(enviadas.length, 0, `não devia responder: ${JSON.stringify(enviadas)}`);
});

teste('/versao mostra o commit ao dono e ignora o funcionário', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/versao'));
  assert.ok(resp.text.includes('Versão no ar'), resp.text);
  assert.ok(resp.text.includes('/anular'), resp.text);

  await mandar(ctx.webhook, update('/versao', { from: FUNCIONARIO }), { esperaResposta: false });
  assert.strictEqual(enviadas.length, 1, 'funcionário não devia receber resposta');
});

// --- Regressão: o resto do bot não mudou -----------------------------------

teste('regressão: baixa continua indo pra bot_movimentar_estoque', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'baixa', model: 'Ignite 5500',
        flavor: 'Grape Ice', qty: 1, stock_after: 7,
      }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('-1 Ignite 5500 Grape Ice'));
  const rpc = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(rpc.length, 1);
  assert.deepStrictEqual(rpc[0].body.p_items, [{ produto: 'Ignite 5500 Grape Ice', qty: -1 }]);
  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
});

teste('regressão: /comissao não passa por bot_anular_comissao', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '20/07 → 19/08', unidades_hoje: 4, unidades_mes: 120,
      taxa_atual: 1.5, comissao: 180, faltam_para_proxima: 30, proxima_taxa: 2,
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/comissao'));
  assert.ok(resp.text.includes('Acumulado: *120* produtos'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao').length, 0);
});

// --- Runner ----------------------------------------------------------------

async function main() {
  const falsos = await subirFalsos();

  // Env vars ANTES do require: o index.js lê tudo no topo do módulo.
  process.env.TELEGRAM_TOKEN = 'token-de-teste';
  process.env.TELEGRAM_API_BASE = falsos.telegram;
  process.env.SUPABASE_URL = falsos.supabase;
  process.env.SUPABASE_ANON_KEY = 'anon-de-teste';
  process.env.BOT_SYNC_TOKEN = 'token-de-teste';
  process.env.ADMIN_USER_ID = String(DONO);
  process.env.LUCAS_USER_ID = String(DONO);
  process.env.VENDAS_CHAT_ID = String(GRUPO_VENDAS);
  process.env.REPOSICAO_CHAT_ID = String(GRUPO_REPOSICAO);

  const { app } = require('./index.js');
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const ctx = { webhook: `http://127.0.0.1:${server.address().port}/webhook` };

  let falhas = 0;
  for (const t of testes) {
    enviadas.length = 0;
    chamadas.length = 0;
    respostas = {};
    try {
      await t.fn(ctx);
      console.log(`✅ ${t.nome}`);
    } catch (err) {
      falhas++;
      console.log(`❌ ${t.nome}\n   ${err.message}`);
    }
  }

  server.close();
  falsos.fechar();
  console.log(`\n${testes.length - falhas}/${testes.length} testes passaram`);
  process.exit(falhas ? 1 : 0); // os crons do index.js seguram o processo
}

main();
