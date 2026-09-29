-- Tabla de tickets (Garantía y Servicio técnico) — Catapu
-- Para un proyecto NUEVO: pega este archivo entero en Supabase >
-- SQL Editor > New query > Run.
-- Si ya tenías la tabla creada de antes, usa tickets_migracion_v2.sql
-- en vez de este (este CREATE TABLE no toca nada si la tabla ya existe).

create extension if not exists pgcrypto; -- para gen_random_uuid()

create sequence if not exists tickets_numero_seq start with 1;

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  -- Número visible: se muestra como "T-0001" (se arma en el navegador
  -- con este entero, con padStart). Es una sequence de Postgres, así
  -- que dos altas al mismo tiempo nunca se pisan.
  numero integer not null default nextval('tickets_numero_seq'),

  -- "Razón de ingreso" del formulario real.
  tipo text not null check (
    tipo in ('Servicio técnico', 'Garantía - Equipo CATAPU', 'Garantía - Repuestos / Reparación')
  ),
  -- "Sede de ingreso". El valor guardado es el nombre corto que ya
  -- usan las demás vistas (Garantías); el formulario muestra el
  -- nombre largo del papel ("Expocentro, Miraflores", etc.) pero
  -- graba este.
  tienda text not null check (tienda in ('Caminos del Inca', 'Miraflores', 'Taller')),
  fecha date not null default current_date,
  estado text not null default 'Ingresado' check (
    estado in ('Ingresado', 'En diagnóstico', 'En reparación', 'Listo para entrega', 'Entregado', 'Cancelado')
  ),

  -- Datos del cliente
  nombres text,
  apellidos text,
  correo text,
  documento text,
  telefono text,

  -- Datos del equipo
  modelo text,
  imei text,
  contrasena text,
  fecha_compra date,
  comprobante text,
  falla text,
  accesorios text[] not null default '{}',
  probado text check (probado in ('Pudo ser probado', 'No pudo ser probado')),
  fecha_entrega_estimada date,
  tecnico text check (
    tecnico in ('Víctor A.', 'Mario L.', 'Samy B.', 'Bruce M.', 'Pierre B.', 'Jhon R.', 'Hermes R.')
  ),
  -- URLs públicas de las fotos ya subidas al bucket "fotos-tickets".
  fotos text[] not null default '{}',

  notas text,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

alter table tickets enable row level security;

-- Sin control de acceso por ahora (decisión del negocio): cualquiera
-- con la anon key (pública, va en el propio HTML del sitio) puede leer,
-- crear y actualizar tickets. El día que quieras restringirlo, estas
-- son las políticas a reemplazar por unas que exijan auth.uid().
create policy "anon puede leer tickets" on tickets
  for select to anon using (true);

create policy "anon puede crear tickets" on tickets
  for insert to anon with check (true);

create policy "anon puede actualizar tickets" on tickets
  for update to anon using (true) with check (true);

-- ------------------------------------------------------------
-- Almacenamiento de fotos del equipo
-- ------------------------------------------------------------
-- Bucket público: cualquiera con la URL de una foto puede verla (sin
-- necesidad de estar loggeado), igual de abierto que el resto del
-- sistema por ahora.
insert into storage.buckets (id, name, public)
values ('fotos-tickets', 'fotos-tickets', true)
on conflict (id) do nothing;

create policy "anon puede subir fotos de tickets" on storage.objects
  for insert to anon with check (bucket_id = 'fotos-tickets');

create policy "cualquiera puede ver fotos de tickets" on storage.objects
  for select to anon using (bucket_id = 'fotos-tickets');
