// Bot de TAREFAS — outro projeto, outro token, mesmo servidor das lojas.
//
// SEPARAÇÃO: nada aqui usa código do bot das lojas, e o bot das lojas só
// chama ligar() no arranque (dentro de try/catch). Sem TAREFAS_BOT_TOKEN o
// bot de tarefas não liga e as lojas seguem normais. Todo caminho assíncrono
// daqui termina em catch: um erro no bot de tarefas não derruba o processo.
//
// Banco: o mesmo Supabase, só tabelas/funções "tarefas_" (db/tarefas.sql),
// com segredo próprio (TAREFAS_SYNC_TOKEN), separado do das lojas.
//
// Variáveis:
//   TAREFAS_BOT_TOKEN   token do BotFather (sem ela, desligado)
//   TAREFAS_SYNC_TOKEN  segredo gerado pelo db/tarefas.sql
//   TAREFAS_GRUPOS      ids dos grupos autorizados, separados por vírgula
//                       (vazia = só o /idgrupo responde)
//   SUPABASE_URL / SUPABASE_ANON_KEY  as mesmas das lojas

const crypto = require('crypto');
const cron = require('node-cron');

const TZ = 'America/Sao_Paulo';
const CAMINHO_WEBHOOK = '/tarefas/webhook';
// O resumo sai às 10h30 — o servidor já está acordado (o keepalive das lojas
// começa às 10h). Se ele estiver fora do ar nessa hora, sai no primeiro tick
// até as 22h; uma vez por dia, quem garante é o banco.
const HORA_RESUMO = 10;
const MINUTO_RESUMO = 30;
const CRON_RESUMO = '*/10 10-22 * * *';
// Quantas tarefas um /feito ou /reabrir mexe de uma vez.
const MAX_LOTE = 50;
// "feito", "feito!", "feito 2 4", "feita 1-3" — respondendo a uma mensagem.
const RE_FEITO_RESPOSTA = /^(feito|feita)(?=$|[\s.!✅\d#])[\s\d,;#\-–]*[.!✅\s]*$/iu;
const TEXTO_CURTO = 60;
const MAX_MSG = 3800;

const AJUDA = [
  '📋 <b>Bot de Tarefas</b>',
  '',
  '/tarefa texto — registra uma tarefa (também foto com legenda /tarefa, ou respondendo a uma mensagem)',
  '/pendentes — tarefas abertas, das mais antigas para as novas',
  '/minhas — tarefas com você e as que você pediu',
  '/feito 12 — marca como feita; vale vários: <code>/feito 1 2 3</code>, <code>/feito 1-5</code> (ou responda à tarefa com "feito")',
  '/reabrir 12 — volta para aberta (também vários de uma vez)',
  '/pra 12 Nome — define o responsável',
  '/prazo 12 25/10 — define o prazo (<code>/prazo 12 sem</code> tira)',
  '/ver 12 — tarefa completa, com foto e histórico',
  '/idgrupo — ID deste chat',
  '',
  '☀️ Todo dia às 10h30: resumo das abertas, com as atrasadas em destaque.',
].join('\n');

// --- utilidades puras --------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Partes da data/hora em São Paulo. `d` = Date.
function partesSP(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { ano: +p.year, mes: +p.month, dia: +p.day, hora: +p.hour, minuto: +p.minute, iso: `${p.year}-${p.month}-${p.day}` };
}

// Dias entre duas datas ISO (YYYY-MM-DD), b − a.
function diasEntre(aISO, bISO) {
  return Math.round((Date.parse(`${bISO}T00:00:00Z`) - Date.parse(`${aISO}T00:00:00Z`)) / 864e5);
}

function dataBR(iso, comAno = false) {
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return comAno ? `${d}/${m}/${a}` : `${d}/${m}`;
}

function dataHoraBR(ts) {
  const p = partesSP(new Date(ts));
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')} ${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;
}

function textoCurto(texto) {
  const linha = String(texto || '').split('\n')[0].trim();
  return linha.length > TEXTO_CURTO ? `${linha.slice(0, TEXTO_CURTO - 1)}…` : linha;
}

function idadeTexto(dias) {
  if (dias <= 0) return 'hoje';
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

// "1 2 3", "1,2,3", "#4", "1-5", "1 - 5" -> [1, 2, 3, ...] sem repetidos, na
// ordem digitada. null se aparecer algo que não é número ou passar do limite.
function parseNumeros(s) {
  const tokens = String(s || '').replace(/\s*[-–]\s*/g, '-').split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return null;
  const nums = [];
  for (const tk of tokens) {
    let m = tk.match(/^#?(\d+)$/);
    if (m) { nums.push(+m[1]); continue; }
    m = tk.match(/^#?(\d+)-#?(\d+)$/);
    if (!m) return null;
    let [a, b] = [+m[1], +m[2]];
    if (a > b) [a, b] = [b, a];
    if (b - a >= MAX_LOTE) return null;
    for (let i = a; i <= b; i++) nums.push(i);
  }
  const unicos = [...new Set(nums)].filter(n => n > 0);
  return unicos.length && unicos.length <= MAX_LOTE ? unicos : null;
}

function nomeDe(from) {
  if (!from) return '';
  const nome = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return nome || (from.username ? `@${from.username}` : '');
}

function autorDe(from) {
  return { user_id: from && from.id != null ? String(from.id) : null, nome: nomeDe(from) || null };
}

// Sem acento, minúsculo, sem @ — pra comparar o responsável com quem pergunta.
function normNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^@/, '').trim();
}

function ehDaPessoa(responsavel, from) {
  const r = normNome(responsavel);
  if (!r || !from) return false;
  const primeiro = normNome(from.first_name);
  const nomes = [primeiro, normNome(nomeDe(from)), normNome(from.username)].filter(Boolean);
  return nomes.includes(r) || (!!primeiro && r.split(/\s+/)[0] === primeiro);
}

// "25/10" ou "25/10/2026" -> ISO. Sem ano: o deste ano, ou o do ano que vem
// se a data já passou há mais de 60 dias (prazo de janeiro marcado em dezembro).
function parsePrazo(arg, hojeISO) {
  const m = String(arg || '').match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const dia = +m[1], mes = +m[2];
  let ano = m[3] ? +m[3] : +hojeISO.slice(0, 4);
  if (m[3] && m[3].length === 2) ano += 2000;
  const valida = (a) => {
    const d = new Date(Date.UTC(a, mes - 1, dia));
    return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
      ? d.toISOString().slice(0, 10) : null;
  };
  let iso = valida(ano);
  if (!iso) return null;
  if (!m[3] && diasEntre(iso, hojeISO) > 60) iso = valida(ano + 1);
  return iso;
}

function dividir(texto) {
  if (texto.length <= MAX_MSG) return [texto];
  const partes = [];
  let buf = '';
  for (const linha of texto.split('\n')) {
    if (buf && (buf + '\n' + linha).length > MAX_MSG) { partes.push(buf); buf = linha; }
    else buf = buf ? `${buf}\n${linha}` : linha;
  }
  if (buf) partes.push(buf);
  return partes;
}

// Segredo do webhook derivado do token: o Telegram manda ele no cabeçalho, e
// quem não tem o token não consegue forjar update. Nada a configurar.
function segredoWebhook(token) {
  return crypto.createHash('sha256').update(`tarefas-webhook:${token}`).digest('hex').slice(0, 48);
}

// --- o bot -------------------------------------------------------------------

function criarBotTarefas(cfg) {
  const {
    token, syncToken, grupos = [], supabaseUrl, anonKey,
    telegramApi = 'https://api.telegram.org', agora = () => new Date(),
  } = cfg;
  const API = `${telegramApi}/bot${token}`;
  const botId = String(token).split(':')[0];
  const autorizados = new Set(grupos.map(g => String(g).trim()).filter(Boolean));
  const vistos = new Set();

  async function rpc(fn, body) {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: syncToken, ...body }),
    });
    const texto = await resp.text();
    let data = null;
    try { data = texto ? JSON.parse(texto) : null; } catch (_) { /* não-JSON */ }
    if (!resp.ok) {
      const err = new Error(`${fn} HTTP ${resp.status}: ${(data && data.message) || texto.slice(0, 200)}`);
      err.ausente = resp.status === 404 || /Could not find the function|schema cache/i.test(texto);
      throw err;
    }
    return data;
  }

  async function telegram(metodo, body) {
    const resp = await fetch(`${API}/${metodo}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`tarefas: ${metodo} HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    return resp.ok;
  }

  async function enviar(chatId, html, threadId) {
    for (const parte of dividir(html)) {
      const body = { chat_id: chatId, text: parte, parse_mode: 'HTML', disable_web_page_preview: true };
      if (threadId) body.message_thread_id = threadId;
      await telegram('sendMessage', body);
    }
  }

  // Responde no mesmo tópico, quando o grupo usa tópicos.
  const topico = (msg) => (msg.is_topic_message ? msg.message_thread_id : undefined);
  const responder = (msg, html) => enviar(msg.chat.id, html, topico(msg));

  const hoje = () => partesSP(agora()).iso;

  function erroBanco(err) {
    console.error('tarefas:', err.message);
    return err.ausente
      ? '⚠️ As tabelas do bot de tarefas não existem no banco — falta rodar o db/tarefas.sql no Supabase.'
      : '⚠️ Erro ao falar com o banco. Tente de novo em instantes.';
  }

  // --- formatação ------------------------------------------------------------
  // HTML do Telegram: o texto das tarefas passa sempre por esc(), então
  // <, > e & digitados pelo pessoal não quebram a mensagem.

  // "#12 · <b>Texto</b>"
  function linhaTitulo(t, { curto = true } = {}) {
    return `#${t.numero} · <b>${esc(curto ? textoCurto(t.texto) : t.texto)}</b>`;
  }

  // Segunda linha, em itálico: 👤 responsável · 📅 prazo · há X dias · pedida por
  function linhaDetalhe(t, hojeISO, { prazoComAno = false } = {}) {
    const p = [];
    if (t.responsavel) p.push(`👤 ${esc(t.responsavel)}`);
    if (t.prazo) {
      const aberta = t.status !== 'feita';
      const data = dataBR(t.prazo, prazoComAno);
      p.push(aberta && t.prazo < hojeISO ? `📅 ${data} (vencida)` : aberta && t.prazo === hojeISO ? '📅 hoje' : `📅 ${data}`);
    }
    p.push(idadeTexto(diasEntre(partesSP(new Date(t.criada_em)).iso, hojeISO)));
    p.push(`pedida por ${esc(t.pedido_por_nome || '?')}`);
    return `<i>${p.join(' · ')}</i>`;
  }

  const bloco = (t, h) => `${linhaTitulo(t)}\n${linhaDetalhe(t, h)}`;

  // Seção com título e as tarefas separadas por linha em branco. '' se vazia.
  function secao(titulo, itens, h) {
    if (!itens.length) return '';
    return `${titulo} (${itens.length})</b>\n\n${itens.map(t => bloco(t, h)).join('\n\n')}`;
  }

  // Atrasadas primeiro, depois as abertas com responsável, sem responsável no
  // fim. Dentro de cada grupo, da mais antiga pra mais nova (ordem do banco).
  function textoLista(cabecalho, itens, h) {
    const atrasadas = itens.filter(t => t.prazo && t.prazo < h);
    const resto = itens.filter(t => !atrasadas.includes(t));
    return [
      cabecalho,
      secao('⚠️ <b>Atrasadas', atrasadas, h),
      secao('📌 <b>Abertas', resto.filter(t => t.responsavel), h),
      secao('<b>Sem responsável', resto.filter(t => !t.responsavel), h),
    ].filter(Boolean).join('\n\n');
  }

  async function abertas(chatId) {
    const d = await rpc('tarefas_listar', { p_chat_id: String(chatId), p_status: 'aberta' });
    if (!d || d.ok === false) throw new Error(`tarefas_listar: ${(d && d.erro) || 'sem resposta'}`);
    return d.itens || [];
  }

  // Número da tarefa a que a mensagem responde: mensagem do PRÓPRIO bot com um
  // único #N, ou a mensagem que originou a tarefa. null se não der pra saber.
  async function numeroDaResposta(msg) {
    const r = msg.reply_to_message;
    if (!r) return null;
    if (r.from && String(r.from.id) === botId) {
      const nums = [...new Set((String(r.text || r.caption || '').match(/#(\d+)/g) || []).map(x => +x.slice(1)))];
      if (nums.length === 1) return nums[0];
      if (nums.length > 1) return { varias: true };
    }
    const d = await rpc('tarefas_ver', { p_chat_id: String(msg.chat.id), p_origem_msg_id: r.message_id });
    return d && d.ok ? d.tarefa.numero : null;
  }

  function numeroDoArg(text) {
    const arg = String(text || '').trim().split(/\s+/)[1] || '';
    const m = arg.match(/^#?(\d+)$/);
    return m ? +m[1] : null;
  }

  function maiorFoto(m) {
    if (!m || !Array.isArray(m.photo) || !m.photo.length) return null;
    return m.photo.reduce((a, b) => ((b.file_size || 0) >= (a.file_size || 0) ? b : a)).file_id;
  }

  // --- comandos --------------------------------------------------------------

  async function cmdTarefa(msg, text) {
    let texto = text.replace(/^\/tarefa(@\S+)?/i, '').trim();
    let foto = maiorFoto(msg);
    let origem = msg.message_id;
    const r = msg.reply_to_message;
    if (r) {
      if (!texto) texto = String(r.text || r.caption || '').trim();
      foto = foto || maiorFoto(r);
      origem = r.message_id;
    }
    if (!texto) {
      await responder(msg, 'Uso: <code>/tarefa texto</code> — ou responda a uma mensagem com <code>/tarefa</code>.');
      return;
    }
    const d = await rpc('tarefas_criar', {
      p_chat_id: String(msg.chat.id), p_texto: texto, p_foto: foto, p_origem_msg_id: origem, p_autor: autorDe(msg.from),
    });
    if (!d || d.ok === false) { await responder(msg, `⚠️ Não registrei: ${esc((d && d.erro) || 'erro')}`); return; }
    await responder(msg, `📌 <b>#${d.numero} registrada</b>\n<b>${esc(texto)}</b>`);
  }

  async function cmdPendentes(msg) {
    const itens = await abertas(msg.chat.id);
    if (!itens.length) { await responder(msg, '🎉 Nenhuma tarefa aberta.'); return; }
    await responder(msg, textoLista(`📋 <b>Pendentes (${itens.length})</b>`, itens, hoje()));
  }

  async function cmdMinhas(msg) {
    const itens = await abertas(msg.chat.id);
    const h = hoje();
    const comVoce = itens.filter(t => ehDaPessoa(t.responsavel, msg.from));
    const pedidas = itens.filter(t => msg.from && t.pedido_por_id === String(msg.from.id) && !comVoce.includes(t));
    if (!comVoce.length && !pedidas.length) {
      await responder(msg, '🙋 Nenhuma tarefa aberta com você nem pedida por você.');
      return;
    }
    await responder(msg, [
      `🙋 <b>Suas tarefas (${comVoce.length + pedidas.length})</b>`,
      secao('👤 <b>Com você', comVoce, h),
      secao('📝 <b>Pedidas por você', pedidas, h),
    ].filter(Boolean).join('\n\n'));
  }

  // Resolve UM número: argumento, ou a mensagem respondida. Responde o uso e
  // devolve null quando não dá.
  async function numeroOuUso(msg, text, uso) {
    const n = numeroDoArg(text) ?? await numeroDaResposta(msg);
    if (n && n.varias) {
      await responder(msg, 'Essa mensagem tem mais de uma tarefa. Use o número: <code>/ver 12</code>.');
      return null;
    }
    if (!n) { await responder(msg, `Uso: ${uso}`); return null; }
    return n;
  }

  async function atualizar(msg, numero, acao, valor) {
    const d = await rpc('tarefas_atualizar', {
      p_chat_id: String(msg.chat.id), p_numero: numero, p_acao: acao, p_valor: valor ?? null, p_autor: autorDe(msg.from),
    });
    if (d && d.ok === false && d.erro === 'nao_existe') {
      await responder(msg, `❓ Não achei a tarefa #${numero}.`);
      return null;
    }
    return d;
  }

  const LOTE = {
    feito: {
      uso: '<code>/feito 12</code> · <code>/feito 1 2 3</code> · <code>/feito 1-5</code> (ou responda à tarefa com "feito")',
      um: (n) => `✅ <b>#${n} feita</b>`, varios: (q) => `✅ <b>${q} tarefas feitas</b>`,
      jaUm: 'já estava feita', jaVarios: 'Já estavam feitas', erroJa: 'ja_feita',
    },
    reabrir: {
      uso: '<code>/reabrir 12</code> · <code>/reabrir 1 2 3</code> · <code>/reabrir 1-5</code>',
      um: (n) => `🔄 <b>#${n} reaberta</b>`, varios: (q) => `🔄 <b>${q} tarefas reabertas</b>`,
      jaUm: 'já está aberta', jaVarios: 'Já estavam abertas', erroJa: 'ja_aberta',
    },
  };

  // /feito e /reabrir, com um ou vários números ("1 2 3", "1,2,3", "1-5").
  // Cada número é independente: um que não existe ou já estava no estado
  // pedido só vira aviso, sem travar os outros. Resposta única no fim.
  async function cmdLote(msg, text, acao) {
    const L = LOTE[acao];
    const resto = text.replace(/^\/?(feito|feita|reabrir)(@\S+)?/i, '').replace(/[.!✅\s]+$/u, '').trim();
    let nums;
    if (resto) {
      nums = parseNumeros(resto);
      if (!nums) { await responder(msg, `Uso: ${L.uso} (até ${MAX_LOTE} de uma vez)`); return; }
    } else {
      const n = await numeroDaResposta(msg);
      if (n && n.varias) {
        await responder(msg, `Essa mensagem tem mais de uma tarefa. Diga quais: <code>${acao === 'feito' ? 'feito' : '/reabrir'} 2 4</code>.`);
        return;
      }
      if (!n) { await responder(msg, `Uso: ${L.uso}`); return; }
      nums = [n];
    }

    const ok = [];
    const naoExiste = [];
    const jaEstavam = [];
    const falharam = [];
    for (const n of nums) {
      const d = await rpc('tarefas_atualizar', {
        p_chat_id: String(msg.chat.id), p_numero: n, p_acao: acao, p_valor: null, p_autor: autorDe(msg.from),
      });
      if (d && d.ok) ok.push(d.tarefa);
      else if (d && d.erro === 'nao_existe') naoExiste.push(n);
      else if (d && d.erro === L.erroJa) jaEstavam.push(d.tarefa || { numero: n });
      else falharam.push(n);
    }

    const linhas = [];
    const quem = acao === 'feito' ? ` por ${esc(nomeDe(msg.from) || '?')}` : '';
    if (ok.length === 1) {
      linhas.push(`${L.um(ok[0].numero)}${quem}`, `<b>${esc(textoCurto(ok[0].texto))}</b>`);
    } else if (ok.length > 1) {
      linhas.push(`${L.varios(ok.length)}${quem}`, '', ...ok.map(t => linhaTitulo(t)));
    }
    const avisos = [];
    if (naoExiste.length) avisos.push(`❓ Não achei: ${naoExiste.map(n => `#${n}`).join(', ')}`);
    if (jaEstavam.length === 1) {
      const t = jaEstavam[0];
      const por = acao === 'feito' && t.feita_por_nome ? ` por ${esc(t.feita_por_nome)}` : '';
      const em = acao === 'feito' && t.feita_em ? ` em ${dataHoraBR(t.feita_em)}` : '';
      avisos.push(`ℹ️ #${t.numero} ${L.jaUm}${por}${em}.`);
    } else if (jaEstavam.length > 1) {
      avisos.push(`ℹ️ ${L.jaVarios}: ${jaEstavam.map(t => `#${t.numero}`).join(', ')}`);
    }
    if (falharam.length) avisos.push(`⚠️ Não consegui mexer em: ${falharam.map(n => `#${n}`).join(', ')}`);
    if (linhas.length && avisos.length) linhas.push('');
    await responder(msg, [...linhas, ...avisos].join('\n'));
  }

  async function cmdPra(msg, text) {
    const partes = text.trim().split(/\s+/);
    const n = numeroDoArg(text);
    const nome = partes.slice(2).join(' ').trim();
    if (!n || !nome) { await responder(msg, 'Uso: <code>/pra 12 Nome</code>'); return; }
    const d = await atualizar(msg, n, 'responsavel', nome);
    if (!d) return;
    if (!d.ok) { await responder(msg, `⚠️ ${esc(d.erro || 'erro')}`); return; }
    await responder(msg, `👤 <b>#${n}</b> → ${esc(nome)}\n<b>${esc(textoCurto(d.tarefa.texto))}</b>`);
  }

  async function cmdPrazo(msg, text) {
    const partes = text.trim().split(/\s+/);
    const n = numeroDoArg(text);
    const arg = (partes[2] || '').toLowerCase();
    const uso = 'Uso: <code>/prazo 12 25/10</code> (ou <code>/prazo 12 sem</code> pra tirar)';
    if (!n || !arg) { await responder(msg, uso); return; }
    const tirar = arg === 'sem' || arg === '-';
    const iso = tirar ? null : parsePrazo(arg, hoje());
    if (!tirar && !iso) { await responder(msg, `Data inválida. ${uso}`); return; }
    const d = await atualizar(msg, n, 'prazo', iso);
    if (!d) return;
    if (!d.ok) { await responder(msg, `⚠️ ${esc(d.erro || 'erro')}`); return; }
    const cab = tirar ? `📅 <b>#${n}</b> sem prazo` : `📅 <b>#${n}</b> prazo ${dataBR(iso, true)}`;
    await responder(msg, `${cab}\n<b>${esc(textoCurto(d.tarefa.texto))}</b>`);
  }

  const ROTULO_ACAO = { criada: 'criada', feito: 'feita', reabrir: 'reaberta', responsavel: 'responsável', prazo: 'prazo' };

  async function cmdVer(msg, text) {
    const n = await numeroOuUso(msg, text, '<code>/ver 12</code>');
    if (!n) return;
    const d = await rpc('tarefas_ver', { p_chat_id: String(msg.chat.id), p_numero: n });
    if (!d || d.ok === false) { await responder(msg, `❓ Não achei a tarefa #${n}.`); return; }
    const t = d.tarefa;
    const linhas = [
      `📌 <b>Tarefa #${t.numero}</b> · ${t.status === 'feita' ? '✅ feita' : 'aberta'}`,
      '',
      linhaTitulo(t, { curto: false }),
      linhaDetalhe(t, hoje(), { prazoComAno: true }),
      `<i>🕐 criada em ${dataHoraBR(t.criada_em)}</i>`,
    ];
    if (t.status === 'feita') linhas.push(`✅ Feita por ${esc(t.feita_por_nome || '?')} em ${dataHoraBR(t.feita_em)}`);
    const hist = d.historico || [];
    if (hist.length) {
      linhas.push('', '<b>Histórico</b>');
      for (const ev of hist) {
        const det = ev.acao === 'prazo' ? (ev.detalhe ? ` ${dataBR(ev.detalhe)}` : ' removido')
          : ev.acao === 'responsavel' ? ` → ${esc(ev.detalhe || 'ninguém')}` : '';
        linhas.push(`${dataHoraBR(ev.criado_em)} · ${ROTULO_ACAO[ev.acao] || esc(ev.acao)}${det} · ${esc(ev.autor_nome || '?')}`);
      }
    }
    if (t.foto_file_id) {
      const foto = { chat_id: msg.chat.id, photo: t.foto_file_id, caption: `📎 Foto da #${t.numero}` };
      if (topico(msg)) foto.message_thread_id = topico(msg);
      await telegram('sendPhoto', foto);
    }
    await responder(msg, linhas.join('\n'));
  }

  // --- entrada ---------------------------------------------------------------

  // Nunca lança: é o que impede um erro aqui de virar promessa rejeitada solta
  // no processo das lojas.
  async function processarUpdate(update) {
    try {
      const msg = update && update.message;
      if (!msg || !msg.chat) return;
      if (update.update_id != null) {
        if (vistos.has(update.update_id)) return;
        vistos.add(update.update_id);
        if (vistos.size > 1000) vistos.clear();
      }
      const chatId = msg.chat.id;
      const text = String(msg.text || msg.caption || '').trim();
      const cmd = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase().split('@')[0] : '';

      // /idgrupo vale em qualquer chat: é como se descobre o id pra autorizar.
      if (cmd === '/idgrupo') { await responder(msg, `🆔 ID deste chat: <code>${esc(chatId)}</code>`); return; }
      if (!autorizados.has(String(chatId))) return;

      try {
        if (cmd === '/start' || cmd === '/ajuda') await responder(msg, AJUDA);
        else if (cmd === '/tarefa') await cmdTarefa(msg, text);
        else if (cmd === '/pendentes') await cmdPendentes(msg);
        else if (cmd === '/minhas') await cmdMinhas(msg);
        else if (cmd === '/feito') await cmdLote(msg, text, 'feito');
        else if (cmd === '/reabrir') await cmdLote(msg, text, 'reabrir');
        else if (cmd === '/pra') await cmdPra(msg, text);
        else if (cmd === '/prazo') await cmdPrazo(msg, text);
        else if (cmd === '/ver') await cmdVer(msg, text);
        // "feito" ou "feito 2 4" respondendo a uma mensagem. Sem resposta é
        // conversa, e o bot fica quieto.
        else if (!cmd && msg.reply_to_message && RE_FEITO_RESPOSTA.test(text)) await cmdLote(msg, text, 'feito');
      } catch (err) {
        await responder(msg, erroBanco(err));
      }
    } catch (err) {
      console.error('tarefas: falha ao processar update:', err);
    }
  }

  function textoResumo(itens, hojeISO) {
    return textoLista(`☀️ <b>Tarefas abertas — ${dataBR(hojeISO)} (${itens.length})</b>`, itens, hojeISO);
  }

  // Resumo diário. Marca o dia no banco ANTES de mandar: reinício ou dois
  // ticks não repetem o resumo. Sem tarefas abertas, não manda nada.
  async function rodarResumo() {
    const p = partesSP(agora());
    if (p.hora * 60 + p.minuto < HORA_RESUMO * 60 + MINUTO_RESUMO) return;
    for (const chat of autorizados) {
      try {
        const m = await rpc('tarefas_resumo_marcar', { p_chat_id: chat, p_dia: p.iso });
        if (!m || !m.ok || !m.marcado) continue;
        const itens = await abertas(chat);
        if (itens.length) await enviar(chat, textoResumo(itens, p.iso));
      } catch (err) {
        console.error(`tarefas: resumo do grupo ${chat}:`, err.message);
      }
    }
  }

  // Aponta o webhook do Telegram pra este servidor, com o segredo.
  async function registrarWebhook(urlBase) {
    const ok = await telegram('setWebhook', {
      url: `${String(urlBase).replace(/\/$/, '')}${CAMINHO_WEBHOOK}`,
      secret_token: segredoWebhook(token),
      allowed_updates: ['message'],
    });
    console.log(`tarefas: webhook ${ok ? 'registrado' : 'NÃO registrado'} em ${urlBase}${CAMINHO_WEBHOOK}`);
    return ok;
  }

  return { processarUpdate, rodarResumo, registrarWebhook, textoResumo };
}

// Liga o bot de tarefas no app das lojas. Nunca lança; devolve o bot ou null.
// `agora` só existe pros testes controlarem o relógio.
function ligar(app, env = process.env, { agendar = true, agora } = {}) {
  try {
    const token = env.TAREFAS_BOT_TOKEN;
    if (!token) { console.log('bot de tarefas: TAREFAS_BOT_TOKEN não definida — desligado.'); return null; }
    // TAREFAS_GRUPOS pode ficar vazia no começo: aí só o /idgrupo responde,
    // que é justamente como se descobre o id pra preencher ela.
    const faltam = ['TAREFAS_SYNC_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter(k => !env[k]);
    if (faltam.length) { console.error(`bot de tarefas: faltam ${faltam.join(', ')} — desligado.`); return null; }

    const bot = criarBotTarefas({
      token,
      syncToken: env.TAREFAS_SYNC_TOKEN,
      grupos: String(env.TAREFAS_GRUPOS || '').split(','),
      supabaseUrl: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      telegramApi: env.TAREFAS_TELEGRAM_API_BASE || 'https://api.telegram.org',
      ...(agora ? { agora } : {}),
    });
    const segredo = segredoWebhook(token);

    app.post(CAMINHO_WEBHOOK, (req, res) => {
      if (req.get('x-telegram-bot-api-secret-token') !== segredo) { res.sendStatus(401); return; }
      res.sendStatus(200);
      bot.processarUpdate(req.body).catch(err => console.error('tarefas:', err));
    });

    if (agendar) {
      cron.schedule(CRON_RESUMO, () => {
        bot.rodarResumo().catch(err => console.error('tarefas: resumo:', err));
      }, { timezone: TZ });
      const base = env.RENDER_EXTERNAL_URL;
      if (base) {
        bot.registrarWebhook(base).catch(err => console.error('tarefas: setWebhook:', err.message));
      } else {
        console.log('bot de tarefas: sem RENDER_EXTERNAL_URL — registre o webhook à mão.');
      }
    }
    console.log(`bot de tarefas: ligado (${env.TAREFAS_GRUPOS ? 'grupos ' + env.TAREFAS_GRUPOS : 'nenhum grupo autorizado ainda — só /idgrupo'}).`);
    return bot;
  } catch (err) {
    console.error('bot de tarefas: não ligou:', err);
    return null;
  }
}

module.exports = {
  ligar, criarBotTarefas, segredoWebhook, parsePrazo, parseNumeros, partesSP, ehDaPessoa, textoCurto, CAMINHO_WEBHOOK,
};
