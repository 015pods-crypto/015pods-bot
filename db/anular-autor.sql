-- ===========================================================================
-- /anular liberado para qualquer membro + registro de QUEM anulou
--
-- Contexto: /anular passou a ser aceito de qualquer membro do grupo (anular só
-- REDUZ a comissão do Rod — o pior caso é ele se descontar sozinho). /desanular
-- continua só do dono, porque AUMENTA a comissão. Liberar sem saber quem
-- apertou é que seria ruim: daí este Run.
--
-- POR QUE UMA TABELA DE LOG, E NÃO UMA COLUNA EM comissao_ajustes:
-- a bot_anular_comissao já existe no banco e não está versionada neste repo —
-- não dá pra recriá-la aqui sem o corpo dela. Este Run só ENVELOPA a função
-- atual: chama ela igualzinho e grava o autor num log próprio. Nada da lógica
-- de anulação muda, e o Run não depende de nenhuma coluna da comissao_ajustes.
--
-- COMPATIBILIDADE: o bot chama bot_anular_comissao_autor e, se ela não existir
-- (Run não aplicado), cai sozinho na bot_anular_comissao antiga. Ou seja: sem
-- este Run o /anular funciona, só não registra o autor.
--
-- Como rodar: SQL Editor do Supabase, RUN único.
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

create table if not exists public.comissao_anulacoes_log (
  id             bigint generated always as identity primary key,
  unidades       integer     not null,
  autor_user_id  text,
  autor_nome     text,
  meta           jsonb       not null default '{}'::jsonb,
  resultado      jsonb,
  criado_em      timestamptz not null default now()
);

create index if not exists comissao_anulacoes_log_criado_idx
  on public.comissao_anulacoes_log (criado_em desc);

-- Sem policy: só a RPC security definer abaixo escreve aqui.
alter table public.comissao_anulacoes_log enable row level security;

-- Envelope da bot_anular_comissao: mesma anulação, mais o carimbo do autor.
-- Só grava o log quando a anulação deu certo (ok=true) — log de tentativa que
-- falhou viraria "o Rod anulou 5" para uma anulação que não aconteceu.
create or replace function public.bot_anular_comissao_autor(
  p_token    text,
  p_unidades integer,
  p_meta     jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res  jsonb;
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
begin
  v_res := public.bot_anular_comissao(p_token, p_unidades);

  if coalesce((v_res ->> 'ok')::boolean, false) then
    insert into public.comissao_anulacoes_log (unidades, autor_user_id, autor_nome, meta, resultado)
    values (p_unidades, v_meta ->> 'user_id', v_meta ->> 'nome', v_meta, v_res);
  end if;

  return v_res || jsonb_build_object('autor', v_meta ->> 'nome');
end;
$$;

grant execute on function public.bot_anular_comissao_autor(text, integer, jsonb) to anon, authenticated;

-- ─── FIM DO RUN ────────────────────────────────────────────────────────────


-- ═══ Conferência (opcional) ════════════════════════════════════════════════
-- Quem anulou o quê, mais recente primeiro:
--   select criado_em at time zone 'America/Sao_Paulo' as quando,
--          autor_nome, autor_user_id, unidades
--     from public.comissao_anulacoes_log
--    order by criado_em desc limit 20;
