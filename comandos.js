'use strict';
// /comandos (e /ajuda): o que vale em cada grupo, com exemplo e se está
// funcionando. `chaves` liga cada linha aos erros gravados em bot_erros (a
// chave é a mesma que o webhook põe no contexto: o comando, "baixa",
// "entrada", "comprovante", "e2:/levar"...). `desligavel` = interruptor do
// banco (bot_comandos_status.desligados).

const GRUPOS = [
  {
    id: 'vendas', titulo: '🛒 *Grupo de VENDAS*',
    secoes: [
      ['🛍️ Venda', [
        { nome: 'Baixa', desc: 'dá baixa da venda, uma linha por item', ex: '-1 Ignite 5500 Grape Ice', chaves: ['baixa'] },
        { nome: '/atacado', desc: 'venda de atacado (itens embaixo) ou marca a última venda', ex: '/atacado', chaves: ['/atacado'] },
        { nome: '/desatacado', desc: 'desfaz o atacado da última venda', ex: '/desatacado', chaves: ['/desatacado'] },
        { nome: '/poddomes', desc: 'seu pod grátis do mês (sem comissão)', ex: '/poddomes Ignite V55 Grape Ice', chaves: ['/poddomes'] },
        { nome: '/stories', desc: 'foto do stories com /stories na legenda (bônus)', ex: '/stories', chaves: ['/stories'] },
      ]],
      ['💳 Pagamento', [
        { nome: 'Comprovante', desc: 'foto ou PDF do pix; a leitura vai pro faturamento', ex: '(mande a foto)', chaves: ['comprovante'] },
        { nome: '+DINHEIRO', desc: 'dinheiro recebido em mãos', ex: '+100 DINHEIRO', chaves: ['dinheiro'] },
        { nome: '+DESCONTO', desc: 'desconto combinado na sua última venda', ex: '+DESCONTO 20 cliente levou 5', chaves: ['desconto'] },
        { nome: 'Cobrança', desc: 'aviso automático de venda 60 min sem pagamento', ex: '(automático)', chaves: ['cobranca'], desligavel: 'cobranca' },
        { nome: 'Despesa do Rod', desc: 'entrega ou Uber (negativo estorna)', ex: '+25 ENTREGA', chaves: ['despesa'] },
      ]],
      ['📦 Estoque', [
        { nome: '/estoque', desc: 'pods por modelo (detalhado: com sabores)', ex: '/estoque detalhado', chaves: ['/estoque'] },
        { nome: '/zerados · /baixo', desc: 'sem estoque · só 1', ex: '/zerados', chaves: ['/zerados', '/baixo'] },
        { nome: '/troca', desc: 'troca de cliente: sai do estoque, não é venda', ex: '/troca defeito', chaves: ['/troca'] },
        { nome: '/consignado', desc: 'tira do estoque sem virar venda', ex: '/consignado 2 Ignite V50 Grape', chaves: ['/consignado'] },
      ]],
      ['🛠️ Correção', [
        { nome: '/correção', desc: 'lista suas vendas de hoje; com número, desfaz', ex: '/correção 2', chaves: ['/correção'] },
        { nome: '/anular', desc: 'desconta pods da sua comissão', ex: '/anular 2', chaves: ['/anular'] },
        { nome: '/desanular · /adicionar', desc: 'desfaz anulação · soma na comissão (só o dono)', ex: '/adicionar 2 Gabriel', chaves: ['/desanular', '/adicionar'] },
      ]],
      ['📊 Relatórios', [
        { nome: '/comissao', desc: 'sua comissão do mês', ex: '/comissao', chaves: ['/comissao'] },
        { nome: '/sou', desc: 'liga seu Telegram ao vendedor (uma vez)', ex: '/sou Gabriel', chaves: ['/sou'] },
        { nome: '/relatorio · /semana', desc: 'resumo do dia · da semana', ex: '/semana', chaves: ['/relatorio', '/semana'] },
        { nome: '/despesas · /dinheiro', desc: 'despesas do Rod · dinheiro em mãos no ciclo', ex: '/dinheiro', chaves: ['/despesas', '/dinheiro'] },
      ]],
    ],
  },
  {
    id: 'reposicao', titulo: '📥 *Grupo de ENTRADAS da loja (REPOSIÇÃO)*',
    secoes: [
      ['📦 Estoque', [
        { nome: 'Entrada', desc: 'mercadoria que chegou na loja', ex: '+5 Ignite 5500 Grape Ice', chaves: ['entrada'] },
        { nome: 'Entrada sem +', desc: 'número no fim também é entrada', ex: 'Elfbar 40000 Ice King 5', chaves: ['entrada'] },
        { nome: '/levar', desc: 'tira do Estoque 2 e põe na loja', ex: '/levar Ignite V400 Ice Menthol 3', chaves: ['/levar'] },
        { nome: '/troca · /consignado', desc: 'sai do estoque sem ser venda', ex: '/consignado 2 Ignite V50 Grape', chaves: ['/troca', '/consignado'] },
        { nome: '/estoque · /zerados · /baixo', desc: 'ver o estoque da loja', ex: '/estoque', chaves: ['/estoque', '/zerados', '/baixo'] },
      ]],
      ['🛠️ Correção', [
        { nome: '/correção', desc: 'lista os lançamentos de hoje; com número, desfaz', ex: '/correção 1', chaves: ['/correção'] },
      ]],
      ['📊 Relatórios', [
        { nome: '/reposicao', desc: 'entradas dos últimos 30 min', ex: '/reposicao', chaves: ['/reposicao'] },
        { nome: '/relatorio', desc: 'resumo do estoque', ex: '/relatorio', chaves: ['/relatorio'] },
      ]],
    ],
  },
  {
    id: 'estoque2', titulo: '🏬 *Grupo ESTOQUE SECUNDÁRIO (Estoque 2)*',
    nota: '_Aqui nada é venda: sem baixa, comissão ou faturamento._',
    secoes: [
      ['📦 Estoque', [
        { nome: 'Entrada', desc: 'entra no Estoque 2', ex: '+5 Ignite V400 Ice Menthol', chaves: ['e2:mov'] },
        { nome: 'Descontar', desc: 'sai do Estoque 2', ex: '-2 Ignite V400 Ice Menthol', chaves: ['e2:mov', 'e2:/tirar'] },
        { nome: '/atualizar', desc: 'define o saldo de um sabor', ex: '/atualizar Ignite V400 Ice Menthol 10', chaves: ['e2:/atualizar'] },
        { nome: '/levar', desc: 'leva pra loja (uma linha ou no formato da contagem)', ex: '/levar Ignite V400 Ice Menthol 3', chaves: ['e2:/levar'] },
        { nome: '/contagem', desc: 'substitui o saldo: "Modelo:" e "2 Sabor" embaixo', ex: '/contagem', chaves: ['e2:/contagem'] },
      ]],
      ['🛠️ Correção', [
        { nome: '/correção', desc: 'lançamentos de hoje; com número, desfaz', ex: '/correção 3', chaves: ['e2:/correção'] },
      ]],
      ['📊 Relatórios', [
        { nome: '/estoque · /zerados · /baixo', desc: 'ver o Estoque 2', ex: '/estoque', chaves: ['e2:/estoque', 'e2:/zerados', 'e2:/baixo'] },
        { nome: '/reposicao', desc: 'entradas dos últimos 30 min', ex: '/reposicao', chaves: ['e2:/reposicao'] },
      ]],
    ],
  },
  {
    id: 'pedidos', titulo: '📋 *Grupo de PEDIDOS*',
    secoes: [
      ['📦 Estoque', [
        { nome: '/fornecedor', desc: 'importa a lista do fornecedor (só o dono)', ex: '/fornecedor', chaves: ['/fornecedor', 'fila:fornecedor'] },
        { nome: '/apelido', desc: 'liga o nome do fornecedor ao do sistema', ex: '/apelido TE 30K = Elfbar 30000', chaves: ['/apelido'] },
        { nome: '/pedido', desc: 'buscar no Estoque 2, pedido ao fornecedor e ninguém tem', ex: '/pedido detalhe', chaves: ['/pedido', 'botao:pedido'] },
      ]],
    ],
  },
  {
    id: 'faturamento', titulo: '💰 *Grupo de FATURAMENTO*',
    secoes: [
      ['💳 Pagamento', [
        { nome: '/caixa', desc: 'dinheiro que entrou no dia', ex: '/caixa 15/09', chaves: ['/caixa'] },
        { nome: '/caixa corrigir', desc: 'lista numerada pra apagar ou mudar valor', ex: '/caixa valor 2 235', chaves: ['/caixa'] },
        { nome: 'Sem pagamento (3h)', desc: 'lista automática do que ficou sem pagar', ex: '(automático)', chaves: ['auto:sem_pagamento'] },
      ]],
      ['🛠️ Correção', [
        { nome: '/refazerfechamento', desc: 'recalcula o fechamento de um ciclo (sócios)', ex: '/refazerfechamento 30/09', chaves: ['/refazerfechamento'] },
        { nome: '/poddomes_desfazer', desc: 'desfaz o pod do mês (sócios)', ex: '/poddomes_desfazer Rodrigo', chaves: ['/poddomes_desfazer'] },
      ]],
      ['📊 Relatórios', [
        { nome: '/faturamento', desc: 'resumo do mês (automático às 3h)', ex: '/faturamento 09/2026', chaves: ['/faturamento', 'auto:faturamento'] },
        { nome: '/relatorio mes', desc: 'dia a dia do mês', ex: '/relatorio mes', chaves: ['/relatorio'] },
        { nome: '/geral · /fechamento', desc: 'painel e parcial do ciclo (sócios)', ex: '/fechamento', chaves: ['/geral', '/fechamento'] },
      ]],
    ],
  },
  {
    id: 'traducao', titulo: '🔤 *Grupo de TRADUÇÃO*',
    secoes: [
      ['📦 Estoque', [
        { nome: 'Lista colada', desc: 'devolve no formato da reposição (não dá entrada)', ex: '(cole a lista)', chaves: ['/traduzir'] },
        { nome: '/traduzir', desc: 'o mesmo, com a lista embaixo', ex: '/traduzir', chaves: ['/traduzir'] },
      ]],
    ],
  },
  {
    id: 'atualizacoes', titulo: '📝 *Grupo de ATUALIZAÇÕES (tarefas)*',
    secoes: [
      ['🗂️ Tarefas', [
        { nome: '/nova', desc: 'cria uma tarefa', ex: '/nova trocar foto do V80 no site', chaves: ['/nova'] },
        { nome: '/lista · /feitas', desc: 'abertas · concluídas', ex: '/lista', chaves: ['/lista', '/feitas'] },
        { nome: '/feito · /reabrir · /apagar', desc: 'pelo número da lista', ex: '/feito 3', chaves: ['/feito', '/reabrir', '/apagar'] },
        { nome: '/instrucoes', desc: 'como usar', ex: '/instrucoes', chaves: ['/instrucoes'] },
      ]],
    ],
  },
];

