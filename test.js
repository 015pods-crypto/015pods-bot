// Teste local do bot. Sobe dois servidores falsos — Telegram (captura o que o
// bot mandaria) e Supabase (responde às RPCs) — aponta as env vars para eles e
// dirige o webhook com updates de verdade.
//
// Rodar: node test.js   (não precisa de rede nem de token real)

const http = require('http');
const assert = require('assert');

const enviadas = [];      // mensagens que o bot mandou pro Telegram
const chamadas = [];      // { fn, body } de cada RPC recebida
let respostas = {};       // { [fn]: { status, body } } — o que o Supabase falso devolve
const chamadasGemini = []; // { url, body } de cada leitura de comprovante
let respostaGemini = null; // o que o Gemini falso devolve (null = valor padrão)

// Envelope de resposta do Gemini: o JSON do comprovante vem como TEXTO dentro
// de candidates[0].content.parts[0].text.
function geminiJson(obj) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] };
}

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
    const url = req.url || '';
    // getFile + download do arquivo: o caminho que o bot usa pra ler comprovante.
    if (url.includes('/getFile')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { file_path: 'photos/comprovante.jpg' } }));
      return;
    }
    if (url.includes('/file/bot')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('bytes-falsos-da-foto'));
      return;
    }
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

  const gemini = await servidorFalso((req, raw, res) => {
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    chamadasGemini.push({ url: req.url, body });
    const r = respostaGemini || { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });

  return {
    telegram: `http://127.0.0.1:${telegram.address().port}`,
    supabase: `http://127.0.0.1:${supabase.address().port}`,
    gemini: `http://127.0.0.1:${gemini.address().port}`,
    fechar: () => { telegram.close(); supabase.close(); gemini.close(); },
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

// Mensagem com foto (o Telegram manda várias resoluções; o bot pega a maior)
// ou com documento.
function updateArquivo({ chat = GRUPO_VENDAS, from = DONO, caption, doc, size = 1024 } = {}) {
  const message = {
    message_id: updateId,
    from: { id: from },
    chat: { id: chat, type: 'group' },
  };
  if (caption) message.caption = caption;
  if (doc) message.document = { file_id: 'doc-1', mime_type: doc, file_size: size };
  else {
    message.photo = [
      { file_id: 'foto-peq', file_size: 200 },
      { file_id: 'foto-grande', file_size: size },
    ];
  }
  return { update_id: updateId++, message };
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

  // Agora o webhook consulta mais de uma chave (grupo de pedidos, palavras):
  // procurar a chave certa em vez de assumir a ordem das chamadas.
  const cfg = chamadas.filter(c => c.fn === 'bot_config' && c.body.p_key === 'bot_despesa_palavras');
  assert.ok(cfg.length >= 1, 'deveria consultar a lista no banco');
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

// --- Grupo de pedidos: /chatid e /setgrupopedidos --------------------------

teste('/chatid responde o id do chat ao dono, em qualquer chat', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/chatid', { chat: -777, nome: 'Lucas' }));
  assert.ok(resp.text.includes('-777'), resp.text);
  assert.ok(resp.text.includes('Chat atual'), resp.text);
});

// É o ponto do comando: o grupo novo ainda NÃO está na lista de chats
// atendidos, e mesmo assim o /chatid tem que responder lá dentro.
teste('/chatid funciona em grupo que o bot ainda não atende', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/chatid', { chat: -999888 }));
  assert.ok(resp.text.includes('-999888'), resp.text);
});

teste('/chatid ignora quem não é dono (chat aleatório não faz o bot falar)', async (ctx) => {
  await mandar(ctx.webhook, update('/chatid', { chat: -999888, from: FUNCIONARIO }), { esperaResposta: false });
  assert.strictEqual(enviadas.length, 0, `não devia responder: ${JSON.stringify(enviadas)}`);
});

teste('/setgrupopedidos sem argumento grava o chat atual', async (ctx) => {
  respostas.bot_config_set = { status: 200, body: { ok: true } };
  const [resp] = await mandar(ctx.webhook, update('/setgrupopedidos', { chat: -4321 }));

  const rpc = chamadas.filter(c => c.fn === 'bot_config_set');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_key, 'telegram_grupo_pedidos');
  assert.strictEqual(rpc[0].body.p_valor, '-4321');
  assert.ok(resp.text.includes('Grupo de pedidos definido'), resp.text);
});

