-- /correção no grupo de vendas: desfazer uma venda lançada errado.
-- O vendedor vê e desfaz só as vendas DELE do dia da loja (vira às 3h); sócio vê todas
-- das últimas 24h. Desfazer = devolve os itens ao estoque e marca a venda como cancelada,
-- então ela sai da comissão, do resumo do dia e do Início "conforme o Telegram".

create or replace function public.bot_correcao_lista(p_token text, p_meta jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tok text; v_socio boolean; v_vend uuid; v_lista jsonb;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  v_socio := public.bot_eh_socio(p_meta);
  v_vend  := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb) - 'vendedor');
  if not v_socio and v_vend is null then
    return jsonb_build_object('ok', false, 'erro', 'Seu Telegram não está ligado a nenhum vendedor. Mande /sou SeuNome primeiro.');
  end if;

  select coalesce(jsonb_agg(x order by x ->> 'quando_ts' desc), '[]'::jsonb) into v_lista
    from (
      select jsonb_build_object(
               'sale_id', s.id,
               'quando_ts', s.sold_at,
               'hora', to_char(s.sold_at at time zone 'America/Sao_Paulo', 'HH24:MI'),
               'vendedor', v.nome,
               'atacado', s.notes ilike '%atacado%',
               'unidades', (select coalesce(sum(qty), 0) from sale_items where sale_id = s.id),
               'itens', (select string_agg(si.qty || 'x ' || m.name || ' ' || f.name, ', ' order by m.name, f.name)
                           from sale_items si join flavors f on f.id = si.flavor_id join models m on m.id = f.model_id
                          where si.sale_id = s.id)) x
        from sales s left join vendedores v on v.id = s.vendedor_id
       where s.notes ilike 'bot telegram%' and s.status <> 'cancelada'
         and (case when v_socio then s.sold_at > now() - interval '24 hours'
                   else s.vendedor_id = v_vend and public.dia_loja(s.sold_at) = public.dia_loja(now()) end)
       order by s.sold_at desc
       limit 10) t;

  return jsonb_build_object('ok', true, 'socio', v_socio, 'vendas', v_lista);
end $$;

create or replace function public.bot_correcao_desfazer(p_token text, p_sale_id uuid, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok text; v_socio boolean; v_vend uuid; v_sale sales; v_item record; v_itens text; v_un int;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  v_socio := public.bot_eh_socio(p_meta);
  v_vend  := public.vendedor_do_meta(coalesce(p_meta, '{}'::jsonb) - 'vendedor');

  select * into v_sale from sales where id = p_sale_id for update;
  if not found or v_sale.notes not ilike 'bot telegram%' then
    return jsonb_build_object('ok', false, 'erro', 'Venda não encontrada.');
  end if;
  if v_sale.status = 'cancelada' then
    return jsonb_build_object('ok', false, 'erro', 'Essa venda já foi desfeita.');
  end if;
  if not v_socio then
    if v_vend is null or v_sale.vendedor_id is distinct from v_vend then
      return jsonb_build_object('ok', false, 'erro', 'Você só pode desfazer as suas vendas.');
    end if;
    if public.dia_loja(v_sale.sold_at) <> public.dia_loja(now()) then
      return jsonb_build_object('ok', false, 'erro', 'Só dá pra desfazer venda do dia. Peça a um sócio.');
    end if;
  elsif v_sale.sold_at <= now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'erro', 'Venda com mais de 24h: cancele pelo Caixa no sistema.');
  end if;

  select string_agg(si.qty || 'x ' || m.name || ' ' || f.name, ', ' order by m.name, f.name), coalesce(sum(si.qty), 0)
    into v_itens, v_un
    from sale_items si join flavors f on f.id = si.flavor_id join models m on m.id = f.model_id
   where si.sale_id = p_sale_id;

  for v_item in select flavor_id, qty from sale_items where sale_id = p_sale_id loop
    update flavors set stock_qty = stock_qty + v_item.qty where id = v_item.flavor_id;
    insert into stock_movements (flavor_id, qty_delta, type, sale_id, notes)
    values (v_item.flavor_id, v_item.qty, 'cancelamento_venda', p_sale_id,
            'bot telegram: /correção por ' || coalesce(nullif(trim(p_meta ->> 'nome'), ''), 'vendedor'));
  end loop;

  update sales set status = 'cancelada' where id = p_sale_id;
  return jsonb_build_object('ok', true, 'itens', coalesce(v_itens, ''), 'unidades', v_un,
    'modelos', (select coalesce(jsonb_agg(jsonb_build_object('modelo', m.name, 'qtd', q)), '[]'::jsonb)
                  from (select f.model_id, sum(si.qty)::int q from sale_items si join flavors f on f.id = si.flavor_id
                         where si.sale_id = p_sale_id group by 1) z join models m on m.id = z.model_id),
    'hora', to_char(v_sale.sold_at at time zone 'America/Sao_Paulo', 'HH24:MI'));
end $$;

revoke all on function public.bot_correcao_lista(text, jsonb) from public, anon, authenticated;
revoke all on function public.bot_correcao_desfazer(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.bot_correcao_lista(text, jsonb) to anon, service_role;
grant execute on function public.bot_correcao_desfazer(text, uuid, jsonb) to anon, service_role;
