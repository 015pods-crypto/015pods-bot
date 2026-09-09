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
    // Resposta pode ser função de (body): é o que permite a mesma RPC devolver
    // coisas diferentes por p_tipo (bot_despesas_rod despesa vs dinheiro).
    const bruta = respostas[fn];
    const r = (typeof bruta === 'function' ? bruta(body) : bruta) || { status: 200, body: {} };
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

function update(text, { from = DONO, chat = GRUPO_VENDAS, tipo = 'group', nome } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: nome ? { id: from, first_name: nome } : { id: from },
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

teste('/anular 2 chama a RPC com autor e responde só o contador', async (ctx) => {
  respostas.bot_anular_comissao_autor = { status: 200, body: { ok: true, unidades_anuladas: 2 } };
  const [resp] = await mandar(ctx.webhook, update('/anular 2'));

  const rpc = chamadas.filter(c => c.fn === 'bot_anular_comissao_autor');
  assert.strictEqual(rpc.length, 1, 'deveria chamar bot_anular_comissao_autor uma vez');
  assert.strictEqual(rpc[0].body.p_unidades, 2);
  assert.strictEqual(rpc[0].body.p_token, 'token-de-teste');
  assert.strictEqual(rpc[0].body.p_meta.user_id, String(DONO));

  assert.strictEqual(resp.text, '✂️ 2 unidade(s) descontada(s) da comissão.');
});

// AJUSTE 2: qualquer membro pode anular (só REDUZ a comissão do Rod).
teste('/anular pelo Rodrigo funciona e registra quem apertou', async (ctx) => {
  respostas.bot_anular_comissao_autor = { status: 200, body: { ok: true, unidades_anuladas: 1 } };
  const [resp] = await mandar(ctx.webhook, update('/anular 1', { from: FUNCIONARIO, nome: 'Rodrigo' }));

  const rpc = chamadas.filter(c => c.fn === 'bot_anular_comissao_autor');
  assert.strictEqual(rpc.length, 1, 'funcionário deveria conseguir anular');
  assert.strictEqual(rpc[0].body.p_meta.user_id, String(FUNCIONARIO));
  assert.strictEqual(rpc[0].body.p_meta.nome, 'Rodrigo');
  assert.strictEqual(resp.text, '✂️ 1 unidade(s) descontada(s) da comissão. (por Rodrigo)');
});

// Sem o Run do autor aplicado, anular NÃO pode quebrar: cai na RPC antiga.
teste('/anular cai na RPC sem autor se bot_anular_comissao_autor não existe', async (ctx) => {
  respostas.bot_anular_comissao_autor = { status: 404, body: { message: 'Could not find the function' } };
  respostas.bot_anular_comissao = { status: 200, body: { ok: true, unidades_anuladas: 4 } };
  const [resp] = await mandar(ctx.webhook, update('/anular 4', { from: FUNCIONARIO, nome: 'Rodrigo' }));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao').length, 1, 'faltou o fallback');
  assert.strictEqual(resp.text, '✂️ 4 unidade(s) descontada(s) da comissão. (por Rodrigo)');
});

// A RPC virou contador puro. Se um dia voltar a mandar itens/aviso, o bot
// continua respondendo só a linha do contador.
teste('/anular ignora itens e aviso se a RPC mandar', async (ctx) => {
  respostas.bot_anular_comissao_autor = {
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

teste('/desanular pelo funcionário é recusado (aumenta comissão: só o dono)', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/desanular 2', { from: FUNCIONARIO }));
  assert.strictEqual(resp.text, '⛔ Só o dono pode desanular comissão.');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_desanular_comissao').length, 0);
});

teste('/anular sem número ou fora de 1..50 mostra o uso', async (ctx) => {
  for (const texto of ['/anular', '/anular abc', '/anular 0', '/anular 51', '/anular -3']) {
    const [resp] = await mandar(ctx.webhook, update(texto));
    assert.strictEqual(resp.text, 'Uso: /anular 10 (1 a 50)', `para: ${texto}`);
  }
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao_autor').length, 0);
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
  respostas.bot_anular_comissao_autor = { status: 200, body: { ok: true, unidades_anuladas: 1 } };
  const esperado = '✂️ 1 unidade(s) descontada(s) da comissão.';

  const [noReposicao] = await mandar(ctx.webhook, update('/anular 1', { chat: GRUPO_REPOSICAO }));
  assert.strictEqual(noReposicao.text, esperado);

  const [noPrivado] = await mandar(ctx.webhook, update('/anular 1', { chat: DONO, tipo: 'private' }));
  assert.strictEqual(noPrivado.text, esperado);
});

teste('erro da RPC vira mensagem amigável e o webhook continua vivo', async (ctx) => {
  // 500 não é "RPC ausente": não pode cair no fallback, tem que avisar.
  respostas.bot_anular_comissao_autor = { status: 500, body: { message: 'boom' } };
  const [erro] = await mandar(ctx.webhook, update('/anular 2'));
  assert.ok(erro.text.includes('Erro ao falar com o servidor'), erro.text);
  assert.ok(!erro.text.includes('boom'), 'não deve vazar o erro cru da RPC');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_anular_comissao').length, 0,
    '500 não é RPC ausente — não podia tentar a antiga');

  // ok:false também é tratado
  respostas.bot_anular_comissao_autor = { status: 200, body: { ok: false, erro: 'nada a anular' } };
  const [recusa] = await mandar(ctx.webhook, update('/anular 2'));
  assert.ok(recusa.text.includes('nada a anular'), recusa.text);

  // e o bot segue respondendo normalmente depois
  respostas.bot_anular_comissao_autor = { status: 200, body: { ok: true, unidades_anuladas: 1 } };
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
  assert.strictEqual(rpc[0].body.p_tipo, 'despesa');
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
  assert.ok(resp.text.includes('Uso: `+25 ENTREGA`'), resp.text);
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
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesas_rod')[0].body.p_tipo, 'despesa');
  assert.ok(resp.text.includes('21/08 → 20/09'), resp.text);
  assert.ok(resp.text.includes('R$ 25 ENTREGA'), resp.text);
  assert.ok(resp.text.includes('Total do ciclo: R$ 43'), resp.text);
});

// --- AJUSTE 1: despesa SEM o sufixo ROD, por lista de palavras -------------

teste('"+25 ENTREGA" (sem ROD) vira despesa', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 25, total_ciclo: 25 } };
  const [resp] = await mandar(ctx.webhook, update('+25 ENTREGA', { chat: GRUPO_REPOSICAO }));

  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc.length, 1, 'deveria ter virado despesa');
  assert.strictEqual(rpc[0].body.p_valor, 25);
  assert.strictEqual(rpc[0].body.p_descricao, 'ENTREGA');
  assert.strictEqual(rpc[0].body.p_tipo, 'despesa');
  assert.strictEqual(resp.text, '📝 Anotado: R$ 25 ENTREGA — total do ciclo: R$ 25');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
});