teste('/setgrupopedidos aceita id explícito e recusa não-dono', async (ctx) => {
  respostas.bot_config_set = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('/setgrupopedidos -100123'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_config_set')[0].body.p_valor, '-100123');

  chamadas.length = 0;
  await mandar(ctx.webhook, update('/setgrupopedidos', { from: FUNCIONARIO }), { esperaResposta: false });
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_config_set').length, 0);
});

teste('com grupo de pedidos configurado, /pedido é recusado no grupo de VENDAS', async (ctx) => {
  respostas.bot_config = (body) => body.p_key === 'telegram_grupo_pedidos'
    ? { status: 200, body: { ok: true, valor: '-4321' } }
    : { status: 200, body: { ok: true, valor: 'ENTREGA,UBER' } };

  const [resp] = await mandar(ctx.webhook, update('/pedido'));
  assert.ok(resp.text.includes('grupo de pedidos'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_montar_pedido').length, 0);
});

teste('sem a chave configurada, /pedido responde onde for chamado', async (ctx) => {
  respostas.bot_montar_pedido = { status: 200, body: { ok: true, grupos: [], usou_lista_fornecedor: true } };
  const [resp] = await mandar(ctx.webhook, update('/pedido'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_montar_pedido').length, 1);
  assert.ok(resp.text.includes('Nada a pedir'), resp.text);
});

// --- Parse da lista do fornecedor -----------------------------------------

// Trecho no formato real: emojis, negrito, recados e separadores no meio.
const LISTA_REAL = [
  '━━━━━━━━━━━━━━━',
  '🃏 *IGNITE 5500 (V55)* 🃏',
  '• Strawberry Ice',
  '• Grape Ice',
  '- Blueberry Ice',
  '',
  '📣 RECADOS AOS QUERIDOS CLIENTES',
  'NÃO ACEITAMOS DEVOLUÇÃO',
  'AGRADECEMOS A PREFERÊNCIA 🙏',
  '━━━━━━━━━━━━━━━',
  '🔱 *ELFBAR 30000* 🔱',
  '* Watermelon Bubblegum',
  '• Cherry Cola',
  '',
  '🔥 PROMOÇÃO: leve 10 por R$ 250',
  'Faça seu pedido pelo WhatsApp',
  '🃏 LOST MARY MT 20k 🃏',
  '• Hawaii juice',
  '🎉',
].join('\n');

teste('parse da lista real: pega modelos e sabores, descarta recado e separador', async (ctx) => {
  const itens = ctx.mod.parseListaFornecedor(LISTA_REAL);
  assert.deepStrictEqual(itens, [
    { modelo: 'IGNITE 5500 (V55)', sabor: 'Strawberry Ice' },
    { modelo: 'IGNITE 5500 (V55)', sabor: 'Grape Ice' },
    { modelo: 'IGNITE 5500 (V55)', sabor: 'Blueberry Ice' },
    { modelo: 'ELFBAR 30000', sabor: 'Watermelon Bubblegum' },
    { modelo: 'ELFBAR 30000', sabor: 'Cherry Cola' },
    { modelo: 'LOST MARY MT 20k', sabor: 'Hawaii juice' },
  ]);
});

teste('parse: sabor antes de qualquer modelo é descartado, e repetido não duplica', async (ctx) => {
  const itens = ctx.mod.parseListaFornecedor(
    '• Orfao sem modelo\n🃏 IGNITE 5500 🃏\n• Grape\n• Grape\n• grape',
  );
  assert.deepStrictEqual(itens, [{ modelo: 'IGNITE 5500', sabor: 'Grape' }]);
});

teste('/fornecedor com a lista na mesma mensagem importa e resume', async (ctx) => {
  // Corpo real da RPC (números do import de verdade: 295 de 337).
  respostas.bot_fornecedor_importar = {
    status: 200,
    body: {
      ok: true, lista_id: '11111111-2222-3333-4444-555555555555',
      casaram: 295, nao_casaram: 42,
      modelos_novos: ['ADJUST ICE 40K - BY ELFBAR', 'V400 MIX SLIM'],
      sabores_novos: [{ modelo: 'LOST MARY MT 20k', sabor: 'Hawaii juice' }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update(`/fornecedor\n${LISTA_REAL}`));

  const rpc = chamadas.filter(c => c.fn === 'bot_fornecedor_importar');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_itens.length, 6);
  assert.deepStrictEqual(rpc[0].body.p_itens[0], { modelo: 'IGNITE 5500 (V55)', sabor: 'Strawberry Ice' });

  // 337 = casaram + nao_casaram (a RPC não manda o total pronto).
  assert.ok(resp.text.includes('295 de 337 itens casaram (88%)'), resp.text);
  assert.ok(resp.text.includes('ADJUST ICE 40K - BY ELFBAR, V400 MIX SLIM'), resp.text);
  assert.ok(resp.text.includes('42 sabores sem cadastro'), resp.text);
  assert.ok(resp.text.includes('LOST MARY MT 20k · Hawaii juice'), resp.text);
  assert.ok(resp.text.includes('/apelido'), resp.text);
});

teste('/fornecedor sozinho espera a lista na mensagem seguinte', async (ctx) => {
  respostas.bot_fornecedor_importar = { status: 200, body: { ok: true, casaram: 6, nao_casaram: 0 } };

  const [aviso] = await mandar(ctx.webhook, update('/fornecedor'));
  assert.ok(aviso.text.includes('próxima mensagem'), aviso.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_importar').length, 0);

  const [resp] = await mandar(ctx.webhook, update(LISTA_REAL));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_importar').length, 1);
  assert.ok(resp.text.includes('Lista importada'), resp.text);
});

// A lista tem dezenas de linhas começando com "-": sem o desvio, a primeira
// delas cairia na rota de BAIXA DE ESTOQUE.
teste('lista pendente não é confundida com baixa de estoque', async (ctx) => {
  respostas.bot_fornecedor_importar = { status: 200, body: { ok: true, casaram: 6, nao_casaram: 0 } };
  await mandar(ctx.webhook, update('/fornecedor'));
  await mandar(ctx.webhook, update(LISTA_REAL));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0,
    'a lista não podia virar movimento de estoque');
});

teste('conversa curta depois do /fornecedor NÃO é tratada como lista', async (ctx) => {
  await mandar(ctx.webhook, update('/fornecedor'));
  chamadas.length = 0;
  await mandar(ctx.webhook, update('beleza, já mando'), { esperaResposta: false });
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_importar').length, 0);
});

teste('/fornecedor com lista sem nenhum item reconhecível avisa em vez de importar', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update(
    '/fornecedor\nbom dia\ncomo vai\ntudo certo por aí\nabraço\nfalou mesmo\n' + 'x'.repeat(200),
  ));
  assert.ok(resp.text.includes('Não achei nenhum item'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_importar').length, 0);
});

teste('/fornecedor é recusado pro funcionário', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update(`/fornecedor\n${LISTA_REAL}`, { from: FUNCIONARIO }));
  assert.ok(resp.text.includes('Só o dono'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_importar').length, 0);
});

// --- /apelido --------------------------------------------------------------

teste('/apelido TE 30K = Elfbar 30000 grava os dois lados', async (ctx) => {
  respostas.bot_fornecedor_apelido = {
    status: 200, body: { ok: true, apelido: 'TE 30K', modelo: 'Elfbar 30000' },
  };
  const [resp] = await mandar(ctx.webhook, update('/apelido TE 30K = Elfbar 30000'));

  const rpc = chamadas.filter(c => c.fn === 'bot_fornecedor_apelido');
  assert.strictEqual(rpc[0].body.p_apelido, 'TE 30K');
  assert.strictEqual(rpc[0].body.p_modelo, 'Elfbar 30000');
  assert.ok(resp.text.includes('Apelido gravado'), resp.text);
});

teste('/apelido com modelo inexistente mostra o erro da RPC', async (ctx) => {
  respostas.bot_fornecedor_apelido = {
    status: 200, body: { ok: false, erro: 'modelo não encontrado no sistema' },
  };
  const [resp] = await mandar(ctx.webhook, update('/apelido TE 30K = Naoexiste 999'));
  assert.ok(resp.text.includes('modelo não encontrado no sistema'), resp.text);
});

teste('/apelido sem o "=" mostra o uso', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/apelido TE 30K Elfbar'));
  assert.ok(resp.text.includes('Uso:'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_fornecedor_apelido').length, 0);
});

// --- /pedido ---------------------------------------------------------------

// Corpo real da RPC: grupos[] já ordenados por giro, itens[] por quantidade.
const PEDIDO_OK = {
  ok: true, usou_lista_fornecedor: true, teto: 15000, semanas: 4,
  total_custo: 14969.0, unidades: 252,
  grupos: [
    {
      modelo: 'Ignite 5500 (V55)', unidades: 7, valor: 350.0,
      itens: [
        { sabor: 'Strawberry Ice', qtd: 4, estoque: 1, vendas: 12 },
        { sabor: 'Grape Ice', qtd: 3, estoque: 0, vendas: 9 },
      ],
    },
    {
      modelo: 'ELFBAR 30000', unidades: 2, valor: 100.0,
      itens: [{ sabor: 'Cherry Cola', qtd: 2, estoque: 0, vendas: 4 }],
    },
  ],
};

teste('/pedido sai no formato de encaminhar pro fornecedor', async (ctx) => {
  respostas.bot_montar_pedido = { status: 200, body: PEDIDO_OK };
  const [resp] = await mandar(ctx.webhook, update('/pedido'));

  assert.ok(resp.text.includes('*PEDIDO SUGERIDO*'), resp.text);
  assert.ok(resp.text.includes('_252 un · R$ 14.969 de custo_'), resp.text);
  assert.ok(resp.text.includes('\n4 Strawberry Ice\n3 Grape Ice'), resp.text);
  assert.ok(resp.text.includes('*ELFBAR 30000*'), resp.text);
  // A ordem dos grupos é a da RPC (prioridade de giro): Ignite antes de Elfbar.
  assert.ok(resp.text.indexOf('Ignite 5500') < resp.text.indexOf('ELFBAR 30000'), resp.text);
  // Sem estoque/vendas na mensagem principal — é o que vai pro fornecedor.
  assert.ok(!resp.text.includes('tem 1'), resp.text);
  assert.ok(!resp.text.includes('vendeu'), resp.text);
});

teste('/pedido passa teto e semanas pra RPC (padrão 4 semanas)', async (ctx) => {
  respostas.bot_montar_pedido = { status: 200, body: PEDIDO_OK };

  await mandar(ctx.webhook, update('/pedido'));
  let b = chamadas.filter(c => c.fn === 'bot_montar_pedido').pop().body;
  assert.strictEqual(b.p_teto, null);
  assert.strictEqual(b.p_semanas, 4);
  assert.strictEqual(b.p_so_fornecedor, true);

  await mandar(ctx.webhook, update('/pedido 15000'));
  b = chamadas.filter(c => c.fn === 'bot_montar_pedido').pop().body;
  assert.strictEqual(b.p_teto, 15000);
  assert.strictEqual(b.p_semanas, 4);

  await mandar(ctx.webhook, update('/pedido 15000 8'));
  b = chamadas.filter(c => c.fn === 'bot_montar_pedido').pop().body;
  assert.strictEqual(b.p_teto, 15000);
  assert.strictEqual(b.p_semanas, 8);
});

teste('/pedido detalhe 15000 mostra estoque e vendas, e respeita o teto', async (ctx) => {
  respostas.bot_montar_pedido = { status: 200, body: PEDIDO_OK };
  const [resp] = await mandar(ctx.webhook, update('/pedido detalhe 15000'));

  const b = chamadas.filter(c => c.fn === 'bot_montar_pedido').pop().body;
  assert.strictEqual(b.p_teto, 15000, 'o teto tem que chegar na RPC mesmo com "detalhe"');
  assert.ok(resp.text.includes('4 Strawberry Ice (tem 1 · vendeu 12)'), resp.text);
  assert.ok(resp.text.includes('3 Grape Ice (tem 0 · vendeu 9)'), resp.text);
});

teste('zerado aparece com a quantidade que a RPC mandou', async (ctx) => {
  respostas.bot_montar_pedido = {
    status: 200,
    body: {
      ok: true, usou_lista_fornecedor: true, unidades: 2, total_custo: 100,
      grupos: [{
        modelo: 'ELFBAR 30000', unidades: 2, valor: 100,
        itens: [{ sabor: 'Cherry Cola', qtd: 2, estoque: 0, vendas: 0 }],
      }],
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/pedido'));
  assert.ok(resp.text.includes('2 Cherry Cola'), resp.text);
});

teste('/pedido sem lista de fornecedor ativa avisa NO TOPO', async (ctx) => {
  respostas.bot_montar_pedido = {
    status: 200, body: { ...PEDIDO_OK, usou_lista_fornecedor: false },
  };
  const [resp] = await mandar(ctx.webhook, update('/pedido'));
  assert.ok(resp.text.startsWith('⚠️ Sem lista de fornecedor ativa'), resp.text);
  assert.ok(resp.text.includes('Use /fornecedor antes'), resp.text);
});

teste('/pedido longo quebra em várias mensagens sem cortar bloco de modelo', async (ctx) => {
  const grupos = [];
  for (let m = 0; m < 40; m++) {
    const itens = [];
    for (let s = 0; s < 8; s++) {
      itens.push({ sabor: `Sabor comprido numero ${s}`, qtd: 3, estoque: 0, vendas: 1 });
    }
    grupos.push({ modelo: `MODELO NUMERO ${m} COM NOME COMPRIDO`, unidades: 24, valor: 1200, itens });
  }
  respostas.bot_montar_pedido = {
    status: 200, body: { ok: true, usou_lista_fornecedor: true, unidades: 960, total_custo: 50000, grupos },
  };

  const antes = enviadas.length;
  await mandar(ctx.webhook, update('/pedido'));
  await new Promise(r => setTimeout(r, 400));
  const partes = enviadas.slice(antes);

  assert.ok(partes.length > 1, `devia ter quebrado em várias mensagens (${partes.length})`);
  for (const p of partes) {
    assert.ok(p.text.length <= 4096, `mensagem passou de 4096: ${p.text.length}`);
  }
  // Nenhuma parte pode começar com linha de sabor solta: isso é bloco cortado.
  for (const p of partes.slice(1)) {
    assert.ok(/^🃏/.test(p.text.trim()), `parte começa no meio de um bloco:\n${p.text.slice(0, 80)}`);
  }
  // E nenhum item pode ter sumido na quebra.
  const juntas = partes.map(p => p.text).join('\n');
  assert.strictEqual((juntas.match(/Sabor comprido numero/g) || []).length, 320);
});

teste('/pedido não encosta no estoque', async (ctx) => {
  respostas.bot_montar_pedido = { status: 200, body: PEDIDO_OK };
  await mandar(ctx.webhook, update('/pedido 15000'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
});

teste('RPC de pedido ausente diz qual SQL falta', async (ctx) => {
  respostas.bot_montar_pedido = { status: 404, body: { message: 'Could not find the function' } };
  const [resp] = await mandar(ctx.webhook, update('/pedido'));
  assert.ok(resp.text.includes('bot_montar_pedido'), resp.text);
  assert.ok(resp.text.includes('falta rodar o SQL'), resp.text);
});

// --- Atacado ---------------------------------------------------------------

// Item de baixa no formato real da bot_movimentar_estoque (cada baixa cria uma
// venda própria, por isso um sale_id por item).
function baixaOk({ saleId = '77', model = 'Elfbar 30000', flavor = 'Cherry', qty = 6, after = 4 } = {}) {
  return {
    input: `${model} ${flavor}`.toLowerCase(), status: 'ok', direction: 'baixa', qty,
    flavor_id: 'f-uuid', model, flavor, stock_before: after + qty, stock_after: after,
    sale_id: saleId, unit_price: 75.0, sem_preco: false,
  };
}

teste('venda com "atacado" tira a palavra do produto e marca a venda PELO ID', async (ctx) => {
  respostas.bot_movimentar_estoque = { status: 200, body: { resultados: [baixaOk()] } };
  respostas.bot_marcar_atacado = {
    status: 200, body: { ok: true, ja_marcada: false, sale_id: '77', unidades: 6, quando: '14/09 19:32' },
  };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado'));

  // A palavra de controle NÃO pode ir junto na busca do produto.
  const mov = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.deepStrictEqual(mov[0].body.p_items, [{ produto: 'elfbar 30000 cherry', qty: -6 }]);

  const marca = chamadas.filter(c => c.fn === 'bot_marcar_atacado');
  assert.strictEqual(marca.length, 1, 'deveria marcar a venda');
  assert.strictEqual(marca[0].body.p_sale_id, '77', 'tem que marcar PELO ID da venda registrada');

  assert.ok(resp.text.includes('Baixa registrada (ATACADO)'), resp.text);
  assert.ok(resp.text.includes('*ATACADO:* 6x Elfbar 30000 – Cherry'), resp.text);
});

teste('ATACADO em maiúscula e no meio da linha também vale', async (ctx) => {
  respostas.bot_movimentar_estoque = { status: 200, body: { resultados: [baixaOk()] } };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('-6 ATACADO elfbar 30000 cherry'));
  const mov = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.deepStrictEqual(mov[0].body.p_items, [{ produto: 'elfbar 30000 cherry', qty: -6 }]);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 1);
});

// Defesa: se um item vier sem sale_id, a RPC recusa ('sale_id obrigatório') e
// o aviso é DAQUELE item — nunca um chute em "a última venda".
teste('item sem sale_id vira aviso do item, sem chutar outra venda', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'baixa', model: 'Elfbar 30000',
        flavor: 'Cherry', qty: 6, stock_after: 4,
      }],
    },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: false, erro: 'sale_id obrigatório' } };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado'));

  const marca = chamadas.filter(c => c.fn === 'bot_marcar_atacado');
  assert.strictEqual(marca[0].body.p_sale_id, null, 'sem id, manda null e deixa a RPC recusar');
  assert.ok(resp.text.includes('Não marquei'), resp.text);
  assert.ok(resp.text.includes('Elfbar 30000 – Cherry'), resp.text);
});

teste('várias baixas + ATACADO marca TODAS as vendas da mensagem', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [
        baixaOk({ saleId: '77', model: 'Elfbar 30000', flavor: 'Cherry', qty: 6 }),
        baixaOk({ saleId: '78', model: 'Ignite 5500', flavor: 'Grape Ice', qty: 2 }),
      ],
    },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };

  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado\n-2 ignite 5500 grape ice'));

  const marca = chamadas.filter(c => c.fn === 'bot_marcar_atacado');
  assert.strictEqual(marca.length, 2, 'as DUAS vendas da mensagem têm que ser marcadas');
  assert.deepStrictEqual(marca.map(c => c.body.p_sale_id).sort(), ['77', '78']);
  assert.ok(resp.text.includes('*ATACADO:* 6x Elfbar 30000 – Cherry, 2x Ignite 5500 – Grape Ice'), resp.text);
});

