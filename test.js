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

// --- Despesas particulares do Rod ("+25 ENTREGA ROD") ----------------------

teste('"+25 ENTREGA ROD" vira despesa e responde com o acumulado do ciclo', async (ctx) => {
  respostas.bot_despesa_rod_registrar = {
    status: 200,
    body: { ok: true, id: 7, valor: 25, descricao: 'ENTREGA', total_ciclo: 143, ciclo: '21/08 → 20/09' },
  };
  const [resp] = await mandar(ctx.webhook, update('+25 ENTREGA ROD', { chat: GRUPO_REPOSICAO }));

  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc.length, 1, 'deveria registrar a despesa');
  assert.strictEqual(rpc[0].body.p_valor, 25);
  assert.strictEqual(rpc[0].body.p_descricao, 'ENTREGA');
  assert.strictEqual(resp.text, '📝 Anotado: R$ 25 ENTREGA — total do ciclo: R$ 143');

  // O ponto da tarefa: despesa NUNCA pode cair no fluxo de estoque.
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
});

teste('despesa com centavos e ROD minúsculo também é aceita', async (ctx) => {
  respostas.bot_despesa_rod_registrar = {
    status: 200, body: { ok: true, valor: 18.5, total_ciclo: 161.5 },
  };
  const [resp] = await mandar(ctx.webhook, update('+18,50 Uber rod', { chat: GRUPO_REPOSICAO }));
  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc[0].body.p_valor, 18.5);
  assert.strictEqual(rpc[0].body.p_descricao, 'Uber');
  assert.strictEqual(resp.text, '📝 Anotado: R$ 18,50 Uber — total do ciclo: R$ 161,50');
});

teste('COLISÃO: "+2 ignite 50000 grape" continua indo pro estoque', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'entrada', model: 'Ignite 50000 (V500)',
        flavor: 'Grape', qty: 2, stock_after: 20,
      }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('+2 ignite 50000 grape', { chat: GRUPO_REPOSICAO }));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0,
    'não podia ter virado despesa');
  const rpc = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(rpc.length, 1);
  assert.deepStrictEqual(rpc[0].body.p_items, [{ produto: 'ignite 50000 grape', qty: 2 }]);
  assert.ok(resp.text.includes('Entrada registrada'), resp.text);
});

teste('despesa no grupo de VENDAS não leva bronca de "grupo errado"', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 30, total_ciclo: 30 } };
  const respostasBot = await mandar(ctx.webhook, update('+30 ENTREGA ROD'));
  const textos = respostasBot.map(r => r.text).join('\n');
  assert.ok(textos.includes('Anotado'), textos);
  assert.ok(!textos.includes('grupo de reposição'), `não devia reclamar de grupo: ${textos}`);
});

teste('"+25 ROD" (sem descrição) mostra o uso e não chama RPC nenhuma', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('+25 ROD', { chat: GRUPO_REPOSICAO }));
  assert.ok(resp.text.includes('+25 ENTREGA ROD'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
});

teste('falha da RPC de despesa não some em silêncio', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 500, body: { message: 'boom' } };
  const [resp] = await mandar(ctx.webhook, update('+25 ENTREGA ROD', { chat: GRUPO_REPOSICAO }));
  assert.ok(resp.text.includes('Não consegui anotar'), resp.text);
  assert.ok(!resp.text.includes('boom'), 'não deve vazar o erro cru');
});

teste('mensagem mista: despesa e reposição na mesma mensagem seguem rotas diferentes', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 25, total_ciclo: 25 } };
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'entrada', model: 'Ignite 8000 (V80)',
        flavor: 'Cactus', qty: 3, stock_after: 8,
      }],
    },
  };
  await mandar(ctx.webhook, update('+25 ENTREGA ROD\n+3 ignite 8000 cactus', { chat: GRUPO_REPOSICAO }));

  const despesa = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  const estoque = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(despesa.length, 1);
  assert.strictEqual(estoque.length, 1);
  assert.deepStrictEqual(estoque[0].body.p_items, [{ produto: 'ignite 8000 cactus', qty: 3 }]);
});