teste('"+18 uber centro" guarda o complemento livre na descrição', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 18, total_ciclo: 43 } };
  await mandar(ctx.webhook, update('+18 uber centro', { chat: GRUPO_REPOSICAO }));
  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc[0].body.p_valor, 18);
  assert.strictEqual(rpc[0].body.p_descricao, 'uber centro');
});

// O ponto mais importante do ajuste: typo de PRODUTO não pode virar despesa.
teste('produto com typo continua "não encontrado" — NUNCA vira despesa', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: { resultados: [{ status: 'nao_encontrado', input: 'ignitee 50000 grape' }] },
  };
  const [resp] = await mandar(ctx.webhook, update('+2 ignitee 50000 grape', { chat: GRUPO_REPOSICAO }));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0,
    'typo de produto não podia virar despesa silenciosa');
  assert.ok(resp.text.includes('Produto não encontrado'), resp.text);
});

teste('"+25 XYZ" (palavra fora da lista) vai pro estoque, não pra despesa', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: { resultados: [{ status: 'nao_encontrado', input: 'XYZ' }] },
  };
  const [resp] = await mandar(ctx.webhook, update('+25 XYZ', { chat: GRUPO_REPOSICAO }));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0);
  assert.ok(resp.text.includes('Produto não encontrado'), resp.text);
});

// --- ESTORNO: mesmo formato no negativo ------------------------------------

