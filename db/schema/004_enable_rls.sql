-- Corre esto en el SQL editor de Supabase SOLO DESPUES de haber cambiado
-- SUPABASE_KEY en .env a la clave secreta (service_role), no antes -- si
-- activas RLS mientras el backend siga usando la clave publica
-- (sb_publishable_...), el backend se queda sin poder leer ni escribir estas
-- tablas.
--
-- No hace falta crear ninguna politica: la clave service_role del backend
-- se salta RLS por diseño. Activar RLS sin politicas simplemente bloquea
-- cualquier acceso con la clave publica/anon -- que es justo lo que
-- queremos: si esa clave se filtra, ya no sirve para leer ni escribir nada.

alter table public.mensajes enable row level security;
alter table public.extraction_runs enable row level security;
alter table public.users enable row level security;