// Falha numa venda não pode derrubar as outras nem desfazer nada: avisa só a
// que ficou de fora.
teste('falha em uma das vendas avisa SÓ ela, e as outras seguem marcadas', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [
        baixaOk({ saleId: '77', model: 'Elfbar 30000', flavor: 'Cherry', qty: 6 }),
        baixaOk({ saleId: '78', model: 'Ignite 5500', flavor: 'Grape Ice', qty: 2 }),
      ],
    },
  };
  respostas.bot_marcar_atacado = (body) => body.p_sale_id === '78'
    ? { status: 200, body: { ok: false, erro: 'venda não encontrada' } }
    : { status: 200, body: { ok: true, ja_marcada: false } };

  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado\n-2 ignite 5500 grape ice'));

  assert.ok(resp.text.includes('*ATACADO:* 6x Elfbar 30000 – Cherry'), resp.text);
  assert.ok(resp.text.includes('Não marquei *Ignite 5500 – Grape Ice*'), resp.text);
  assert.ok(resp.text.includes('venda não encontrada'), resp.text);
  assert.ok(!resp.text.includes('2x Ignite 5500 – Grape Ice'), 'a que falhou não pode aparecer como marcada');
});

teste('venda normal não vira atacado nem chama a RPC de marca', async (ctx) => {
  respostas.bot_movimentar_estoque = { status: 200, body: { resultados: [baixaOk()] } };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
  assert.ok(resp.text.includes('Baixa registrada!'), resp.text);
  assert.ok(!resp.text.includes('ATACADO'), resp.text);
});

// Produto que não existe não pode gerar marca: marcaria a venda ANTERIOR.
teste('atacado em baixa que falhou não marca venda nenhuma', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200, body: { resultados: [{ status: 'nao_encontrado', input: 'elfbari cherry' }] },
  };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbari cherry atacado'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0,
    'sem baixa não pode marcar a venda anterior');
  assert.ok(resp.text.includes('Produto não encontrado'), resp.text);
});

teste('"-6 atacado" (só a palavra) é formato inválido, não venda', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('-6 atacado'));
  assert.ok(resp.text.includes('Formato inválido'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
});

teste('falha ao marcar atacado avisa no grupo (não some em silêncio)', async (ctx) => {
  respostas.bot_movimentar_estoque = { status: 200, body: { resultados: [baixaOk()] } };
  respostas.bot_marcar_atacado = { status: 404, body: { message: 'Could not find the function' } };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado'));
  assert.ok(resp.text.includes('Baixa registrada (ATACADO)'), resp.text);
  assert.ok(resp.text.includes('bot_marcar_atacado'), resp.text);
  assert.ok(resp.text.includes('/atacado'), resp.text);
});

teste('venda já marcada não duplica a palavra, só avisa', async (ctx) => {
  respostas.bot_movimentar_estoque = { status: 200, body: { resultados: [baixaOk()] } };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: true } };
  const [resp] = await mandar(ctx.webhook, update('-6 elfbar 30000 cherry atacado'));
  assert.ok(resp.text.includes('Já estava marcada'), resp.text);
});

teste('entrada com a palavra atacado limpa o texto mas não marca nada', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'entrada', model: 'Elfbar 30000',
        flavor: 'Cherry', qty: 6, stock_after: 10,
      }],
    },
  };
  await mandar(ctx.webhook, update('+6 elfbar 30000 cherry atacado', { chat: GRUPO_REPOSICAO }));
  const mov = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.deepStrictEqual(mov[0].body.p_items, [{ produto: 'elfbar 30000 cherry', qty: 6 }]);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
});

// --- /atacado como CABEÇALHO (o bug do pedido não debitado) ----------------
//
// O Rodrigo mandou "/atacado" e colou o pedido embaixo. O comando venceu, as
// linhas de baixa foram ignoradas SEM AVISO, nenhum estoque saiu, e o bot
// ainda foi oferecer pra marcar a venda ANTERIOR (de outro pedido).

teste('REGRESSÃO: "/atacado" + baixas debita tudo e marca tudo', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [
        baixaOk({ saleId: '77', model: 'Elfbar 30000', flavor: 'Cherry', qty: 2, after: 10 }),
        baixaOk({ saleId: '78', model: 'Ignite 50000', flavor: 'Grape Ice', qty: 3, after: 7 }),
      ],
    },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };

  const [resp] = await mandar(ctx.webhook, update('/atacado\n-2 elfbar 30000 cherry\n-3 ignite 50000 grape ice'));

  // 1. As duas baixas TÊM que sair do estoque.
  const mov = chamadas.filter(c => c.fn === 'bot_movimentar_estoque');
  assert.strictEqual(mov.length, 1, 'as linhas de baixa não podem ser ignoradas');
  assert.deepStrictEqual(mov[0].body.p_items, [
    { produto: 'elfbar 30000 cherry', qty: -2 },
    { produto: 'ignite 50000 grape ice', qty: -3 },
  ]);

  // 2. As duas vendas marcadas como atacado.
  const marca = chamadas.filter(c => c.fn === 'bot_marcar_atacado');
  assert.deepStrictEqual(marca.map(c => c.body.p_sale_id).sort(), ['77', '78']);

  // 3. E NUNCA olhar a venda anterior quando a mensagem traz itens.
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0,
    'mensagem com itens não pode mexer em venda anterior');

  assert.ok(resp.text.includes('2x Elfbar 30000 – Cherry'), resp.text);
  assert.ok(resp.text.includes('3x Ignite 50000 – Grape Ice'), resp.text);
});