teste('"-50 DINHEIRO" estorna dinheiro em mãos (mesma RPC, valor negativo)', async (ctx) => {
  respostas.bot_despesa_rod_registrar = {
    status: 200, body: { ok: true, tipo: 'dinheiro', estorno: true, valor: -50, total_ciclo: 80 },
  };
  const [resp] = await mandar(ctx.webhook, update('-50 DINHEIRO'));

  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_valor, -50, 'o valor tem que ir NEGATIVO pra RPC');
  assert.strictEqual(rpc[0].body.p_tipo, 'dinheiro');
  assert.strictEqual(resp.text, '↩️ Estornado: R$ 50 de DINHEIRO — total em mãos no ciclo: R$ 80');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0,
    'estorno não podia virar baixa de estoque');
});

teste('"-25 ENTREGA erro de digitação" estorna despesa com o motivo junto', async (ctx) => {
  respostas.bot_despesa_rod_registrar = {
    status: 200, body: { ok: true, tipo: 'despesa', estorno: true, valor: -25, total_ciclo: 0 },
  };
  const [resp] = await mandar(ctx.webhook, update('-25 ENTREGA erro de digitação'));

  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc[0].body.p_valor, -25);
  assert.strictEqual(rpc[0].body.p_descricao, 'ENTREGA erro de digitação');
  assert.strictEqual(rpc[0].body.p_tipo, 'despesa');
  assert.ok(resp.text.startsWith('↩️ Estornado: R$ 25 de ENTREGA erro de digitação'), resp.text);
  assert.ok(resp.text.includes('total do ciclo: R$ 0'), resp.text);
});

// O risco do ajuste: "-" é o comando de VENDA. Uma linha de venda engolida
// como estorno seria um produto que sai do estoque sem sair de verdade.
teste('ESTORNO x VENDA: "-2 ignite 50000 grape" continua baixando estoque', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'baixa', model: 'Ignite 50000 (V500)',
        flavor: 'Grape', qty: 2, stock_after: 18,
      }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('-2 ignite 50000 grape'));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0,
    'venda não podia virar estorno');
  const rpc = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(rpc.length, 1);
  assert.deepStrictEqual(rpc[0].body.p_items, [{ produto: 'ignite 50000 grape', qty: -2 }]);
  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
});

teste('ESTORNO x VENDA: produto com typo continua "não encontrado", não estorno', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: { resultados: [{ status: 'nao_encontrado', input: 'igniti 50000 grape' }] },
  };
  const [resp] = await mandar(ctx.webhook, update('-2 igniti 50000 grape'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0);
  assert.ok(resp.text.includes('Produto não encontrado'), resp.text);
});

teste('+ e - convivem na mesma mensagem, cada um na sua rota', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 0, total_ciclo: 0 } };
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'baixa', model: 'Ignite 5500',
        flavor: 'Grape Ice', qty: 1, stock_after: 6,
      }],
    },
  };
  await mandar(ctx.webhook, update('+100 DINHEIRO\n-50 DINHEIRO\n-1 Ignite 5500 Grape Ice'));
  await new Promise(r => setTimeout(r, 150));

  const reg = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(reg.length, 2, 'os dois lançamentos de dinheiro deviam ter ido pra RPC');
  assert.strictEqual(reg[0].body.p_valor, 100);
  assert.strictEqual(reg[1].body.p_valor, -50);

  const estoque = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(estoque.length, 1);
  assert.deepStrictEqual(estoque[0].body.p_items, [{ produto: 'Ignite 5500 Grape Ice', qty: -1 }]);
});

// Se o Run que devolve 'estorno' ainda não estiver aplicado, o sinal que o bot
// mandou decide — não pode responder "Anotado" pra um estorno.
teste('estorno sem o campo estorno na resposta cai no sinal enviado', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, total_ciclo: 80 } };
  const [resp] = await mandar(ctx.webhook, update('-50 DINHEIRO'));
  assert.ok(resp.text.startsWith('↩️ Estornado'), resp.text);
});

teste('valor zero não vira lançamento nem estorno', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: { resultados: [{ status: 'nao_encontrado', input: 'DINHEIRO' }] },
  };
  const [resp] = await mandar(ctx.webhook, update('-0 DINHEIRO'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar').length, 0,
    'zero não podia ir pra RPC');
  assert.ok(resp.text.includes('Não entendi') || resp.text.includes('não encontrado'), resp.text);
});

// --- AJUSTE 3: dinheiro em mãos -------------------------------------------

