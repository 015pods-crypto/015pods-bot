-- ===========================================================================
-- Atacado: marcar UMA VENDA ESPECÍFICA, pelo id
--
-- A regra em si (valor fixo por unidade em vez da taxa da faixa, com as
-- unidades contando pro volume do ciclo) já vive na bot_comissao, que
-- identifica a venda pela palavra "atacado" no `notes`. Este Run entrega só a
-- outra ponta: como essa palavra chega no `notes`.
--
-- POR QUE POR ID, E NÃO "A ÚLTIMA": marcar atacado mexe em comissão. "A última
-- venda" é uma mira que se move sozinha — entre registrar e marcar, outra
-- venda pode entrar e levar a marca no lugar da certa. Por isso a
-- bot_marcar_atacado EXIGE p_sale_id: sem id, ela recusa em vez de adivinhar.
--
-- Quem descobre o id da venda a corrigir é a bot_ultima_venda, e ela nunca
-- marca nada — só devolve o candidato pro bot confirmar com o usuário. São
-- duas funções de propósito: escolher o alvo e disparar são passos separados.
--
-- JANELA DE 30 MIN: a bot_ultima_venda só enxerga venda recente. Correção de
-- atacado é coisa de "esqueci a palavra agora há pouco"; venda de ontem se
-- corrige no sistema, não por um comando que aponta pro que estiver por último.
--
-- POR QUE UMA RPC SEPARADA, E NÃO UM PARÂMETRO NA bot_movimentar_estoque:
-- a bot_movimentar_estoque já existe no banco e não está versionada neste
-- repo — não dá pra recriá-la aqui sem o corpo dela.
--
-- IDEMPOTENTE: rodar duas vezes na mesma venda não duplica a palavra; a
-- segunda devolve ja_marcada = true.
--
-- Como rodar: SQL Editor do Supabase, RUN único.
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

-- A assinatura mudou (era só p_token, mirando "a última venda"). Dropar antes
-- evita o Postgres manter as duas e o PostgREST reclamar de chamada ambígua —
-- e, pior, evita a versão insegura continuar existindo.
drop function if exists public.bot_marcar_atacado(text);

-- Candidato à correção manual (/atacado). NÃO marca nada: só devolve o que
-- seria marcado, pro bot pedir confirmação antes.
create or replace function public.bot_ultima_venda(p_token text, p_minutos int default 30)
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
  v_min    int := greatest(1, coalesce(p_minutos, 30));
  v_un     int;
  v_itens  text;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  -- Cancelada fica de fora: marcar uma venda que não existe mais só criaria
  -- confusão no extrato.
  select s.id::text,
         s.notes,
         to_char(s.sold_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
    into v_id, v_notes, v_quando
    from sales s
   where s.notes ilike 'bot telegram%'
     and s.status <> 'cancelada'
     and s.sold_at >= now() - make_interval(mins => v_min)
   order by s.sold_at desc, s.id desc
   limit 1;

  if v_id is null then
    return jsonb_build_object(
      'ok', false,
      'erro', format('nenhuma venda do bot nos últimos %s minutos', v_min)
    );
  end if;

  -- `itens` sai daqui já legível ("1x Oxbar 30000 White Grape"): é o que o bot
  -- mostra na confirmação do /atacado, em vez de "1 unidade(s)".
  select coalesce(sum(si.qty), 0),
         string_agg(si.qty || 'x ' || m.name || ' ' || f.name, ', ')
    into v_un, v_itens
    from sale_items si
    join flavors f on f.id = si.flavor_id
    join models  m on m.id = f.model_id
   where si.sale_id::text = v_id;

  return jsonb_build_object(
    'ok', true,
    'sale_id', v_id,
    'unidades', v_un,
    'itens', coalesce(v_itens, ''),
    'quando', v_quando,
    'ja_marcada', (v_notes ilike '%atacado%'),
    'notes', v_notes
  );
end;
$$;

-- Marca UMA venda, pelo id. Sem id, recusa.
create or replace function public.bot_marcar_atacado(p_token text, p_sale_id text)
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
  v_itens  text;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  -- A trava principal deste Run: nada de "a última" como fallback.
  if p_sale_id is null or btrim(p_sale_id) = '' then
    return jsonb_build_object('ok', false, 'erro', 'sale_id obrigatório');
  end if;

  select s.id::text,
         s.notes,
         to_char(s.sold_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
    into v_id, v_notes, v_quando
    from sales s
   where s.id::text = btrim(p_sale_id)
     and s.notes ilike 'bot telegram%'
     and s.status <> 'cancelada'
   limit 1;

  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'venda não encontrada');
  end if;

  -- `itens` sai daqui já legível ("1x Oxbar 30000 White Grape"): é o que o bot
  -- mostra na confirmação do /atacado, em vez de "1 unidade(s)".
  select coalesce(sum(si.qty), 0),
         string_agg(si.qty || 'x ' || m.name || ' ' || f.name, ', ')
    into v_un, v_itens
    from sale_items si
    join flavors f on f.id = si.flavor_id
    join models  m on m.id = f.model_id
   where si.sale_id::text = v_id;

  if v_notes ilike '%atacado%' then
    return jsonb_build_object(
      'ok', true, 'ja_marcada', true,
      'sale_id', v_id, 'unidades', v_un, 'itens', coalesce(v_itens, ''),
      'quando', v_quando, 'notes', v_notes
    );
  end if;

  update sales
     set notes = v_notes || ' atacado'
   where id::text = v_id;

  return jsonb_build_object(
    'ok', true, 'ja_marcada', false,
    'sale_id', v_id, 'unidades', v_un, 'itens', coalesce(v_itens, ''),
    'quando', v_quando,
    'notes', v_notes || ' atacado'
  );
end;
$$;

grant execute on function public.bot_ultima_venda(text, int)      to anon, authenticated;
grant execute on function public.bot_marcar_atacado(text, text)   to anon, authenticated;

-- Valor pago por unidade no atacado. A bot_comissao lê daqui; este insert só
-- garante que a chave exista. `do nothing` de propósito: se você já configurou
-- outro valor, ele NÃO é sobrescrito.
insert into public.integration_config (key, value)
values ('comissao_atacado_valor', '2')
on conflict (key) do nothing;

-- ─── FIM DO RUN ────────────────────────────────────────────────────────────


-- ═══ Conferência (trocando <TOKEN>) ════════════════════════════════════════
-- Qual venda o /atacado ofereceria agora (e se já está marcada):
--   select public.bot_ultima_venda('<TOKEN>');
--   select public.bot_ultima_venda('<TOKEN>', 120);   -- janela maior, só pra olhar
--
-- Marcar pelo id devolvido acima (rodar 2x: a segunda vem ja_marcada = true):
--   select public.bot_marcar_atacado('<TOKEN>', '<SALE_ID>');
--
-- Tem que RECUSAR (é o ponto do Run):
--   select public.bot_marcar_atacado('<TOKEN>', null);
--   select public.bot_marcar_atacado('<TOKEN>', '');
--
-- Conferir a quebra depois de marcar:
--   select public.bot_comissao('<TOKEN>');
--
-- Desfazer uma marcação errada:
--   update sales set notes = replace(notes, ' atacado', '') where id::text = '<SALE_ID>';
--
-- ═══ NOTA ══════════════════════════════════════════════════════════════════
-- Este arquivo é FIEL ao que está em produção — dá pra recolar o Run sem medo
-- de rebaixar as funções. O campo `itens` ("1x Oxbar 30000 White Grape") vem do
-- join sale_items → flavors → models; o bot usa ele na confirmação do /atacado
-- e só cai em "N unidade(s)" se vier vazio.
