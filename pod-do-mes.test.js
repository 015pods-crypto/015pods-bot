// Testes do /poddomes de ponta a ponta: mensagem de verdade no webhook -> index.js
// -> SQL de verdade (db/pod-do-mes.sql) num Postgres em memória (PGlite). A
// bot_comissao e a bot_movimentar_estoque são cópias das de produção, então
// "não soma na comissão" é testado contra a conta real.
//
// Rodar: node pod-do-mes.test.js   (não precisa de rede nem de token real)

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TOKEN = 'token-de-teste';
const VENDAS = -100, REPOSICAO = -200, FATURAMENTO = -300;
const RODRIGO = { id: 1001, first_name: 'Rodrigo' };
const GABRIEL = { id: 1002, first_name: 'Gabriel' };
const SOCIO = { id: 111, first_name: 'Lucas' };
const ESTRANHO = { id: 4242, first_name: 'Fulano' };

// Relógio único do bot e do banco.
let relogio = new Date('2026-11-04T15:00:00-03:00').getTime();
const DataReal = Date;
global.Date = class extends DataReal {
  constructor(...a) { if (a.length) super(...a); else super(relogio); }
  static now() { return relogio; }
};

let db = null;
const enviadas = [];

const lit = v => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

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
const responder = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function rpc(fn, body) {
  const args = Object.entries(body).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const r = await db.query(`select public.${fn}(${args}) as r`);
  return r.rows[0].r;
}

async function escalar(sql) {
  const r = await db.query(sql);
  return Object.values(r.rows[0])[0];
}
const estoque = sabor => escalar(`select stock_qty from flavors where name = '${sabor}'`);
const vendas = () => escalar('select count(*)::int from sales');
const pods = () => escalar('select count(*)::int from pod_do_mes where desfeito_em is null');

async function mudarRelogio(iso) {
  relogio = new DataReal(iso).getTime();
  await db.query('delete from _relogio');
  await db.query(`insert into _relogio values ('${iso}')`);
}

let idUpdate = 1;
async function mandar(ctx, text, { from = RODRIGO, chat = VENDAS, n = 1 } = {}) {
  const antes = enviadas.length;
  const u = { update_id: idUpdate++, message: { message_id: idUpdate, from, chat: { id: chat, type: 'group' }, text } };
  await fetch(ctx.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) });
  for (let i = 0; i < 400 && enviadas.length < antes + n; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 20));
  const novas = enviadas.slice(antes);
  assert.strictEqual(novas.length, n, `esperava ${n} mensagem(ns) para "${text}", vieram: ${JSON.stringify(novas.map(m => m.text))}`);
  return novas;
}

const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

const GRAPE = 'Ignite V55 Grape Ice';

teste('1. /poddomes tira 1 do estoque e não soma em venda, comissão nem meta', async (ctx) => {
  await mandar(ctx, '-1 Ignite V55 Mango');                 // uma venda normal, para comparar
  const antes = await rpc('bot_comissao', { p_token: TOKEN });
  assert.strictEqual(antes.unidades_mes, 1);

  const [resp, aviso] = await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  const esperado = `🎁 Pod do mês do Rodrigo registrado: ${GRAPE}. Saiu 1 do estoque, sem comissão. Próximo só em dezembro.`;
  assert.strictEqual(resp.text, esperado);
  assert.strictEqual(String(resp.chat_id), String(VENDAS));
  assert.strictEqual(aviso.text, esperado);
  assert.strictEqual(String(aviso.chat_id), String(FATURAMENTO));
  assert.strictEqual(await estoque('Grape Ice'), 4);

  const depois = await rpc('bot_comissao', { p_token: TOKEN });
  assert.deepStrictEqual(
    [depois.unidades_mes, depois.comissao, depois.faltam_para_proxima, depois.taxa_atual],
    [antes.unidades_mes, antes.comissao, antes.faltam_para_proxima, antes.taxa_atual]);
  assert.strictEqual(await vendas(), 1, 'o pod não pode virar venda');

  const reg = (await db.query(`select custo, mes::text, dia::text, produto from pod_do_mes`)).rows[0];
  assert.deepStrictEqual({ ...reg, custo: Number(reg.custo) },
    { custo: 42.5, mes: '2026-11-01', dia: '2026-11-04', produto: GRAPE });
  const mov = (await db.query(`select qty_delta, type::text, notes from stock_movements where notes like '%pod%'`)).rows;
  assert.deepStrictEqual(mov, [{ qty_delta: -1, type: 'ajuste', notes: 'bot telegram: pod do mês' }]);
});

