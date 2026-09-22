-- ===========================================================================
-- Config do bot: leitura e escrita restritas a uma lista explícita de chaves
--
-- POR QUE ESTE RUN É OBRIGATÓRIO:
-- a bot_config que está no banco hoje (db/despesas-rod.sql, RUN 2) só libera
-- chaves com prefixo 'bot_'. A chave do grupo de pedidos chama-se
-- 'telegram_grupo_pedidos' — sem este Run ela é RECUSADA na leitura, o bot
-- nunca enxerga o grupo, e o /setgrupopedidos não tem onde gravar.
--
-- O que muda:
--   1. bot_config_chaves() — a lista branca, num lugar só.
--   2. bot_config passa a usar essa lista (o curinga 'bot_%' SAIU).
--   3. nasce a bot_config_set, que é o que o /setgrupopedidos usa pra gravar.
--
-- SEM ESCRITA LIVRE, E SEM LEITURA LIVRE: a integration_config guarda tokens e
-- chaves de API. O curinga 'bot_%' da versão anterior foi removido de
-- propósito — se uma chave secreta um dia nascer com esse prefixo, ela estaria
-- legível com o token do bot. As duas RPCs agora só enxergam a lista branca, e
-- o bot_sync_token não está nela (nem poderia: é o segredo que autentica tudo).
--
-- Chave nova no futuro = acrescentar em bot_config_chaves() e rodar de novo.
--
-- Como rodar: SQL Editor do Supabase, RUN único.
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

-- Única fonte de verdade sobre o que o bot pode ler e gravar na config.
create or replace function public.bot_config_chaves()
returns text[]
language sql
immutable
as $$
  select array[
    'telegram_grupo_pedidos',     -- id do grupo de pedidos (/setgrupopedidos)
    'telegram_grupo_faturamento', -- id do grupo de faturamento (/setgrupofaturamento)
    'telegram_grupo_traducao',    -- id do grupo de tradução (/setgrupotraducao)
    'bot_despesa_palavras',       -- CSV das palavras de despesa (+25 ENTREGA)
    'bot_nao_pods',               -- modelos que não são pod (/estoque)
    'bot_lembrete_chips'          -- data do último lembrete dos chips (dia 20)
  ];
$$;

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

  -- Lista branca e nada além dela. Sem isto esta RPC viraria um "leia qualquer
  -- segredo da integration_config" para quem tiver o token do bot.
  if p_key is null or not (p_key = any(public.bot_config_chaves())) then
    return jsonb_build_object('ok', false, 'erro', 'chave não permitida');
  end if;

  select value into v_val from integration_config where key = p_key;

  return jsonb_build_object('ok', true, 'key', p_key, 'valor', coalesce(v_val, ''));
end;
$$;

-- Escrita: mesma lista branca. É o que o /setgrupopedidos usa.
create or replace function public.bot_config_set(p_token text, p_key text, p_valor text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tok text;
begin
  select value into v_tok from integration_config where key = 'bot_sync_token';
  if v_tok is null or p_token is distinct from v_tok then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  if p_key is null or not (p_key = any(public.bot_config_chaves())) then
    return jsonb_build_object('ok', false, 'erro', 'chave não permitida para escrita');
  end if;

  insert into public.integration_config (key, value)
  values (p_key, coalesce(p_valor, ''))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('ok', true, 'key', p_key, 'valor', coalesce(p_valor, ''));
end;
$$;

grant execute on function public.bot_config_chaves()              to anon, authenticated;
grant execute on function public.bot_config(text, text)           to anon, authenticated;
grant execute on function public.bot_config_set(text, text, text) to anon, authenticated;

-- ─── FIM DO RUN ────────────────────────────────────────────────────────────


-- ═══ Conferência (trocando <TOKEN>) ════════════════════════════════════════
-- Tem que vir ok:true em todas estas:
--   select public.bot_config('<TOKEN>', 'telegram_grupo_pedidos');
--   select public.bot_config('<TOKEN>', 'telegram_grupo_faturamento');
--   select public.bot_config('<TOKEN>', 'telegram_grupo_traducao');
--   select public.bot_config('<TOKEN>', 'bot_despesa_palavras');
--   select public.bot_config('<TOKEN>', 'bot_nao_pods');
--   select public.bot_config('<TOKEN>', 'bot_lembrete_chips');
--
-- Tem que RECUSAR nestas três (é o ponto do Run):
--   select public.bot_config('<TOKEN>', 'bot_sync_token');
--   select public.bot_config_set('<TOKEN>', 'bot_sync_token', 'x');
--   select public.bot_config_set('<TOKEN>', 'qualquer_outra_chave', 'x');
