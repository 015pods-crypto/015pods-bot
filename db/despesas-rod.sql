-- ===========================================================================
-- Registros do Rod: DESPESA ("+25 ENTREGA") e DINHEIRO ("+100 DINHEIRO")
--
-- VERSÃO ÚNICA — substitui a versão anterior deste arquivo (que não tinha a
-- coluna `tipo`). Se os Runs antigos NÃO foram aplicados no banco ainda, rode
-- só o que está aqui: não existe migração a fazer.
--
-- Como rodar: SQL Editor do Supabase, um RUN de cada vez, na ordem 1 → 2 → 3.
-- O token é conferido contra integration_config.bot_sync_token, igual às
-- outras RPCs do bot — não precisa editar nada antes de rodar.
--
-- NOME DA TABELA: continua `despesas_rod` (com coluna `tipo`) em vez de virar
-- `registros_rod`. As RPCs já se chamam bot_despesa*_ e renomear tabela+RPCs
-- só pra caber o dinheiro trocaria nome em três lugares sem ganhar nada.
--
-- TIPOS (coluna `tipo`, sinais contábeis OPOSTOS — por isso não é um só):
--   'despesa'  → a loja DEVE ao Rod (entrega, uber, gasolina...)
--   'dinheiro' → o Rod está COM dinheiro da loja em mãos (venda paga em espécie)
--
-- Ciclo: 21/mm 00:00 → 20/mm+1 23:59:59 (America/Sao_Paulo). O ciclo é gravado
-- em cada lançamento (ciclo_inicio/ciclo_fim), então o acumulado zera sozinho na
-- virada e um lançamento nunca "muda de ciclo" depois.
-- ===========================================================================


-- ═══ RUN 1 — tabela ════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN 1" e aperte Run)

create table if not exists public.despesas_rod (
  id           bigint generated always as identity primary key,
  tipo         text          not null default 'despesa'
                             check (tipo in ('despesa', 'dinheiro')),
  valor        numeric(10,2) not null check (valor > 0),
  descricao    text          not null default '',
  criado_em    timestamptz   not null default now(),
  ciclo_inicio date          not null,
  ciclo_fim    date          not null,
  meta         jsonb         not null default '{}'::jsonb
);

-- Se a tabela já existir de uma versão anterior sem `tipo`, isto a completa
-- (no-op quando a coluna já está lá).
alter table public.despesas_rod
  add column if not exists tipo text not null default 'despesa';

create index if not exists despesas_rod_ciclo_idx
  on public.despesas_rod (ciclo_inicio, tipo, criado_em);

-- Sem policy nenhuma: o acesso é só pelas RPCs security definer abaixo.
alter table public.despesas_rod enable row level security;

-- ─── FIM DO RUN 1 ──────────────────────────────────────────────────────────


-- ═══ RUN 2 — funções ═══════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN 2" e aperte Run)

-- As assinaturas mudaram (ganharam p_tipo): dropar antes evita o Postgres criar
-- uma SEGUNDA sobrecarga e o PostgREST reclamar de chamada ambígua.
drop function if exists public.bot_despesa_rod_registrar(text, numeric, text, jsonb);
drop function if exists public.bot_despesas_rod(text, timestamptz);

-- Ciclo vigente para um instante qualquer. Regra única do sistema: fecha SEMPRE
-- no dia 20 às 23:59 (Brasília). Dia 21..fim-do-mês → ciclo começa neste mês;
-- dia 1..20 → ciclo começou no dia 21 do mês passado.
-- (bot_comissao aplica a MESMA regra no próprio corpo — ver comissao-ciclo-20.sql.
--  A duplicação é de propósito: os dois arquivos rodam em qualquer ordem.)
create or replace function public.bot_ciclo(p_ts timestamptz default now())
returns table (inicio date, fim date)
language sql
stable
as $$
  select
    case when extract(day from d) >= 21
         then (date_trunc('month', d) + interval '20 days')::date
         else (date_trunc('month', d) - interval '1 month' + interval '20 days')::date
    end,
    case when extract(day from d) >= 21
         then (date_trunc('month', d) + interval '1 month' + interval '19 days')::date
         else (date_trunc('month', d) + interval '19 days')::date
    end
  from (select (p_ts at time zone 'America/Sao_Paulo')::date as d) t;
$$;

-- Rótulo do ciclo no formato usado nas mensagens: "21/07 → 20/08".
create or replace function public.bot_ciclo_label(p_inicio date, p_fim date)
returns text
language sql
immutable
as $$
  select to_char(p_inicio, 'DD/MM') || ' → ' || to_char(p_fim, 'DD/MM');
$$;

