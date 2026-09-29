-- Migración: separa el nombre del cliente en dos columnas
-- ("nombres" y "apellidos") en vez de un solo campo "nombre".
-- Si ya tenías tickets guardados con "nombre" completo, ese texto se
-- copia entero a "nombres" (no se pierde, pero no se separa solo en
-- nombre/apellido — corrígelo a mano si hace falta).
--
-- Pégalo en Supabase > SQL Editor > New query > Run.

alter table tickets add column if not exists nombres text;
alter table tickets add column if not exists apellidos text;

update tickets set nombres = nombre where nombres is null and nombre is not null;

alter table tickets drop column if exists nombre;
