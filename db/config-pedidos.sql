-- ===========================================================================
-- Config do grupo de pedidos: leitura da chave nova + escrita pelo bot
--
-- POR QUE ESTE RUN É OBRIGATÓRIO:
-- a bot_config que está no banco hoje (db/despesas-rod.sql, RUN 2) só libera
-- chaves com prefixo 'bot_'. A chave do grupo de pedidos chama-se
-- 'telegram_grupo_pedidos' — sem este Run ela é RECUSADA na leitura, o bot
-- nunca enxerga o grupo, e o /setgrupopedidos não tem onde gravar.
--
-- O que muda:
--   1. bot_config passa a liberar também as chaves da lista explícita abaixo.
--   2. nasce a bot_config_set, que é o que o /setgrupopedidos usa pra gravar.
--
-- LEITURA x ESCRITA: ler qualquer chave 'bot_%' segue liberado (é o namespace
-- do bot, e não havia regressão a criar). ESCREVER exige a lista explícita —
-- uma escrita errada é o que quebra o bot, então ela não ganha curinga.
-- O bot_sync_token continua fora dos dois: é o segredo que autentica tudo.
--
-- Como rodar: SQL Editor do Supabase, RUN único.
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

-- Chaves de configuração que o bot pode ler E gravar. Pra liberar uma chave
-- nova no futuro, é só acrescentar aqui e rodar o Run de novo.
create or replace function public.bot_config_chaves()
returns text[]
language sql
immutable
as $$
  select array['bot_despesa_palavras', 'telegram_grupo_pedidos'];
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

  -- Namespace do bot OU chave explicitamente liberada. Sem isso esta RPC
  -- viraria um "leia qualquer segredo da integration_config" com o token do bot.
  if p_key is null
     or p_key = 'bot_sync_token'
     or not (p_key like 'bot\_%' or p_key = any(public.bot_config_chaves()))
  then
    return jsonb_build_object('ok', false, 'erro', 'chave não permitida');
  end if;

  select value into v_val from integration_config where key = p_key;

  return jsonb_build_object('ok', true, 'key', p_key, 'valor', coalesce(v_val, ''));
end;
$$;

-- Escrita: só as chaves da lista explícita. É o que o /setgrupopedidos usa.
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

grant execute on function public.bot_config_chaves()                to anon, authenticated;
grant execute on function public.bot_config(text, text)             to anon, authenticated;
grant execute on function public.bot_config_set(text, text, text)   to anon, authenticated;

-- ─── FIM DO RUN ────────────────────────────────────────────────────────────


-- ═══ Conferência (trocando <TOKEN>) ════════════════════════════════════════
-- select public.bot_config('<TOKEN>', 'telegram_grupo_pedidos');   -- deve vir ok:true
-- select public.bot_config('<TOKEN>', 'bot_sync_token');           -- deve RECUSAR
-- select public.bot_config_set('<TOKEN>', 'bot_sync_token', 'x');  -- deve RECUSAR
--
-- As três RPCs de fornecedor/pedido NÃO estão neste repo (nem neste Run).
-- Confira se já existem no banco antes de testar os comandos:
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('bot_fornecedor_importar','bot_fornecedor_apelido','bot_montar_pedido')
--    order by 1;
-- Se vier vazio, o bot responde "a RPC X não existe no banco" em vez de quebrar.