const GERAIS = [
  { nome: '/comandos', desc: 'esta lista (sócio: `/comandos tudo`)', ex: '/comandos', chaves: ['/comandos'] },
  { nome: '/meuid · /idgrupo', desc: 'seu ID · o ID deste grupo', ex: '/meuid', chaves: ['/meuid', '/idgrupo'] },
];

function statusItem(item, st) {
  if (item.desligavel && (st.desligados || []).includes(item.desligavel)) return '⛔';
  const comErro = new Set((st.erros || []).map(e => e.chave));
  return item.chaves.some(c => comErro.has(c)) ? '⚠️' : '✅';
}

function linhaItem(item, st) {
  const nome = item.nome.includes('_') ? `\`${item.nome}\`` : `*${item.nome}*`;
  const ex = item.ex.startsWith('(') ? `_${item.ex}_` : `\`${item.ex}\``;
  return `${statusItem(item, st)} ${nome} — ${item.desc}\n      ${ex}`;
}

function blocoGrupo(g, st) {
  const partes = [g.titulo];
  if (g.nota) partes.push(g.nota);
  for (const [assunto, itens] of g.secoes) {
    partes.push(`\n*${assunto}*`);
    for (const it of itens) partes.push(linhaItem(it, st));
  }
  return partes.join('\n');
}

