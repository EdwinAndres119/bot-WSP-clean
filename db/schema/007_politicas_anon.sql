-- =====================================================================
-- PASO 2 — Politicas RLS para el bot (opcion B: clave anon acotada)
-- Correr DESPUES de 000_setup_completo.sql (secciones 1 y 2, las tablas).
-- NO descomentar la seccion 3 de ese archivo: esta la reemplaza.
-- =====================================================================

-- GRANTs a nivel tabla. RLS es solo la mitad del control de acceso: sin el
-- GRANT, las politicas ni se evaluan y da "permission denied for table".
-- En Supabase Cloud vienen por defecto; en self-hosted no siempre.
grant usage on schema public to anon;
grant select, insert, update on public.mensajes to anon;
grant select, insert, update on public.extraction_runs to anon;
grant usage, select on all sequences in schema public to anon;

-- Prende RLS: a partir de aca, solo pasa lo que las politicas permitan.
alter table public.mensajes enable row level security;
alter table public.extraction_runs enable row level security;

-- mensajes: el bot guarda con upsert por id, asi que necesita INSERT y
-- UPDATE. Sin el UPDATE funciona la primera corrida y falla la segunda.
create policy "bot_select_mensajes" on public.mensajes
  for select to anon using (true);
create policy "bot_insert_mensajes" on public.mensajes
  for insert to anon with check (true);
create policy "bot_update_mensajes" on public.mensajes
  for update to anon using (true) with check (true);

-- extraction_runs: inserta al arrancar la corrida y actualiza el progreso.
create policy "bot_select_runs" on public.extraction_runs
  for select to anon using (true);
create policy "bot_insert_runs" on public.extraction_runs
  for insert to anon with check (true);
create policy "bot_update_runs" on public.extraction_runs
  for update to anon using (true) with check (true);

-- Sin politica de DELETE a proposito: el bot nunca borra.
