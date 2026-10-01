-- Migración v6: Historial de ticket (comentarios + eventos
-- automáticos: creación, cambios de estado, informe técnico). Pega
-- esto en Supabase > SQL Editor > New query > Run.

create table if not exists ticket_eventos (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,

  -- Quién lo hizo. Puede quedar en null (ej. si todavía no se eligió
  -- "comentando como" la primera vez) — se muestra "—" en ese caso.
  autor text check (autor is null or autor in (
    'Víctor A.', 'Mario L.', 'Samy B.', 'Bruce M.', 'Pierre B.', 'Jhon R.', 'Hermes R.'
  )),

  -- Puede faltar si el evento es solo fotos.
  texto text,
  -- URLs públicas de fotos (mismo bucket "fotos-tickets" que ya usan
  -- los tickets).
  fotos text[] not null default '{}',

  creado timestamptz not null default now()
);

create index if not exists ticket_eventos_ticket_id_idx on ticket_eventos(ticket_id);

alter table ticket_eventos enable row level security;

create policy "logueados pueden leer eventos" on ticket_eventos
  for select to authenticated using (true);

create policy "logueados pueden crear eventos" on ticket_eventos
  for insert to authenticated with check (true);

-- Sin policies de update/delete a propósito: es un registro de
-- solo-agregar (historial/auditoría), no se edita ni se borra desde
-- la web.