teste('"+100 DINHEIRO" é categoria própria (não despesa) e responde o total em mãos', async (ctx) => {
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 100, total_ciclo: 130 } };
  const [resp] = await mandar(ctx.webhook, update('+100 DINHEIRO'));

  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_valor, 100);
  assert.strictEqual(rpc[0].body.p_tipo, 'dinheiro', 'DINHEIRO não pode ser gravado como despesa');
  assert.strictEqual(resp.text, '💵 Anotado: R$ 100 em DINHEIRO — total em mãos no ciclo: R$ 130');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
});

teste('/dinheiro lista só o ciclo de dinheiro em mãos', async (ctx) => {
  respostas.bot_despesas_rod = {
    status: 200,
    body: {
      ok: true, tipo: 'dinheiro', ciclo: '21/08 → 20/09', total: 130,
      itens: [{ valor: 30, descricao: 'DINHEIRO', data: '21/08' },
              { valor: 100, descricao: 'DINHEIRO', data: '22/08' }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/dinheiro'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_despesas_rod')[0].body.p_tipo, 'dinheiro');
  assert.ok(resp.text.includes('Dinheiro em mãos'), resp.text);
  assert.ok(resp.text.includes('21/08 → 20/09'), resp.text);
  assert.ok(resp.text.includes('R$ 100'), resp.text);
  assert.ok(resp.text.includes('Total em mãos no ciclo: R$ 130'), resp.text);
});

teste('/geral mostra comissão, despesas, dinheiro e o acerto do ciclo', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '21/08 → 20/09', unidades_hoje: 4, unidades_mes: 120,
      taxa_atual: 2.5, comissao: 300,
    },
  };
  respostas.bot_despesas_rod = (body) => body.p_tipo === 'dinheiro'
    ? { status: 200, body: { ok: true, total: 500, itens: [{}, {}], ciclo: '21/08 → 20/09' } }
    : { status: 200, body: { ok: true, total: 143, itens: [{}, {}, {}], ciclo: '21/08 → 20/09' } };

  const [resp] = await mandar(ctx.webhook, update('/geral'));
  assert.ok(resp.text.includes('Geral — 21/08 → 20/09'), resp.text);
  assert.ok(resp.text.includes('Unidades: *120*'), resp.text);
  assert.ok(resp.text.includes('R$ 300,00'), resp.text);
  assert.ok(resp.text.includes('3 lançamento(s) → *R$ 143,00*'), resp.text);
  assert.ok(resp.text.includes('2 lançamento(s) → *R$ 500,00*'), resp.text);
  // 500 − (300 + 143) = 57
  assert.ok(resp.text.includes('Rod repassa R$ 57,00'), resp.text);
});

teste('/geral com sinal invertido diz que a loja paga o Rod', async (ctx) => {
  assert.ok(ctx.mod.linhaAcerto(100, 443).includes('Loja paga R$ 343,00 ao Rod'),
    ctx.mod.linhaAcerto(100, 443));
  assert.ok(ctx.mod.linhaAcerto(443, 443).includes('zerado'), ctx.mod.linhaAcerto(443, 443));
});

teste('/geral avisa qual fonte falhou em vez de inventar o acerto', async (ctx) => {
  respostas.bot_comissao = { status: 500, body: { message: 'boom' } };
  respostas.bot_despesas_rod = { status: 200, body: { ok: true, total: 10, itens: [] } };
  const [resp] = await mandar(ctx.webhook, update('/geral'));
  assert.ok(resp.text.includes('não consegui consultar'), resp.text);
  assert.ok(!resp.text.includes('Rod repassa'), 'sem comissão não pode anunciar acerto');
});

// --- Lista de palavras vem do banco (palavra nova = update no config) ------
// Deixado por último de propósito: é o único teste que popula o cache de
// palavras do módulo (TTL ~1 min), e um cache quente mudaria os testes acima.

