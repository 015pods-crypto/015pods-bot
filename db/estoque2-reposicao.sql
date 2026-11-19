-- 18/11/2026 — Estoque 2 pelo Telegram (grupo "estoque atualizado") + Reposição
-- que olha o Estoque 2 primeiro (/pedido em 3 partes, "Pedido feito", chegada).
-- Só peças novas, exceto: bot_fornecedor_importar passa a usar as ligações
-- guardadas (fornecedor_ligacoes) e acessos_salvar aceita a chave 'reposicao'.

-- ───────── Estoque 2: movimentos do grupo ─────────
alter table public.estoque2_movimentos drop constraint if exists estoque2_movimentos_tipo_check;
alter table public.estoque2_movimentos add constraint estoque2_movimentos_tipo_check
  check (tipo in ('ajuste', 'planilha', 'para_loja', 'entrada', 'saida'));
alter table public.estoque2_movimentos add column if not exists tg_nome text;

-- Mesmo jeito de achar o produto que a bot_movimentar_estoque (exato, depois
-- subconjunto). Devolve {status, flavor_id, model, flavor} ou {status, matches}.
create or replace function public.bot_achar_sabor(p_input text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_np text; v_full text; v_matches jsonb; v_n int;
begin
  if coalesce(btrim(p_input), '') = '' then return jsonb_build_object('status', 'nao_encontrado'); end if;
  v_np := public.bot_norm_np(p_input);
  v_full := public.bot_norm(translate(p_input, '()', '  '));
  select coalesce(jsonb_agg(jsonb_build_object('flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb), count(*)
    into v_matches, v_n
    from flavors f join models m on m.id = f.model_id
   where f.active and m.active
     and (public.bot_norm_np(m.name || ' ' || f.name) = v_np
          or public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')) = v_full);
  if v_n = 0 and length(v_full) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('flavor_id', f.id, 'model', m.name, 'flavor', f.name)), '[]'::jsonb), count(*)
      into v_matches, v_n
      from flavors f join models m on m.id = f.model_id
     where f.active and m.active
       and string_to_array(v_full, ' ') <@ string_to_array(public.bot_norm(translate(m.name || ' ' || f.name, '()', '  ')), ' ');
  end if;
  if v_n = 0 then return jsonb_build_object('status', 'nao_encontrado'); end if;
  if v_n > 1 then return jsonb_build_object('status', 'ambiguo', 'matches', v_matches); end if;
  return jsonb_build_object('status', 'ok') || (v_matches -> 0);
end $$;
revoke all on function public.bot_achar_sabor(text) from public, anon, authenticated;

create or replace function public.bot_token_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and p_token = (select value from integration_config where key = 'bot_sync_token')
$$;
revoke all on function public.bot_token_ok(text) from public, anon, authenticated;

-- Tira do Estoque 2 e põe na loja. Núcleo usado pelo bot (/levar, "Confirmar
-- que levou") e pelo sistema. Não é venda: estoque da loja sobe, sem comissão.
create or replace function public.estoque2_levar_nucleo(p_flavor uuid, p_qtd int, p_user uuid, p_nome text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tem int; v_loja int;
begin
  if p_qtd is null or p_qtd <= 0 then return jsonb_build_object('ok', false, 'erro', 'Quantidade inválida.'); end if;
  select qtd into v_tem from estoque2 where flavor_id = p_flavor for update;
  if coalesce(v_tem, 0) < p_qtd then
    return jsonb_build_object('ok', false, 'erro', 'O Estoque 2 só tem ' || coalesce(v_tem, 0) || '.', 'estoque2', coalesce(v_tem, 0));
  end if;
  update estoque2 set qtd = qtd - p_qtd, atualizado_em = now(), atualizado_por = p_user where flavor_id = p_flavor;
  update flavors set stock_qty = coalesce(stock_qty, 0) + p_qtd where id = p_flavor returning stock_qty into v_loja;
  insert into stock_movements (flavor_id, qty_delta, type, notes, user_id)
  values (p_flavor, p_qtd, 'ajuste', 'Veio do Estoque 2' || coalesce(' (' || nullif(p_nome, '') || ')', ''), p_user);
  insert into estoque2_movimentos (flavor_id, delta, saldo, tipo, motivo, user_id, tg_nome)
  values (p_flavor, -p_qtd, v_tem - p_qtd, 'para_loja', 'Levado para a loja', p_user, nullif(p_nome, ''));
  return jsonb_build_object('ok', true, 'estoque2', v_tem - p_qtd, 'loja', v_loja);
end $$;
revoke all on function public.estoque2_levar_nucleo(uuid, int, uuid, text) from public, anon, authenticated;

-- Grupo do Estoque 2: entrada (+) e saída sem venda (/tirar). p_items =
-- [{produto, qty}] com qty > 0 entrada e qty < 0 saída.
create or replace function public.bot_estoque2_mover(p_token text, p_items jsonb, p_meta jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_qty int; v_achou jsonb; v_fid uuid; v_tem int; v_res jsonb := '[]'::jsonb; v_line jsonb;
        v_nome text := nullif(btrim(coalesce(p_meta ->> 'nome', p_meta ->> 'username', '')), '');
begin
  if not public.bot_token_ok(p_token) then raise exception 'token inválido' using errcode = '42501'; end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_line := jsonb_build_object('input', v_item ->> 'produto');
    v_qty := nullif(v_item ->> 'qty', '')::int;
    if v_qty is null or v_qty = 0 then v_res := v_res || (v_line || '{"status":"qtd_invalida"}'); continue; end if;
    v_achou := public.bot_achar_sabor(v_item ->> 'produto');
    if v_achou ->> 'status' <> 'ok' then v_res := v_res || (v_line || v_achou); continue; end if;
    v_fid := (v_achou ->> 'flavor_id')::uuid;
    select qtd into v_tem from estoque2 where flavor_id = v_fid for update;
    v_tem := coalesce(v_tem, 0);
    if v_tem + v_qty < 0 then
      v_res := v_res || (v_line || v_achou || jsonb_build_object('status', 'estoque_insuficiente', 'qty', -v_qty, 'saldo', v_tem));
      continue;
    end if;
    insert into estoque2 (flavor_id, qtd, atualizado_em) values (v_fid, v_tem + v_qty, now())
    on conflict (flavor_id) do update set qtd = excluded.qtd, atualizado_em = now(), atualizado_por = null;
    insert into estoque2_movimentos (flavor_id, delta, saldo, tipo, motivo, tg_nome)
    values (v_fid, v_qty, v_tem + v_qty, case when v_qty > 0 then 'entrada' else 'saida' end, 'grupo do Telegram', v_nome);
    v_res := v_res || (v_line || v_achou || jsonb_build_object('qty', abs(v_qty), 'direction', case when v_qty > 0 then 'entrada' else 'saida' end,
                                                               'antes', v_tem, 'saldo', v_tem + v_qty));
  end loop;
  return jsonb_build_object('resultados', v_res);
end $$;
revoke all on function public.bot_estoque2_mover(text, jsonb, jsonb) from public;
grant execute on function public.bot_estoque2_mover(text, jsonb, jsonb) to anon, authenticated;

-- /levar pelo bot: p_items = [{produto, qty}] ou [{flavor_id, qty}].
create or replace function public.bot_estoque2_levar(p_token text, p_items jsonb, p_meta jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_achou jsonb; v_r jsonb; v_res jsonb := '[]'::jsonb; v_line jsonb;
        v_nome text := nullif(btrim(coalesce(p_meta ->> 'nome', p_meta ->> 'username', '')), '');
begin
  if not public.bot_token_ok(p_token) then raise exception 'token inválido' using errcode = '42501'; end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_line := jsonb_build_object('input', coalesce(v_item ->> 'produto', ''));
    if v_item ? 'flavor_id' then
      select jsonb_build_object('status', 'ok', 'flavor_id', f.id, 'model', m.name, 'flavor', f.name) into v_achou
        from flavors f join models m on m.id = f.model_id where f.id = (v_item ->> 'flavor_id')::uuid;
      v_achou := coalesce(v_achou, '{"status":"nao_encontrado"}');
    else
      v_achou := public.bot_achar_sabor(v_item ->> 'produto');
    end if;
    if v_achou ->> 'status' <> 'ok' then v_res := v_res || (v_line || v_achou); continue; end if;
    v_r := public.estoque2_levar_nucleo((v_achou ->> 'flavor_id')::uuid, nullif(v_item ->> 'qty', '')::int, null, v_nome);
    v_res := v_res || (v_line || v_achou || jsonb_build_object('qty', (v_item ->> 'qty')::int) ||
              case when (v_r ->> 'ok')::boolean then jsonb_build_object('status', 'ok', 'estoque2', v_r -> 'estoque2', 'loja', v_r -> 'loja')
                   else jsonb_build_object('status', 'erro', 'erro', v_r ->> 'erro', 'estoque2', v_r -> 'estoque2') end);
  end loop;
  return jsonb_build_object('resultados', v_res);
end $$;
revoke all on function public.bot_estoque2_levar(text, jsonb, jsonb) from public;
grant execute on function public.bot_estoque2_levar(text, jsonb, jsonb) to anon, authenticated;

-- Saldo do Estoque 2 (comando /estoque no grupo do Estoque 2).
create or replace function public.bot_estoque2_ler(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then raise exception 'token inválido' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('modelo', m.name, 'sabor', f.name, 'qtd', e.qtd) order by m.name, f.name)
                     from estoque2 e join flavors f on f.id = e.flavor_id join models m on m.id = f.model_id
                    where e.qtd > 0), '[]'::jsonb);
end $$;
revoke all on function public.bot_estoque2_ler(text) from public;
grant execute on function public.bot_estoque2_ler(text) to anon, authenticated;

-- ───────── Lista do fornecedor: nomes ligados à mão (uma vez, vale sempre) ─────────
create table if not exists public.fornecedor_ligacoes (
  chave text primary key,              -- fnorm(modelo) || '|' || fsabor(sabor), como veio na lista
  flavor_id uuid not null references public.flavors (id) on delete cascade,
  criado_em timestamptz not null default now(),
  criado_por uuid references auth.users (id) on delete set null
);
alter table public.fornecedor_ligacoes enable row level security;
revoke all on public.fornecedor_ligacoes from public, anon, authenticated;

create or replace function public.fornecedor_chave(p_modelo text, p_sabor text) returns text
language sql immutable as $$ select btrim(public.fnorm(p_modelo)) || '|' || btrim(public.fsabor(p_sabor)) $$;

create or replace function public.bot_fornecedor_importar(p_token text, p_itens jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare v_tok text; v_lista uuid; r jsonb; v_model uuid; v_flavor uuid; v_m text;
        v_ok int := 0; v_nao int := 0; v_novos jsonb := '[]'::jsonb; v_falt jsonb := '[]'::jsonb;
begin
  select value into v_tok from integration_config where key='bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  update fornecedor_lista set ativa = false where ativa;
  insert into fornecedor_lista default values returning id into v_lista;

  for r in select * from jsonb_array_elements(p_itens) loop
    v_model := null; v_flavor := null; v_m := fnorm(r->>'modelo');
    -- 0) ligação feita à mão na tela Reposição: vale antes de tudo
    select flavor_id into v_flavor from fornecedor_ligacoes where chave = public.fornecedor_chave(r->>'modelo', r->>'sabor');
    if v_flavor is null then
      select model_id into v_model from fornecedor_apelidos where fnorm(apelido) = v_m limit 1;
      if v_model is null then
        select id into v_model from models
         where fnorm(name) = v_m or fnorm(name) like '%'||v_m||'%' or v_m like '%'||fnorm(name)||'%'
         order by length(name) limit 1;
      end if;
      if v_model is null then
        select id into v_model from models
         where similarity(fnorm(name), v_m) > 0.45
         order by similarity(fnorm(name), v_m) desc limit 1;
      end if;

      if v_model is not null then
        select f.id into v_flavor from flavors f
         where f.model_id = v_model and fsabor(f.name) = fsabor(r->>'sabor') limit 1;
        if v_flavor is null then
          select f.id into v_flavor from flavors f
           where f.model_id = v_model and similarity(fsabor(f.name), fsabor(r->>'sabor')) > 0.55
           order by similarity(fsabor(f.name), fsabor(r->>'sabor')) desc limit 1;
        end if;
      end if;
    end if;

    insert into fornecedor_itens (lista_id, modelo_txt, sabor_txt, flavor_id, casou)
    values (v_lista, r->>'modelo', r->>'sabor', v_flavor, v_flavor is not null);

    if v_flavor is not null then v_ok := v_ok + 1;
    else
      v_nao := v_nao + 1;
      if v_model is null then
        v_novos := v_novos || jsonb_build_object('modelo', r->>'modelo');
      else
        v_falt := v_falt || jsonb_build_object('modelo', r->>'modelo', 'sabor', r->>'sabor');
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'lista_id', v_lista,
    'casaram', v_ok, 'nao_casaram', v_nao,
    'modelos_novos', (select coalesce(jsonb_agg(distinct x->>'modelo'),'[]'::jsonb)
                        from jsonb_array_elements(v_novos) t(x)),
    'sabores_novos', (select coalesce(jsonb_agg(x),'[]'::jsonb)
                        from (select * from jsonb_array_elements(v_falt) limit 30) t(x)));
end $function$;

-- Lista colada no sistema: o bot lê (mesma leitura do /fornecedor) e importa.
create table if not exists public.fornecedor_colagens (
  id uuid primary key default gen_random_uuid(),
  texto text not null,
  status text not null default 'pendente' check (status in ('pendente', 'lendo', 'feito', 'erro')),
  resumo text,
  criado_em timestamptz not null default now(),
  criado_por uuid references auth.users (id) on delete set null,
  pego_em timestamptz
);
alter table public.fornecedor_colagens enable row level security;
revoke all on public.fornecedor_colagens from public, anon, authenticated;

create or replace function public.bot_fornecedor_fila_pegar(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if not public.bot_token_ok(p_token) then raise exception 'token inválido' using errcode = '42501'; end if;
  -- 'lendo' há mais de 10 min = o bot caiu no meio: volta para a fila
  update fornecedor_colagens set status = 'pendente' where status = 'lendo' and pego_em < now() - interval '10 minutes';
  select * into v from fornecedor_colagens where status = 'pendente' order by criado_em limit 1 for update skip locked;
  if v.id is null then return jsonb_build_object('ok', true, 'vazia', true); end if;
  update fornecedor_colagens set status = 'lendo', pego_em = now() where id = v.id;
  return jsonb_build_object('ok', true, 'id', v.id, 'texto', v.texto);
end $$;
revoke all on function public.bot_fornecedor_fila_pegar(text) from public;
grant execute on function public.bot_fornecedor_fila_pegar(text) to anon, authenticated;

create or replace function public.bot_fornecedor_fila_fim(p_token text, p_id uuid, p_ok boolean, p_resumo text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then raise exception 'token inválido' using errcode = '42501'; end if;
  update fornecedor_colagens set status = case when p_ok then 'feito' else 'erro' end, resumo = p_resumo where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.bot_fornecedor_fila_fim(text, uuid, boolean, text) from public;
grant execute on function public.bot_fornecedor_fila_fim(text, uuid, boolean, text) to anon, authenticated;

-- ───────── Reposição: buscar no Estoque 2 / pedir ao fornecedor / ninguém tem ─────────
create table if not exists public.reposicao_pedidos (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  origem text not null check (origem in ('telegram', 'sistema')),
  criado_por text,
  lista_id uuid references public.fornecedor_lista (id) on delete set null,
  mensagem text,
  status text not null default 'rascunho' check (status in ('rascunho', 'feito', 'chegou')),
  levou_em timestamptz, levou_por text,
  feito_em timestamptz, feito_por text,
  chegou_em timestamptz
);
create table if not exists public.reposicao_itens (
  id bigserial primary key,
  pedido_id uuid not null references public.reposicao_pedidos (id) on delete cascade,
  tipo text not null check (tipo in ('buscar', 'pedir', 'ninguem')),
  flavor_id uuid not null references public.flavors (id) on delete cascade,
  qtd int not null check (qtd > 0),
  chegou int not null default 0,
  levou int not null default 0,
  sugestao_flavor_id uuid references public.flavors (id) on delete set null
);
create index if not exists reposicao_itens_pedido on public.reposicao_itens (pedido_id);
create index if not exists reposicao_itens_aberto on public.reposicao_itens (flavor_id) where tipo = 'pedir';
alter table public.reposicao_pedidos enable row level security;
alter table public.reposicao_itens enable row level security;
revoke all on public.reposicao_pedidos, public.reposicao_itens from public, anon, authenticated;

create or replace function public.reposicao_pode() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_socio() or public.tem_acesso('reposicao')
$$;

-- A conta, sem gravar nada. Mesma regra do /pedido: sabor que vendeu nas
-- últimas p_semanas e tem 0 ou 1 na loja; leva até 2; zerados primeiro, do que
-- mais vende para o que menos vende. Primeiro o Estoque 2, depois o fornecedor
-- (última lista), e o resto é "ninguém tem" com uma sugestão do mesmo modelo.
create or replace function public.reposicao_calcular(p_semanas int default 4)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_lista uuid; v_quando timestamptz; v jsonb;
begin
  select id, importada_em into v_lista, v_quando from fornecedor_lista where ativa order by importada_em desc limit 1;
  with giro as (
    select si.flavor_id, sum(si.qty)::int vendas
      from sale_items si join sales s on s.id = si.sale_id
     where s.status <> 'cancelada' and public.dia_loja(s.sold_at) > public.dia_loja(now()) - (p_semanas * 7)
     group by si.flavor_id
  ), forn as (
    select distinct flavor_id from fornecedor_itens where lista_id = v_lista and flavor_id is not null
  ), base as (
    select f.id flavor_id, f.model_id, m.name modelo, f.name sabor, greatest(coalesce(f.stock_qty, 0), 0)::int estoque,
           coalesce(e2.qtd, 0) estoque2, g.vendas, (fo.flavor_id is not null) no_fornecedor,
           2 - greatest(coalesce(f.stock_qty, 0), 0) precisa,
           (select pc.cost from product_costs pc where pc.flavor_id = f.id and pc.cost > 0
             order by coalesce(to_jsonb(pc)->>'updated_at', to_jsonb(pc)->>'created_at') desc nulls last limit 1) custo,
           row_number() over (order by case when coalesce(f.stock_qty, 0) <= 0 then 0 else 1 end, g.vendas desc, m.name, f.name) prioridade
      from flavors f join models m on m.id = f.model_id join giro g on g.flavor_id = f.id
      left join estoque2 e2 on e2.flavor_id = f.id left join forn fo on fo.flavor_id = f.id
     where f.active is not false and m.active is not false and g.vendas >= 1 and coalesce(f.stock_qty, 0) <= 1
  ), conta as (
    select *, least(estoque2, precisa) buscar,
           case when no_fornecedor then precisa - least(estoque2, precisa) else 0 end pedir,
           case when not no_fornecedor then precisa - least(estoque2, precisa) else 0 end ninguem
      from base
  ), sug as (
    -- sabor do mesmo modelo que alguém tem (Estoque 2 ou fornecedor), com venda
    -- mais parecida; fica de fora o que já está faltando
    select c.flavor_id, s.id sug_id, s.name sug_sabor, s.vendas sug_vendas, s.onde
      from conta c
      cross join lateral (
        select f2.id, f2.name, coalesce(g2.vendas, 0) vendas,
               case when coalesce(e2.qtd, 0) > 0 then 'Estoque 2' else 'fornecedor' end onde
          from flavors f2
          left join giro g2 on g2.flavor_id = f2.id
          left join estoque2 e2 on e2.flavor_id = f2.id
         where f2.model_id = c.model_id and f2.id <> c.flavor_id and f2.active is not false
           and (coalesce(e2.qtd, 0) > 0 or exists (select 1 from forn where forn.flavor_id = f2.id))
           and not exists (select 1 from conta c2 where c2.flavor_id = f2.id and c2.ninguem > 0)
         order by abs(coalesce(g2.vendas, 0) - c.vendas), coalesce(g2.vendas, 0) desc, f2.name
         limit 1) s
     where c.ninguem > 0
  )
  select jsonb_build_object(
    'lista', case when v_lista is null then null else jsonb_build_object('id', v_lista, 'importada_em', v_quando,
               'dias', (public.dia_loja(now()) - public.dia_loja(v_quando)),
               'itens', (select count(*) from fornecedor_itens where lista_id = v_lista),
               'ligados', (select count(*) from fornecedor_itens where lista_id = v_lista and casou)) end,
    'semanas', p_semanas,
    'buscar', coalesce((select jsonb_agg(jsonb_build_object('flavor_id', flavor_id, 'modelo', modelo, 'sabor', sabor, 'qtd', buscar,
                 'estoque', estoque, 'estoque2', estoque2, 'vendas', vendas) order by prioridade) from conta where buscar > 0), '[]'::jsonb),
    'pedir', coalesce((select jsonb_agg(jsonb_build_object('flavor_id', flavor_id, 'modelo', modelo, 'sabor', sabor, 'qtd', pedir,
                 'estoque', estoque, 'vendas', vendas, 'custo', custo) order by prioridade) from conta where pedir > 0), '[]'::jsonb),
    'ninguem', coalesce((select jsonb_agg(jsonb_build_object('flavor_id', c.flavor_id, 'modelo', c.modelo, 'sabor', c.sabor, 'qtd', c.ninguem,
                 'estoque', c.estoque, 'vendas', c.vendas,
                 'sugestao', case when s.sug_id is null then null else jsonb_build_object('flavor_id', s.sug_id, 'sabor', s.sug_sabor,
                                  'vendas', s.sug_vendas, 'onde', s.onde) end) order by c.prioridade)
                 from conta c left join sug s on s.flavor_id = c.flavor_id where c.ninguem > 0), '[]'::jsonb))
    into v;
  return v;
end $$;
revoke all on function public.reposicao_calcular(int) from public, anon, authenticated;

-- Mensagem para o fornecedor: "Boa tarde! Pedido 015:" + itens por modelo + total.
create or replace function public.reposicao_mensagem(p_pedir jsonb) returns text
language sql immutable as $$
  with it as (
    select x ->> 'modelo' modelo, x ->> 'sabor' sabor, (x ->> 'qtd')::int qtd, ord
      from jsonb_array_elements(coalesce(p_pedir, '[]'::jsonb)) with ordinality t(x, ord)
  ), g as (
    select modelo, min(ord) o, string_agg(qtd || ' ' || sabor, E'\n' order by ord) linhas from it group by modelo
  )
  select case when not exists (select 1 from it) then null else
    'Boa tarde! Pedido 015:' || E'\n\n' || (select string_agg(modelo || E'\n' || linhas, E'\n\n' order by o) from g) ||
    E'\n\nTotal: ' || (select sum(qtd) from it) || ' unidades' end
$$;

-- Monta e GUARDA a rodada (rascunho), para os botões do Telegram agirem nela.
create or replace function public.reposicao_criar(p_origem text, p_por text, p_semanas int default 4)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_id uuid; v_msg text;
begin
  v := public.reposicao_calcular(coalesce(p_semanas, 4));
  v_msg := public.reposicao_mensagem(v -> 'pedir');
  insert into reposicao_pedidos (origem, criado_por, lista_id, mensagem)
  values (p_origem, p_por, (v -> 'lista' ->> 'id')::uuid, v_msg) returning id into v_id;
  insert into reposicao_itens (pedido_id, tipo, flavor_id, qtd, sugestao_flavor_id)
  select v_id, t.tipo, (x ->> 'flavor_id')::uuid, (x ->> 'qtd')::int, (x -> 'sugestao' ->> 'flavor_id')::uuid
    from (select 'buscar' tipo, x from jsonb_array_elements(v -> 'buscar') x
          union all select 'pedir', x from jsonb_array_elements(v -> 'pedir') x
          union all select 'ninguem', x from jsonb_array_elements(v -> 'ninguem') x) t;
  -- rascunho velho sem uso não serve para nada
  delete from reposicao_pedidos where status = 'rascunho' and levou_em is null and criado_em < now() - interval '3 days';
  return v || jsonb_build_object('id', v_id, 'mensagem', v_msg);
end $$;
revoke all on function public.reposicao_criar(text, text, int) from public, anon, authenticated;

-- "Confirmar que levou": transfere o que está em 'buscar' (até o que o Estoque 2 tiver agora).
create or replace function public.reposicao_levou_nucleo(p_id uuid, p_por text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; i record; v_tem int; v_q int; v_r jsonb; v_ok jsonb := '[]'::jsonb; v_falhou jsonb := '[]'::jsonb;
begin
  select * into p from reposicao_pedidos where id = p_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'erro', 'Essa lista não existe mais. Mande /pedido de novo.'); end if;
  if p.levou_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'Já confirmado por ' || coalesce(p.levou_por, '?') || ' em ' || to_char(p.levou_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.');
  end if;
  for i in select ri.*, m.name modelo, f.name sabor from reposicao_itens ri join flavors f on f.id = ri.flavor_id join models m on m.id = f.model_id
            where ri.pedido_id = p_id and ri.tipo = 'buscar' order by ri.id loop
    select coalesce(qtd, 0) into v_tem from estoque2 where flavor_id = i.flavor_id;
    v_q := least(i.qtd, coalesce(v_tem, 0));
    if v_q <= 0 then
      v_falhou := v_falhou || jsonb_build_object('modelo', i.modelo, 'sabor', i.sabor, 'qtd', i.qtd, 'erro', 'Estoque 2 sem esse sabor agora');
      continue;
    end if;
    v_r := public.estoque2_levar_nucleo(i.flavor_id, v_q, p_user, p_por);
    if (v_r ->> 'ok')::boolean then
      update reposicao_itens set levou = v_q where id = i.id;
      v_ok := v_ok || jsonb_build_object('modelo', i.modelo, 'sabor', i.sabor, 'qtd', v_q, 'loja', v_r -> 'loja', 'estoque2', v_r -> 'estoque2');
    else
      v_falhou := v_falhou || jsonb_build_object('modelo', i.modelo, 'sabor', i.sabor, 'qtd', i.qtd, 'erro', v_r ->> 'erro');
    end if;
  end loop;
  update reposicao_pedidos set levou_em = now(), levou_por = p_por where id = p_id;
  return jsonb_build_object('ok', true, 'levados', v_ok, 'falhou', v_falhou);
end $$;
revoke all on function public.reposicao_levou_nucleo(uuid, text, uuid) from public, anon, authenticated;

-- "Pedido feito": registra o pedido com a data; daí em diante as entradas marcam o que chegou.
create or replace function public.reposicao_feito_nucleo(p_id uuid, p_por text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record; v_un int;
begin
  select * into p from reposicao_pedidos where id = p_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'erro', 'Essa lista não existe mais. Mande /pedido de novo.'); end if;
  if p.status <> 'rascunho' then
    return jsonb_build_object('ok', false, 'erro', 'Esse pedido já foi registrado por ' || coalesce(p.feito_por, '?') || ' em ' || to_char(p.feito_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.');
  end if;
  select coalesce(sum(qtd), 0) into v_un from reposicao_itens where pedido_id = p_id and tipo = 'pedir';
  if v_un = 0 then return jsonb_build_object('ok', false, 'erro', 'Não tem nada para pedir ao fornecedor nessa lista.'); end if;
  update reposicao_pedidos set status = 'feito', feito_em = now(), feito_por = p_por where id = p_id;
  return jsonb_build_object('ok', true, 'unidades', v_un, 'feito_em', now());
end $$;
revoke all on function public.reposicao_feito_nucleo(uuid, text) from public, anon, authenticated;

-- Pedidos feitos que ainda não chegaram inteiros: o que chegou e o que falta.
create or replace function public.reposicao_abertos() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'feito_em' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', p.id, 'feito_em', p.feito_em, 'feito_por', p.feito_por,
      'pedido', (select sum(qtd) from reposicao_itens where pedido_id = p.id and tipo = 'pedir'),
      'chegou', (select sum(chegou) from reposicao_itens where pedido_id = p.id and tipo = 'pedir'),
      'faltam', coalesce((select jsonb_agg(jsonb_build_object('modelo', m.name, 'sabor', f.name, 'qtd', ri.qtd - ri.chegou) order by m.name, f.name)
                   from reposicao_itens ri join flavors f on f.id = ri.flavor_id join models m on m.id = f.model_id
                  where ri.pedido_id = p.id and ri.tipo = 'pedir' and ri.chegou < ri.qtd), '[]'::jsonb)) x
      from reposicao_pedidos p where p.status = 'feito'
  ) t
$$;
revoke all on function public.reposicao_abertos() from public, anon, authenticated;

-- Entrada de mercadoria (+ no grupo de reposição ou no do Estoque 2): abate dos
-- pedidos feitos, do mais antigo para o mais novo. p_itens = [{flavor_id, qty}].
create or replace function public.reposicao_chegou_nucleo(p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x jsonb; v_resta int; i record; v_q int; v_tocados uuid[] := '{}'; v_res jsonb := '[]'::jsonb; v_p uuid;
begin
  for x in select * from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) loop
    v_resta := nullif(x ->> 'qty', '')::int;
    continue when v_resta is null or v_resta <= 0 or nullif(x ->> 'flavor_id', '') is null;
    for i in select ri.id, ri.pedido_id, ri.qtd - ri.chegou falta from reposicao_itens ri join reposicao_pedidos p on p.id = ri.pedido_id
              where p.status = 'feito' and ri.tipo = 'pedir' and ri.flavor_id = (x ->> 'flavor_id')::uuid and ri.chegou < ri.qtd
              order by p.feito_em, ri.id for update of ri loop
      exit when v_resta <= 0;
      v_q := least(v_resta, i.falta);
      update reposicao_itens set chegou = chegou + v_q where id = i.id;
      v_resta := v_resta - v_q;
      if not i.pedido_id = any(v_tocados) then v_tocados := v_tocados || i.pedido_id; end if;
    end loop;
  end loop;
  foreach v_p in array v_tocados loop
    if not exists (select 1 from reposicao_itens where pedido_id = v_p and tipo = 'pedir' and chegou < qtd) then
      update reposicao_pedidos set status = 'chegou', chegou_em = now() where id = v_p;
    end if;
    v_res := v_res || (select jsonb_build_object('id', p.id, 'feito_em', p.feito_em, 'completo', p.status = 'chegou',
      'pedido', (select sum(qtd) from reposicao_itens where pedido_id = p.id and tipo = 'pedir'),
      'chegou', (select sum(chegou) from reposicao_itens where pedido_id = p.id and tipo = 'pedir'),
      'faltam', coalesce((select jsonb_agg(jsonb_build_object('modelo', m.name, 'sabor', f.name, 'qtd', ri.qtd - ri.chegou) order by m.name, f.name)
                   from reposicao_itens ri join flavors f on f.id = ri.flavor_id join models m on m.id = f.model_id
                  where ri.pedido_id = p.id and ri.tipo = 'pedir' and ri.chegou < ri.qtd), '[]'::jsonb))
      from reposicao_pedidos p where p.id = v_p);
  end loop;
  return jsonb_build_object('ok', true, 'pedidos', v_res);
end $$;
revoke all on function public.reposicao_chegou_nucleo(jsonb) from public, anon, authenticated;

-- ── Bot ──
create or replace function public.bot_reposicao_criar(p_token text, p_por text, p_semanas int default 4)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then return jsonb_build_object('ok', false, 'erro', 'token inválido'); end if;
  return jsonb_build_object('ok', true) || public.reposicao_criar('telegram', p_por, p_semanas);
end $$;
create or replace function public.bot_reposicao_mensagem(p_token text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then return jsonb_build_object('ok', false, 'erro', 'token inválido'); end if;
  return jsonb_build_object('ok', true, 'mensagem', (select mensagem from reposicao_pedidos where id = p_id));
end $$;
create or replace function public.bot_reposicao_levou(p_token text, p_id uuid, p_por text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then return jsonb_build_object('ok', false, 'erro', 'token inválido'); end if;
  return public.reposicao_levou_nucleo(p_id, p_por, null);
end $$;
create or replace function public.bot_reposicao_feito(p_token text, p_id uuid, p_por text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then return jsonb_build_object('ok', false, 'erro', 'token inválido'); end if;
  return public.reposicao_feito_nucleo(p_id, p_por);
end $$;
create or replace function public.bot_reposicao_chegou(p_token text, p_itens jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.bot_token_ok(p_token) then return jsonb_build_object('ok', false, 'erro', 'token inválido'); end if;
  return public.reposicao_chegou_nucleo(p_itens);
end $$;
revoke all on function public.bot_reposicao_criar(text, text, int), public.bot_reposicao_mensagem(text, uuid),
  public.bot_reposicao_levou(text, uuid, text), public.bot_reposicao_feito(text, uuid, text), public.bot_reposicao_chegou(text, jsonb) from public;
grant execute on function public.bot_reposicao_criar(text, text, int), public.bot_reposicao_mensagem(text, uuid),
  public.bot_reposicao_levou(text, uuid, text), public.bot_reposicao_feito(text, uuid, text), public.bot_reposicao_chegou(text, jsonb) to anon, authenticated;

-- ── Sistema (tela Estoque > Reposição; só quem tem o acesso "Reposição") ──
create or replace function public.reposicao_app_ver()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  v := public.reposicao_criar('sistema', (select name from profiles where id = public.uid_efetivo()), 4);
  return jsonb_build_object('ok', true, 'socio', public.is_socio()) || v || jsonb_build_object(
    'abertos', public.reposicao_abertos(),
    'nao_reconhecidos', coalesce((select jsonb_agg(jsonb_build_object('id', fi.id, 'modelo', fi.modelo_txt, 'sabor', fi.sabor_txt) order by fi.modelo_txt, fi.sabor_txt)
                                  from fornecedor_itens fi where fi.lista_id = (v -> 'lista' ->> 'id')::uuid and not fi.casou), '[]'::jsonb));
end $$;
create or replace function public.reposicao_app_levou(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  return public.reposicao_levou_nucleo(p_id, (select name from profiles where id = public.uid_efetivo()), public.uid_efetivo());
end $$;
create or replace function public.reposicao_app_feito(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  return public.reposicao_feito_nucleo(p_id, (select name from profiles where id = public.uid_efetivo()));
end $$;
-- Liga um nome da lista do fornecedor ao sabor certo; vale para as próximas listas.
create or replace function public.reposicao_app_ligar(p_item uuid, p_flavor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_chave text; v_lista uuid;
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  select public.fornecedor_chave(modelo_txt, sabor_txt), lista_id into v_chave, v_lista from fornecedor_itens where id = p_item;
  if v_chave is null then return jsonb_build_object('ok', false, 'erro', 'Item não encontrado.'); end if;
  if not exists (select 1 from flavors where id = p_flavor) then return jsonb_build_object('ok', false, 'erro', 'Sabor não encontrado.'); end if;
  insert into fornecedor_ligacoes (chave, flavor_id, criado_por) values (v_chave, p_flavor, public.uid_efetivo())
  on conflict (chave) do update set flavor_id = excluded.flavor_id, criado_em = now(), criado_por = excluded.criado_por;
  update fornecedor_itens set flavor_id = p_flavor, casou = true
   where lista_id = v_lista and public.fornecedor_chave(modelo_txt, sabor_txt) = v_chave;
  return jsonb_build_object('ok', true);
end $$;
create or replace function public.reposicao_app_colar(p_texto text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  if length(btrim(coalesce(p_texto, ''))) < 10 then return jsonb_build_object('ok', false, 'erro', 'Cole a lista inteira do fornecedor.'); end if;
  insert into fornecedor_colagens (texto, criado_por) values (p_texto, public.uid_efetivo()) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
create or replace function public.reposicao_app_colagem(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.reposicao_pode() then return jsonb_build_object('ok', false, 'erro', 'sem permissão'); end if;
  return (select jsonb_build_object('ok', true, 'status', status, 'resumo', resumo) from fornecedor_colagens where id = p_id);
end $$;
revoke all on function public.reposicao_app_ver(), public.reposicao_app_levou(uuid), public.reposicao_app_feito(uuid),
  public.reposicao_app_ligar(uuid, uuid), public.reposicao_app_colar(text), public.reposicao_app_colagem(uuid), public.reposicao_pode() from public, anon;
grant execute on function public.reposicao_app_ver(), public.reposicao_app_levou(uuid), public.reposicao_app_feito(uuid),
  public.reposicao_app_ligar(uuid, uuid), public.reposicao_app_colar(text), public.reposicao_app_colagem(uuid), public.reposicao_pode() to authenticated;

-- Acesso "Reposição" em Equipe e acessos (sócio já tem tudo).
create or replace function public.acessos_salvar(p_user uuid, p_modelo text, p_chaves text[], p_vendedor uuid)
 returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_validas text[] := array[
    'inicio','pdv','caixa','pedidos','pedidos_entrega','remarketing','disparo','estoque','auditoria','financeiro','radar','pares',
    'atacado','consignado','comissao','clientes','crm','catalogo','precos','promocoes','cupons','combos','afiliados',
    'ajustes','notificacoes','reposicao',
    'ver_custo','ajustar_estoque','conferir_estoque','comissao_todos','mexer_disparo','mudar_precos','ver_clientes'];
  v_invalida text;
begin
  if not public.is_socio() then raise exception 'Apenas sócios' using errcode = '42501'; end if;
  if p_modelo not in ('socio', 'vendedor', 'personalizado') then raise exception 'Modelo inválido'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'Login não encontrado'; end if;

  select k into v_invalida from unnest(coalesce(p_chaves, '{}')) k where k <> all(v_validas) limit 1;
  if v_invalida is not null then raise exception 'Acesso inválido: %', v_invalida; end if;

  if p_modelo <> 'socio' then
    if p_user = auth.uid() then
      return jsonb_build_object('ok', false, 'erro', 'Você não pode tirar o próprio acesso de sócio.');
    end if;
    update profiles set role = 'funcionario' where id = p_user and role::text = 'socio';
  else
    update profiles set role = 'socio' where id = p_user;
  end if;

  insert into acessos_usuario (user_id, modelo, chaves, vendedor_id, atualizado_em, atualizado_por)
  values (p_user, case when p_modelo = 'vendedor' then 'vendedor' else 'personalizado' end,
          coalesce(p_chaves, '{}'), p_vendedor, now(), auth.uid())
  on conflict (user_id) do update
    set modelo = excluded.modelo, chaves = excluded.chaves, vendedor_id = excluded.vendedor_id,
        atualizado_em = now(), atualizado_por = auth.uid();
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'erro', 'Esse vendedor já está ligado a outro login.');
end $function$;
