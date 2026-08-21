-- ===========================================================================
-- TAREFA 1 — ciclo de comissão fecha SEMPRE no dia 20 às 23:59 (Brasília)
--
-- Antes: janela 20/mm → 19/mm+1 (fechava dia 19).
-- Agora: janela 21/mm → 20/mm+1 (fecha dia 20; o cron do resumo roda 23:59).
--
-- Nada de comissão é armazenado — tudo é derivado de sales/sale_items a cada
-- chamada. Trocar a janela JÁ é a correção retroativa: as vendas de 19/08 (pós
-- fechamento antigo) e de 20/08 passam a cair no ciclo que fechou, e os
-- descontos de comissao_ajustes do período continuam sendo respeitados.
--
-- Mudanças em relação à função atual (o resto é idêntico):
--   1. dia 20 → dia 21 no cálculo de v_ini, e v_fim vira o dia 20 do mês
--      seguinte (calculado pela regra, não por v_ini + 1 mês - 1 dia).
--   2. p_mes, que já existia na assinatura e era IGNORADA, passa a valer:
--      é a data de referência do ciclo. É o que permite refazer o fechamento
--      de um ciclo passado — bot_comissao(token, '2026-08-20').
--   3. o piso de 20/07/2026 (entrada do sistema no ar) vira um clamp explícito:
--      o primeiro ciclo começa em 20/07, não em 21/07, senão a correção do
--      fechamento perderia o primeiro dia de operação.
--
-- Como rodar: SQL Editor do Supabase, RUN único (é só um create or replace).
-- ===========================================================================

create or replace function public.bot_comissao(p_token text, p_mes date default null::date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tok text; v_hoje date; v_ini date; v_fim date;
  v_ano int; v_mes int;
  v_un_mes int; v_un_hoje int; v_ajuste int;
  v_rate numeric; v_com numeric;
  v_prox record; v_faltam int;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  -- Data de referência: hoje, ou a data pedida em p_mes (refazer fechamento).
  v_hoje := coalesce(p_mes, (now() at time zone 'America/Sao_Paulo')::date);
  v_ano  := extract(year  from v_hoje)::int;
  v_mes  := extract(month from v_hoje)::int;

  -- Ciclo 21/mm → 20/mm+1. Do dia 21 em diante já é o ciclo novo.
  if extract(day from v_hoje) >= 21 then
    v_ini := make_date(v_ano, v_mes, 21);
    v_fim := (v_ini + interval '1 month')::date - 1;
  else
    v_ini := (make_date(v_ano, v_mes, 21) - interval '1 month')::date;
    v_fim := make_date(v_ano, v_mes, 20);
  end if;

  -- Sistema no ar desde 20/07/2026: o primeiro ciclo começa lá.
  if v_ini <= date '2026-07-21' then v_ini := date '2026-07-20'; end if;

  select coalesce(sum(si.qty),0),
         coalesce(sum(si.qty) filter (
           where (s.sold_at at time zone 'America/Sao_Paulo')::date = v_hoje),0)
  into v_un_mes, v_un_hoje
  from sales s join sale_items si on si.sale_id = s.id
  where s.notes ilike 'bot telegram%'
    and s.status <> 'cancelada'
    and (s.sold_at at time zone 'America/Sao_Paulo')::date between v_ini and v_fim;

  select coalesce(sum(unidades),0) into v_ajuste
  from comissao_ajustes
  where (created_at at time zone 'America/Sao_Paulo')::date between v_ini and v_fim;

  v_un_mes := greatest(0, v_un_mes - v_ajuste);

  select rate into v_rate from commission_tiers
   where v_un_mes >= min_units and (max_units is null or v_un_mes <= max_units)
   order by min_units desc limit 1;

  v_com := round(v_un_mes * coalesce(v_rate,0), 2);

  select min_units, rate into v_prox from commission_tiers
   where min_units > v_un_mes order by min_units limit 1;

  v_faltam := case when v_prox.min_units is null then null
                   else v_prox.min_units - v_un_mes end;

  return jsonb_build_object(
    'ok', true,
    'mes', to_char(v_ini,'DD/MM') || ' → ' || to_char(v_fim,'DD/MM'),
    'unidades_hoje', v_un_hoje, 'unidades_mes', v_un_mes,
    'taxa_atual', v_rate, 'comissao', v_com,
    'faltam_para_proxima', v_faltam, 'proxima_taxa', v_prox.rate,
    'fecha_hoje', (v_hoje = v_fim));
end $function$;


-- ═══ Conferência (rodar depois, trocando <TOKEN>) ══════════════════════════
--
-- Ciclo vigente hoje (21/08/2026) — deve vir "21/08 → 20/09" e começar zerado:
--   select public.bot_comissao('<TOKEN>');
--
-- Fechamento CORRIGIDO do ciclo anterior — deve vir "20/07 → 20/08" com
-- fecha_hoje = true, já somando as vendas de 19 e 20/08:
--   select public.bot_comissao('<TOKEN>', '2026-08-20');
--
-- O que o fechamento antigo (19/08) tinha contado, para comparar:
--   select coalesce(sum(si.qty),0) as unidades_ate_19_08
--     from sales s join sale_items si on si.sale_id = s.id
--    where s.notes ilike 'bot telegram%' and s.status <> 'cancelada'
--      and (s.sold_at at time zone 'America/Sao_Paulo')::date
--          between date '2026-07-20' and date '2026-08-19';