teste('"atacado" sem barra como cabeçalho vale igual', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [
        baixaOk({ saleId: '1', model: 'Elfbar 30000', flavor: 'Cherry', qty: 2 }),
        baixaOk({ saleId: '2', model: 'Ignite 50000', flavor: 'Grape', qty: 3 }),
        baixaOk({ saleId: '3', model: 'Oxbar 30000', flavor: 'White Grape', qty: 1 }),
      ],
    },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };

  await mandar(ctx.webhook, update('atacado\n-2 elfbar 30000 cherry\n-3 ignite 50000 grape\n-1 oxbar 30000 white grape'));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 1);
  assert.deepStrictEqual(
    chamadas.filter(c => c.fn === 'bot_marcar_atacado').map(c => c.body.p_sale_id).sort(),
    ['1', '2', '3'],
  );
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
});

teste('cabeçalho de atacado no FIM da mensagem também vale', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200, body: { resultados: [baixaOk({ saleId: '77', qty: 2 })] },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  await mandar(ctx.webhook, update('-2 elfbar 30000 cherry\n/atacado'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 1);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
});

// O pior sintoma do bug era o silêncio.
teste('mensagem com cabeçalho e nenhum item explica, e não toca em venda anterior', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/atacado bom dia pessoal'));
  assert.ok(resp.text.includes('Não reconheci item nenhum'), resp.text);
  assert.ok(resp.text.includes('/atacado'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
});

teste('cabeçalho de atacado com linha barrada pela regra de grupo não fica mudo', async (ctx) => {
  // Entrada (+) no grupo de VENDAS: barrada. A mensagem não pode sumir calada.
  const respostasBot = await mandar(ctx.webhook, update('/atacado\n+2 elfbar 30000 cherry'));
  const textos = respostasBot.map(r => r.text).join('\n');
  await new Promise(r => setTimeout(r, 150));
  const todos = enviadas.map(r => r.text).join('\n');
  assert.ok(todos.includes('Reposição é no grupo de reposição') || textos.includes('Reposição'), todos);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
});

// --- /atacado sozinho: marca direto, com desfazer -------------------------

const ULTIMA_VENDA = {
  status: 200,
  body: {
    ok: true, sale_id: '77', unidades: 6, itens: '6x Elfbar 30000 Cherry',
    quando: '14/09 16:31', ja_marcada: false,
  },
};

teste('/atacado sozinho marca a última venda na hora (sem confirmar)', async (ctx) => {
  respostas.bot_ultima_venda = ULTIMA_VENDA;
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };

  const [resp] = await mandar(ctx.webhook, update('/atacado'));

  const marca = chamadas.filter(c => c.fn === 'bot_marcar_atacado');
  assert.strictEqual(marca.length, 1, 'tem que marcar direto, sem etapa de confirmação');
  assert.strictEqual(marca[0].body.p_sale_id, '77');
  assert.ok(resp.text.includes('Marquei como atacado'), resp.text);
  assert.ok(resp.text.includes('6x Elfbar 30000 Cherry'), resp.text);
  assert.ok(resp.text.includes('16:31'), resp.text);
  assert.ok(resp.text.includes('/desatacado'), resp.text);
});

teste('/atacado sozinho usa a janela de 30 minutos', async (ctx) => {
  respostas.bot_ultima_venda = ULTIMA_VENDA;
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('/atacado'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda')[0].body.p_minutos, 30);
});

teste('"atacado" sozinho, sem barra, também corrige', async (ctx) => {
  respostas.bot_ultima_venda = ULTIMA_VENDA;
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  const [resp] = await mandar(ctx.webhook, update('atacado'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 1);
  assert.ok(resp.text.includes('Marquei como atacado'), resp.text);
});

teste('/desatacado desfaz a marca da venda que acabou de ser marcada', async (ctx) => {
  respostas.bot_ultima_venda = ULTIMA_VENDA;
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  respostas.bot_desmarcar_atacado = { status: 200, body: { ok: true } };

  await mandar(ctx.webhook, update('/atacado'));
  const [resp] = await mandar(ctx.webhook, update('/desatacado'));

  const des = chamadas.filter(c => c.fn === 'bot_desmarcar_atacado');
  assert.strictEqual(des.length, 1);
  assert.strictEqual(des[0].body.p_sale_id, '77', 'tem que desfazer a MESMA venda');
  assert.ok(resp.text.includes('removida'), resp.text);
});

teste('/desatacado desfaz TODAS as vendas da última marcação automática', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200,
    body: {
      resultados: [
        baixaOk({ saleId: '77', model: 'Elfbar 30000', flavor: 'Cherry', qty: 2 }),
        baixaOk({ saleId: '78', model: 'Ignite 50000', flavor: 'Grape Ice', qty: 3 }),
      ],
    },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  respostas.bot_desmarcar_atacado = { status: 200, body: { ok: true } };

  await mandar(ctx.webhook, update('/atacado\n-2 elfbar 30000 cherry\n-3 ignite 50000 grape ice'));
  await mandar(ctx.webhook, update('/desatacado'));

  assert.deepStrictEqual(
    chamadas.filter(c => c.fn === 'bot_desmarcar_atacado').map(c => c.body.p_sale_id).sort(),
    ['77', '78'],
  );
});

teste('/desatacado sem marcação recente avisa em vez de chutar', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/desatacado'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_desmarcar_atacado').length, 0);
  assert.ok(resp.text.includes('Não tenho marcação recente'), resp.text);
});