teste('2. segundo /poddomes no mês: recusa e não mexe no estoque', async (ctx) => {
  await mudarRelogio('2026-11-03T15:00:00-03:00');
  await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  await mudarRelogio('2026-11-20T15:00:00-03:00');
  const [resp] = await mandar(ctx, '/poddomes ignite v55 mango');
  assert.strictEqual(resp.text,
    `Você já pegou seu pod do mês de novembro: ${GRAPE}, no dia 03/11. O próximo libera dia 01/12.`);
  assert.strictEqual(await estoque('Mango'), 5);
  assert.strictEqual(await pods(), 1);
  // Dois pedidos em sequência rápida (o PGlite executa um por vez, então isto não
  // prova concorrência real: ela fica com o lock do vendedor e o índice único).
  const r = await Promise.all([
    rpc('bot_pod_do_mes', { p_token: TOKEN, p_produto: 'ignite v55 mango', p_meta: { user_id: '1002' } }),
    rpc('bot_pod_do_mes', { p_token: TOKEN, p_produto: 'ignite v55 mango', p_meta: { user_id: '1002' } }),
  ]);
  assert.deepStrictEqual(r.map(x => x.status).sort(), ['ja_usou', 'ok']);
  assert.strictEqual(await estoque('Mango'), 4);
});

teste('3. dia 1º à 1h conta para o mês anterior; às 3h já é o mês novo', async (ctx) => {
  await mudarRelogio('2026-12-01T01:00:00-03:00');
  const [resp] = await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  assert.ok(resp.text.endsWith('Próximo só em dezembro.'), resp.text);
  assert.strictEqual(await escalar(`select mes::text from pod_do_mes`), '2026-11-01');
  assert.strictEqual(await escalar(`select dia::text from pod_do_mes`), '2026-11-30');
  const [ainda] = await mandar(ctx, '/poddomes ignite v55 mango');
  assert.ok(ainda.text.includes('novembro') && ainda.text.includes('dia 30/11'), ainda.text);

  await mudarRelogio('2026-12-01T03:00:00-03:00');
  const [novo] = await mandar(ctx, '/poddomes ignite v55 mango', { n: 2 });
  assert.ok(novo.text.endsWith('Próximo só em janeiro.'), novo.text);
  assert.strictEqual(await escalar(`select count(*)::int from pod_do_mes where mes = '2026-12-01'`), 1);
});

teste('não acumula: mês sem usar não vira 2 no seguinte', async (ctx) => {
  await mudarRelogio('2026-12-10T15:00:00-03:00');
  await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  const [resp] = await mandar(ctx, '/poddomes ignite v55 mango');
  assert.ok(resp.text.startsWith('Você já pegou seu pod do mês de dezembro'), resp.text);
});

teste('4. tabacaria, complemento, lista bot_nao_pods e quantidade 2: recusa', async (ctx) => {
  for (const produto of ['seda king size', 'isqueiro bic azul', 'carregador usb c']) {
    const [resp] = await mandar(ctx, `/poddomes ${produto}`);
    assert.ok(resp.text.includes('só para pod') && resp.text.includes('Nada foi tirado'), resp.text);
  }
  for (const t of ['/poddomes 2 ignite v55 grape ice', '/poddomes 2x ignite v55 grape ice',
    '/poddomes -2 ignite v55 grape ice', '/poddomes ignite v55 grape ice x2',
    '/poddomes ignite v55 grape ice\nignite v55 mango']) {
    const [resp] = await mandar(ctx, t);
    assert.ok(resp.text.includes('sempre 1 unidade'), `${t} -> ${resp.text}`);
  }
  assert.strictEqual(await pods(), 0);
  assert.strictEqual(await escalar(`select count(*)::int from stock_movements`), 0);
  assert.strictEqual(await estoque('Grape Ice'), 5);
  assert.strictEqual(await estoque('King Size'), 5);
});

