-- Migración v5: estados ampliados, hora de entrega, alerta de correo
-- (sin uso todavía) e Informe Técnico. Pega esto en Supabase > SQL
-- Editor > New query > Run (ya tenías la tabla de la v4).

-- Los 2 estados viejos que ya no existen en la lista nueva se
-- reasignan a su equivalente más cercano ANTES de agregar la
-- restricción de abajo: si algún ticket real quedó con "Listo para
-- entrega" o "Cancelado", la restricción nueva fallaría al chocar con
-- esos valores existentes.
update tickets set estado = 'Reparado' where estado = 'Listo para entrega';
update tickets set estado = 'No reparado/Irreparable' where estado = 'Cancelado';

alter table tickets drop constraint if exists tickets_estado_check;
alter table tickets add constraint tickets_estado_check check (estado in (
  'Ingresado', 'En diagnóstico', 'Presupuesto enviado', 'Aprobado por el cliente',
  'En reparación', 'Reparado', 'No presentó fallas', 'Entregado',
  'No reparado/Irreparable', 'Garantía anulada', 'Presupuesto no aprobado',
  'Cambio de equipo o reembolso', 'Cambio de equipo', 'Reembolso'
));

-- Se llena sola (desde tickets.js) la primera vez que el estado pasa a
-- "Entregado"; nunca se borra, aunque el estado cambie después.
alter table tickets add column if not exists entregado_en timestamptz;

-- Activa/desactiva el aviso por correo al cliente. Todavía no dispara
-- ningún correo real, solo se guarda para cuando se implemente.
alter table tickets add column if not exists alerta_correo boolean not null default true;

-- Informe Técnico: se redacta una sola vez desde el detalle del
-- ticket. Mientras "informe_generado_en" sea null, el panel muestra el
-- formulario de redacción; una vez tiene fecha, muestra el reporte de
-- solo lectura.
alter table tickets add column if not exists informe_diagnostico text;
alter table tickets add column if not exists informe_observaciones text;
alter table tickets add column if not exists informe_conclusion text;
alter table tickets add column if not exists informe_generado_en timestamptz;
