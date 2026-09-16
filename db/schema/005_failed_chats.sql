-- Corre esto en el SQL editor de Supabase (Project > SQL Editor).
-- Guarda el detalle de que chats fallaron en cada corrida (numero/nombre +
-- motivo del error), para que el equipo de negocio los pueda revisar
-- manualmente despues desde el panel Admin.

alter table public.extraction_runs
    add column if not exists failed_chats jsonb not null default '[]'::jsonb;