teste('/despesas lista os lançamentos do ciclo', async (ctx) => {
  respostas.bot_despesas_rod = {
    status: 200,
    body: {
      ok: true, ciclo: '21/08 → 20/09', total: 43,
      itens: [
        { valor: 25, descricao: 'ENTREGA', data: '21/08' },
        { valor: 18, descricao: 'UBER', data: '22/08' },
      ],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/despesas'));
  assert.ok(resp.text.includes('21/08 → 20/09'), resp.text);
  assert.ok(resp.text.includes('R$ 25 ENTREGA'), resp.text);
  assert.ok(resp.text.includes('Total do ciclo: R$ 43'), resp.text);
});

// --- Fechamento soma comissão + despesas -----------------------------------

teste('fechamento inclui a linha de despesas e o total a pagar', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    { mes: '21/07 → 20/08', unidades_mes: 120, taxa_atual: 2.5, comissao: 300 },
    { ok: true, total: 143 },
  );
  assert.ok(texto.includes('FECHAMENTO DO PERÍODO 21/07 → 20/08'), texto);
  assert.ok(texto.includes('💰 Comissão: *R$ 300,00*'), texto);
  assert.ok(texto.includes('🛵 Entregas/despesas Rod: R$ 143,00'), texto);
  assert.ok(texto.includes('Total a pagar: R$ 443,00'), texto);
});

teste('fechamento avisa quando não conseguiu somar as despesas (não paga a menos calado)', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    { mes: '21/07 → 20/08', unidades_mes: 120, taxa_atual: 2.5, comissao: 300 }, null,
  );
  assert.ok(texto.includes('Não consegui somar'), texto);
  assert.ok(!texto.includes('Total a pagar'), 'sem despesas confiáveis não pode anunciar total');
});

teste('o fechamento do relatório diário puxa as despesas do ciclo', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '21/07 → 20/08', fecha_hoje: true, unidades_mes: 120,
      unidades_hoje: 4, taxa_atual: 2.5, comissao: 300,
    },
  };
  respostas.bot_despesas_rod = { status: 200, body: { ok: true, total: 143, itens: [] } };
  const texto = await ctx.mod.textoComissaoRelatorio();
  assert.ok(texto.includes('Total a pagar: R$ 443,00'), texto);
});

// --- /refazerfechamento (correção do corte 19 → 20) ------------------------

teste('/refazerfechamento publica a correção no grupo de vendas', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '20/07 → 20/08', fecha_hoje: true, unidades_mes: 130,
      unidades_hoje: 6, taxa_atual: 2.5, comissao: 325,
    },
  };
  respostas.bot_despesas_rod = { status: 200, body: { ok: true, total: 0, itens: [] } };

  // Mandado no privado do dono: a correção tem que sair no GRUPO, não só no DM.
  await mandar(ctx.webhook, update('/refazerfechamento 20/08/2026', { chat: DONO, tipo: 'private' }));
  await new Promise(r => setTimeout(r, 200));

  const rpc = chamadas.filter(c => c.fn === 'bot_comissao');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_mes, '2026-08-20', 'data de corte errada');

  const noGrupo = enviadas.find(e => String(e.chat_id) === String(GRUPO_VENDAS));
  assert.ok(noGrupo, `nada foi pro grupo: ${JSON.stringify(enviadas)}`);
  assert.ok(noGrupo.text.includes('FECHAMENTO CORRIGIDO — 20/07 → 20/08'), noGrupo.text);
  assert.ok(noGrupo.text.includes('Novo corte: 20/08 às 23:59'), noGrupo.text);
  assert.ok(noGrupo.text.includes('Substitui o fechamento anterior'), noGrupo.text);
  assert.ok(noGrupo.text.includes('*130* produtos'), noGrupo.text);

  const noPrivado = enviadas.find(e => String(e.chat_id) === String(DONO));
  assert.ok(noPrivado && noPrivado.text.includes('publicada no grupo'), 'faltou confirmar pro dono');
});

teste('/refazerfechamento é recusado pro funcionário e não recalcula nada', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/refazerfechamento 20/08', { from: FUNCIONARIO }));
  assert.ok(resp.text.includes('Só o dono'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comissao').length, 0);
});

teste('/refazerfechamento sem data (ou com data inválida) mostra o uso', async (ctx) => {
  for (const texto of ['/refazerfechamento', '/refazerfechamento ontem', '/refazerfechamento 32/13']) {
    const [resp] = await mandar(ctx.webhook, update(texto));
    assert.ok(resp.text.includes('Uso: /refazerfechamento'), `para ${texto}: ${resp.text}`);
  }
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comissao').length, 0);
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

  const mod = require('./index.js');
  const { app } = mod;
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  // `mod` fica no ctx pros testes que chamam função exportada direto (fechamento),
  // em vez de dirigir o webhook.
  const ctx = { webhook: `http://127.0.0.1:${server.address().port}/webhook`, mod };

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
