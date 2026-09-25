// ============================================================
// Apps Script de CORREOS / JOTFORM (dashboard Catapu)
// ------------------------------------------------------------
// Proyecto NUEVO e INDEPENDIENTE, creado DESDE ADENTRO de la cuenta
// catapu.serviciotecnico@gmail.com (Apps Script solo puede leer el
// Gmail de la cuenta que lo ejecuta — por eso no puede ir en la misma
// cuenta que produccion.gs/reparaciones.gs/garantias.gs).
//
// Qué hace: dado un IMEI, busca en Gmail los correos que JotForm envía
// por cada ticket de ese equipo — "Recepción de Equipos CATAPU"
// (la falla que reportó el cliente al ingresar) e "Informe Técnico
// CATAPU" (diagnóstico, conclusión y técnico asignado) — y arma el
// historial completo del equipo, incluyendo cuántos clientes distintos
// han pasado por él.
//
// SOLO LECTURA: nunca modifica, archiva, marca ni borra ningún correo.
//
// Parámetro del doGet: imei=XXXXXXXXXXXXXXX (obligatorio, ≥6 dígitos),
// &callback=nombre (JSONP).
// ============================================================

// El remitente real de TODOS los correos de JotForm (el nombre que se
// ve, "Reparado", "Garantía - Equipo CATAPU", etc., lo arma JotForm por
// notificación y varía; la dirección real siempre es esta).
const REMITENTE_JOTFORM = "noreply@formresponse.com";
const ZONA_HORARIA = "America/Lima";
const MIN_DIGITOS_IMEI = 6;
const MAX_HILOS = 50; // tope de seguridad; un equipo real no debería superar esto

function doGet(e) {
  const params = (e && e.parameter) || {};
  let json;

  try {
    // Solo dígitos: evita que alguien meta operadores de búsqueda de
    // Gmail (ej. "OR", "has:attachment") a través de este parámetro.
    const imei = String(params.imei || "").replace(/\D/g, "");
    if (imei.length < MIN_DIGITOS_IMEI) {
      throw new Error("Escribe un IMEI de al menos " + MIN_DIGITOS_IMEI + " dígitos.");
    }
    json = JSON.stringify(obtenerHistorialImei(imei));
  } catch (err) {
    json = JSON.stringify({ error: String(err.message || err) });
  }

  return responder(json, params.callback);
}

