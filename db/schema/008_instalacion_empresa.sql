-- =====================================================================
-- INSTALACION COMPLETA EN LA SUPABASE DE LA EMPRESA (opcion B: clave anon)
-- Correr TODO ESTO de una sola vez en el SQL Editor. Es idempotente.
-- =====================================================================

-- ---------- 1. Tabla mensajes ----------
create table if not exists public.mensajes (
    id text primary key,
    chat_id text,
    chat_name text,
    is_group boolean not null default false,
    remitente_numero text,
    remitente_nombre text,
    esta_registrado boolean not null default false,
    body text,
    message_type text,
    from_me boolean not null default false,
    has_media boolean not null default false,
    media_mimetype text,
    media_filename text,
    media_path text,
    timestamp timestamptz,
    fetched_at timestamptz not null default now()
);

create index if not exists mensajes_fetched_at_idx on public.mensajes (fetched_at);
create index if not exists mensajes_chat_id_idx on public.mensajes (chat_id);
create index if not exists mensajes_timestamp_idx on public.mensajes (timestamp desc);

-- ---------- 2. Tabla extraction_runs ----------
create table if not exists public.extraction_runs (
    id bigint generated always as identity primary key,
    line_label text not null,
    months_limit integer,
    status text not null default 'running',
    chats_found integer not null default 0,
    chats_processed integer not null default 0,
    chats_failed integer not null default 0,
    messages_saved integer not null default 0,
    failed_chats jsonb not null default '[]'::jsonb,
    empty_chats jsonb not null default '[]'::jsonb,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text
);

create index if not exists extraction_runs_started_at_idx on public.extraction_runs (started_at desc);
create index if not exists extraction_runs_line_label_idx on public.extraction_runs (line_label);

-- ---------- 3. Permisos a nivel tabla para el rol anon ----------
-- Sin esto las politicas ni se evaluan: da "permission denied for table".
grant usage on schema public to anon;
grant select, insert, update on public.mensajes to anon;
grant select, insert, update on public.extraction_runs to anon;
grant usage, select on all sequences in schema public to anon;

-- ---------- 4. RLS + politicas acotadas ----------
alter table public.mensajes enable row level security;
alter table public.extraction_runs enable row level security;

drop policy if exists "bot_select_mensajes" on public.mensajes;
drop policy if exists "bot_insert_mensajes" on public.mensajes;
drop policy if exists "bot_update_mensajes" on public.mensajes;
drop policy if exists "bot_select_runs" on public.extraction_runs;
drop policy if exists "bot_insert_runs" on public.extraction_runs;
drop policy if exists "bot_update_runs" on public.extraction_runs;

create policy "bot_select_mensajes" on public.mensajes for select to anon using (true);
create policy "bot_insert_mensajes" on public.mensajes for insert to anon with check (true);
create policy "bot_update_mensajes" on public.mensajes for update to anon using (true) with check (true);

create policy "bot_select_runs" on public.extraction_runs for select to anon using (true);
create policy "bot_insert_runs" on public.extraction_runs for insert to anon with check (true);
create policy "bot_update_runs" on public.extraction_runs for update to anon using (true) with check (true);

-- Sin politica de DELETE a proposito: el bot nunca borra.

-- ---------- 5. Verificacion ----------
select tablename, rowsecurity as rls_prendido from pg_tables
where schemaname = 'public' and tablename in ('mensajes','extraction_runs');

select tablename, policyname, cmd from pg_policies
where schemaname = 'public' order by tablename, policyname;