teste('quantidade 1 escrita é aceita', async (ctx) => {
  await mandar(ctx, '/poddomes -1 ignite v55 grape ice', { n: 2 });
  assert.strictEqual(await estoque('Grape Ice'), 4);
});

teste('quem não é vendedor é recusado, e sócio não lança para outro', async (ctx) => {
  const [resp] = await mandar(ctx, '/poddomes ignite v55 grape ice', { from: ESTRANHO });
  assert.ok(resp.text.includes('só para vendedor cadastrado'), resp.text);
  const [status] = await mandar(ctx, '/poddomes', { from: ESTRANHO });
  assert.ok(status.text.includes('só para vendedor cadastrado'), status.text);
  const r = await rpc('bot_pod_do_mes', { p_token: TOKEN, p_produto: 'ignite v55 grape ice', p_meta: { user_id: '111', vendedor: 'Rodrigo' } });
  assert.strictEqual(r.status, 'nao_vendedor');
  assert.strictEqual(await estoque('Grape Ice'), 5);
});

teste('mesma busca da baixa: não encontrado, ambíguo e sem estoque dão o mesmo resultado', async (ctx) => {
  for (const entrada of ['produto que nao existe', 'ignite v55', 'ignite v55 zerado']) {
    const baixa = (await rpc('bot_movimentar_estoque', { p_token: TOKEN, p_items: [{ produto: entrada, qty: -1 }] })).resultados[0];
    const pod = await rpc('bot_pod_do_mes', { p_token: TOKEN, p_produto: entrada, p_meta: { user_id: '1001' } });
    assert.strictEqual(pod.status, baixa.status, entrada);
    assert.strictEqual(JSON.stringify(pod.matches), JSON.stringify(baixa.matches), entrada);
  }
  const [zerado] = await mandar(ctx, '/poddomes ignite v55 zerado');
  assert.ok(zerado.text.includes('já está zerado'), zerado.text);
  const [ambiguo] = await mandar(ctx, '/poddomes ignite v55');
  assert.ok(ambiguo.text.includes('ambíguo') && ambiguo.text.includes('Grape Ice'), ambiguo.text);
  const [sumiu] = await mandar(ctx, '/poddomes produto que nao existe');
  assert.ok(sumiu.text.includes('Produto não encontrado'), sumiu.text);
  assert.strictEqual(await pods(), 0);
});

teste('/poddomes sem produto mostra se está disponível ou o que pegou', async (ctx) => {
  const [livre] = await mandar(ctx, '/poddomes');
  assert.strictEqual(livre.text, 'Seu pod do mês de novembro ainda está disponível 🎁');
  await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  const [usado] = await mandar(ctx, '/poddomes');
  assert.strictEqual(usado.text, `Você já pegou seu pod do mês de novembro: ${GRAPE}, no dia 04/11. O próximo libera dia 01/12.`);
});

teste('5. /poddomes_desfazer: sócio devolve e libera; vendedor é recusado', async (ctx) => {
  await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  const [negado] = await mandar(ctx, '/poddomes_desfazer Rodrigo', { from: GABRIEL });
  assert.strictEqual(negado.text, 'Esse comando é só para os sócios.');
  const [proprio] = await mandar(ctx, '/poddomes_desfazer Rodrigo');
  assert.strictEqual(proprio.text, 'Esse comando é só para os sócios.');
  assert.strictEqual(await estoque('Grape Ice'), 4);
  assert.strictEqual(await pods(), 1);

  const [ok] = await mandar(ctx, '/poddomes_desfazer rodrigo', { from: SOCIO });
  assert.ok(ok.text.includes('desfeito') && ok.text.includes('Voltou 1 ao estoque'), ok.text);
  assert.strictEqual(await estoque('Grape Ice'), 5);
  assert.strictEqual(await pods(), 0);
  const mov = (await db.query(`select qty_delta, type::text from stock_movements where notes = 'bot telegram: pod do mês desfeito'`)).rows;
  assert.deepStrictEqual(mov, [{ qty_delta: 1, type: 'ajuste' }]);
  assert.strictEqual(await escalar('select count(*)::int from pod_do_mes'), 1, 'o histórico fica');

  const [denovo] = await mandar(ctx, '/poddomes_desfazer Rodrigo', { from: SOCIO });
  assert.ok(denovo.text.includes('não tem pod do mês de novembro'), denovo.text);
  assert.strictEqual(await estoque('Grape Ice'), 5, 'desfazer duas vezes não devolve em dobro');

  const [liberado] = await mandar(ctx, '/poddomes ignite v55 mango', { n: 2 });
  assert.ok(liberado.text.startsWith('🎁 Pod do mês do Rodrigo registrado'), liberado.text);
});