-- Lê uma chave da integration_config. É por aqui que o bot busca a lista
-- `bot_despesa_palavras` — palavra nova de despesa = update no config (RUN 3),
-- sem deploy do bot.
create or replace function public.bot_config(p_token text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok text;
  v_val text;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  -- Só chaves de configuração do bot são legíveis: sem isso esta RPC viraria
  -- um "leia qualquer segredo da integration_config" com o token do bot.
  if p_key is null or p_key not like 'bot\_%' or p_key = 'bot_sync_token' then
    return jsonb_build_object('ok', false, 'erro', 'chave não permitida');
  end if;

  select value into v_val from integration_config where key = p_key;

  return jsonb_build_object('ok', true, 'key', p_key, 'valor', coalesce(v_val, ''));
end;
$$;

-- Registra um lançamento e devolve o acumulado do ciclo PARA AQUELE TIPO — é
-- esse número que o bot ecoa no grupo ("total do ciclo" / "total em mãos").
-- Somar tipos diferentes aqui daria um total sem significado: os sinais são
-- opostos.
create or replace function public.bot_despesa_rod_registrar(
  p_token     text,
  p_valor     numeric,
  p_descricao text,
  p_tipo      text default 'despesa',
  p_meta      jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok    text;
  v_tipo   text;
  v_inicio date;
  v_fim    date;
  v_id     bigint;
  v_total  numeric;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  if p_valor is null or p_valor <= 0 then
    return jsonb_build_object('ok', false, 'erro', 'valor inválido');
  end if;

  v_tipo := lower(btrim(coalesce(p_tipo, 'despesa')));
  if v_tipo not in ('despesa', 'dinheiro') then
    return jsonb_build_object('ok', false, 'erro', 'tipo inválido');
  end if;

  -- Descrição vazia só é aceita em 'dinheiro' ("+100 DINHEIRO" não tem mais o
  -- que dizer); despesa sem descrição é lançamento cego e continua barrada.
  if v_tipo = 'despesa' and (p_descricao is null or btrim(p_descricao) = '') then
    return jsonb_build_object('ok', false, 'erro', 'descrição vazia');
  end if;

  select inicio, fim into v_inicio, v_fim from public.bot_ciclo(now());

  insert into public.despesas_rod (tipo, valor, descricao, ciclo_inicio, ciclo_fim, meta)
  values (v_tipo, round(p_valor, 2), btrim(coalesce(p_descricao, '')),
          v_inicio, v_fim, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  select coalesce(sum(valor), 0) into v_total
    from public.despesas_rod
   where ciclo_inicio = v_inicio and tipo = v_tipo;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'tipo', v_tipo,
    'valor', round(p_valor, 2),
    'descricao', btrim(coalesce(p_descricao, '')),
    'total_ciclo', v_total,
    'ciclo', public.bot_ciclo_label(v_inicio, v_fim),
    'ciclo_inicio', v_inicio,
    'ciclo_fim', v_fim
  );
end;
$$;

-- Acumulado + itens do ciclo, de um tipo. Usado pelo /despesas, /dinheiro,
-- /geral e pelo fechamento.
-- p_ref permite consultar o ciclo de outra data (ex.: refazer um fechamento).
create or replace function public.bot_despesas_rod(
  p_token text,
  p_ref   timestamptz default now(),
  p_tipo  text default 'despesa'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok    text;
  v_tipo   text;
  v_inicio date;
  v_fim    date;
  v_total  numeric;
  v_itens  jsonb;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  v_tipo := lower(btrim(coalesce(p_tipo, 'despesa')));
  if v_tipo not in ('despesa', 'dinheiro') then
    return jsonb_build_object('ok', false, 'erro', 'tipo inválido');
  end if;

  select inicio, fim into v_inicio, v_fim from public.bot_ciclo(coalesce(p_ref, now()));

  select coalesce(sum(valor), 0),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'valor', valor,
             'descricao', descricao,
             'data', to_char(criado_em at time zone 'America/Sao_Paulo', 'DD/MM')
           ) order by criado_em
         ), '[]'::jsonb)
    into v_total, v_itens
    from public.despesas_rod
   where ciclo_inicio = v_inicio and tipo = v_tipo;

  return jsonb_build_object(
    'ok', true,
    'tipo', v_tipo,
    'total', v_total,
    'itens', v_itens,
    'ciclo', public.bot_ciclo_label(v_inicio, v_fim),
    'ciclo_inicio', v_inicio,
    'ciclo_fim', v_fim
  );
end;
$$;

-- PostgREST só enxerga o que tem grant. As RPCs são security definer e checam
-- o token por dentro; a tabela continua inacessível pro anon.
grant execute on function public.bot_ciclo(timestamptz)                                     to anon, authenticated;
grant execute on function public.bot_ciclo_label(date, date)                                to anon, authenticated;
grant execute on function public.bot_config(text, text)                                     to anon, authenticated;
grant execute on function public.bot_despesa_rod_registrar(text, numeric, text, text, jsonb) to anon, authenticated;
grant execute on function public.bot_despesas_rod(text, timestamptz, text)                  to anon, authenticated;

-- ─── FIM DO RUN 2 ──────────────────────────────────────────────────────────


-- ═══ RUN 3 — lista de palavras de despesa ══════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN 3" e aperte Run)
--
-- CSV, case-insensitive, lido pelo bot com cache de ~1 min. Palavra nova de
-- despesa = rodar de novo este RUN com a palavra a mais. NÃO deploy.
-- DINHEIRO é palavra reservada do bot e NÃO entra aqui.

insert into public.integration_config (key, value)
values ('bot_despesa_palavras', 'ENTREGA,UBER,GASOLINA')
on conflict (key) do update set value = excluded.value;

-- ─── FIM DO RUN 3 ──────────────────────────────────────────────────────────


-- ═══ Conferência rápida (opcional, trocando <TOKEN>) ═══════════════════════
-- select * from public.bot_ciclo(now());                              -- ciclo de hoje
-- select public.bot_config('<TOKEN>', 'bot_despesa_palavras');        -- lista atual
-- select public.bot_despesa_rod_registrar('<TOKEN>', 25, 'ENTREGA', 'despesa');
-- select public.bot_despesa_rod_registrar('<TOKEN>', 100, 'DINHEIRO', 'dinheiro');
-- select public.bot_despesas_rod('<TOKEN>', now(), 'despesa');
-- select public.bot_despesas_rod('<TOKEN>', now(), 'dinheiro');
--
-- Depois de testar, para limpar os lançamentos de teste:
-- delete from public.despesas_rod where meta = '{}'::jsonb;
