-- ===========================================================================
-- Atacado: marcar a última venda do bot
--
-- A REGRA em si (valor fixo por unidade em vez da taxa da faixa, com as
-- unidades contando pro volume do ciclo) já vive na bot_comissao, que
-- identifica a venda pela palavra "atacado" no `notes`. Este Run entrega só a
-- outra ponta: como essa palavra chega no `notes`.
--
-- POR QUE UMA RPC SEPARADA, E NÃO UM PARÂMETRO NA bot_movimentar_estoque:
-- a bot_movimentar_estoque já existe no banco e não está versionada neste
-- repo — não dá pra recriá-la aqui sem o corpo dela. Então o bot registra a
-- venda como sempre e, logo em seguida, chama esta função. A mesma função
-- atende o /atacado (correção quando o atendente esquece a palavra), que é
-- exatamente a mesma operação.
--
-- MARCA UMA VENDA SÓ: a mais recente do bot. É o que o /atacado precisa e
-- cobre o caso normal (mensagem de uma linha). A função devolve QUAL venda
-- marcou (unidades e horário) pro bot ecoar no grupo — numa mensagem com
-- várias baixas, dá pra ver na hora que só a última foi marcada.
--
-- IDEMPOTENTE: rodar duas vezes na mesma venda não duplica a palavra; a
-- segunda devolve ja_marcada = true.
--
-- Como rodar: SQL Editor do Supabase, RUN único.
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

create or replace function public.bot_marcar_atacado(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok    text;
  v_id     text;
  v_notes  text;
  v_quando text;
  v_un     int;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  -- Última venda feita pelo bot. Cancelada fica de fora: marcar uma venda que
  -- não existe mais só criaria confusão no extrato.
  select s.id::text,
         s.notes,
         to_char(s.sold_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
    into v_id, v_notes, v_quando
    from sales s
   where s.notes ilike 'bot telegram%'
     and s.status <> 'cancelada'
   order by s.sold_at desc, s.id desc
   limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'nenhuma venda do bot encontrada');
  end if;

  select coalesce(sum(si.qty), 0) into v_un
    from sale_items si
   where si.sale_id::text = v_id;

  if v_notes ilike '%atacado%' then
    return jsonb_build_object(
      'ok', true, 'ja_marcada', true,
      'sale_id', v_id, 'unidades', v_un, 'quando', v_quando, 'notes', v_notes
    );
  end if;

  update sales
     set notes = v_notes || ' atacado'
   where id::text = v_id;

  return jsonb_build_object(
    'ok', true, 'ja_marcada', false,
    'sale_id', v_id, 'unidades', v_un, 'quando', v_quando,
    'notes', v_notes || ' atacado'
  );
end;
$$;

grant execute on function public.bot_marcar_atacado(text) to anon, authenticated;

-- Valor pago por unidade no atacado. A bot_comissao lê daqui; este insert só
-- garante que a chave exista com o valor combinado.
insert into public.integration_config (key, value)
values ('comissao_atacado_valor', '2')
on conflict (key) do nothing;

-- ─── FIM DO RUN ────────────────────────────────────────────────────────────


-- ═══ Conferência (trocando <TOKEN>) ════════════════════════════════════════
-- Qual é a última venda do bot (a que o /atacado marcaria):
--   select s.id, s.sold_at at time zone 'America/Sao_Paulo' as quando, s.notes
--     from sales s
--    where s.notes ilike 'bot telegram%' and s.status <> 'cancelada'
--    order by s.sold_at desc, s.id desc limit 3;
--
-- Marcar (rodar duas vezes: a segunda tem que vir ja_marcada = true):
--   select public.bot_marcar_atacado('<TOKEN>');
--
-- Conferir a quebra depois de marcar:
--   select public.bot_comissao('<TOKEN>');
--
-- Desfazer uma marcação errada (troque <ID> pelo sale_id devolvido acima):
--   update sales set notes = replace(notes, ' atacado', '') where id::text = '<ID>';