teste('/poddomes_desfazer com nome errado não cai no próprio sócio', async (ctx) => {
  const [resp] = await mandar(ctx, '/poddomes_desfazer Fulano', { from: SOCIO });
  assert.ok(resp.text.includes('Não achei') && resp.text.includes('• Rodrigo') && resp.text.includes('• Gabriel'), resp.text);
});

teste('só no grupo de vendas; reposição é recusada', async (ctx) => {
  const [resp] = await mandar(ctx, '/poddomes ignite v55 grape ice', { chat: REPOSICAO });
  assert.strictEqual(resp.text, '🎁 O /poddomes é no grupo de VENDAS.');
  assert.strictEqual(await pods(), 0);
});

teste('mensagens: linha 🎁 separada, no dia certo, sem contar como venda', async (ctx) => {
  await mandar(ctx, '-1 Ignite V55 Mango');
  await mandar(ctx, '/poddomes ignite v55 grape ice', { n: 2 });
  await mandar(ctx, '/poddomes ignite v55 mango', { from: GABRIEL, n: 2 });
  const linhaR = `🎁 Pod do mês: Rodrigo (${GRAPE})`;
  const linhaG = '🎁 Pod do mês: Gabriel (Ignite V55 Mango)';

  const [dele] = await mandar(ctx, '/comissao');
  assert.ok(dele.text.includes(linhaR) && !dele.text.includes(linhaG), dele.text);
  assert.ok(dele.text.includes('Seus pods no mês: *1*'), dele.text);
  assert.ok(dele.text.indexOf(linhaR) < dele.text.indexOf('Ritmo do mês'), 'o ritmo fica por último');
  assert.ok(dele.text.includes('Rodrigo: 0,3 pods/dia'), dele.text);

  const [socio] = await mandar(ctx, '/comissao', { from: SOCIO });
  assert.ok(socio.text.includes(linhaR) && socio.text.includes(linhaG), socio.text);
  const [estranho] = await mandar(ctx, '/comissao', { from: ESTRANHO });
  assert.ok(!estranho.text.includes('Pod do mês'), estranho.text);

  const mod = ctx.mod;
  const hoje = await mod.textoComissaoRelatorio('2026-11-04');
  assert.ok(hoje.includes(linhaR) && hoje.includes(linhaG) && hoje.includes('Acumulado: *1*'), hoje);
  const outroDia = await mod.textoComissaoRelatorio('2026-11-05');
  assert.ok(!outroDia.includes('Pod do mês'), outroDia);
  const fechamento = await mod.textoComissaoRelatorio('2026-11-30');
  assert.ok(fechamento.includes('FECHAMENTO') && fechamento.includes(linhaR) && fechamento.includes(linhaG), fechamento);
  assert.ok(fechamento.includes('Total: *1*'), fechamento);
});

teste('SQL: RLS ligada, tabela fechada e função só com o token certo', async () => {
  assert.strictEqual(await escalar(`select relrowsecurity from pg_class where relname = 'pod_do_mes'`), true);
  for (const papel of ['anon', 'authenticated']) {
    assert.strictEqual(await escalar(`select has_table_privilege('${papel}', 'public.pod_do_mes', 'select')`), false, papel);
    assert.strictEqual(await escalar(`select has_function_privilege('${papel}', 'public.bot_pod_do_mes(text,text,jsonb)', 'execute')`), true, papel);
  }
  assert.strictEqual(await escalar(`select has_table_privilege('service_role', 'public.pod_do_mes', 'select')`), true);
  await assert.rejects(rpc('bot_pod_do_mes', { p_token: 'errado', p_produto: 'x', p_meta: { user_id: '1001' } }), /token inválido/);
  await assert.rejects(db.query(`insert into pod_do_mes (vendedor_id, flavor_id, produto, mes, dia)
    select v.id, f.id, 'x', '2026-11-05', '2026-11-05' from vendedores v, flavors f limit 1`), /check/);
});

