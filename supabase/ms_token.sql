-- Guarda el último refresh token de Microsoft (OneDrive personal) que usa
-- la Edge Function "produccion". Solo la función (service role) lo lee y
-- escribe: RLS activado y SIN políticas = nadie más puede verlo.
create table if not exists public.ms_token (
  id int primary key,
  refresh_token text not null,
  actualizado timestamptz not null default now()
);
alter table public.ms_token enable row level security;