teste('palavra nova no bot_despesa_palavras funciona sem deploy', async (ctx) => {
  respostas.bot_config = {
    status: 200,
    body: { ok: true, key: 'bot_despesa_palavras', valor: 'ENTREGA,UBER,GASOLINA,ALMOÇO' },
  };
  respostas.bot_despesa_rod_registrar = { status: 200, body: { ok: true, valor: 15, total_ciclo: 15 } };

  const [resp] = await mandar(ctx.webhook, update('+15 ALMOÇO', { chat: GRUPO_REPOSICAO }));

  const cfg = chamadas.filter(c => c.fn === 'bot_config');
  assert.ok(cfg.length >= 1, 'deveria consultar a lista no banco');
  assert.strictEqual(cfg[0].body.p_key, 'bot_despesa_palavras');
  const rpc = chamadas.filter(c => c.fn === 'bot_despesa_rod_registrar');
  assert.strictEqual(rpc.length, 1, 'ALMOÇO deveria ter virado despesa');
  assert.strictEqual(rpc[0].body.p_descricao, 'ALMOÇO');
  assert.ok(resp.text.includes('Anotado: R$ 15 ALMOÇO'), resp.text);
});

// --- Fechamento soma comissão + despesas -----------------------------------

teste('fechamento inclui despesas, dinheiro em mãos e o acerto', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    { mes: '21/07 → 20/08', unidades_mes: 120, taxa_atual: 2.5, comissao: 300 },
    { ok: true, total: 143 },
    { ok: true, total: 500 },
  );
  assert.ok(texto.includes('FECHAMENTO DO PERÍODO 21/07 → 20/08'), texto);
  assert.ok(texto.includes('💰 Comissão: *R$ 300,00*'), texto);
  assert.ok(texto.includes('🛵 Entregas/despesas Rod: R$ 143,00'), texto);
  assert.ok(texto.includes('Total a pagar: R$ 443,00'), texto);
  assert.ok(texto.includes('💵 Dinheiro em mãos (Rod): R$ 500,00'), texto);
  assert.ok(texto.includes('Rod repassa R$ 57,00'), texto);
});

teste('fechamento avisa quando não conseguiu somar as despesas (não paga a menos calado)', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    { mes: '21/07 → 20/08', unidades_mes: 120, taxa_atual: 2.5, comissao: 300 },
    null,
    { ok: true, total: 500 },
  );
  assert.ok(texto.includes('Não consegui somar as entregas'), texto);
  assert.ok(!texto.includes('Total a pagar'), 'sem despesas confiáveis não pode anunciar total');
  assert.ok(!texto.includes('Acerto'), 'sem o total a pagar não dá pra fechar o acerto');
});

teste('fechamento avisa quando não conseguiu somar o dinheiro em mãos', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    { mes: '21/07 → 20/08', unidades_mes: 120, taxa_atual: 2.5, comissao: 300 },
    { ok: true, total: 143 },
    null,
  );
  assert.ok(texto.includes('Total a pagar: R$ 443,00'), texto);
  assert.ok(texto.includes('Não consegui somar o dinheiro'), texto);
  assert.ok(!texto.includes('Acerto'), texto);
});

teste('o fechamento do relatório diário puxa despesas E dinheiro do ciclo', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '21/07 → 20/08', fecha_hoje: true, unidades_mes: 120,
      unidades_hoje: 4, taxa_atual: 2.5, comissao: 300,
    },
  };
  respostas.bot_despesas_rod = (body) => body.p_tipo === 'dinheiro'
    ? { status: 200, body: { ok: true, total: 500, itens: [] } }
    : { status: 200, body: { ok: true, total: 143, itens: [] } };

  const texto = await ctx.mod.textoComissaoRelatorio();
  assert.ok(texto.includes('Total a pagar: R$ 443,00'), texto);
  assert.ok(texto.includes('Dinheiro em mãos (Rod): R$ 500,00'), texto);
  assert.ok(texto.includes('Rod repassa R$ 57,00'), texto);
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

// --- /adicionar N (oposto do /anular, só o dono) ---------------------------

const COMISSAO_BASE = {
  ok: true, mes: '21/08 → 20/09', unidades_hoje: 0, unidades_mes: 39,
  taxa_atual: 2.5, comissao: 97.5, faltam_para_proxima: 762, proxima_taxa: 2.65,
};

