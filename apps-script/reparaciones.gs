// ============================================================
// Apps Script de REPARACIÓN (dashboard Catapu)
// ------------------------------------------------------------
// Va en el proyecto de Apps Script ligado a la spreadsheet
// "EQUIPOS REPARADOS" (Extensiones > Apps Script desde esa hoja).
// Este archivo es una copia de respaldo: si lo cambias aquí, pégalo
// en el proyecto y publica una "Nueva versión" de la implementación
// (la URL /exec no cambia).
//
// Acepta &callback=nombre (JSONP). Su URL va en reparacion.js.
// ============================================================

const HOJA_REPARACIONES = "REPARADOS";

function doGet(e) {
  const params = (e && e.parameter) || {};
  let resultado;

  try {
    resultado = obtenerReparaciones();
  } catch (err) {
    // El front muestra este mensaje en pantalla en vez de quedarse cargando.
    resultado = { error: String(err.message || err) };
  }

  return responder(JSON.stringify(resultado), params.callback);
}

// Responde JSONP si piden callback; si no, JSON normal.
// Solo aceptamos nombres de función "seguros" para que nadie pueda
// inyectar código arbitrario a través del parámetro callback.
function responder(jsonTexto, callback) {
  if (callback && /^[A-Za-z_$][\w$.]*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + "(" + jsonTexto + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(jsonTexto)
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// Reparación
// ------------------------------------------------------------
// Devuelve solo las columnas que usa el panel, con nombres simples y
// la fecha ya convertida a "AAAA-MM-DD". Así el front no tiene que
// adivinar formatos ni zonas horarias, y la respuesta pesa mucho menos.
function obtenerReparaciones() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(HOJA_REPARACIONES);
  if (!hoja) throw new Error('No existe la hoja "' + HOJA_REPARACIONES + '".');

  const datos = hoja.getDataRange().getValues();
  const zona = ss.getSpreadsheetTimeZone();
  const cabecera = datos[0].map(normalizarCabecera);

  const columnas = {
    modelo: "MODELO",
    imei: "IMEI",
    falla: "FALLA",
    cliente: "CLIENTE",
    fecha: "FECHA DE REPARACION",
    repuesto: "REPUESTO",
    observaciones: "OBSERVACIONES",
    tecnico: "TECNICO",
    chequeo: "CHEQUEO",
  };

  const indice = {};
  const faltantes = [];
  Object.keys(columnas).forEach(campo => {
    indice[campo] = cabecera.indexOf(columnas[campo]);
    if (indice[campo] === -1) faltantes.push(columnas[campo]);
  });
  if (faltantes.length) {
    throw new Error("Faltan columnas en la hoja: " + faltantes.join(", "));
  }

  const filas = [];
  datos.slice(1).forEach(fila => {
    const registro = {
      modelo: texto(fila[indice.modelo]),
      imei: texto(fila[indice.imei]),
      falla: texto(fila[indice.falla]),
      cliente: texto(fila[indice.cliente]),
      fecha: fechaAISO(fila[indice.fecha], zona),
      repuesto: texto(fila[indice.repuesto]),
      observaciones: texto(fila[indice.observaciones]),
      tecnico: texto(fila[indice.tecnico]),
      chequeo: texto(fila[indice.chequeo]),
    };
    // Saltamos filas totalmente vacías.
    if (registro.modelo || registro.imei || registro.falla || registro.fecha) {
      filas.push(registro);
    }
  });
  return filas;
}

function normalizarCabecera(valor) {
  return String(valor)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // "REPARACIÓN" -> "REPARACION"
}

function texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor).trim();
}

// La hoja puede traer fechas reales o texto "d/m/aaaa" (ej. 4/6/2021 =
// 4 de junio). Devolvemos siempre "AAAA-MM-DD", o "" si no se entiende.
function fechaAISO(valor, zona) {
  if (valor instanceof Date && !isNaN(valor)) {
    return Utilities.formatDate(valor, zona, "yyyy-MM-dd");
  }
  const m = String(valor).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
}
