// ============================================================
// Apps Script de ORDEN DE INGRESO (dashboard Catapu)
// ------------------------------------------------------------
// Proyecto NUEVO e INDEPENDIENTE, creado DESDE ADENTRO de la cuenta
// pruebacatapu10@gmail.com (así el correo sale de esa dirección, y
// GmailApp solo puede mandar correos de la cuenta que lo ejecuta).
//
// Qué hace: dado el id de un ticket, lo busca directo en Supabase (sin
// pasar por el navegador) y arma un PDF — "Orden de Ingreso" o
// "Informe Técnico", según ?tipo=. Dos acciones por ?accion= (se
// combinan con ?tipo=):
//   enviar     -> genera el PDF y lo manda por correo al cliente +
//                 copia de respaldo interna. Responde JSON (JSONP).
//   descargar  -> genera el PDF y lo devuelve directo como archivo
//                 para descargar (no manda ningún correo).
// ?tipo=ingreso (o sin tipo) -> Orden de Ingreso (funciones de este
//   mismo archivo). ?tipo=informe -> Informe Técnico (funciones en
//   apps-script/informe-tecnico.gs, agregado como SEGUNDO archivo
//   dentro de este mismo proyecto — comparten namespace global, así
//   que el doGet de acá las puede llamar directo).
//
// Para no depender de que el navegador mande todos los datos del
// ticket por la URL (fotos, falla, accesorios...), este script lee el
// ticket directo de la API de Supabase usando la "service_role" key
// (se salta RLS a propósito — por diseño, nunca sale de acá, nunca va
// al frontend).
//
// Configuración necesaria en Configuración del proyecto > Propiedades
// de secuencia de comandos:
//   CLAVE_ACCESO          misma clave que guardaste en Supabase
//                         (tabla config_privada, clave
//                         "apps_script_secreto") — la que ya usan los
//                         otros Apps Script del dashboard.
//   SUPABASE_URL          https://xxxx.supabase.co (tu proyecto)
//   SUPABASE_SERVICE_KEY  la key "service_role" (Supabase > Project
//                         Settings > API). NUNCA la "anon" acá, y
//                         nunca pegar esta key en el frontend.
//   CORREO_RESPALDO       pruebacatapu10@gmail.com — copia interna de
//                         cada orden que se envía.
//
// Para redesplegar después de editar: Implementar > Administrar
// implementaciones > lápiz > Nueva versión > Implementar (la URL
// /exec no cambia). Esa URL va en tickets.js, const ORDEN_INGRESO_URL.
// ============================================================

const TIENDAS_NOMBRE_LARGO = {
  "Miraflores": "Expocentro, Miraflores",
  "Caminos del Inca": "Caminos del Inca, Surco",
  "Taller": "Laboratorio principal",
};

function doGet(e) {
  const params = (e && e.parameter) || {};

  if (!verificarClave(params.clave)) {
    return responderError("No autorizado.", params.callback);
  }

  const id = params.id;
  if (!id) {
    return responderError("Falta el id del ticket.", params.callback);
  }

  let ticket;
  try {
    ticket = obtenerTicket(id);
  } catch (err) {
    return responderError(String(err.message || err), params.callback);
  }
  if (!ticket) {
    return responderError("Ticket no encontrado.", params.callback);
  }

  // tipo=informe -> Informe Técnico (apps-script/informe-tecnico.gs,
  // mismo proyecto); sin tipo o tipo=ingreso -> Orden de Ingreso
  // (las funciones de más abajo, en este mismo archivo).
  const esInforme = params.tipo === "informe";

  if (params.accion === "descargar") {
    try {
      const pdf = esInforme ? generarPdfInforme(ticket) : generarPdf(ticket);
      pdf.setName(`${esInforme ? "Informe-Tecnico" : "Orden-Ingreso"}-T-${ticket.numero}.pdf`);
      return pdf; // Apps Script sirve un Blob devuelto desde doGet como descarga directa.
    } catch (err) {
      return responderError(String(err.message || err), params.callback);
    }
  }

  // accion === "enviar" (o sin accion, por si acaso)
  try {
    if (esInforme) {
      enviarCorreoInforme(ticket);
    } else {
      enviarCorreo(ticket);
    }
    return responder(JSON.stringify({ ok: true }), params.callback);
  } catch (err) {
    return responderError(String(err.message || err), params.callback);
  }
}

