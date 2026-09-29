-- Migración: protege todo con cuentas individuales (Supabase Auth).
-- Dos cosas:
--   1) Las políticas de "tickets" y del bucket de fotos pasan de
--      "anon" (cualquiera) a "authenticated" (solo quien inició sesión).
--   2) Se crea "config_privada", una tabla de una sola fila con la
--      clave secreta que necesitan los 4 Apps Script (Producción,
--      Reparación, Garantías, Correos) para aceptar pedidos — solo
--      legible por alguien ya logueado.
--
-- Pégalo en Supabase > SQL Editor > New query > Run.

-- ------------------------------------------------------------
-- 1) Tickets: de "anon" a "authenticated"
-- ------------------------------------------------------------
drop policy if exists "anon puede leer tickets" on tickets;
drop policy if exists "anon puede crear tickets" on tickets;
drop policy if exists "anon puede actualizar tickets" on tickets;

create policy "logueados pueden leer tickets" on tickets
  for select to authenticated using (true);

create policy "logueados pueden crear tickets" on tickets
  for insert to authenticated with check (true);

create policy "logueados pueden actualizar tickets" on tickets
  for update to authenticated using (true) with check (true);

drop policy if exists "anon puede subir fotos de tickets" on storage.objects;
drop policy if exists "cualquiera puede ver fotos de tickets" on storage.objects;

create policy "logueados pueden subir fotos de tickets" on storage.objects
  for insert to authenticated with check (bucket_id = 'fotos-tickets');

create policy "logueados pueden ver fotos de tickets" on storage.objects
  for select to authenticated using (bucket_id = 'fotos-tickets');

-- ------------------------------------------------------------
-- 2) Clave compartida para los Apps Script (Producción, Reparación,
--    Garantías, Correos) — cada uno la valida en su doGet().
-- ------------------------------------------------------------
create table if not exists config_privada (
  clave text primary key,
  valor text not null
);

alter table config_privada enable row level security;

create policy "logueados pueden leer config" on config_privada
  for select to authenticated using (true);
-- Sin políticas de insert/update/delete a propósito: esta tabla se
-- administra a mano desde el SQL Editor (con tu sesión de dueño del
-- proyecto, que no pasa por RLS), nunca desde la web.

insert into config_privada (clave, valor)
values ('apps_script_secreto', '1a34603787027703104f80f48fb8bc35d1c3a5a529c88beb')
on conflict (clave) do nothing;
