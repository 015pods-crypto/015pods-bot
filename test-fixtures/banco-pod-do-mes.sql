-- Banco mínimo para pod-do-mes.test.js. NÃO roda em produção.
-- As tabelas têm só as colunas que estas funções usam. As funções bot_comissao,
-- bot_movimentar_estoque, bot_norm, bot_norm_np e vendedor_do_meta são cópias
-- das de produção; se mudarem lá, atualize aqui.
create role anon; create role authenticated; create role service_role;
create type movimento as enum ('venda', 'ajuste');

create table integration_config (key text primary key, value text);
create table brands (id uuid primary key default gen_random_uuid(), name text);
create table models (id uuid primary key default gen_random_uuid(), brand_id uuid references brands(id), name text, active boolean default true);
create table flavors (id uuid primary key default gen_random_uuid(), model_id uuid references models(id), name text, stock_qty int default 0, active boolean default true);
create table product_costs (flavor_id uuid primary key, cost numeric);
create table vendedores (id uuid primary key default gen_random_uuid(), nome text, telegram_user_id text, ativo boolean default true);
create table channels (id uuid primary key default gen_random_uuid(), name text, type text, active boolean default true);
create table cash_sessions (id uuid primary key default gen_random_uuid(), status text);
create table prices (flavor_id uuid, channel_id uuid, price numeric);
create table sales (id uuid primary key default gen_random_uuid(), channel_id uuid, cash_session_id uuid, payment_method text, delivery_cost numeric, total numeric, status text, notes text, vendedor_id uuid, registrado_por_tg text, registrado_por_nome text, sold_at timestamptz default now());
create table sale_items (id uuid primary key default gen_random_uuid(), sale_id uuid, flavor_id uuid, qty int, unit_price numeric);
create table sale_item_costs (sale_item_id uuid, unit_cost numeric);
create table stock_movements (id uuid primary key default gen_random_uuid(), flavor_id uuid, qty_delta int, type movimento, notes text, sale_id uuid, created_at timestamptz default now());
create table commission_tiers (min_units int, max_units int, rate numeric);
create table comissao_ajustes (id uuid primary key default gen_random_uuid(), unidades int, created_at timestamptz default now(), vendedor_id uuid);

-- Relógio falso: mesma conta da dia_loja de produção, com o "agora" do teste.
create table _relogio (agora timestamptz);
create table _socios (user_id text);
create function dia_loja(p_ts timestamptz default now()) returns date language sql stable set search_path to 'public' as $$
  select ((coalesce((select agora from _relogio limit 1), p_ts) at time zone 'America/Sao_Paulo') - interval '3 hours')::date;
$$;
create function bot_eh_socio(p_meta jsonb) returns boolean language sql stable as $$
  select exists (select 1 from _socios where user_id = p_meta ->> 'user_id');
$$;
create function tg_do_meta(p_meta jsonb) returns text language sql immutable as $$ select p_meta ->> 'user_id' $$;

-- Cópias do banco de produção (04/11/2026).
CREATE OR REPLACE FUNCTION public.bot_norm(p text)
 RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  select regexp_replace(
    translate(
      lower(btrim(coalesce(p, ''))),
      'áàâãäéèêëíìîïóòôõöúùûüçñ/',
      'aaaaaeeeeiiiiooooouuuucn '
    ),
    '\s+', ' ', 'g'
  );
$function$;

CREATE OR REPLACE FUNCTION public.bot_norm_np(p text)
 RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  select public.bot_norm(regexp_replace(coalesce(p, ''), '\([^)]*\)', ' ', 'g'));
$function$;

CREATE OR REPLACE FUNCTION public.vendedor_do_meta(p_meta jsonb)
 RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce(
    (select id from vendedores
      where ativo and nullif(trim(p_meta ->> 'vendedor'), '') is not null
        and public.bot_eh_socio(p_meta)
        and lower(nome) = lower(trim(p_meta ->> 'vendedor'))),
    (select id from vendedores
      where ativo and telegram_user_id is not null
        and telegram_user_id = coalesce(p_meta ->> 'user_id', p_meta ->> 'id', p_meta ->> 'from_id')));
$function$;

