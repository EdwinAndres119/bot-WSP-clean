-- =====================================================================
-- SETUP COMPLETO — correr esto en una instancia de Supabase/Postgres NUEVA
-- (SQL Editor del dashboard, o psql directo si es self-hosted).
--
-- Reemplaza a correr 002 + 005 + 006 por separado: crea las dos tablas ya
-- completas, con todas las columnas y sus indices. Es idempotente
-- (`if not exists`), asi que se puede correr mas de una vez sin romper nada.
--
-- La seccion de RLS del final va APARTE a proposito — leer su advertencia
-- antes de correrla.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. mensajes — cada mensaje extraido de WhatsApp
-- ---------------------------------------------------------------------
create table if not exists public.mensajes (
    -- La PK es el id REAL del mensaje de WhatsApp, no un identity propio:
    -- MessageRepository.save() hace upsert con onConflict: 'id' para
    -- deduplicar entre corridas. Si se cambia a un id autogenerado, se
    -- rompe la deduplicacion y se guardarian mensajes repetidos.
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
    -- Ruta relativa al proyecto donde quedo el archivo en disco.
    -- Los archivos NO se guardan en la base, solo su ruta.
    media_path text,

    -- Fecha real del mensaje en WhatsApp. El nombre "timestamp" es una
    -- palabra no reservada en Postgres (funciona sin comillas) y el codigo
    -- ya la manda asi — no renombrar sin cambiar MessagePipeline.js.
    timestamp timestamptz,

    -- Ultima vez que una corrida confirmo este mensaje. MessagePipeline.js
    -- lo manda en CADA upsert (no solo insert) a proposito: si solo se
    -- seteara en el insert, un mensaje ya guardado de una corrida vieja
    -- desaparecia del export de una corrida nueva aunque esta lo hubiera
    -- vuelto a traer (bug real, visto en runId=29 el 2026-09-17). Es lo que
    -- usa GET /api/export?runId=N para saber que mensajes entraron en cada
    -- corrida.
    fetched_at timestamptz not null default now()
);

-- /api/export filtra por fetched_at y ordena por timestamp; el desglose por
-- chat agrupa por chat_id. Sin estos indices, cada export hace scan completo.
create index if not exists mensajes_fetched_at_idx on public.mensajes (fetched_at);
create index if not exists mensajes_chat_id_idx on public.mensajes (chat_id);
create index if not exists mensajes_timestamp_idx on public.mensajes (timestamp desc);


-- ---------------------------------------------------------------------
-- 2. extraction_runs — una fila por corrida de extraccion
-- ---------------------------------------------------------------------
create table if not exists public.extraction_runs (
    id bigint generated always as identity primary key,

    line_label text not null,
    months_limit integer,
    status text not null default 'running',

    chats_found integer not null default 0,
    chats_processed integer not null default 0,
    chats_failed integer not null default 0,
    messages_saved integer not null default 0,

    -- Chats que fallaron con un error tecnico real: {chatId, chatName, error}
    failed_chats jsonb not null default '[]'::jsonb,
    -- Chats revisados bien pero sin mensajes que guardar, con el motivo:
    -- {chatId, chatName, reason}. NO mezclar con failed_chats: son cosas
    -- distintas y el equipo de negocio las revisa por separado.
    empty_chats jsonb not null default '[]'::jsonb,

    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text
);

create index if not exists extraction_runs_started_at_idx
    on public.extraction_runs (started_at desc);
create index if not exists extraction_runs_line_label_idx
    on public.extraction_runs (line_label);


-- =====================================================================
-- 3. RLS — CORRER SOLO DESPUES DE CONFIRMAR LA CLAVE
--
-- ⚠️ Antes de correr esta seccion, SUPABASE_KEY en el .env del backend
--    tiene que ser la clave `service_role` (secreta).
--
--    Si el backend sigue usando la clave `anon`/publica y se activa RLS,
--    el bot se queda SIN PODER LEER NI ESCRIBIR estas tablas y toda
--    extraccion va a fallar silenciosamente.
--
--    Como saber cual tenes: decodifica el JWT (jwt.io o
--    `Buffer.from(<parte del medio>, 'base64').toString()`), y fijate en
--    el campo "role": tiene que decir "service_role", no "anon".
--
-- No hacen falta politicas: la clave service_role se salta RLS por diseño.
-- Activar RLS sin politicas bloquea cualquier acceso con la clave publica,
-- que es justo lo que queremos si esa clave se llega a filtrar.
-- =====================================================================

-- alter table public.mensajes enable row level security;
-- alter table public.extraction_runs enable row level security;
