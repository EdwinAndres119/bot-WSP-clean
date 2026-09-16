-- Corre esto en el SQL editor de Supabase (Project > SQL Editor).
-- Guarda por separado los chats que se revisaron bien pero no tenian
-- mensajes que guardar (sin actividad en el rango, o bloqueados por
-- WhatsApp) - distinto de failed_chats (005), que son errores tecnicos
-- reales. Mezclar ambos seria enganoso para el equipo que los revisa.

alter table public.extraction_runs
    add column if not exists empty_chats jsonb not null default '[]'::jsonb;
