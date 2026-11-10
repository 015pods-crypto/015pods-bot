-- ===========================================================================
-- /poddomes — 1 pod por mês, de graça, para cada vendedor
--
-- É só uma saída de estoque. Fica numa tabela própria e NÃO grava em `sales`:
-- assim a bot_comissao, o faturamento e as views sale_financials e
-- product_sales não têm como somar o pod do mês.
--
-- Mês = o da comissão: dia 1 ao último dia, pelo dia da loja (dia_loja, vira
-- às 3h). O índice único é a garantia final do limite de 1 por mês. Um pod
-- desfeito continua na tabela como histórico (desfeito_em) e libera o mês.
--
-- O estoque sai de flavors.stock_qty e fica registrado em stock_movements,
-- para a conferência de estoque não acusar o pod como sumido.
--
-- Como rodar: SQL Editor do Supabase, RUN único. Pode rodar de novo sem
-- estragar nada (create if not exists / create or replace).
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

create table if not exists public.pod_do_mes (
  id                uuid        primary key default gen_random_uuid(),
  vendedor_id       uuid        not null references public.vendedores (id),
  flavor_id         uuid        not null references public.flavors (id),
  produto           text        not null,
  custo             numeric(10,2) not null default 0,  -- product_costs.cost na hora da saída
  mes               date        not null check (extract(day from mes) = 1),
  dia               date        not null,              -- dia da loja
  registrado_por_tg text,
  criado_em         timestamptz not null default now(),
  desfeito_em       timestamptz,
  desfeito_por_tg   text
);
create unique index if not exists pod_do_mes_um_por_mes
  on public.pod_do_mes (vendedor_id, mes) where desfeito_em is null;
create index if not exists pod_do_mes_mes_idx on public.pod_do_mes (mes);

-- RLS ligada e sem policy: só as funções abaixo (security definer) mexem.
alter table public.pod_do_mes enable row level security;
revoke all on table public.pod_do_mes from public, anon, authenticated;
grant select, insert, update, delete on table public.pod_do_mes to service_role;