teste('/adicionar 3 pelo dono chama a RPC com autor e mostra o extrato', async (ctx) => {
  respostas.bot_adicionar_comissao = { status: 200, body: { ok: true, unidades_adicionadas: 3 } };
  respostas.bot_comissao = { status: 200, body: { ...COMISSAO_BASE, unidades_mes: 42, comissao: 105 } };

  const [resp] = await mandar(ctx.webhook, update('/adicionar 3', { nome: 'Lucas' }));

  const rpc = chamadas.filter(c => c.fn === 'bot_adicionar_comissao');
  assert.strictEqual(rpc.length, 1, 'deveria chamar bot_adicionar_comissao uma vez');
  assert.strictEqual(rpc[0].body.p_unidades, 3);
  assert.strictEqual(rpc[0].body.p_token, 'token-de-teste');
  assert.deepStrictEqual(rpc[0].body.p_meta, { user_id: String(DONO), nome: 'Lucas' });

  assert.ok(resp.text.includes('➕ 3 unidade(s) adicionada(s) à comissão. (por Lucas)'), resp.text);
  assert.ok(resp.text.includes('Acumulado: *42* produtos'), resp.text);
});

teste('/adicionar pelo Rodrigo é recusado e não chega na RPC', async (ctx) => {
  respostas.bot_adicionar_comissao = { status: 200, body: { ok: true, unidades_adicionadas: 3 } };
  const [resp] = await mandar(ctx.webhook, update('/adicionar 3', { from: FUNCIONARIO, nome: 'Rodrigo' }));
  assert.strictEqual(resp.text, '⛔ Só o dono pode adicionar comissão.');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_adicionar_comissao').length, 0);
});

teste('/adicionar 0 e /adicionar 99 batem na faixa 1..50', async (ctx) => {
  for (const texto of ['/adicionar 0', '/adicionar 99', '/adicionar', '/adicionar abc']) {
    const [resp] = await mandar(ctx.webhook, update(texto));
    assert.strictEqual(resp.text, 'Uso: /adicionar 10 (1 a 50)', `para: ${texto}`);
  }
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_adicionar_comissao').length, 0);
});

teste('/adicionar: o extrato bate com o que o /comissao responde depois', async (ctx) => {
  // Supabase falso com estado: a RPC de adicionar move o acumulado que o
  // bot_comissao devolve — é assim que dá pra ver os dois batendo.
  let acumulado = 39;
  respostas.bot_adicionar_comissao = (body) => {
    acumulado += body.p_unidades;
    return { status: 200, body: { ok: true, unidades_adicionadas: body.p_unidades } };
  };
  respostas.bot_comissao = () => ({
    status: 200,
    body: { ...COMISSAO_BASE, unidades_mes: acumulado, comissao: acumulado * 2.5 },
  });

  const [antes] = await mandar(ctx.webhook, update('/comissao'));
  assert.ok(antes.text.includes('Acumulado: *39* produtos'), antes.text);

  const [resp] = await mandar(ctx.webhook, update('/adicionar 3'));
  assert.ok(resp.text.includes('Acumulado: *42* produtos'), resp.text);

  const [depois] = await mandar(ctx.webhook, update('/comissao'));
  assert.ok(depois.text.includes('Acumulado: *42* produtos'), depois.text);
});

teste('/adicionar: erro da RPC não vira adição fantasma', async (ctx) => {
  respostas.bot_adicionar_comissao = { status: 200, body: { ok: false, erro: 'quantidade deve ser de 1 a 50' } };
  const [resp] = await mandar(ctx.webhook, update('/adicionar 3'));
  assert.ok(resp.text.includes('quantidade deve ser de 1 a 50'), resp.text);
  assert.ok(!resp.text.includes('adicionada(s)'), 'não pode confirmar o que não entrou');
});

teste('/adicionar: extrato fora do ar não apaga a confirmação da adição', async (ctx) => {
  respostas.bot_adicionar_comissao = { status: 200, body: { ok: true, unidades_adicionadas: 3 } };
  respostas.bot_comissao = { status: 500, body: { message: 'boom' } };
  const [resp] = await mandar(ctx.webhook, update('/adicionar 3'));
  assert.ok(resp.text.includes('➕ 3 unidade(s) adicionada(s)'), resp.text);
  assert.ok(resp.text.includes('não consegui puxar o extrato'), resp.text);
  assert.ok(!resp.text.includes('boom'), 'não deve vazar o erro cru');
});

// --- Relatório semanal (/semana + domingo 14h) -----------------------------