teste('/atacado em venda já marcada avisa e oferece desfazer', async (ctx) => {
  respostas.bot_ultima_venda = {
    status: 200,
    body: {
      ok: true, sale_id: '77', unidades: 6, itens: '6x Elfbar 30000 Cherry',
      quando: '14/09 16:31', ja_marcada: true,
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/atacado'));
  assert.ok(resp.text.includes('já estava marcada'), resp.text);
  assert.ok(resp.text.includes('/desatacado'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0,
    'não precisa remarcar o que já está marcado');
});

teste('/atacado sem venda na janela explica o que fazer', async (ctx) => {
  respostas.bot_ultima_venda = {
    status: 200, body: { ok: false, erro: 'nenhuma venda do bot nos últimos 30 minutos' },
  };
  const [resp] = await mandar(ctx.webhook, update('/atacado'));
  assert.ok(resp.text.includes('nenhuma venda do bot nos últimos 30 minutos'), resp.text);
  assert.ok(resp.text.includes('cole as linhas de baixa embaixo'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
});

teste('/atacado cai pra unidades se a venda vier sem o campo itens', async (ctx) => {
  respostas.bot_ultima_venda = {
    status: 200, body: { ok: true, sale_id: '77', unidades: 6, quando: '14/09 16:31' },
  };
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  const [resp] = await mandar(ctx.webhook, update('/atacado'));
  assert.ok(resp.text.includes('6 unidade(s)'), resp.text);
  assert.ok(!resp.text.includes('undefined'), resp.text);
});

teste('/atacado do Rodrigo é recusado sem ROD_USER_ID, e a recusa mostra o id dele', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/atacado', { from: FUNCIONARIO }));
  assert.ok(resp.text.includes('Só o dono e o Rodrigo'), resp.text);
  assert.ok(resp.text.includes(String(FUNCIONARIO)), `a recusa tem que mostrar o id: ${resp.text}`);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
});

teste('podeMarcarAtacado: dono sempre; outro só com ROD_USER_ID cadastrado', async (ctx) => {
  assert.strictEqual(ctx.mod.podeMarcarAtacado(DONO), true);
  assert.strictEqual(ctx.mod.podeMarcarAtacado(FUNCIONARIO), false);
});

teste('separarControleAtacado tira a palavra e sinaliza o controle', async (ctx) => {
  const f = ctx.mod.separarControleAtacado;
  assert.deepStrictEqual(f('/atacado\n-2 elfbar cherry'),
    { controle: true, linhas: ['-2 elfbar cherry'] });
  assert.deepStrictEqual(f('atacado\n-2 a\n-3 b'),
    { controle: true, linhas: ['-2 a', '-3 b'] });
  // Tudo na mesma linha também vale.
  assert.deepStrictEqual(f('/atacado -2 elfbar cherry'),
    { controle: true, linhas: ['-2 elfbar cherry'] });
  assert.deepStrictEqual(f('/atacado'), { controle: true, linhas: [] });
  // Não é controle:
  assert.deepStrictEqual(f('-2 elfbar cherry'), { controle: false, linhas: ['-2 elfbar cherry'] });
  assert.deepStrictEqual(f('/desatacado'), { controle: false, linhas: ['/desatacado'] });
  assert.deepStrictEqual(f('atacadao 30000'), { controle: false, linhas: ['atacadao 30000'] });
});

// /desatacado não pode ser engolido pelo roteamento do atacado.
teste('/desatacado não é confundido com cabeçalho de atacado', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/desatacado'));
  assert.ok(resp.text.includes('Não tenho marcação recente'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
});

teste('/desatacado avisa quando a RPC não existe no banco', async (ctx) => {
  respostas.bot_ultima_venda = ULTIMA_VENDA;
  respostas.bot_marcar_atacado = { status: 200, body: { ok: true, ja_marcada: false } };
  respostas.bot_desmarcar_atacado = { status: 404, body: { message: 'Could not find the function' } };

  await mandar(ctx.webhook, update('/atacado'));
  const [resp] = await mandar(ctx.webhook, update('/desatacado'));
  assert.ok(resp.text.includes('bot_desmarcar_atacado'), resp.text);
  assert.ok(resp.text.includes('falta rodar o SQL'), resp.text);
});

// Venda normal (sem a palavra) segue intocada por tudo isso.
teste('regressão: baixa normal não vira atacado nem chama nada de atacado', async (ctx) => {
  respostas.bot_movimentar_estoque = {
    status: 200, body: { resultados: [baixaOk({ saleId: '77', qty: 2 })] },
  };
  const [resp] = await mandar(ctx.webhook, update('-2 elfbar 30000 cherry'));
  assert.ok(resp.text.includes('Baixa registrada!'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_marcar_atacado').length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_ultima_venda').length, 0);
});

// --- Quebra varejo/atacado no extrato --------------------------------------

const COMISSAO_ATACADO = {
  ok: true, mes: '21/08 → 20/09', unidades_hoje: 12,
  unidades_mes: 812, unidades_varejo: 780, unidades_atacado: 32,
  taxa_atual: 2.65, valor_atacado: 2, comissao: 2131,
  faltam_para_proxima: 88, proxima_taxa: 3,
};

teste('/comissao mostra a quebra varejo + atacado', async (ctx) => {
  respostas.bot_comissao = { status: 200, body: COMISSAO_ATACADO };
  const [resp] = await mandar(ctx.webhook, update('/comissao'));

  assert.ok(resp.text.includes('Unidades: *812* (780 varejo + 32 atacado)'), resp.text);
  assert.ok(resp.text.includes('Varejo: 780 × R$ 2,65 = R$ 2.067,00'), resp.text);
  assert.ok(resp.text.includes('Atacado: 32 × R$ 2,00 = R$ 64,00'), resp.text);
  assert.ok(resp.text.includes('💰 Comissão: *R$ 2.131,00*'), resp.text);
});

// O total exibido é o da RPC, não a soma feita aqui: quem decide é o banco.
teste('o total do extrato vem da RPC, mesmo se não bater com as parcelas', async (ctx) => {
  respostas.bot_comissao = { status: 200, body: { ...COMISSAO_ATACADO, comissao: 9999 } };
  const [resp] = await mandar(ctx.webhook, update('/comissao'));
  assert.ok(resp.text.includes('R$ 9.999,00'), resp.text);
});

teste('ciclo sem atacado mantém o extrato de sempre', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: {
      ok: true, mes: '21/08 → 20/09', unidades_hoje: 4, unidades_mes: 120,
      unidades_varejo: 120, unidades_atacado: 0, taxa_atual: 1.5,
      valor_atacado: 2, comissao: 180, faltam_para_proxima: 30, proxima_taxa: 2,
    },
  };
  const [resp] = await mandar(ctx.webhook, update('/comissao'));
  assert.ok(resp.text.includes('Acumulado: *120* produtos'), resp.text);
  assert.ok(!resp.text.includes('atacado'), `sem atacado no ciclo não polui o extrato: ${resp.text}`);
});

teste('fechamento mostra a quebra de atacado', async (ctx) => {
  const texto = ctx.mod.montarFechamento(
    COMISSAO_ATACADO, { ok: true, total: 143 }, { ok: true, total: 500 },
  );
  assert.ok(texto.includes('Unidades: *812* (780 varejo + 32 atacado)'), texto);
  assert.ok(texto.includes('Atacado: 32 × R$ 2,00 = R$ 64,00'), texto);
  assert.ok(texto.includes('💰 Comissão: *R$ 2.131,00*'), texto);
  assert.ok(texto.includes('Total a pagar: R$ 2.274,00'), texto);
});

// --- Comprovantes de pagamento --------------------------------------------

const REGISTRO_OK = {
  status: 200,
  body: { ok: true, duplicado: false, total_dia: 450, qtd_dia: 3 },
};

teste('foto de comprovante é lida, registrada e somada no caixa do dia', async (ctx) => {
  respostaGemini = {
    status: 200,
    body: geminiJson({
      valor: 150.0, codigo: 'E12345ABC', pago_em: '2026-09-15T16:42:00',
      pagador: 'Fulano', banco: 'Nubank', confianca: 'alta',
    }),
  };
  respostas.bot_comprovante_registrar = REGISTRO_OK;

  const [resp] = await mandar(ctx.webhook, updateArquivo());

  // Leu a foto MAIOR (a pequena borra o valor).
  assert.strictEqual(chamadasGemini.length, 1, 'deveria chamar o Gemini uma vez');
  const partes = chamadasGemini[0].body.contents[0].parts;
  assert.ok(partes[0].text.includes('comprovante de pagamento brasileiro'), 'faltou o prompt');
  assert.strictEqual(partes[1].inline_data.mime_type, 'image/jpeg');
  assert.ok(partes[1].inline_data.data.length > 0, 'faltou a imagem em base64');

  const rpc = chamadas.filter(c => c.fn === 'bot_comprovante_registrar');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_valor, 150);
  assert.strictEqual(rpc[0].body.p_codigo, 'E12345ABC');
  assert.strictEqual(rpc[0].body.p_pagador, 'Fulano');
  assert.strictEqual(rpc[0].body.p_banco, 'Nubank');
  assert.strictEqual(rpc[0].body.p_arquivo_id, 'foto-grande');
  assert.strictEqual(rpc[0].body.p_bruto.codigo, 'E12345ABC', 'p_bruto tem que levar o JSON inteiro');

  assert.strictEqual(resp.text,
    '💰 Comprovante lido: *R$ 150,00* · total do dia: R$ 450,00 (3 comprovantes)');
});

teste('comprovante reenviado (mesmo código) vira alerta de duplicado', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, codigo: 'E12345ABC', confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200,
    body: { ok: true, duplicado: true, motivo: 'codigo', valor: 150, quando: '14/09 16:31' },
  };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(resp.text.includes('COMPROVANTE JÁ ENVIADO'), resp.text);
  assert.ok(resp.text.includes('14/09 16:31'), resp.text);
  assert.ok(resp.text.includes('R$ 150,00'), resp.text);
  assert.ok(resp.text.includes('antes de liberar o pedido'), resp.text);
});

teste('mesmo valor repetido vira aviso mais leve', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200,
    body: { ok: true, duplicado: true, motivo: 'valor_repetido', valor: 150, quando: '16:20' },
  };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(resp.text.includes('Já entrou um comprovante de R$ 150,00'), resp.text);
  assert.ok(resp.text.includes('Se for outro pagamento, tudo bem'), resp.text);
  assert.ok(!resp.text.includes('JÁ ENVIADO'), resp.text);
});

teste('confiança baixa NÃO registra e pede o valor', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: null, confianca: 'baixa' }) };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0,
    'sem confiança não pode registrar');
  assert.ok(resp.text.includes('Não consegui ler o valor'), resp.text);
});

// Valor com confiança baixa é o modelo dizendo que chutou.
teste('valor lido com confiança baixa também é recusado', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'baixa' }) };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Não consegui ler o valor'), resp.text);
});

teste('confiança média é aceita', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'media' }) };
  respostas.bot_comprovante_registrar = REGISTRO_OK;
  await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 1);
});

// Foto que não é comprovante: o modelo não acha valor, e o bot só não registra.
teste('imagem que não é comprovante não registra nada', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: null, confianca: 'baixa' }) };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Confere e me diz o valor'), resp.text);
});

teste('falha da API do Gemini não quebra o bot: pede o valor', async (ctx) => {
  respostaGemini = { status: 429, body: { error: { message: 'quota exceeded' } } };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Não consegui ler o valor'), resp.text);
  assert.ok(!resp.text.includes('quota'), 'não vaza o erro cru da API');

  // E o bot segue vivo depois.
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = REGISTRO_OK;
  const [depois] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(depois.text.includes('Comprovante lido'), depois.text);
});

teste('resposta do modelo embrulhada em ```json ainda é lida', async (ctx) => {
  respostaGemini = {
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: '```json\n{"valor": 99.9, "confianca": "alta"}\n```' }] } }] },
  };
  respostas.bot_comprovante_registrar = REGISTRO_OK;
  await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar')[0].body.p_valor, 99.9);
});

teste('resposta do modelo que não é JSON pede o valor', async (ctx) => {
  respostaGemini = {
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: 'não consegui ver direito' }] } }] },
  };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Não consegui ler o valor'), resp.text);
});

teste('valor fora da faixa registra, mas avisa', async (ctx) => {
  respostas.bot_comprovante_registrar = { status: 200, body: { ok: true, duplicado: false, total_dia: 2500, qtd_dia: 1 } };

  respostaGemini = { status: 200, body: geminiJson({ valor: 2500, confianca: 'alta' }) };
  const [alto] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(alto.text.includes('Comprovante lido'), alto.text);
  assert.ok(alto.text.includes('valor fora do padrão'), alto.text);

  respostaGemini = { status: 200, body: geminiJson({ valor: 10, confianca: 'alta' }) };
  const [baixo] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(baixo.text.includes('valor fora do padrão'), baixo.text);

  // Dentro da faixa não leva aviso nenhum.
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
  const [normal] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(!normal.text.includes('fora do padrão'), normal.text);
});