-- Cópia de public.bot_comissao do banco de produção (04/11/2026).
CREATE OR REPLACE FUNCTION public.bot_comissao(p_token text, p_mes date DEFAULT NULL::date, p_meta jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tok text; v_hoje date; v_ini date; v_fim date;
  v_ano int; v_mes int;
  v_vlr_atac numeric;
  v_t_varejo int; v_t_atacado int; v_t_hoje int; v_t_aj int; v_t_aj_hoje int; v_t_total int;
  v_rate numeric; v_prox record; v_faltam int;
  v_eu uuid; v_eu_nome text; v_socio boolean;
  v_lista jsonb; v_sem int; v_eu_obj jsonb; v_por jsonb; v_completo boolean;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  select coalesce(value::numeric, 2) into v_vlr_atac
    from integration_config where key = 'comissao_atacado_valor';
  v_vlr_atac := coalesce(v_vlr_atac, 2);

  v_hoje := coalesce(p_mes, public.dia_loja(now()));
  v_ano  := extract(year  from v_hoje)::int;
  v_mes  := extract(month from v_hoje)::int;

  /* ciclo da comissão (igual a antes):
     - a partir de 01/10/2026: mês cheio
     - 21/09 a 30/09/2026: transição
     - antes: do dia 21 ao dia 20 */
  if v_hoje >= date '2026-10-01' then
    v_ini := date_trunc('month', v_hoje)::date;
    v_fim := (date_trunc('month', v_hoje) + interval '1 month')::date - 1;
  elsif v_hoje >= date '2026-09-21' then
    v_ini := date '2026-09-21';
    v_fim := date '2026-09-30';
  else
    if extract(day from v_hoje) >= 21 then
      v_ini := make_date(v_ano, v_mes, 21);
      v_fim := (v_ini + interval '1 month')::date - 1;
    else
      v_ini := (make_date(v_ano, v_mes, 21) - interval '1 month')::date;
      v_fim := make_date(v_ano, v_mes, 20);
    end if;
    if v_ini <= date '2026-07-21' then v_ini := date '2026-07-20'; end if;
  end if;

  /* pods do ciclo agrupados por vendedor (mesmos filtros de antes) */
  with palavras as (
    select lower(trim(x)) as p
      from regexp_split_to_table(
             regexp_replace(coalesce((select value from integration_config where key = 'bot_nao_pods'), ''),
                            '[\[\]""]', '', 'g'),
             '\s*[,;|\n]\s*') as x
     where trim(x) <> ''
  ),
  itens as (
    select s.vendedor_id, s.notes, s.sold_at, si.qty
      from sales s
      join sale_items si on si.sale_id = s.id
      join flavors f on f.id = si.flavor_id
      join models m on m.id = f.model_id
      left join brands b on b.id = m.brand_id
     where s.notes ilike 'bot telegram%'
       and s.notes not ilike '%troca%'          -- troca não é venda: não gera comissão
       and s.status <> 'cancelada'
       and public.dia_loja(s.sold_at) between v_ini and v_fim
       and coalesce(lower(trim(b.name)), '') not in ('complementos', 'tabacaria')
       and not exists (select 1 from palavras w where lower(m.name) like '%' || w.p || '%')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'vendedor_id', vendedor_id, 'varejo', varejo, 'atacado', atacado, 'hoje', hoje)), '[]'::jsonb)
    into v_por
    from (select vendedor_id,
                 coalesce(sum(qty) filter (where notes not ilike '%atacado%'), 0)::int as varejo,
                 coalesce(sum(qty) filter (where notes ilike '%atacado%'), 0)::int as atacado,
                 coalesce(sum(qty) filter (where public.dia_loja(sold_at) = v_hoje), 0)::int as hoje
            from itens group by vendedor_id) x;

  select coalesce(sum(varejo), 0), coalesce(sum(atacado), 0), coalesce(sum(hoje), 0),
         coalesce(sum(case when vendedor_id is null then varejo + atacado end), 0)
    into v_t_varejo, v_t_atacado, v_t_hoje, v_sem
    from jsonb_to_recordset(v_por) as r(vendedor_id uuid, varejo int, atacado int, hoje int);

  select coalesce(sum(unidades), 0),
         coalesce(sum(unidades) filter (where public.dia_loja(created_at) = v_hoje), 0)
    into v_t_aj, v_t_aj_hoje
    from comissao_ajustes
   where public.dia_loja(created_at) between v_ini and v_fim;

  /* anulações descontam do varejo do mês E das unidades do dia */
  v_t_varejo := greatest(0, v_t_varejo - v_t_aj);
  v_t_hoje   := greatest(0, v_t_hoje - v_t_aj_hoje);
  v_t_total  := v_t_varejo + v_t_atacado;

  /* a faixa olha o total do TIME (atacado ajuda a subir de faixa) */
  select rate into v_rate from commission_tiers
   where v_t_total >= min_units and (max_units is null or v_t_total <= max_units)
   order by min_units desc limit 1;
  v_rate := coalesce(v_rate, 0);

  select min_units, rate into v_prox from commission_tiers
   where min_units > v_t_total order by min_units limit 1;
  v_faltam := case when v_prox.min_units is null then null else v_prox.min_units - v_t_total end;

  /* por vendedor: os pods dele × a faixa do time */
  with r as (
    select * from jsonb_to_recordset(v_por) as r(vendedor_id uuid, varejo int, atacado int, hoje int)
  ), base as (
    select v.id, v.nome,
           coalesce(r.varejo, 0) as varejo, coalesce(r.atacado, 0) as atacado, coalesce(r.hoje, 0) as hoje,
           coalesce((select sum(unidades) from comissao_ajustes a
                      where a.vendedor_id = v.id
                        and public.dia_loja(a.created_at) between v_ini and v_fim), 0) as aj,
           coalesce((select sum(unidades) from comissao_ajustes a
                      where a.vendedor_id = v.id
                        and public.dia_loja(a.created_at) = v_hoje), 0) as aj_hoje
      from vendedores v
      left join r on r.vendedor_id = v.id
     where v.ativo or r.vendedor_id is not null
  ), calc as (
    select id, nome,
           greatest(0, varejo - aj)::int as varejo,
           atacado::int as atacado,
           greatest(0, hoje - aj_hoje)::int as hoje
      from base
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'vendedor_id', id, 'nome', nome,
           'unidades_hoje', hoje,
           'unidades_mes', varejo + atacado,
           'unidades_varejo', varejo,
           'unidades_atacado', atacado,
           'comissao', round(varejo * v_rate + atacado * v_vlr_atac, 2))
         order by nome), '[]'::jsonb)
    into v_lista
    from calc;

  /* quem está perguntando:
     - sistema (sócio logado): tudo, separado por vendedor
     - sócio no bot: tudo, separado por vendedor
     - vendedor no bot: só os números dele + total do time
     - sem identificação (bot antigo): o resumo do time, como era antes */
  v_completo := coalesce((p_meta ->> 'sistema')::boolean, false) or public.bot_eh_socio(p_meta);
  v_eu    := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb) - 'vendedor');
  v_socio := v_completo;

  if v_eu is not null and not v_socio then
    /* vendedor: só os números dele + o total do time */
    select e into v_eu_obj from jsonb_array_elements(v_lista) e
     where (e ->> 'vendedor_id')::uuid = v_eu;
    return jsonb_build_object(
      'ok', true, 'pessoal', true,
      'vendedor', v_eu_obj ->> 'nome',
      'mes', to_char(v_ini,'DD/MM') || ' → ' || to_char(v_fim,'DD/MM'),
      'unidades_hoje', (v_eu_obj ->> 'unidades_hoje')::int,
      'unidades_mes', (v_eu_obj ->> 'unidades_mes')::int,
      'unidades_varejo', (v_eu_obj ->> 'unidades_varejo')::int,
      'unidades_atacado', (v_eu_obj ->> 'unidades_atacado')::int,
      'valor_atacado', v_vlr_atac,
      'taxa_atual', v_rate,
      'comissao', (v_eu_obj ->> 'comissao')::numeric,
      'time_unidades_mes', v_t_total,
      'time_unidades_hoje', v_t_hoje,
      'faltam_para_proxima', v_faltam, 'proxima_taxa', v_prox.rate,
      'fecha_hoje', (v_hoje = v_fim));
  end if;

  if p_meta is null then
    /* chamada sem identificação: mesmo formato de antes (time todo, sem separar) */
    return jsonb_build_object(
      'ok', true,
      'mes', to_char(v_ini,'DD/MM') || ' → ' || to_char(v_fim,'DD/MM'),
      'unidades_hoje', v_t_hoje,
      'unidades_mes', v_t_total,
      'unidades_varejo', v_t_varejo,
      'unidades_atacado', v_t_atacado,
      'valor_atacado', v_vlr_atac,
      'taxa_atual', v_rate,
      'comissao', round(v_t_varejo * v_rate + v_t_atacado * v_vlr_atac, 2),
      'faltam_para_proxima', v_faltam, 'proxima_taxa', v_prox.rate,
      'fecha_hoje', (v_hoje = v_fim));
  end if;

  if not v_socio then
    /* Telegram não cadastrado: só o total do time, sem valores de ninguém */
    return jsonb_build_object(
      'ok', true, 'pessoal', false, 'restrito', true,
      'mes', to_char(v_ini,'DD/MM') || ' → ' || to_char(v_fim,'DD/MM'),
      'time_unidades_mes', v_t_total,
      'time_unidades_hoje', v_t_hoje,
      'taxa_atual', v_rate,
      'faltam_para_proxima', v_faltam, 'proxima_taxa', v_prox.rate,
      'aviso', 'Seu Telegram não está ligado a nenhum vendedor. Mande /sou SeuNome.');
  end if;

  /* sócios e sistema: o time inteiro, separado por vendedor (sem fixo) */
  return jsonb_build_object(
    'ok', true, 'pessoal', false,
    'mes', to_char(v_ini,'DD/MM') || ' → ' || to_char(v_fim,'DD/MM'),
    'unidades_hoje', v_t_hoje,
    'unidades_mes', v_t_total,
    'unidades_varejo', v_t_varejo,
    'unidades_atacado', v_t_atacado,
    'valor_atacado', v_vlr_atac,
    'taxa_atual', v_rate,
    'comissao', round(v_t_varejo * v_rate + v_t_atacado * v_vlr_atac, 2),
    'time_unidades_mes', v_t_total,
    'time_unidades_hoje', v_t_hoje,
    'faltam_para_proxima', v_faltam, 'proxima_taxa', v_prox.rate,
    'fecha_hoje', (v_hoje = v_fim),
    'vendedores', v_lista,
    'sem_vendedor_unidades', v_sem);