// Fixture no formato da RPC bot_relatorio_semanal. Números pequenos e
// propositais: 2 do top vendem mais do que têm, 1 caiu, 1 empatou.
const SEMANA_FIXTURE = {
  ok: true,
  periodo: '01/09 a 07/09',
  periodo_anterior: '25/08 a 31/08',
  total: 224,
  total_anterior: 202,
  top: [
    { modelo: 'Ignite 50000 (V500)', qtd: 28, qtd_ant: 18, estoque: 19,
      sabores: [{ sabor: 'Grape ice', qtd: 3 }, { sabor: 'Watermelon ice', qtd: 3 }] },
    { modelo: 'Elfbar 30000', qtd: 10, qtd_ant: 15, estoque: 38, sabores: [] },
    { modelo: 'Oxbar 50000', qtd: 9, qtd_ant: 9, estoque: 17,
      sabores: [{ sabor: 'Strawberry Ice', qtd: 2 }] },
  ],
  top_sabores: [
    { sabor: 'Strawberry Ice', modelo: 'Ignite 5500 (V55)', qtd: 3 },
    { sabor: 'Grape ice', modelo: 'Ignite 50000 (V500)', qtd: 3 },
  ],
  repor: [{ modelo: 'Ignite 50000 (V500)', vendeu: 28, estoque: 19 }],
  parados: [{ modelo: 'Elfbar 45000', estoque: 7 }],
  parados_extra: [{ modelo: 'Stikadinho', estoque: 63 }, { modelo: 'Kitkat', estoque: 47 }],
};

teste('/semana devolve o relatório no formato combinado', async (ctx) => {
  respostas.bot_relatorio_semanal = { status: 200, body: SEMANA_FIXTURE };
  const [resp] = await mandar(ctx.webhook, update('/semana'));

  const rpc = chamadas.filter(c => c.fn === 'bot_relatorio_semanal');
  assert.strictEqual(rpc.length, 1, 'deveria consultar a RPC uma vez');
  assert.strictEqual(rpc[0].body.p_token, 'token-de-teste');

  const t = resp.text;
  assert.ok(t.includes('RELATÓRIO DA SEMANA (01/09 a 07/09)'), t);
  assert.ok(t.includes('*224* unidades vendidas (semana anterior: 202) 🔥'), t);
  assert.ok(t.includes('1. Ignite 50000 (V500) — 28 un (18) 🔥 · estoque 19 ⚠️'), t);
  assert.ok(t.includes('   Grape ice 3 · Watermelon ice 3'), t);
  assert.ok(t.includes('1. Strawberry Ice — 3 un (Ignite 5500 (V55))'), t);
  assert.ok(t.includes('· Ignite 50000 (V500) — vendeu 28, tem 19'), t);
  assert.ok(t.includes('· Elfbar 45000 — 7 un'), t);
  assert.ok(t.includes('🍬 Encalhados: Stikadinho 63 · Kitkat 47'), t);
  assert.ok(!t.includes('R$'), 'relatório semanal não fala em dinheiro');
});

teste('semanal: setas comparam com a semana anterior (🔥 / 📉 / ➡️)', async (ctx) => {
  const t = ctx.mod.montarRelatorioSemanal(SEMANA_FIXTURE);
  assert.ok(t.includes('2. Elfbar 30000 — 10 un (15) 📉'), t);
  assert.ok(t.includes('3. Oxbar 50000 — 9 un (9) ➡️'), t);
  // estoque cobre o que vendeu → sem ⚠️ na linha
  const linhaOxbar = t.split('\n').find(l => l.startsWith('3. Oxbar'));
  assert.ok(!linhaOxbar.includes('⚠️'), linhaOxbar);
});

teste('semanal: sem parados o texto diz isso em vez de sumir com a seção', async (ctx) => {
  const t = ctx.mod.montarRelatorioSemanal({ ...SEMANA_FIXTURE, parados: [] });
  assert.ok(t.includes('📉 *PARADOS*'), t);
  assert.ok(t.includes('· nenhum pod parado 👏'), t);
});

teste('semanal: seção vazia (menos PARADOS) é omitida inteira', async (ctx) => {
  const t = ctx.mod.montarRelatorioSemanal({
    ok: true, periodo: '01/09 a 07/09', total: 0, total_anterior: 0,
    top: [], top_sabores: [], repor: [], parados: [], parados_extra: [],
  });
  assert.ok(!t.includes('TOP MODELOS'), t);
  assert.ok(!t.includes('TOP SABORES'), t);
  assert.ok(!t.includes('REPOR'), t);
  assert.ok(!t.includes('Encalhados'), t);
  assert.ok(t.includes('nenhum pod parado'), t);
  assert.ok(t.includes('*0* unidades vendidas (semana anterior: 0) ➡️'), t);
});