function responder(json, callback) {
  if (callback && /^[A-Za-z_$][\w$.]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + "(" + json + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// Historial de un IMEI
// ------------------------------------------------------------
function obtenerHistorialImei(imei) {
  const inicio = Date.now();

  // Gmail busca por su propio índice (no es una lectura línea por
  // línea), así que esto es rápido sin importar cuántos correos tenga
  // la bandeja. El propio usuario ya probó a mano que buscar el IMEI
  // tal cual encuentra justo los correos de ese equipo.
  const hilos = GmailApp.search(`from:${REMITENTE_JOTFORM} ${imei}`, 0, MAX_HILOS);

  const recepciones = [];
  const informes = [];

  hilos.forEach(hilo => {
    hilo.getMessages().forEach(mensaje => {
      const html = mensaje.getBody();
      const tipo = tipoDeCorreo(html);
      if (!tipo) return; // "Constancia de Entrega" u otro correo que no nos interesa

      const campos = extraerCamposJotform(html);

      // Nos aseguramos de que el IMEI de ESTE correo sea el pedido y no
      // otro número que Gmail haya emparejado por casualidad en otro campo.
      const imeiDelCorreo = (campos["imei / código de serie"] || "").replace(/\D/g, "");
      if (imeiDelCorreo !== imei) return;

      const ticket = campos["numero de ticket"] || "";
      const fecha = Utilities.formatDate(mensaje.getDate(), ZONA_HORARIA, "yyyy-MM-dd");

      if (tipo === "recepcion") {
        recepciones.push({
          ticket: ticket,
          fecha: fecha,
          nombre: campos["nombre"] || "",
          correo: campos["correo electrónico"] || "",
          sede: campos["sede de ingreso"] || "",
          falla: campos["descripción de fallas / problemas mencionado por el cliente"] || "",
        });
      } else {
        informes.push({
          ticket: ticket,
          fecha: fecha,
          tecnico: campos["técnico asignado"] || "",
          diagnostico: campos["diagnostico técnico y conclusión"] || "",
          conclusion: campos["conclusión del caso/ticket"] || "",
        });
      }
    });
  });

  // Un mismo ticket trae su Recepción y su Informe Técnico en dos
  // correos separados; se juntan aquí en un solo evento por ticket.
  const eventosPorTicket = new Map();
  recepciones.forEach(r => {
    eventosPorTicket.set(r.ticket, Object.assign({}, eventosPorTicket.get(r.ticket), r));
  });
  informes.forEach(i => {
    eventosPorTicket.set(i.ticket, Object.assign({}, eventosPorTicket.get(i.ticket), i));
  });
  const eventos = [...eventosPorTicket.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  // "Cuántos clientes distintos pasaron por este equipo": se cuenta por
  // correo (más confiable que el nombre); si un correo no tiene, se usa
  // el nombre como respaldo para no perder ese caso.
  const clientesVistos = new Map(); // clave (correo o nombre) -> {nombre, correo}
  recepciones.forEach(r => {
    const clave = (r.correo || r.nombre || "").toLowerCase().trim();
    if (clave) clientesVistos.set(clave, { nombre: r.nombre, correo: r.correo });
  });

  return {
    imei: imei,
    clientesDistintos: clientesVistos.size,
    clientes: [...clientesVistos.values()],
    eventos: eventos,
    generado: new Date().toISOString(),
    ms: Date.now() - inicio,
  };
}

function tipoDeCorreo(html) {
  if (html.indexOf("Recepción de Equipos CATAPU") !== -1) return "recepcion";
  if (html.indexOf("Informe Técnico CATAPU") !== -1) return "informe";
  return null; // "Constancia de Entrega" u otro tipo de correo, se ignora
}

// ------------------------------------------------------------
// Lector de las tablas de JotForm
// ------------------------------------------------------------
// Cada correo trae una tabla con filas <tr class="questionRow"> de dos
// celdas: la etiqueta (questionColumn) y el valor (valueColumn). Esto
// arma un diccionario { etiqueta normalizada: valor en texto plano }.
function extraerCamposJotform(html) {
  const campos = {};
  const filas = html.match(/<tr[^>]*class="questionRow"[^>]*>[\s\S]*?<\/tr>/g) || [];

  filas.forEach(fila => {
    const celdas = [...fila.matchAll(/<td[^>]*class="(?:questionColumn|valueColumn)"[^>]*>([\s\S]*?)<\/td>/g)];
    if (celdas.length < 2) return;

    const etiqueta = normalizarEtiqueta(limpiarHtml(celdas[0][1]));
    const valor = limpiarHtml(celdas[1][1]);
    if (etiqueta) campos[etiqueta] = valor;
  });

  return campos;
}

// Pasa un fragmento de celda a texto plano legible: los <br> se
// convierten en salto de línea (para no perder los párrafos del
// diagnóstico técnico), el resto de etiquetas se quita.
function limpiarHtml(fragmento) {
  return fragmento
    // El HTML de origen trae sus propios saltos de línea "\r\n" solo
    // por formato/indentación (no deberían verse); se normalizan ANTES
    // de convertir <br> a "\n", si no, cada <br> real deja también el
    // salto de línea "de indentación" pegado al lado.
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>\n?/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Las etiquetas a veces traen ":" al final y a veces no (JotForm no es
// consistente entre formularios) — se normaliza quitando ese ":" y
// pasando a minúsculas, para poder buscarlas siempre igual.
function normalizarEtiqueta(etiqueta) {
  return etiqueta.replace(/[:\s]+$/, "").trim().toLowerCase();
}