// Valor alto entra DIRETO: não existe confirmação no meio do caminho.
teste('valor alto é registrado na hora, sem perguntar nada', async (ctx) => {
  respostas.bot_comprovante_registrar = { status: 200, body: { ok: true, duplicado: false, total_dia: 3500, qtd_dia: 1 } };
  respostaGemini = { status: 200, body: geminiJson({ valor: 3500, confianca: 'alta' }) };

  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 1);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar')[0].body.p_valor, 3500);
  assert.ok(resp.text.includes('Comprovante lido: *R$ 3.500,00*'), resp.text);
  assert.ok(!resp.text.includes('Confirma'), resp.text);
});

teste('PDF é aceito; sticker e vídeo são ignorados', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = REGISTRO_OK;

  await mandar(ctx.webhook, updateArquivo({ doc: 'application/pdf' }));
  assert.strictEqual(chamadasGemini[0].body.contents[0].parts[1].inline_data.mime_type, 'application/pdf');

  chamadas.length = 0; chamadasGemini.length = 0; enviadas.length = 0;
  await mandar(ctx.webhook, updateArquivo({ doc: 'video/mp4' }), { esperaResposta: false });
  assert.strictEqual(chamadasGemini.length, 0, 'vídeo não é comprovante');
  assert.strictEqual(enviadas.length, 0);
});

// O caso mais comum do dia a dia: a foto do comprovante vem com a baixa
// escrita na legenda. Tem que fazer as DUAS coisas, numa resposta só.
function baixaParaComprovante() {
  return {
    status: 200,
    body: {
      resultados: [{
        status: 'ok', direction: 'baixa', model: 'Ignite 40000 Mix (V400Mix)',
        flavor: 'Grape Ice', qty: 1, stock_after: 1, sale_id: '77',
      }],
    },
  };
}

teste('foto COM legenda de baixa dá baixa E registra o comprovante', async (ctx) => {
  respostas.bot_movimentar_estoque = baixaParaComprovante();
  respostaGemini = { status: 200, body: geminiJson({ valor: 165, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200, body: { ok: true, duplicado: false, total_dia: 1250, qtd_dia: 9 },
  };

  const respostasBot = await mandar(ctx.webhook, updateArquivo({ caption: '-1 ignite 40000 mix grape ice' }));
  await new Promise(r => setTimeout(r, 200));

  // As duas coisas aconteceram...
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 1);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 1);
  assert.strictEqual(chamadasGemini.length, 1, 'a imagem tem que ser lida também');

  // ...numa RESPOSTA SÓ.
  assert.strictEqual(respostasBot.length, 1, `devia ser uma mensagem só: ${JSON.stringify(respostasBot)}`);
  assert.strictEqual(enviadas.length, 1, 'nada de segunda mensagem solta');
  const t = respostasBot[0].text;
  assert.ok(t.includes('Baixa registrada'), t);
  assert.ok(t.includes('Ignite 40000 Mix (V400Mix) – Grape Ice'), t);
  assert.ok(t.includes('Estoque baixo'), t);
  assert.ok(t.includes('💰 Comprovante lido: *R$ 165,00* · total do dia: R$ 1.250,00 (9 comprovantes)'), t);
});

// Independência: a baixa é a parte que não pode falhar.
teste('falha ao ler a imagem NÃO impede a baixa', async (ctx) => {
  respostas.bot_movimentar_estoque = baixaParaComprovante();
  respostaGemini = { status: 429, body: { error: { message: 'quota exceeded' } } };

  const [resp] = await mandar(ctx.webhook, updateArquivo({ caption: '-1 ignite 40000 mix grape ice' }));
  await new Promise(r => setTimeout(r, 200));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_movimentar_estoque').length, 1,
    'a baixa tem que acontecer de qualquer jeito');
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
  assert.ok(resp.text.includes('Não consegui ler o valor'), resp.text);
});

