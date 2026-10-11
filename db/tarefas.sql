-- ===========================================================================
-- Bot de TAREFAS (outro projeto, mesmo Supabase das lojas)
--
-- Tudo aqui começa com "tarefas_": tabelas e funções. Nenhuma tabela ou função
-- das lojas é tocada — nem lida. O bot de tarefas tem o PRÓPRIO segredo
-- (tarefas_config.sync_token), separado do bot_sync_token das lojas.
--
-- Numeração: cada grupo tem a sua (#1, #2… por chat_id).
--
-- Como rodar: SQL Editor do Supabase, RUN único. Pode rodar de novo sem
-- estragar nada (create if not exists / create or replace) — o token NÃO é
-- trocado numa segunda rodada.
--
-- Depois de rodar, pegue o token para a variável TAREFAS_SYNC_TOKEN do Render:
--   select valor from public.tarefas_config where chave = 'sync_token';
-- ===========================================================================


-- ═══ RUN ÚNICO ═════════════════════════════════════════════════════════════
-- (cole daqui até a linha "FIM DO RUN" e aperte Run)

-- Segredo do bot. Gerado aqui mesmo: não fica no repositório (que é público).
create table if not exists public.tarefas_config (
  chave text primary key,
  valor text not null
);
alter table public.tarefas_config enable row level security;

insert into public.tarefas_config (chave, valor)
values ('sync_token', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (chave) do nothing;

create table if not exists public.tarefas_itens (
  id              bigint generated always as identity primary key,
  chat_id         text        not null,
  numero          integer     not null,
  texto           text        not null,
  foto_file_id    text,
  origem_msg_id   bigint,
  pedido_por_id   text,
  pedido_por_nome text,
  responsavel     text,
  prazo           date,
  status          text        not null default 'aberta' check (status in ('aberta', 'feita')),
  feita_por_id    text,
  feita_por_nome  text,
  feita_em        timestamptz,
  criada_em       timestamptz not null default now(),
  unique (chat_id, numero)
);
create index if not exists tarefas_itens_status_idx on public.tarefas_itens (chat_id, status, numero);
create index if not exists tarefas_itens_origem_idx on public.tarefas_itens (chat_id, origem_msg_id);
alter table public.tarefas_itens enable row level security;

create table if not exists public.tarefas_historico (
  id         bigint generated always as identity primary key,
  tarefa_id  bigint      not null references public.tarefas_itens (id) on delete cascade,
  acao       text        not null,
  detalhe    text,
  autor_id   text,
  autor_nome text,
  criado_em  timestamptz not null default now()
);
create index if not exists tarefas_historico_tarefa_idx on public.tarefas_historico (tarefa_id, criado_em);
alter table public.tarefas_historico enable row level security;

-- Um resumo das 9h por grupo por dia. Fica no banco porque o servidor
-- reinicia a qualquer hora: a memória do processo não serve pra isso.
create table if not exists public.tarefas_resumos (
  chat_id    text        not null,
  dia        date        not null,
  enviado_em timestamptz not null default now(),
  primary key (chat_id, dia)
);
alter table public.tarefas_resumos enable row level security;
-- Sem policy nas quatro tabelas: só as funções abaixo (security definer) mexem.

create or replace function public.tarefas_token_ok(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_token is not null and exists (
    select 1 from tarefas_config where chave = 'sync_token' and valor = p_token
  );
$$;
revoke execute on function public.tarefas_token_ok(text) from public, anon, authenticated;

-- /tarefa — número sequencial por grupo. O lock por grupo evita dois #12
-- quando duas tarefas chegam juntas.
create or replace function public.tarefas_criar(
  p_token         text,
  p_chat_id       text,
  p_texto         text,
  p_foto          text   default null,
  p_origem_msg_id bigint default null,
  p_autor         jsonb  default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num   integer;
  v_id    bigint;
  v_autor jsonb := coalesce(p_autor, '{}'::jsonb);
begin
  if not tarefas_token_ok(p_token) then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  if coalesce(btrim(p_texto), '') = '' then
    return jsonb_build_object('ok', false, 'erro', 'texto vazio');
  end if;

  perform pg_advisory_xact_lock(hashtext('tarefas_criar:' || p_chat_id));
  select coalesce(max(numero), 0) + 1 into v_num from tarefas_itens where chat_id = p_chat_id;

  insert into tarefas_itens (chat_id, numero, texto, foto_file_id, origem_msg_id, pedido_por_id, pedido_por_nome)
  values (p_chat_id, v_num, btrim(p_texto), p_foto, p_origem_msg_id, v_autor->>'user_id', v_autor->>'nome')
  returning id into v_id;

  insert into tarefas_historico (tarefa_id, acao, autor_id, autor_nome)
  values (v_id, 'criada', v_autor->>'user_id', v_autor->>'nome');

  return jsonb_build_object('ok', true, 'numero', v_num, 'id', v_id);
end;
$$;

-- /pendentes, /minhas e o resumo: as abertas, da mais antiga pra mais nova.
create or replace function public.tarefas_listar(
  p_token   text,
  p_chat_id text,
  p_status  text default 'aberta'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not tarefas_token_ok(p_token) then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  return jsonb_build_object('ok', true, 'itens', coalesce((
    select jsonb_agg(to_jsonb(t) order by t.numero)
    from tarefas_itens t
    where t.chat_id = p_chat_id and t.status = coalesce(p_status, 'aberta')
  ), '[]'::jsonb));
end;
$$;

-- /ver — a tarefa e o histórico. Acha pelo número OU pela mensagem que a
-- originou (é o "feito" respondendo à mensagem original).
create or replace function public.tarefas_ver(
  p_token         text,
  p_chat_id       text,
  p_numero        integer default null,
  p_origem_msg_id bigint  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t tarefas_itens%rowtype;
begin
  if not tarefas_token_ok(p_token) then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  if p_numero is not null then
    select * into t from tarefas_itens where chat_id = p_chat_id and numero = p_numero;
  elsif p_origem_msg_id is not null then
    select * into t from tarefas_itens where chat_id = p_chat_id and origem_msg_id = p_origem_msg_id
    order by numero desc limit 1;
  end if;
  if t.id is null then
    return jsonb_build_object('ok', false, 'erro', 'nao_existe');
  end if;

  return jsonb_build_object(
    'ok', true,
    'tarefa', to_jsonb(t),
    'historico', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.criado_em, h.id)
      from tarefas_historico h where h.tarefa_id = t.id
    ), '[]'::jsonb)
  );
end;
$$;

-- /feito, /reabrir, /pra e /prazo numa função só, sempre com histórico.
--   p_acao: 'feito' | 'reabrir' | 'responsavel' | 'prazo'
--   p_valor: nome do responsável, ou o prazo em ISO (YYYY-MM-DD); vazio limpa.
create or replace function public.tarefas_atualizar(
  p_token   text,
  p_chat_id text,
  p_numero  integer,
  p_acao    text,
  p_valor   text  default null,
  p_autor   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t       tarefas_itens%rowtype;
  v_autor jsonb := coalesce(p_autor, '{}'::jsonb);
  v_valor text  := nullif(btrim(coalesce(p_valor, '')), '');
begin
  if not tarefas_token_ok(p_token) then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;

  select * into t from tarefas_itens where chat_id = p_chat_id and numero = p_numero for update;
  if t.id is null then
    return jsonb_build_object('ok', false, 'erro', 'nao_existe');
  end if;

  if p_acao = 'feito' then
    if t.status = 'feita' then
      return jsonb_build_object('ok', false, 'erro', 'ja_feita', 'tarefa', to_jsonb(t));
    end if;
    update tarefas_itens
       set status = 'feita', feita_por_id = v_autor->>'user_id', feita_por_nome = v_autor->>'nome', feita_em = now()
     where id = t.id returning * into t;
  elsif p_acao = 'reabrir' then
    if t.status = 'aberta' then
      return jsonb_build_object('ok', false, 'erro', 'ja_aberta', 'tarefa', to_jsonb(t));
    end if;
    update tarefas_itens
       set status = 'aberta', feita_por_id = null, feita_por_nome = null, feita_em = null
     where id = t.id returning * into t;
  elsif p_acao = 'responsavel' then
    update tarefas_itens set responsavel = v_valor where id = t.id returning * into t;
  elsif p_acao = 'prazo' then
    if v_valor is not null and v_valor !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('ok', false, 'erro', 'prazo_invalido');
    end if;
    update tarefas_itens set prazo = v_valor::date where id = t.id returning * into t;
  else
    return jsonb_build_object('ok', false, 'erro', 'acao_invalida');
  end if;

  insert into tarefas_historico (tarefa_id, acao, detalhe, autor_id, autor_nome)
  values (t.id, p_acao, v_valor, v_autor->>'user_id', v_autor->>'nome');

  return jsonb_build_object('ok', true, 'tarefa', to_jsonb(t));
end;
$$;

-- Resumo das 9h: marca o dia ANTES de mandar. Devolve marcado=true só para
-- quem marcou primeiro — é o que impede resumo repetido depois de reinício.
create or replace function public.tarefas_resumo_marcar(
  p_token   text,
  p_chat_id text,
  p_dia     date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not tarefas_token_ok(p_token) then
    return jsonb_build_object('ok', false, 'erro', 'token inválido');
  end if;
  insert into tarefas_resumos (chat_id, dia) values (p_chat_id, p_dia) on conflict do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'marcado', v_n > 0);
end;
$$;

-- ═══ FIM DO RUN ════════════════════════════════════════════════════════════
