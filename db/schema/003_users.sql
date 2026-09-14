-- Corre esto en el SQL editor de Supabase (Project > SQL Editor).
-- Una cuenta por persona para el login del panel. La contraseña nunca se
-- guarda en texto plano, solo su hash (bcrypt, generado por el backend).

create table if not exists public.users (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    phone         text not null,
    email         text not null unique,
    password_hash text not null,
    created_at    timestamptz not null default now()
);

-- IMPORTANTE: igual que "mensajes" y "extraction_runs", el backend escribe
-- con la clave publica (sb_publishable_...), asi que RLS tiene que quedar
-- desactivado para que los inserts/selects funcionen - activarlo sin
-- politicas bloquearia al propio backend. Esto es un riesgo real: cualquiera
-- con esa clave publica podria leer los password_hash de esta tabla. Vale la
-- pena migrar a la clave secreta de Supabase para esta tabla en particular
-- antes de que esto salga de la fase de pruebas.
