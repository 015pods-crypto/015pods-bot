-- ===========================================================================
-- Despesas particulares do Rod ("+25 ENTREGA ROD" no grupo)
--
-- Como rodar: SQL Editor do Supabase, um RUN de cada vez (create table separado
-- das functions). O token é conferido contra integration_config.bot_sync_token,
-- igual às outras RPCs do bot — não precisa editar nada antes de rodar.
--
-- Ciclo: 21/mm 00:00 → 20/mm+1 23:59:59 (America/Sao_Paulo). O ciclo é gravado
-- em cada lançamento (ciclo_inicio/ciclo_fim), então o acumulado zera sozinho na
-- virada e um lançamento nunca "muda de ciclo" depois.
-- ===========================================================================


-- ═══ RUN 1 — tabela ════════════════════════════════════════════════════════

create table if not exists public.despesas_rod (
  id           bigint generated always as identity primary key,
  valor        numeric(10,2) not null check (valor > 0),
  descricao    text          not null check (length(btrim(descricao)) > 0),
  criado_em    timestamptz   not null default now(),
  ciclo_inicio date          not null,
  ciclo_fim    date          not null,
  meta         jsonb         not null default '{}'::jsonb
);

create index if not exists despesas_rod_ciclo_idx
  on public.despesas_rod (ciclo_inicio, criado_em);

-- Sem policy nenhuma: o acesso é só pelas RPCs security definer abaixo.
alter table public.despesas_rod enable row level security;


-- ═══ RUN 2 — funções ═══════════════════════════════════════════════════════

-- Ciclo vigente para um instante qualquer. Regra única do sistema: fecha SEMPRE
-- no dia 20 às 23:59 (Brasília). Dia 21..fim-do-mês → ciclo começa neste mês;
-- dia 1..20 → ciclo começou no dia 21 do mês passado.
-- (bot_comissao deve passar a usar esta mesma função — ver TAREFA 1.)
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

-- Registra um lançamento e devolve o acumulado do ciclo (é o número que o bot
-- ecoa no grupo: "total do ciclo: R$ 143").
create or replace function public.bot_despesa_rod_registrar(
  p_token     text,
  p_valor     numeric,
  p_descricao text,
  p_meta      jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok    text;
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

  if p_descricao is null or btrim(p_descricao) = '' then
    return jsonb_build_object('ok', false, 'erro', 'descrição vazia');
  end if;

  select inicio, fim into v_inicio, v_fim from public.bot_ciclo(now());

  insert into public.despesas_rod (valor, descricao, ciclo_inicio, ciclo_fim, meta)
  values (round(p_valor, 2), btrim(p_descricao), v_inicio, v_fim, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;

  select coalesce(sum(valor), 0) into v_total
    from public.despesas_rod
   where ciclo_inicio = v_inicio;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'valor', round(p_valor, 2),
    'descricao', btrim(p_descricao),
    'total_ciclo', v_total,
    'ciclo', public.bot_ciclo_label(v_inicio, v_fim),
    'ciclo_inicio', v_inicio,
    'ciclo_fim', v_fim
  );
end;
$$;

-- Acumulado + itens do ciclo. Usado pelo /despesas e pelo fechamento.
-- p_ref permite consultar o ciclo de outra data (ex.: refazer um fechamento).
create or replace function public.bot_despesas_rod(
  p_token text,
  p_ref   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok    text;
  v_inicio date;
  v_fim    date;
  v_total  numeric;
  v_itens  jsonb;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
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
   where ciclo_inicio = v_inicio;

  return jsonb_build_object(
    'ok', true,
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
grant execute on function public.bot_ciclo(timestamptz)                              to anon, authenticated;
grant execute on function public.bot_ciclo_label(date, date)                         to anon, authenticated;
grant execute on function public.bot_despesa_rod_registrar(text, numeric, text, jsonb) to anon, authenticated;
grant execute on function public.bot_despesas_rod(text, timestamptz)                 to anon, authenticated;


-- ═══ Conferência rápida (opcional) ═════════════════════════════════════════
-- select * from public.bot_ciclo(now());                       -- ciclo de hoje
-- select * from public.bot_ciclo('2026-08-20 23:59-03'::timestamptz);  -- 21/07 → 20/08
-- select * from public.bot_ciclo('2026-08-21 00:01-03'::timestamptz);  -- 21/08 → 20/09