teste('comprovante duplicado com legenda de baixa: baixa entra, comprovante avisa', async (ctx) => {
  respostas.bot_movimentar_estoque = baixaParaComprovante();
  respostaGemini = { status: 200, body: geminiJson({ valor: 165, codigo: 'E1', confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200,
    body: { ok: true, duplicado: true, motivo: 'codigo', valor: 165, quando: '14/09 16:31' },
  };

  const [resp] = await mandar(ctx.webhook, updateArquivo({ caption: '-1 ignite 40000 mix grape ice' }));
  await new Promise(r => setTimeout(r, 200));

  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
  assert.ok(resp.text.includes('COMPROVANTE JÁ ENVIADO'), resp.text);
  assert.ok(!resp.text.includes('total do dia'), 'duplicado não soma no caixa');
});

teste('valor fora da faixa com legenda de baixa registra e avisa', async (ctx) => {
  respostas.bot_movimentar_estoque = baixaParaComprovante();
  respostaGemini = { status: 200, body: geminiJson({ valor: 2500, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200, body: { ok: true, duplicado: false, total_dia: 2500, qtd_dia: 1 },
  };

  const [resp] = await mandar(ctx.webhook, updateArquivo({ caption: '-1 ignite 40000 mix grape ice' }));
  await new Promise(r => setTimeout(r, 200));
  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
  assert.ok(resp.text.includes('valor fora do padrão'), resp.text);
});

teste('texto de baixa SEM foto segue igual, sem tocar no Gemini', async (ctx) => {
  respostas.bot_movimentar_estoque = baixaParaComprovante();
  const [resp] = await mandar(ctx.webhook, update('-1 ignite 40000 mix grape ice'));
  assert.strictEqual(chamadasGemini.length, 0);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 0);
  assert.ok(resp.text.includes('Baixa registrada'), resp.text);
  assert.ok(!resp.text.includes('Comprovante'), resp.text);
});

// Legenda de COMANDO continua sendo comando puro: a foto é só anexo.
teste('foto com legenda de comando não vira comprovante', async (ctx) => {
  respostas.bot_caixa_dia = { status: 200, body: { ok: true, dia: '15/09', comprovantes_qtd: 0 } };
  const [resp] = await mandar(ctx.webhook, updateArquivo({ caption: '/caixa' }));
  assert.strictEqual(chamadasGemini.length, 0, 'comando não dispara leitura de imagem');
  assert.ok(resp.text.includes('CAIXA DE'), resp.text);
});

// Linha barrada pela regra de grupo não pode levar a foto junto pro ralo.
teste('legenda barrada pela regra de grupo ainda registra o comprovante', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 165, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = {
    status: 200, body: { ok: true, duplicado: false, total_dia: 165, qtd_dia: 1 },
  };
  // "+" no grupo de VENDAS é barrado.
  await mandar(ctx.webhook, updateArquivo({ caption: '+1 ignite 40000 mix grape ice' }));
  await new Promise(r => setTimeout(r, 250));

  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_registrar').length, 1,
    'a foto não podia ser descartada junto com a linha barrada');
  const todos = enviadas.map(e => e.text).join('\n');
  assert.ok(todos.includes('Comprovante lido'), todos);
});

teste('foto no grupo de reposição não é tratada como comprovante', async (ctx) => {
  await mandar(ctx.webhook, updateArquivo({ chat: GRUPO_REPOSICAO }), { esperaResposta: false });
  assert.strictEqual(chamadasGemini.length, 0);
  assert.strictEqual(enviadas.length, 0);
});

teste('RPC de comprovante ausente diz qual SQL falta', async (ctx) => {
  respostaGemini = { status: 200, body: geminiJson({ valor: 150, confianca: 'alta' }) };
  respostas.bot_comprovante_registrar = { status: 404, body: { message: 'Could not find the function' } };
  const [resp] = await mandar(ctx.webhook, updateArquivo());
  assert.ok(resp.text.includes('bot_comprovante_registrar'), resp.text);
  assert.ok(resp.text.includes('falta rodar o SQL'), resp.text);
});

// --- /caixa ----------------------------------------------------------------

const CAIXA_DIA = {
  ok: true, dia: '15/09', comprovantes_total: 450, comprovantes_qtd: 3, ticket_medio: 150,
  itens: [
    { hora: '16:42', valor: 150 },
    { hora: '17:03', valor: 89.9 },
    { hora: '18:20', valor: 210.1 },
  ],
};

teste('/caixa mostra o total recebido, o ticket médio e a lista', async (ctx) => {
  respostas.bot_caixa_dia = { status: 200, body: CAIXA_DIA };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(resp.text.includes('CAIXA DE 15/09'), resp.text);
  assert.ok(resp.text.includes('Total recebido: *R$ 450,00*'), resp.text);
  assert.ok(resp.text.includes('3 comprovantes · ticket médio R$ 150,00'), resp.text);
  assert.ok(resp.text.includes('16:42 · R$ 150,00'), resp.text);
  assert.ok(resp.text.includes('17:03 · R$ 89,90'), resp.text);
});

// O motivo do ajuste: preço de tabela x venda negociada dava diferença falsa
// todo dia. A comparação não pode voltar por descuido.
teste('/caixa NÃO compara com as vendas do sistema', async (ctx) => {
  respostas.bot_caixa_dia = { status: 200, body: CAIXA_DIA };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(!/Diferen[çc]a/i.test(resp.text), resp.text);
  assert.ok(!/Vendas registradas/i.test(resp.text), resp.text);
  assert.ok(!/dadas baixa/i.test(resp.text), resp.text);
});

teste('/caixa com mais de 15 comprovantes mostra só o resumo', async (ctx) => {
  const itens = [];
  for (let i = 0; i < 16; i++) itens.push({ hora: `1${i % 10}:00`, valor: 50 });
  respostas.bot_caixa_dia = {
    status: 200,
    body: { ok: true, dia: '15/09', comprovantes_total: 800, comprovantes_qtd: 16, ticket_medio: 50, itens },
  };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(resp.text.includes('16 comprovantes · ticket médio R$ 50,00'), resp.text);
  assert.ok(!resp.text.includes('· R$ 50,00\n'), 'lista longa não pode virar parede de texto');
  assert.strictEqual(resp.text.split('\n').length, 3, resp.text);
});

teste('/caixa em dia sem comprovante diz isso, sem ticket médio zerado', async (ctx) => {
  respostas.bot_caixa_dia = {
    status: 200,
    body: { ok: true, dia: '15/09', comprovantes_total: 0, comprovantes_qtd: 0, ticket_medio: 0, itens: [] },
  };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(resp.text.includes('Nenhum comprovante registrado'), resp.text);
  assert.ok(!resp.text.includes('ticket médio'), resp.text);
});

teste('/caixa 15/09 consulta o dia pedido', async (ctx) => {
  respostas.bot_caixa_dia = { status: 200, body: { ok: true, dia: '15/09', comprovantes_qtd: 0 } };
  await mandar(ctx.webhook, update('/caixa 15/09'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_dia')[0].body.p_data, '2026-09-15');
});

teste('/caixa com data inválida mostra o uso', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/caixa ontem'));
  assert.ok(resp.text.includes('Uso: /caixa'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_dia').length, 0);
});

teste('/caixa com a RPC fora do ar avisa em vez de calar', async (ctx) => {
  respostas.bot_caixa_dia = { status: 500, body: { message: 'boom' } };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(resp.text.includes('Erro ao consultar o caixa'), resp.text);
  assert.ok(!resp.text.includes('boom'), resp.text);
});

teste('o resumo diário das 23:59 leva o caixa junto', async (ctx) => {
  respostas.bot_comissao = {
    status: 200,
    body: { ok: true, mes: '21/08 → 20/09', unidades_hoje: 4, unidades_mes: 120, taxa_atual: 1.5, comissao: 180 },
  };
  respostas.bot_caixa_dia = { status: 200, body: CAIXA_DIA };
  await ctx.mod.enviarResumoVendas();
  const noGrupo = enviadas.find(e => String(e.chat_id) === String(GRUPO_VENDAS));
  assert.ok(noGrupo.text.includes('CAIXA DE 15/09'), noGrupo.text);
  assert.ok(noGrupo.text.includes('Total recebido: *R$ 450,00*'), noGrupo.text);
  // O resumo das 23:59 já é longo: entra só o total, sem a lista e sem
  // comparação nenhuma com as vendas.
  assert.ok(!noGrupo.text.includes('16:42 · R$ 150,00'), noGrupo.text);
  assert.ok(!/Diferen[çc]a/i.test(noGrupo.text), noGrupo.text);
});

// --- Grupo de faturamento --------------------------------------------------

const GRUPO_FATURAMENTO = -300;

// Config falsa com o grupo de faturamento já configurado.
function configComFaturamento(id = GRUPO_FATURAMENTO) {
  respostas.bot_config = (body) => body.p_key === 'telegram_grupo_faturamento'
    ? { status: 200, body: { ok: true, valor: String(id) } }
    : { status: 200, body: { ok: true, valor: '' } };
}

const CAIXA_MES = {
  ok: true, mes: 'Setembro', de: '2026-09-01', ate: '2026-09-30',
  hoje: { total: 1470, qtd: 10 },
  mes_total: 24380, mes_qtd: 165, ticket: 147.76,
  media_dia: 1283.15, projecao: 38494.5,
  melhor_dia: { dia: '2026-09-12', total: 2140 },
  mes_anterior: 31200,
  dias: [
    { dia: '2026-09-01', total: 1240, qtd: 8 },
    { dia: '2026-09-02', total: 980, qtd: 6 },
    { dia: '2026-09-03', total: 0, qtd: 0 },
  ],
};

teste('/setgrupofaturamento grava a chave do grupo', async (ctx) => {
  respostas.bot_config_set = { status: 200, body: { ok: true } };
  const [resp] = await mandar(ctx.webhook, update('/setgrupofaturamento', { chat: GRUPO_FATURAMENTO }));

  const rpc = chamadas.filter(c => c.fn === 'bot_config_set');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_key, 'telegram_grupo_faturamento');
  assert.strictEqual(rpc[0].body.p_valor, String(GRUPO_FATURAMENTO));
  assert.ok(resp.text.includes('Grupo de faturamento definido'), resp.text);
});

teste('/setgrupofaturamento é recusado pro funcionário', async (ctx) => {
  await mandar(ctx.webhook, update('/setgrupofaturamento', { from: FUNCIONARIO }), { esperaResposta: false });
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_config_set').length, 0);
});

teste('/faturamento responde no grupo de faturamento', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 200, body: CAIXA_MES };

  const [resp] = await mandar(ctx.webhook, update('/faturamento', { chat: GRUPO_FATURAMENTO }));
  assert.ok(resp.text.includes('FATURAMENTO'), resp.text);
  assert.ok(resp.text.includes('Hoje: *R$ 1.470,00* (10 pagamentos)'), resp.text);
  assert.ok(resp.text.includes('Total: *R$ 24.380,00*'), resp.text);
  assert.ok(resp.text.includes('Média por dia: R$ 1.283,15'), resp.text);
  assert.ok(resp.text.includes('Melhor dia: 12/09 com R$ 2.140,00'), resp.text);
  assert.ok(resp.text.includes('Projeção do mês: R$ 38.494,50'), resp.text);
  assert.ok(resp.text.includes('Mês passado fechou em R$ 31.200,00'), resp.text);
  assert.ok(resp.text.includes('📈 acima do mês passado'), resp.text);
});

// O ponto do grupo: faturamento não pode vazar pro grupo de vendas.
teste('/faturamento é recusado no grupo de VENDAS', async (ctx) => {
  configComFaturamento();
  const [resp] = await mandar(ctx.webhook, update('/faturamento'));
  assert.ok(resp.text.includes('grupo de faturamento'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_mes').length, 0);
});

// Sem a chave configurada vale SÓ o privado do dono — ao contrário dos
// pedidos, que valem em qualquer lugar enquanto não são configurados.
teste('sem grupo configurado, /faturamento só responde no privado do dono', async (ctx) => {
  respostas.bot_caixa_mes = { status: 200, body: CAIXA_MES };

  const [noGrupo] = await mandar(ctx.webhook, update('/faturamento'));
  assert.ok(noGrupo.text.includes('grupo de faturamento'), noGrupo.text);

  const [noPrivado] = await mandar(ctx.webhook, update('/faturamento', { chat: DONO, tipo: 'private' }));
  assert.ok(noPrivado.text.includes('FATURAMENTO'), noPrivado.text);
});

teste('projeção abaixo do mês passado vira seta pra baixo', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 200, body: { ...CAIXA_MES, projecao: 28000 } };
  const [resp] = await mandar(ctx.webhook, update('/faturamento', { chat: GRUPO_FATURAMENTO }));
  assert.ok(resp.text.includes('📉 abaixo do mês passado'), resp.text);
});

teste('mês anterior zerado não vira linha nenhuma', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 200, body: { ...CAIXA_MES, mes_anterior: 0 } };
  const [resp] = await mandar(ctx.webhook, update('/faturamento', { chat: GRUPO_FATURAMENTO }));
  assert.ok(!resp.text.includes('Mês passado'), resp.text);
  assert.ok(!resp.text.includes('📈'), resp.text);
  assert.ok(!resp.text.includes('📉'), resp.text);
});

teste('/faturamento 08/2026 consulta o mês pedido', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = {
    status: 200,
    body: { ...CAIXA_MES, mes: 'Agosto', de: '2026-08-01', ate: '2026-08-31', mes_total: 31200 },
  };
  const [resp] = await mandar(ctx.webhook, update('/faturamento 08/2026', { chat: GRUPO_FATURAMENTO }));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_mes')[0].body.p_ref, '2026-08-01');
  // Mês fechado: "hoje" e "projeção" não fazem sentido.
  assert.ok(!resp.text.includes('Hoje:'), resp.text);
  assert.ok(!resp.text.includes('Projeção'), resp.text);
  assert.ok(resp.text.includes('Total: *R$ 31.200,00*'), resp.text);
});

teste('/faturamento com argumento inválido mostra o uso', async (ctx) => {
  configComFaturamento();
  const [resp] = await mandar(ctx.webhook, update('/faturamento agosto', { chat: GRUPO_FATURAMENTO }));
  assert.ok(resp.text.includes('Uso: /faturamento'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_mes').length, 0);
});

teste('/relatorio mes lista dia a dia, com os dias sem movimento', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 200, body: CAIXA_MES };
  const [resp] = await mandar(ctx.webhook, update('/relatorio mes', { chat: GRUPO_FATURAMENTO }));

  assert.ok(resp.text.includes('SETEMBRO · dia a dia'), resp.text);
  assert.ok(resp.text.includes('01/09 · R$ 1.240,00 (8)'), resp.text);
  assert.ok(resp.text.includes('03/09 · — sem movimento'), resp.text);
  assert.ok(resp.text.includes('Total: R$ 24.380,00 · 165 pagamentos'), resp.text);
});