-- Registra o pod do mês de QUEM MANDOU. Tudo numa transação só: qualquer recusa
-- ou erro deixa o estoque como estava.
create or replace function public.bot_pod_do_mes(p_token text, p_produto text, p_meta jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_input text := btrim(coalesce(p_produto, ''));
  v_line jsonb := jsonb_build_object('input', btrim(coalesce(p_produto, '')));
  v_vend uuid; v_vend_nome text; v_tg text;
  v_dia date; v_mes date; v_prox date;
  v_ja record;
  v_np text; v_full text; v_matches jsonb; v_n integer;
  v_fid uuid; v_model text; v_flavor text; v_before integer; v_cost numeric(10,2);
  v_marca text; v_nao_pod boolean;
begin
  if p_token is null or p_token <>
     (select value from public.integration_config where key = 'bot_sync_token') then
    raise exception 'token inválido' using errcode = '42501';
  end if;

  -- O dono é sempre quem mandou: tira a chave "vendedor", que deixaria um sócio
  -- lançar no nome de outra pessoa.
  v_vend := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb) - 'vendedor');
  if v_vend is null then
    return jsonb_build_object('ok', false, 'status', 'nao_vendedor');
  end if;
  v_tg := public.tg_do_meta(coalesce(p_meta, '{}'::jsonb));

  -- Um pedido por vendedor de cada vez. "no key update" não trava as baixas.
  select nome into v_vend_nome from public.vendedores where id = v_vend for no key update;

  v_dia  := public.dia_loja(now());
  v_mes  := date_trunc('month', v_dia::timestamp)::date;
  v_prox := (v_mes + interval '1 month')::date;

  select produto, dia into v_ja from public.pod_do_mes
   where vendedor_id = v_vend and mes = v_mes and desfeito_em is null;
  if found then
    return jsonb_build_object('ok', false, 'status', 'ja_usou', 'vendedor', v_vend_nome,
      'produto', v_ja.produto, 'dia', v_ja.dia, 'mes', v_mes, 'proximo', v_prox);
  end if;

  if v_input = '' then
    return v_line || jsonb_build_object('ok', false, 'status', 'nao_encontrado');
  end if;

  -- Mesma busca da bot_movimentar_estoque: exato primeiro, subconjunto depois.
  v_np   := public.bot_norm_np(v_input);
  v_full := public.bot_norm(translate(v_input, '()', '  '));
  select coalesce(jsonb_agg(jsonb_build_object('flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb),
         count(*)
    into v_matches, v_n
    from public.flavors f join public.models m on m.id = f.model_id
   where f.active and m.active
     and ( public.bot_norm_np(m.name || ' ' || f.name) = v_np
        or public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')) = v_full );
  if v_n = 0 and length(v_full) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb),
           count(*)
      into v_matches, v_n
      from public.flavors f join public.models m on m.id = f.model_id
     where f.active and m.active
       and string_to_array(v_full, ' ')
           <@ string_to_array(public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')), ' ');
  end if;
  if v_n = 0 then
    return v_line || jsonb_build_object('ok', false, 'status', 'nao_encontrado');
  end if;
  if v_n > 1 then
    return v_line || jsonb_build_object('ok', false, 'status', 'ambiguo', 'matches', v_matches);
  end if;

  v_fid    := (v_matches -> 0 ->> 'flavor_id')::uuid;
  v_model  := v_matches -> 0 ->> 'model';
  v_flavor := v_matches -> 0 ->> 'flavor';

  -- Mesmo filtro de pod da bot_comissao.
  select b.name into v_marca
    from public.flavors f join public.models m on m.id = f.model_id
    left join public.brands b on b.id = m.brand_id
   where f.id = v_fid;
  with palavras as (
    select lower(trim(x)) as p
      from regexp_split_to_table(
             regexp_replace(coalesce((select value from integration_config where key = 'bot_nao_pods'), ''),
                            '[\[\]""]', '', 'g'),
             '\s*[,;|\n]\s*') as x
     where trim(x) <> ''
  )
  select coalesce(lower(trim(v_marca)), '') in ('complementos', 'tabacaria')
      or exists (select 1 from palavras w where lower(v_model) like '%' || w.p || '%')
    into v_nao_pod;
  if v_nao_pod then
    return v_line || jsonb_build_object('ok', false, 'status', 'nao_pod',
      'model', v_model, 'flavor', v_flavor);
  end if;

  select stock_qty into v_before from public.flavors where id = v_fid for update;
  if coalesce(v_before, 0) < 1 then
    return v_line || jsonb_build_object('ok', false, 'status', 'estoque_insuficiente', 'qty', 1,
      'flavor_id', v_fid, 'model', v_model, 'flavor', v_flavor, 'stock_before', v_before);
  end if;

  select coalesce(cost, 0) into v_cost from public.product_costs where flavor_id = v_fid;
  v_cost := coalesce(v_cost, 0);

  update public.flavors set stock_qty = stock_qty - 1 where id = v_fid;
  insert into public.stock_movements (flavor_id, qty_delta, type, notes)
    values (v_fid, -1, 'ajuste', 'bot telegram: pod do mês');
  insert into public.pod_do_mes (vendedor_id, flavor_id, produto, custo, mes, dia, registrado_por_tg)
    values (v_vend, v_fid, v_model || ' ' || v_flavor, v_cost, v_mes, v_dia, v_tg);

  return v_line || jsonb_build_object('ok', true, 'status', 'ok', 'vendedor', v_vend_nome,
    'produto', v_model || ' ' || v_flavor, 'qty', 1, 'dia', v_dia, 'mes', v_mes, 'proximo', v_prox,
    'stock_before', v_before, 'stock_after', v_before - 1);
end;
$$;


-- /poddomes sem produto: já usou no mês ou ainda está disponível?
create or replace function public.bot_pod_do_mes_status(p_token text, p_meta jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_vend uuid; v_vend_nome text; v_mes date; v_prox date; v_ja record;
begin
  if p_token is null or p_token <>
     (select value from public.integration_config where key = 'bot_sync_token') then
    raise exception 'token inválido' using errcode = '42501';
  end if;

  v_vend := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb) - 'vendedor');
  if v_vend is null then
    return jsonb_build_object('ok', false, 'status', 'nao_vendedor');
  end if;
  select nome into v_vend_nome from public.vendedores where id = v_vend;

  v_mes  := date_trunc('month', public.dia_loja(now())::timestamp)::date;
  v_prox := (v_mes + interval '1 month')::date;

  select produto, dia into v_ja from public.pod_do_mes
   where vendedor_id = v_vend and mes = v_mes and desfeito_em is null;
  if found then
    return jsonb_build_object('ok', true, 'status', 'usado', 'vendedor', v_vend_nome,
      'produto', v_ja.produto, 'dia', v_ja.dia, 'mes', v_mes, 'proximo', v_prox);
  end if;
  return jsonb_build_object('ok', true, 'status', 'disponivel', 'vendedor', v_vend_nome,
    'mes', v_mes, 'proximo', v_prox);
end;
$$;


-- Pods do mês de uma data (padrão: hoje), para as linhas 🎁 das mensagens.
create or replace function public.bot_pod_do_mes_lista(p_token text, p_ref date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mes date;
begin
  if p_token is null or p_token <>
     (select value from public.integration_config where key = 'bot_sync_token') then
    raise exception 'token inválido' using errcode = '42501';
  end if;

  v_mes := date_trunc('month', coalesce(p_ref, public.dia_loja(now()))::timestamp)::date;
  return jsonb_build_object('ok', true, 'mes', v_mes, 'itens', coalesce((
    select jsonb_agg(jsonb_build_object('vendedor', v.nome, 'produto', p.produto, 'dia', p.dia)
                     order by p.dia, p.criado_em)
      from public.pod_do_mes p join public.vendedores v on v.id = p.vendedor_id
     where p.mes = v_mes and p.desfeito_em is null
  ), '[]'::jsonb));
end;
$$;


-- Só sócio: desfaz o pod do mês atual do vendedor, devolve 1 ao estoque e libera.
create or replace function public.bot_pod_do_mes_desfazer(p_token text, p_vendedor text, p_meta jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vend uuid; v_vend_nome text; v_mes date; v_prox date; v_pod record; v_after integer;
begin
  if p_token is null or p_token <>
     (select value from public.integration_config where key = 'bot_sync_token') then
    raise exception 'token inválido' using errcode = '42501';
  end if;

  if not coalesce(public.bot_eh_socio(coalesce(p_meta, '{}'::jsonb)), false) then
    return jsonb_build_object('ok', false, 'status', 'nao_socio');
  end if;

  -- Busca direta pelo nome: a vendedor_do_meta cairia no próprio sócio se o nome
  -- não existisse, e aí desfaria o pod da pessoa errada.
  select id, nome into v_vend, v_vend_nome from public.vendedores
   where lower(nome) = lower(btrim(coalesce(p_vendedor, '')))
   order by ativo desc limit 1
   for no key update;
  if v_vend is null then
    return jsonb_build_object('ok', false, 'status', 'vendedor_nao_encontrado',
      'nomes', coalesce((select jsonb_agg(nome order by nome) from public.vendedores where ativo), '[]'::jsonb));
  end if;

  v_mes  := date_trunc('month', public.dia_loja(now())::timestamp)::date;
  v_prox := (v_mes + interval '1 month')::date;

  select id, flavor_id, produto into v_pod from public.pod_do_mes
   where vendedor_id = v_vend and mes = v_mes and desfeito_em is null
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'nao_usou', 'vendedor', v_vend_nome, 'mes', v_mes);
  end if;

  update public.flavors set stock_qty = stock_qty + 1 where id = v_pod.flavor_id
    returning stock_qty into v_after;
  insert into public.stock_movements (flavor_id, qty_delta, type, notes)
    values (v_pod.flavor_id, 1, 'ajuste', 'bot telegram: pod do mês desfeito');
  update public.pod_do_mes
     set desfeito_em = now(), desfeito_por_tg = public.tg_do_meta(coalesce(p_meta, '{}'::jsonb))
   where id = v_pod.id;

  return jsonb_build_object('ok', true, 'status', 'ok', 'vendedor', v_vend_nome,
    'produto', v_pod.produto, 'mes', v_mes, 'proximo', v_prox, 'stock_after', v_after);
end;
$$;


revoke execute on function public.bot_pod_do_mes(text, text, jsonb)          from public;
revoke execute on function public.bot_pod_do_mes_status(text, jsonb)         from public;
revoke execute on function public.bot_pod_do_mes_lista(text, date)           from public;
revoke execute on function public.bot_pod_do_mes_desfazer(text, text, jsonb) from public;
grant execute on function public.bot_pod_do_mes(text, text, jsonb)          to anon, authenticated;
grant execute on function public.bot_pod_do_mes_status(text, jsonb)         to anon, authenticated;
grant execute on function public.bot_pod_do_mes_lista(text, date)           to anon, authenticated;
grant execute on function public.bot_pod_do_mes_desfazer(text, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';

-- ═══ FIM DO RUN ════════════════════════════════════════════════════════════