function verificarClave(clave) {
  const esperada = PropertiesService.getScriptProperties().getProperty("CLAVE_ACCESO");
  return !!esperada && clave === esperada;
}

function responder(json, callback) {
  if (callback && /^[A-Za-z_$][\w$.]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + "(" + json + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function responderError(mensaje, callback) {
  return responder(JSON.stringify({ error: mensaje }), callback);
}

// ------------------------------------------------------------
// Supabase: trae el ticket completo saltándose RLS (service role,
// server-to-server, nunca expuesta al navegador).
// ------------------------------------------------------------
function obtenerTicket(id) {
  const props = PropertiesService.getScriptProperties();
  const url = `${props.getProperty("SUPABASE_URL")}/rest/v1/tickets?id=eq.${encodeURIComponent(id)}&select=*`;
  const respuesta = UrlFetchApp.fetch(url, {
    headers: {
      apikey: props.getProperty("SUPABASE_SERVICE_KEY"),
      Authorization: `Bearer ${props.getProperty("SUPABASE_SERVICE_KEY")}`,
    },
    muteHttpExceptions: true,
  });
  if (respuesta.getResponseCode() !== 200) {
    throw new Error("Supabase respondió " + respuesta.getResponseCode() + ": " + respuesta.getContentText());
  }
  const filas = JSON.parse(respuesta.getContentText());
  return filas[0] || null;
}

// ------------------------------------------------------------
// Correo
// ------------------------------------------------------------
function enviarCorreo(ticket) {
  const props = PropertiesService.getScriptProperties();
  const copia = props.getProperty("CORREO_RESPALDO");
  const destinatarios = [ticket.correo, copia].filter(Boolean).join(",");
  if (!destinatarios) {
    throw new Error("El ticket no tiene correo de cliente ni hay un correo de respaldo configurado.");
  }

  const pdf = generarPdf(ticket);
  pdf.setName(`Orden-Ingreso-T-${ticket.numero}.pdf`);

  GmailApp.sendEmail(
    destinatarios,
    `Orden de Ingreso — Ticket T-${ticket.numero}`,
    `Se adjunta la orden de ingreso del equipo (T-${ticket.numero}).`,
    {
      attachments: [pdf],
      name: "Catapu Servicio Técnico",
    }
  );
}

// ------------------------------------------------------------
// PDF: arma un HTML con el mismo diseño del formulario en papel y lo
// convierte. La conversión HTML->PDF de Apps Script soporta CSS
// inline, tablas y <img src="https://..."> remotas (las fotos ya son
// URLs públicas del bucket "fotos-tickets").
// ------------------------------------------------------------
function generarPdf(ticket) {
  const html = plantillaHtml(ticket);
  const blob = Utilities.newBlob(html, "text/html", "orden.html");
  return blob.getAs(MimeType.PDF);
}

function plantillaHtml(t) {
  const sede = TIENDAS_NOMBRE_LARGO[t.tienda] || t.tienda || "—";
  const nombreCompleto = [t.nombres, t.apellidos].filter(Boolean).join(" ") || "—";
  const accesorios = (t.accesorios && t.accesorios.length) ? t.accesorios.join(", ") : "Ninguno";
  const fotosHtml = (t.fotos && t.fotos.length)
    ? t.fotos.map((url) => `<img src="${escaparHtml(url)}" style="width:170px;height:170px;object-fit:cover;border-radius:4px;margin:0 10px 10px 0;" />`).join("")
    : "";

  const bannerEntrega = t.fecha_entrega_estimada
    ? `<div style="text-align:center;padding:6px 0 12px;">
         <div style="font-size:12px;color:#c0392b;font-weight:bold;">Fecha Estimada de Entrega</div>
         <div style="font-size:14px;color:#c0392b;font-weight:bold;">${escaparHtml(t.fecha_entrega_estimada)}</div>
       </div>`
    : "";

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: Arial, sans-serif; color:#1b1f24; font-size:12px;">
        <div style="background:#eaf0fb;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:20px;font-weight:bold;">Recepción de equipos</div>
          <div style="font-size:11px;color:#55606c;">${escaparHtml(formatearFechaLarga(t.creado))}</div>
        </div>

        ${bannerEntrega}

        <table style="width:100%;border-collapse:collapse;margin-top:10px;">
          <tr>
            <td style="padding:8px 0;border-top:1px solid #d9dee3;border-bottom:1px solid #d9dee3;width:33%;">
              <div style="font-weight:bold;">Razón de ingreso:</div>
              <div style="background:#eef1f5;padding:4px 8px;border-radius:3px;display:inline-block;margin-top:4px;">${escaparHtml(t.tipo || "—")}</div>
            </td>
            <td style="padding:8px 0;border-top:1px solid #d9dee3;border-bottom:1px solid #d9dee3;width:34%;">
              <div style="font-weight:bold;">Sede de ingreso:</div>
              <div style="background:#eef1f5;padding:4px 8px;border-radius:3px;display:inline-block;margin-top:4px;">${escaparHtml(sede)}</div>
            </td>
            <td style="padding:8px 0;border-top:1px solid #d9dee3;border-bottom:1px solid #d9dee3;width:33%;">
              <div style="font-weight:bold;">Número de ticket:</div>
              <div style="margin-top:4px;">T-${escaparHtml(String(t.numero))}</div>
            </td>
          </tr>
        </table>

        <div style="font-weight:bold;margin-top:16px;">Datos del Cliente</div>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;">
          <tr>
            <td style="padding:4px 0;width:50%;"><b>Nombres Completos:</b><br/>${escaparHtml(nombreCompleto)}</td>
            <td style="padding:4px 0;width:50%;"><b>Documento de Identidad:</b><br/>${escaparHtml(t.documento || "—")}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;"><b>Correo Electrónico:</b><br/>${escaparHtml(t.correo || "—")}</td>
            <td style="padding:4px 0;"><b>Número de Teléfono:</b><br/>${escaparHtml(t.telefono || "—")}</td>
          </tr>
        </table>

        <div style="font-weight:bold;margin-top:16px;border-top:1px solid #d9dee3;padding-top:10px;">Datos del Equipo</div>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;">
          <tr>
            <td style="padding:4px 0;width:50%;vertical-align:top;">
              <b>Descripción de Fallas / Problemas mencionado por el cliente:</b><br/>${escaparHtml(t.falla || "—")}
            </td>
            <td style="padding:4px 0;width:50%;vertical-align:top;">
              <b>Marca, Modelo, etc:</b><br/>${escaparHtml(t.modelo || "—")}<br/><br/>
              <b>IMEI / Código de Serie:</b><br/>${escaparHtml(t.imei || "—")}
            </td>
          </tr>
          <tr>
            <td style="padding:4px 0;vertical-align:top;">
              <b>Accesorios recibidos con el equipo:</b><br/>${escaparHtml(accesorios)}
            </td>
            <td style="padding:4px 0;vertical-align:top;">
              <b>¿Pudo ser probado el equipo?</b><br/>${escaparHtml(t.probado || "—")}
            </td>
          </tr>
          <tr>
            <td style="padding:4px 0;vertical-align:top;">
              <b>Contraseña (si posee):</b><br/>${escaparHtml(t.contrasena || "—")}
            </td>
            <td style="padding:4px 0;vertical-align:top;">
              <b>Responsable del registro:</b><br/>${escaparHtml(t.tecnico || "—")}
            </td>
          </tr>
        </table>

        ${fotosHtml ? `
          <div style="font-weight:bold;margin-top:16px;border-top:1px solid #d9dee3;padding-top:10px;">Registro fotográfico del estado inicial del dispositivo:</div>
          <div style="margin-top:8px;">${fotosHtml}</div>
        ` : ""}
      </body>
    </html>`;
}

function escaparHtml(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatearFechaLarga(iso) {
  if (!iso) return "";
  const fecha = new Date(iso);
  return Utilities.formatDate(fecha, "America/Lima", "d 'de' MMMM, yyyy");
}