// /relatorio sem argumento continua sendo o de ESTOQUE, em qualquer grupo.
teste('/relatorio sozinho continua sendo o relatório de estoque', async (ctx) => {
  configComFaturamento();
  respostas.bot_ler_estoque = { status: 200, body: [] };
  const [resp] = await mandar(ctx.webhook, update('/relatorio'));
  assert.ok(resp.text.includes('Relatório de estoque'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_mes').length, 0);
});

teste('/relatorio mes é recusado fora do grupo de faturamento', async (ctx) => {
  configComFaturamento();
  const [resp] = await mandar(ctx.webhook, update('/relatorio mes'));
  assert.ok(resp.text.includes('grupo de faturamento'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_caixa_mes').length, 0);
});

teste('mês longo quebra em várias mensagens', async (ctx) => {
  configComFaturamento();
  const dias = [];
  for (let i = 1; i <= 31; i++) {
    dias.push({ dia: `2026-09-${String(i).padStart(2, '0')}`, total: 1234.56, qtd: 9 });
  }
  respostas.bot_caixa_mes = { status: 200, body: { ...CAIXA_MES, dias } };

  const partes = await ctx.mod.textosFaturamentoDetalhe(null);
  for (const p of partes) assert.ok(p.length <= 4096, `passou de 4096: ${p.length}`);
  const juntas = partes.join('\n');
  assert.ok(juntas.includes('01/09'), juntas.slice(0, 200));
  assert.ok(juntas.includes('31/09'), 'faltou o último dia');
});

teste('RPC de faturamento ausente diz qual SQL falta', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 404, body: { message: 'Could not find the function' } };
  const [resp] = await mandar(ctx.webhook, update('/faturamento', { chat: GRUPO_FATURAMENTO }));
  assert.ok(resp.text.includes('bot_caixa_mes'), resp.text);
  assert.ok(resp.text.includes('falta rodar o SQL'), resp.text);
});

teste('o resumo das 23:30 vai SÓ pro grupo de faturamento', async (ctx) => {
  configComFaturamento();
  respostas.bot_caixa_mes = { status: 200, body: CAIXA_MES };
  await ctx.mod.enviarFaturamentoDiario();

  assert.strictEqual(enviadas.length, 1, `devia ser uma mensagem só: ${JSON.stringify(enviadas)}`);
  assert.strictEqual(String(enviadas[0].chat_id), String(GRUPO_FATURAMENTO));
  assert.ok(enviadas[0].text.includes('FATURAMENTO'), enviadas[0].text);
  // Nunca no grupo de vendas.
  assert.ok(!enviadas.some(e => String(e.chat_id) === String(GRUPO_VENDAS)));
});

teste('sem grupo configurado, o resumo automático não manda nada', async (ctx) => {
  respostas.bot_caixa_mes = { status: 200, body: CAIXA_MES };
  await ctx.mod.enviarFaturamentoDiario();
  assert.strictEqual(enviadas.length, 0, `não tem pra onde mandar: ${JSON.stringify(enviadas)}`);
});

teste('o resumo de faturamento é agendado às 23:30 de Brasília', async (ctx) => {
  assert.strictEqual(ctx.mod.CRON_FATURAMENTO, '30 23 * * *');
});

// --- /caixa corrigir · apagar · valor --------------------------------------

const LISTA_HOJE = {
  status: 200,
  body: {
    ok: true, dia: 'hoje', comprovantes_total: 3675, comprovantes_qtd: 2,
    itens: [
      { id: 'c-1', hora: '10:14', valor: 175 },
      { id: 'c-2', hora: '11:32', valor: 3500 },
    ],
  },
};

teste('/caixa corrigir lista os comprovantes numerados', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  const [resp] = await mandar(ctx.webhook, update('/caixa corrigir'));
  assert.ok(resp.text.includes('COMPROVANTES DE HOJE'), resp.text);
  assert.ok(resp.text.includes('1 · 10:14 · R$ 175,00'), resp.text);
  assert.ok(resp.text.includes('2 · 11:32 · R$ 3.500,00'), resp.text);
  assert.ok(resp.text.includes('/caixa apagar'), resp.text);
  assert.ok(resp.text.includes('/caixa valor'), resp.text);
});

// O ponto da tarefa: agir pelo ID da lista, nunca por valor nem "o último".
teste('/caixa apagar 2 apaga PELO ID do item 2', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  respostas.bot_comprovante_apagar = { status: 200, body: { ok: true } };

  await mandar(ctx.webhook, update('/caixa corrigir'));
  const [resp] = await mandar(ctx.webhook, update('/caixa apagar 2'));

  const rpc = chamadas.filter(c => c.fn === 'bot_comprovante_apagar');
  assert.strictEqual(rpc.length, 1);
  assert.strictEqual(rpc[0].body.p_id, 'c-2', 'tem que mandar o id, não a posição');
  assert.ok(resp.text.includes('Apagado'), resp.text);
  assert.ok(resp.text.includes('Novo total do dia'), resp.text);
});

teste('/caixa valor 2 235 corrige pelo id e mostra o novo total', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  respostas.bot_comprovante_valor = { status: 200, body: { ok: true, valor_anterior: 3500 } };

  await mandar(ctx.webhook, update('/caixa corrigir'));
  const [resp] = await mandar(ctx.webhook, update('/caixa valor 2 235'));

  const rpc = chamadas.filter(c => c.fn === 'bot_comprovante_valor');
  assert.strictEqual(rpc[0].body.p_id, 'c-2');
  assert.strictEqual(rpc[0].body.p_valor, 235);
  assert.ok(resp.text.includes('Corrigido'), resp.text);
  assert.ok(resp.text.includes('R$ 235,00'), resp.text);
});

teste('/caixa valor aceita vírgula e centavos', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  respostas.bot_comprovante_valor = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('/caixa corrigir'));
  await mandar(ctx.webhook, update('/caixa valor 1 235,50'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_valor')[0].body.p_valor, 235.5);
});

teste('/caixa apagar sem a lista aberta manda abrir primeiro', async (ctx) => {
  const [resp] = await mandar(ctx.webhook, update('/caixa apagar 2'));
  assert.ok(resp.text.includes('/caixa corrigir'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_apagar').length, 0);
});

teste('/caixa apagar com número fora da lista avisa', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  await mandar(ctx.webhook, update('/caixa corrigir'));
  const [resp] = await mandar(ctx.webhook, update('/caixa apagar 9'));
  assert.ok(resp.text.includes('Não existe o número 9'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_apagar').length, 0);
});

// Depois de apagar, as posições mudaram: a lista velha não pode continuar
// valendo, senão o próximo "apagar 2" acerta outro comprovante.
teste('depois de apagar, a lista velha é descartada', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  respostas.bot_comprovante_apagar = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('/caixa corrigir'));
  await mandar(ctx.webhook, update('/caixa apagar 1'));

  chamadas.length = 0;
  const [resp] = await mandar(ctx.webhook, update('/caixa apagar 1'));
  assert.ok(resp.text.includes('/caixa corrigir'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_apagar').length, 0);
});

teste('/caixa corrigir 15/09 mexe em outro dia', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  respostas.bot_comprovante_apagar = { status: 200, body: { ok: true } };
  await mandar(ctx.webhook, update('/caixa corrigir 15/09'));
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovantes_dia')[0].body.p_data, '2026-09-15');

  await mandar(ctx.webhook, update('/caixa apagar 1'));
  // O total conferido depois tem que ser o do MESMO dia, não o de hoje.
  const consultas = chamadas.filter(c => c.fn === 'bot_comprovantes_dia');
  assert.strictEqual(consultas[consultas.length - 1].body.p_data, '2026-09-15');
});

teste('/caixa apagar do funcionário é recusado', async (ctx) => {
  respostas.bot_comprovantes_dia = LISTA_HOJE;
  await mandar(ctx.webhook, update('/caixa corrigir'));
  const [resp] = await mandar(ctx.webhook, update('/caixa apagar 1', { from: FUNCIONARIO }));
  assert.ok(resp.text.includes('Só o dono e o Rodrigo'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovante_apagar').length, 0);
});

teste('/caixa corrigir em dia sem comprovante não abre lista', async (ctx) => {
  respostas.bot_comprovantes_dia = { status: 200, body: { ok: true, dia: 'hoje', itens: [] } };
  const [resp] = await mandar(ctx.webhook, update('/caixa corrigir'));
  assert.ok(resp.text.includes('Nenhum comprovante registrado'), resp.text);

  const [depois] = await mandar(ctx.webhook, update('/caixa apagar 1'));
  assert.ok(depois.text.includes('/caixa corrigir'), depois.text);
});

teste('/caixa sem argumento continua sendo o resumo do dia', async (ctx) => {
  respostas.bot_caixa_dia = { status: 200, body: CAIXA_DIA };
  const [resp] = await mandar(ctx.webhook, update('/caixa'));
  assert.ok(resp.text.includes('Total recebido'), resp.text);
  assert.strictEqual(chamadas.filter(c => c.fn === 'bot_comprovantes_dia').length, 0);
});

// --- Runner ----------------------------------------------------------------

async function main() {
  const falsos = await subirFalsos();

  // Env vars ANTES do require: o index.js lê tudo no topo do módulo.
  process.env.TELEGRAM_TOKEN = 'token-de-teste';
  process.env.TELEGRAM_API_BASE = falsos.telegram;
  process.env.SUPABASE_URL = falsos.supabase;
  process.env.GEMINI_API_BASE = falsos.gemini;
  process.env.GEMINI_API_KEY = 'chave-de-teste';
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
    chamadasGemini.length = 0;
    respostas = {};
    respostaGemini = null;
    mod._resetEstadoTeste(); // config, fornecedor pendente e marcação de atacado
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