end $function$;

-- Cópia de public.bot_movimentar_estoque do banco de produção (04/11/2026).
CREATE OR REPLACE FUNCTION public.bot_movimentar_estoque(p_token text, p_items jsonb, p_meta jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item      jsonb;
  v_input     text;
  v_np        text;
  v_full      text;
  v_qty       integer;
  v_matches   jsonb;
  v_n         integer;
  v_fid       uuid;
  v_model     text;
  v_flavor    text;
  v_before    integer;
  v_baixa     integer;
  v_ch015     uuid;
  v_session   uuid;
  v_price     numeric(10,2);
  v_cost      numeric(10,2);
  v_sale_id   uuid;
  v_item_id   uuid;
  v_note      text;
  v_semprec   boolean;
  v_res       jsonb := '[]'::jsonb;
  v_ok        integer := 0;
  v_err       integer := 0;
  v_line      jsonb;
  v_vend      uuid;
  v_vend_nome text;
  v_tg        text;
  v_tg_nome   text;
begin
  if p_token is null or p_token <>
     (select value from public.integration_config where key = 'bot_sync_token') then
    raise exception 'token inválido' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items deve ser um array json' using errcode = '22023';
  end if;

  -- quem está dando a baixa
  v_vend    := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb));
  v_tg      := public.tg_do_meta(coalesce(p_meta, '{}'::jsonb));
  v_tg_nome := nullif(trim(coalesce(p_meta ->> 'nome', p_meta ->> 'username', '')), '');
  select nome into v_vend_nome from public.vendedores where id = v_vend;

  -- Loja fixa 015 e o caixa aberto do dia (resolvidos uma vez por chamada).
  select id into v_ch015 from public.channels
    where name = '015 Pods' and type = 'loja' and active limit 1;
  select id into v_session from public.cash_sessions where status = 'aberto' limit 1;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_input := btrim(coalesce(v_item ->> 'produto', ''));
    v_qty   := nullif(v_item ->> 'qty', '')::integer;
    v_line  := jsonb_build_object('input', v_input);

    begin
      if v_qty is null or v_qty = 0 then
        v_res := v_res || (v_line || jsonb_build_object('status', 'qtd_invalida'));
        v_err := v_err + 1;
        continue;
      end if;
      if v_input = '' then
        v_res := v_res || (v_line || jsonb_build_object('status', 'nao_encontrado'));
        v_err := v_err + 1;
        continue;
      end if;

      -- match exato: com/sem conteúdo do parêntese, dos dois lados
      v_np   := public.bot_norm_np(v_input);
      v_full := public.bot_norm(translate(v_input, '()', '  '));
      select coalesce(jsonb_agg(jsonb_build_object(
               'flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb),
             count(*)
        into v_matches, v_n
      from public.flavors f
      join public.models m on m.id = f.model_id
      where f.active and m.active
        and ( public.bot_norm_np(m.name || ' ' || f.name) = v_np
           or public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')) = v_full );

      -- fallback por subconjunto (input ⊆ produto) só se o exato deu 0
      if v_n = 0 and length(v_full) > 0 then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb),
               count(*)
          into v_matches, v_n
        from public.flavors f
        join public.models m on m.id = f.model_id
        where f.active and m.active
          and string_to_array(v_full, ' ')
              <@ string_to_array(public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')), ' ');
      end if;

      if v_n = 0 then
        v_res := v_res || (v_line || jsonb_build_object('status', 'nao_encontrado'));
        v_err := v_err + 1;
        continue;
      end if;
      if v_n > 1 then
        v_res := v_res || (v_line || jsonb_build_object('status', 'ambiguo', 'matches', v_matches));
        v_err := v_err + 1;
        continue;
      end if;

      v_fid    := (v_matches -> 0 ->> 'flavor_id')::uuid;
      v_model  := v_matches -> 0 ->> 'model';
      v_flavor := v_matches -> 0 ->> 'flavor';

      select stock_qty into v_before from public.flavors where id = v_fid for update;

      if v_qty > 0 then
        -- ENTRADA: só ajusta estoque + livro-razão
        update public.flavors set stock_qty = stock_qty + v_qty where id = v_fid;
        insert into public.stock_movements (flavor_id, qty_delta, type, notes)
          values (v_fid, v_qty, 'ajuste', 'bot telegram: entrada');
        v_res := v_res || (v_line || jsonb_build_object(
          'status', 'ok', 'direction', 'entrada', 'qty', v_qty,
          'flavor_id', v_fid, 'model', v_model, 'flavor', v_flavor,
          'stock_before', v_before, 'stock_after', v_before + v_qty));
        v_ok := v_ok + 1;

      else
        -- BAIXA → venda direta na 015
        v_baixa := -v_qty;
        if v_ch015 is null then
          v_res := v_res || (v_line || jsonb_build_object(
            'status', 'erro', 'message', 'canal 015 Pods não encontrado',
            'flavor_id', v_fid, 'model', v_model, 'flavor', v_flavor));
          v_err := v_err + 1;
          continue;
        end if;
        if v_before < v_baixa then
          v_res := v_res || (v_line || jsonb_build_object(
            'status', 'estoque_insuficiente', 'qty', v_baixa,
            'flavor_id', v_fid, 'model', v_model, 'flavor', v_flavor,
            'stock_before', v_before));
          v_err := v_err + 1;
          continue;
        end if;

        select price into v_price from public.prices
          where flavor_id = v_fid and channel_id = v_ch015;
        v_semprec := v_price is null;
        v_price   := coalesce(v_price, 0);
        v_note    := case when v_semprec then 'bot telegram SEM PREÇO' else 'bot telegram' end;
        select coalesce(cost, 0) into v_cost from public.product_costs where flavor_id = v_fid;
        v_cost := coalesce(v_cost, 0);

        update public.flavors set stock_qty = stock_qty - v_baixa where id = v_fid;

        insert into public.sales (channel_id, cash_session_id, payment_method,
                                  delivery_cost, total, status, notes,
                                  vendedor_id, registrado_por_tg, registrado_por_nome)
          values (v_ch015, v_session, 'pix', 0, v_price * v_baixa, 'concluida', v_note,
                  v_vend, v_tg, v_tg_nome)
          returning id into v_sale_id;
        insert into public.sale_items (sale_id, flavor_id, qty, unit_price)
          values (v_sale_id, v_fid, v_baixa, v_price) returning id into v_item_id;
        insert into public.sale_item_costs (sale_item_id, unit_cost)
          values (v_item_id, v_cost);
        insert into public.stock_movements (flavor_id, qty_delta, type, sale_id, notes)
          values (v_fid, -v_baixa, 'venda', v_sale_id, v_note);

        v_res := v_res || (v_line || jsonb_build_object(
          'status', 'ok', 'direction', 'baixa', 'qty', v_baixa,
          'flavor_id', v_fid, 'model', v_model, 'flavor', v_flavor,
          'stock_before', v_before, 'stock_after', v_before - v_baixa,
          'sale_id', v_sale_id, 'unit_price', v_price, 'sem_preco', v_semprec));
        v_ok := v_ok + 1;
      end if;

    exception when others then
      v_res := v_res || (v_line || jsonb_build_object('status', 'erro', 'message', SQLERRM));
      v_err := v_err + 1;
    end;
  end loop;

  return jsonb_build_object(
    'resultados', v_res,
    'resumo', jsonb_build_object('ok', v_ok, 'erros', v_err,
                                 'total', jsonb_array_length(p_items)),
    'vendedor', v_vend_nome
  );
end;
$function$;
