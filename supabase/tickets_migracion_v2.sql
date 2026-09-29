-- Migración: actualiza la tabla "tickets" que ya creaste para que
-- tenga todos los campos del formulario real de "Recepción de Equipos
-- CATAPU" (razón de ingreso con 3 opciones, contraseña, fecha de
-- compra, comprobante, accesorios, prueba del equipo, fecha estimada
-- de entrega, técnico y fotos). NO borra los tickets que ya tengas.
--
-- Pégalo en Supabase > SQL Editor > New query > Run. Se puede correr
-- más de una vez sin problema (todo es "si no existe / reemplaza").

-- "tipo" ahora tiene 3 razones posibles en vez de 2.
alter table tickets drop constraint if exists tickets_tipo_check;
alter table tickets add constraint tickets_tipo_check
  check (tipo in ('Servicio técnico', 'Garantía - Equipo CATAPU', 'Garantía - Repuestos / Reparación'));

alter table tickets add column if not exists contrasena text;
alter table tickets add column if not exists fecha_compra date;
alter table tickets add column if not exists comprobante text;
alter table tickets add column if not exists accesorios text[] not null default '{}';

alter table tickets drop constraint if exists tickets_probado_check;
alter table tickets add column if not exists probado text;
alter table tickets add constraint tickets_probado_check
  check (probado is null or probado in ('Pudo ser probado', 'No pudo ser probado'));

alter table tickets add column if not exists fecha_entrega_estimada date;

alter table tickets drop constraint if exists tickets_tecnico_check;
alter table tickets add column if not exists tecnico text;
alter table tickets add constraint tickets_tecnico_check
  check (tecnico is null or tecnico in ('Víctor A.', 'Mario L.', 'Samy B.', 'Bruce M.', 'Pierre B.', 'Jhon R.', 'Hermes R.'));

alter table tickets add column if not exists fotos text[] not null default '{}';

-- Almacenamiento de fotos del equipo (bucket público + permisos)
insert into storage.buckets (id, name, public)
values ('fotos-tickets', 'fotos-tickets', true)
on conflict (id) do nothing;

drop policy if exists "anon puede subir fotos de tickets" on storage.objects;
create policy "anon puede subir fotos de tickets" on storage.objects
  for insert to anon with check (bucket_id = 'fotos-tickets');

drop policy if exists "cualquiera puede ver fotos de tickets" on storage.objects;
create policy "cualquiera puede ver fotos de tickets" on storage.objects
  for select to anon using (bucket_id = 'fotos-tickets');
