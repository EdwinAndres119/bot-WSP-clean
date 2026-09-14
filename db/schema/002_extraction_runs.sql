-- Corre esto en el SQL editor de Supabase (Project > SQL Editor).
-- Tabla para el panel de admin: registra cada corrida de extraccion,
-- de que linea fue, con que limite de meses, y como termino.

create table if not exists public.extraction_runs (
    id bigint generated always as identity primary key,
    line_label text not null,
    months_limit integer,
    status text not null default 'running',
    chats_found integer not null default 0,
    chats_processed integer not null default 0,
    chats_failed integer not null default 0,
    messages_saved integer not null default 0,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    error_message text
);

create index if not exists extraction_runs_started_at_idx
    on public.extraction_runs (started_at desc);

create index if not exists extraction_runs_line_label_idx
    on public.extraction_runs (line_label);
