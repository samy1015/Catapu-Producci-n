// ============================================================
// Informe Técnico (dashboard Catapu) — SEGUNDO archivo del MISMO
// proyecto Apps Script que orden-ingreso.gs (no es un proyecto nuevo:
// agregar con el botón "+" junto a "Archivos" en el editor, dentro del
// proyecto ya creado en pruebacatapu10@gmail.com).
// ------------------------------------------------------------
// El doGet (en orden-ingreso.gs) llama a las funciones de acá cuando
// la petición trae ?tipo=informe. Reutiliza de ese archivo:
// verificarClave, responder, responderError, obtenerTicket,
// escaparHtml, formatearFechaLarga, TIENDAS_NOMBRE_LARGO — todas
// disponibles sin import porque los .gs de un mismo proyecto
// comparten namespace global.
//
// No necesita Script Properties propias: usa las mismas
// (SUPABASE_URL, SUPABASE_SERVICE_KEY, CORREO_RESPALDO) ya
// configuradas para la Orden de Ingreso.
// ============================================================

function enviarCorreoInforme(ticket) {
  const props = PropertiesService.getScriptProperties();
  const copia = props.getProperty("CORREO_RESPALDO");
  const destinatarios = [ticket.correo, copia].filter(Boolean).join(",");
  if (!destinatarios) {
    throw new Error("El ticket no tiene correo de cliente ni hay un correo de respaldo configurado.");
  }

  const pdf = generarPdfInforme(ticket);
  pdf.setName(`Informe-Tecnico-T-${ticket.numero}.pdf`);

  GmailApp.sendEmail(
    destinatarios,
    `Informe Técnico — Ticket T-${ticket.numero}`,
    `Se adjunta el informe técnico del equipo (T-${ticket.numero}).`,
    {
      attachments: [pdf],
      name: "Catapu Servicio Técnico",
    }
  );
}

function generarPdfInforme(ticket) {
  const html = plantillaInformeHtml(ticket);
  const blob = Utilities.newBlob(html, "text/html", "informe.html");
  return blob.getAs(MimeType.PDF);
}

function plantillaInformeHtml(t) {
  const nombreCompleto = [t.nombres, t.apellidos].filter(Boolean).join(" ") || "—";

  const fotosHtml = (t.fotos && t.fotos.length)
    ? t.fotos.map((url) => `<img src="${escaparHtml(url)}" style="width:170px;height:170px;object-fit:cover;border-radius:4px;margin:0 10px 10px 0;" />`).join("")
    : "";

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: Arial, sans-serif; color:#1b1f24; font-size:12px;">

        <!-- Página 1: datos + informe -->
        <div style="background:#eaf0fb;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:20px;font-weight:bold;">Informe Técnico</div>
          <div style="font-size:11px;color:#55606c;">${escaparHtml(formatearFechaLarga(new Date().toISOString()))}</div>
        </div>

        <div style="font-weight:bold;margin-top:16px;">Datos del Cliente</div>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;border-bottom:1px solid #d9dee3;padding-bottom:8px;">
          <tr>
            <td style="padding:4px 0;width:40%;"><b>Nombres Completos:</b><br/>${escaparHtml(nombreCompleto)}</td>
            <td style="padding:4px 0;width:30%;"><b>Documento de Identidad:</b><br/>${escaparHtml(t.documento || "—")}</td>
            <td style="padding:4px 0;width:30%;"><b>Correo Electrónico:</b><br/>${escaparHtml(t.correo || "—")}</td>
          </tr>
        </table>

        <div style="font-weight:bold;margin-top:16px;">Datos del Equipo</div>
        <table style="width:100%;border-collapse:collapse;margin-top:6px;border-bottom:1px solid #d9dee3;padding-bottom:8px;">
          <tr>
            <td style="padding:4px 0;width:40%;"><b>Marca, Modelo, etc:</b><br/>${escaparHtml(t.modelo || "—")}</td>
            <td style="padding:4px 0;width:30%;"><b>IMEI / Código de Serie:</b><br/>${escaparHtml(t.imei || "—")}</td>
            <td style="padding:4px 0;width:30%;"><b>Numero de Ticket:</b><br/>T-${escaparHtml(String(t.numero))}</td>
          </tr>
        </table>

        <div style="font-weight:bold;margin-top:16px;">Informe Técnico</div>
        <div style="margin-top:8px;">
          <b>Descripción de Fallas / Problemas mencionado por el cliente:</b><br/>
          ${escaparHtml(t.falla || "—")}
        </div>
        <div style="margin-top:12px;">
          <b>Diagnóstico Técnico:</b><br/>
          ${escaparHtml(t.informe_diagnostico || "—")}
        </div>
        <div style="margin-top:12px;">
          <b>Observaciones:</b><br/>
          ${escaparHtml(t.informe_observaciones || "—")}
        </div>
        <div style="margin-top:12px;">
          <b>Estado del caso:</b><br/>
          <div style="background:#eef1f5;padding:4px 8px;border-radius:3px;display:inline-block;margin-top:4px;">${escaparHtml(t.informe_conclusion || "—")}</div>
        </div>
        <div style="margin-top:12px;">
          <b>Técnico Asignado:</b><br/>
          <div style="background:#eef1f5;padding:4px 8px;border-radius:3px;display:inline-block;margin-top:4px;">${escaparHtml(t.tecnico || "—")}</div>
        </div>

        ${fotosHtml ? `
          <!-- Página 2: registro fotográfico -->
          <div style="page-break-before: always;"></div>
          <div style="font-weight:bold;margin-top:16px;">Registro Fotográfico final:</div>
          <div style="margin-top:8px;">${fotosHtml}</div>
        ` : ""}

        <!-- Página 3: párrafo de cierre (texto fijo) -->
        <div style="page-break-before: always;"></div>
        <div style="margin-top:16px;">
          <p>Estimado cliente,</p>
          <p>
            En caso se indique en conclusión de reparación "Equipo en garantía procede para cambio o devolución",
            deberá responder a este correo electrónico indicando su elección.
          </p>
          <p>
            En los demás casos su equipo se encuentra listo para recojo. Puede pasar a recoger su equipo a partir
            del día siguiente hábil de recibido este correo electrónico.
          </p>
          <p>
            En caso el titular de la orden no pueda realizar el recojo del equipo personalmente, deberá ingresar al
            siguiente enlace y completar el formulario de autorización de terceros:
            <!-- TODO: agregar el link real del Formulario de Autorización de terceros cuando lo tengamos. -->
            Formulario de Autorización
          </p>
          <p>Luego de transcurrido 1 día hábil, el tercero autorizado podrá acercarse para realizar el trámite.</p>
          <p>Si tiene alguna duda respecto al proceso, puede comunicarse con nosotros a través de los siguientes canales:</p>
          <p>
            <b>Correo electrónico:</b> serviciotecnico@catapu.com<br/>
            <b>WhatsApp de Soporte Técnico:</b> 985 356 905
          </p>
          <p><b>Catapu - Servicio Técnico</b></p>
        </div>
      </body>
    </html>`;
}