teste('semanal: respeita os limites de cada seção', async (ctx) => {
  const muitos = n => Array.from({ length: n }, (_, i) => i);
  const t = ctx.mod.montarRelatorioSemanal({
    ok: true, periodo: '01/09 a 07/09', total: 99, total_anterior: 1,
    top: muitos(10).map(i => ({ modelo: `Modelo${i}`, qtd: 9, qtd_ant: 1, estoque: 99, sabores: [] })),
    top_sabores: muitos(12).map(i => ({ sabor: `Sabor${i}`, modelo: 'M', qtd: 2 })),
    repor: muitos(10).map(i => ({ modelo: `Repor${i}`, vendeu: 5, estoque: 1 })),
    parados: muitos(9).map(i => ({ modelo: `Parado${i}`, estoque: 3 })),
    parados_extra: muitos(8).map(i => ({ modelo: `Doce${i}`, estoque: 4 })),
  });
  assert.ok(t.includes('6. Modelo5') && !t.includes('7. Modelo6'), 'top: 6 modelos');
  assert.ok(t.includes('8. Sabor7') && !t.includes('9. Sabor8'), 'sabores: 8');
  assert.ok(t.includes('Repor7') && !t.includes('Repor8'), 'repor: 8');
  assert.ok(t.includes('Parado5') && !t.includes('Parado6'), 'parados: 6');
  assert.ok(t.includes('Doce4') && !t.includes('Doce5'), 'encalhados: 5');
});

teste('semanal: RPC fora do ar vira aviso amigável e o bot segue vivo', async (ctx) => {
  respostas.bot_relatorio_semanal = { status: 500, body: { message: 'boom' } };
  const [erro] = await mandar(ctx.webhook, update('/semana'));
  assert.ok(erro.text.includes('Não consegui montar o relatório da semana'), erro.text);
  assert.ok(!erro.text.includes('boom'), 'não deve vazar o erro cru');

  // ok:false também é tratado, e o comando seguinte responde normal
  respostas.bot_relatorio_semanal = { status: 200, body: { ok: false, erro: 'sem dados' } };
  const [recusa] = await mandar(ctx.webhook, update('/semana'));
  assert.ok(recusa.text.includes('Não consegui montar'), recusa.text);

  respostas.bot_relatorio_semanal = { status: 200, body: SEMANA_FIXTURE };
  const [depois] = await mandar(ctx.webhook, update('/semana'));
  assert.ok(depois.text.includes('RELATÓRIO DA SEMANA'), depois.text);
});

teste('semanal: o envio automático vai pro grupo de VENDAS', async (ctx) => {
  respostas.bot_relatorio_semanal = { status: 200, body: SEMANA_FIXTURE };
  await ctx.mod.enviarRelatorioSemanal();
  assert.strictEqual(enviadas.length, 1, JSON.stringify(enviadas));
  assert.strictEqual(String(enviadas[0].chat_id), String(GRUPO_VENDAS));
  assert.ok(enviadas[0].text.includes('RELATÓRIO DA SEMANA'), enviadas[0].text);
});

teste('semanal: o agendamento cai domingo às 14h de Brasília', async (ctx) => {
  const cron = require('node-cron');
  assert.strictEqual(ctx.mod.CRON_RELATORIO_SEMANAL, '0 14 * * 0');
  assert.ok(cron.validate(ctx.mod.CRON_RELATORIO_SEMANAL), 'expressão inválida');

  // Não basta conferir a string: é o node-cron quem decide quando ela dispara.
  const task = cron.schedule(ctx.mod.CRON_RELATORIO_SEMANAL, () => {},
    { timezone: 'America/Sao_Paulo', scheduled: false });
  const proximo = new Date(task.getNextRun());
  task.destroy();

  const emSP = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(proximo);
  assert.ok(/dom/i.test(emSP), `deveria cair num domingo: ${emSP}`);
  assert.ok(/14:00/.test(emSP), `deveria cair às 14:00: ${emSP}`);
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
    mod._resetCachePalavras(); // o cache de palavras atravessa testes (TTL 1 min)
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