function blocoGerais(st) {
  return ['*ℹ️ Em todos os grupos*', ...GERAIS.map(it => linhaItem(it, st))].join('\n');
}

const LEGENDA = '_✅ funcionando · ⚠️ deu erro nos últimos 7 dias · ⛔ desligado_';

// Uma mensagem por grupo (cabe no limite do Telegram); a 1ª leva a legenda.
function montarComandos(grupoId, st, opts = {}) {
  const status = st || {};
  if (opts.tudo) {
    const msgs = GRUPOS.map(g => blocoGrupo(g, status));
    msgs[0] = `📖 *TODOS OS COMANDOS*\n${LEGENDA}\n\n` + msgs[0];
    msgs.push(blocoGerais(status) + '\n\n' + blocoErros(status));
    return msgs;
  }
  const g = GRUPOS.find(x => x.id === grupoId);
  if (!g) return [`📖 *COMANDOS*\n${LEGENDA}\n\n` + blocoGerais(status)];
  return [`${LEGENDA}\n\n${blocoGrupo(g, status)}\n\n${blocoGerais(status)}`];
}

const NOMES_CHAVE = { baixa: 'Baixa (-)', entrada: 'Entrada (+)', comprovante: 'Comprovante', dinheiro: '+DINHEIRO', desconto: '+DESCONTO', despesa: 'Despesa do Rod', cobranca: 'Cobrança', 'e2:mov': 'Estoque 2: entrada/saída', 'auto:faturamento': 'Faturamento das 3h', 'auto:sem_pagamento': 'Sem pagamento das 3h', 'fila:fornecedor': 'Lista do fornecedor (sistema)', 'botao:pedido': 'Botões do /pedido' };