async function semear() {
  await db.exec(`
    insert into integration_config values ('bot_sync_token', '${TOKEN}'), ('bot_nao_pods', '["carregador","pilha"]');
    insert into channels (name, type) values ('015 Pods', 'loja');
    insert into commission_tiers values (0, 399, 2), (400, null, 3);
    insert into vendedores (nome, telegram_user_id) values ('Rodrigo', '1001'), ('Gabriel', '1002');
    insert into _socios values ('111');
    insert into brands (name) values ('Ignite'), ('Tabacaria'), ('Complementos'), ('Geek');
    insert into models (name, brand_id)
      select 'Ignite V55', id from brands where name = 'Ignite' union all
      select 'Seda', id from brands where name = 'Tabacaria' union all
      select 'Isqueiro', id from brands where name = 'Complementos' union all
      select 'Carregador', id from brands where name = 'Geek';
    insert into flavors (name, stock_qty, model_id)
      select x.n, x.q, m.id from models m, (values ('Grape Ice', 5), ('Mango', 5), ('Zerado', 0)) x(n, q) where m.name = 'Ignite V55'
      union all select 'King Size', 5, id from models where name = 'Seda'
      union all select 'Bic Azul', 5, id from models where name = 'Isqueiro'
      union all select 'USB C', 5, id from models where name = 'Carregador';
    insert into product_costs select id, 42.5 from flavors where name = 'Grape Ice';
  `);
}

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = __dirname;
  const fixture = fs.readFileSync(path.join(dir, 'test-fixtures', 'banco-pod-do-mes.sql'), 'utf8');
  const sql = fs.readFileSync(path.join(dir, 'db', 'pod-do-mes.sql'), 'utf8');

  const telegram = await servidor((req, raw, res) => {
    let corpo = {};
    try { corpo = JSON.parse(raw); } catch (_) {}
    enviadas.push(corpo);
    responder(res, 200, { ok: true, result: { message_id: 1 } });
  });
  const supabase = await servidor(async (req, raw, res) => {
    const fn = req.url.split('/').pop();
    const body = JSON.parse(raw || '{}');
    if (fn === 'bot_config') {
      const valor = body.p_key === 'telegram_grupo_faturamento' ? String(FATURAMENTO) : '';
      responder(res, 200, { ok: true, valor });
      return;
    }
    try {
      responder(res, 200, await rpc(fn, body));
    } catch (err) {
      const ausente = /does not exist/.test(err.message);
      responder(res, ausente ? 404 : 500, { message: err.message });
    }
  });
  const url = s => `http://127.0.0.1:${s.address().port}`;

  Object.assign(process.env, {
    TELEGRAM_TOKEN: 'token', TELEGRAM_API_BASE: url(telegram),
    SUPABASE_URL: url(supabase), SUPABASE_ANON_KEY: 'anon', BOT_SYNC_TOKEN: TOKEN,
    ADMIN_USER_ID: String(SOCIO.id), LUCAS_USER_ID: String(SOCIO.id),
    VENDAS_CHAT_ID: String(VENDAS), REPOSICAO_CHAT_ID: String(REPOSICAO),
  });
  const logErro = console.error;
  const logInfo = console.log;
  const mod = require('./index.js');
  const server = await new Promise(r => { const s = mod.app.listen(0, '127.0.0.1', () => r(s)); });
  const ctx = { webhook: `${url(server)}/webhook`, mod };

  let falhas = 0;
  for (const t of testes) {
    db = new PGlite();
    await db.exec(fixture);
    await db.exec(sql);
    await semear();
    await mudarRelogio('2026-11-04T15:00:00-03:00');
    enviadas.length = 0;
    console.log = () => {};
    console.error = () => {};
    try {
      await t.fn(ctx);
      console.log = logInfo;
      console.log(`✅ ${t.nome}`);
    } catch (err) {
      falhas++;
      console.log = logInfo;
      console.log(`❌ ${t.nome}\n   ${err.message}`);
    }
    console.error = logErro;
    await db.close();
  }
  server.close(); telegram.close(); supabase.close();
  console.log(`\n${testes.length - falhas}/${testes.length} testes passaram`);
  process.exit(falhas ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
