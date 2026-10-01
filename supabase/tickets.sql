-- Tabla de tickets (Garantía y Servicio técnico) — Catapu
-- Para un proyecto NUEVO: pega este archivo entero en Supabase >
-- SQL Editor > New query > Run.
-- Si ya tenías la tabla creada de antes, usa las migraciones
-- tickets_migracion_v2/v3/v4.sql en vez de este (este CREATE TABLE no
-- toca nada si la tabla ya existe).

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
  estado text not null default 'Ingresado' check (estado in (
    'Ingresado', 'En diagnóstico', 'Presupuesto enviado', 'Aprobado por el cliente',
    'En reparación', 'Reparado', 'No presentó fallas', 'Entregado',
    'No reparado/Irreparable', 'Garantía anulada', 'Presupuesto no aprobado',
    'Cambio de equipo o reembolso', 'Cambio de equipo', 'Reembolso'
  )),
  -- Se llena sola (tickets.js) la primera vez que el estado pasa a
  -- "Entregado"; nunca se borra aunque el estado cambie después.
  entregado_en timestamptz,
  -- Activa/desactiva el aviso por correo al cliente. Todavía no
  -- dispara ningún correo real, solo se guarda para más adelante.
  alerta_correo boolean not null default true,

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

  -- Informe Técnico: se redacta una sola vez desde el detalle del
  -- ticket. Mientras "informe_generado_en" sea null, el panel muestra
  -- el formulario de redacción; una vez tiene fecha, muestra el
  -- reporte de solo lectura.
  informe_diagnostico text,
  informe_observaciones text,
  informe_conclusion text,
  informe_generado_en timestamptz,

  notas text,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

alter table tickets enable row level security;

-- Solo cuentas logueadas (Supabase Auth — ver auth.js): el dashboard
-- entero vive detrás de un login, así que aquí no hace falta permitir
-- "anon". Las cuentas se crean a mano desde Authentication > Users.
create policy "logueados pueden leer tickets" on tickets
  for select to authenticated using (true);

create policy "logueados pueden crear tickets" on tickets
  for insert to authenticated with check (true);

create policy "logueados pueden actualizar tickets" on tickets
  for update to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Almacenamiento de fotos del equipo
-- ------------------------------------------------------------
-- OJO: el bucket es público (public=true), lo que en Supabase hace que
-- la URL directa de un archivo (getPublicUrl) se pueda leer SIN pasar
-- por RLS ni login — la política de "select" de abajo solo aplica a
-- la API autenticada, no a esa URL directa. Las URLs no son adivinables
-- (incluyen el UUID del ticket), pero no son privadas de verdad. Si en
-- algún momento hace falta que sí lo sean, hay que volver el bucket
-- privado y servir las fotos con createSignedUrl() en vez de la URL
-- pública guardada en "fotos".
insert into storage.buckets (id, name, public)
values ('fotos-tickets', 'fotos-tickets', true)
on conflict (id) do nothing;

create policy "logueados pueden subir fotos de tickets" on storage.objects
  for insert to authenticated with check (bucket_id = 'fotos-tickets');

create policy "logueados pueden ver fotos de tickets" on storage.objects
  for select to authenticated using (bucket_id = 'fotos-tickets');

-- ------------------------------------------------------------
-- Clave compartida para los Apps Script de solo lectura (Producción,
-- Reparación, Garantías, Correos) — no usan Supabase, así que cada uno
-- valida esta misma clave en su doGet() antes de responder cualquier
-- cosa. Solo un usuario logueado puede leerla.
-- ------------------------------------------------------------
create table if not exists config_privada (
  clave text primary key,
  valor text not null
);

alter table config_privada enable row level security;

create policy "logueados pueden leer config" on config_privada
  for select to authenticated using (true);
-- Sin políticas de insert/update/delete a propósito: se administra a
-- mano desde el SQL Editor (con tu sesión de dueño, que no pasa por
-- RLS), nunca desde la web. Reemplaza el valor por uno propio:
insert into config_privada (clave, valor)
values ('apps_script_secreto', 'CAMBIA_ESTO_POR_UN_TEXTO_LARGO_Y_ALEATORIO')
on conflict (clave) do nothing;