function nomeChave(c) {
  if (NOMES_CHAVE[c]) return NOMES_CHAVE[c];
  if (c.startsWith('e2:')) return `Estoque 2: ${c.slice(3)}`;
  return c;
}

function blocoErros(st) {
  const erros = (st && st.erros) || [];
  if (!erros.length) return '🧯 *Erros nos últimos 7 dias:* nenhum ✅';
  return ['🧯 *Erros nos últimos 7 dias*', ...erros.map(e => `⚠️ ${nomeChave(String(e.chave)).replace(/_/g, '\\_')} — ${e.n}x`)].join('\n');
}

// Chave de erro de uma mensagem (o que o /comandos olha).
function chaveDaMensagem(text, cmd, opts = {}) {
  const t = String(text || '').trim();
  let c = '';
  if (cmd && cmd.startsWith('/')) {
    const semAcento = cmd.normalize('NFD').replace(/[̀-ͯ]/g, '');
    c = semAcento === '/correcao' || semAcento === '/corrigir' ? '/correção' : cmd;
    if (c === '/ajuda' || c === '/start') c = '/comandos';
    if (c === '/estoque2') c = '/estoque';
  } else if (opts.estoque2) {
    c = 'mov';
  } else if (/^[+-]\s*DESCONTO\b/i.test(t)) c = 'desconto';
  else if (/^[+-]\s*\d+([.,]\d+)?\s+DINHEIRO\b/i.test(t)) c = 'dinheiro';
  else if (/^[+-]\s*\d+([.,]\d+)?\s+(ENTREGA|UBER|99|MOTOBOY|GASOLINA)\b/i.test(t)) c = 'despesa';
  else if (t.startsWith('-')) c = 'baixa';
  else if (t.startsWith('+')) c = 'entrada';
  else if (opts.arquivo) c = 'comprovante';
  else if (opts.reposicao) c = 'entrada';
  else if (opts.traducao) c = '/traduzir';
  else c = 'mensagem';
  return opts.estoque2 ? `e2:${c}` : c;
}

module.exports = { GRUPOS, montarComandos, chaveDaMensagem, blocoErros, statusItem };
