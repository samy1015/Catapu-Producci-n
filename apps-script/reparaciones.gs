// ============================================================
// Apps Script de REPARACIÓN (dashboard Catapu)
// ------------------------------------------------------------
// Va en el proyecto de Apps Script ligado a la spreadsheet
// "EQUIPOS REPARADOS" (Extensiones > Apps Script desde esa hoja).
// Es una copia de respaldo: si lo cambias aquí, pégalo en el proyecto
// y publica una "Nueva versión" de la implementación (la URL /exec no
// cambia). Su URL va en reparacion.js.
//
// Parámetros (todos opcionales, todos con &callback=nombre para JSONP):
//   desde=AAAA-MM-DD   solo reparaciones con fecha >= desde
//   hasta=AAAA-MM-DD   solo reparaciones con fecha <= hasta
//                      (con desde/hasta, las filas sin fecha se omiten)
//   fresco=1           relee la hoja y renueva la caché (botón
//                      "Actualizar" del panel)
//
// Igual que en Producción, la respuesta sale de una CACHÉ.
// ANTES DE USAR: ejecuta una vez `instalarActualizacionAutomatica`
// desde el editor. Crea un disparador que renueva la caché cada 10
// minutos, así el panel casi nunca espera a que se lea la hoja.
// ============================================================

const HOJA_REPARACIONES = "REPARADOS";

// Solo estas columnas viajan al panel. Nombre en la hoja -> nombre en
// la respuesta. El orden define el orden de cada fila enviada.
const COLUMNAS_PANEL = [
  ["FECHA DE REPARACION", "fecha"],
  ["TECNICO", "tecnico"],
  ["MODELO", "modelo"],
  ["FALLA", "falla"],
];

const CACHE_PREFIJO = "rep_v1"; // súbelo si cambias COLUMNAS_PANEL
const CACHE_TTL_SEG = 900;      // 15 min; el disparador la renueva cada 10
const CACHE_TAM_TROZO = 40000;  // cada valor de caché admite hasta 100 KB

function doGet(e) {
  const params = (e && e.parameter) || {};
  let json;

  try {
    json = obtenerReparacionesJson(
      fechaValida(params.desde),
      fechaValida(params.hasta),
      params.fresco === "1"
    );
  } catch (err) {
    // El panel muestra este mensaje en pantalla en vez de quedarse cargando.
    json = JSON.stringify({ error: String(err.message || err) });
  }

  return responder(json, params.callback);
}

// Responde JSONP si piden callback; si no, JSON normal.
// Solo aceptamos nombres de función "seguros" para que nadie pueda
// inyectar código arbitrario a través del parámetro callback.
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

// Acepta solo "AAAA-MM-DD"; cualquier otra cosa se ignora.
function fechaValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || "")) ? String(valor) : "";
}

// ------------------------------------------------------------
// Respuesta (caché + filtro por rango)
// ------------------------------------------------------------
function obtenerReparacionesJson(desde, hasta, forzar) {
  let json = forzar ? null : leerCache();
  if (!json) {
    json = construirResumenJson();
    guardarCache(json);
  }
  if (!desde && !hasta) return json;

  // La caché guarda TODO el historial; el rango se recorta aquí. Las
  // fechas "AAAA-MM-DD" se comparan como texto.
  const paquete = JSON.parse(json);
  const iFecha = paquete.columnas.indexOf("fecha");
  paquete.filas = paquete.filas.filter(fila => {
    const fecha = fila[iFecha];
    if (!fecha) return false;
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  });
  return JSON.stringify(paquete);
}

function construirResumenJson() {
  const inicio = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(HOJA_REPARACIONES);
  if (!hoja) throw new Error('No existe la hoja "' + HOJA_REPARACIONES + '".');

  const datos = hoja.getDataRange().getValues();
  const msLeer = Date.now() - inicio;
  const zona = ss.getSpreadsheetTimeZone();
  const cabecera = datos[0].map(normalizarCabecera);

  const indices = [];
  const faltantes = [];
  COLUMNAS_PANEL.forEach(par => {
    const i = cabecera.indexOf(par[0]);
    if (i === -1) faltantes.push(par[0]);
    indices.push(i);
  });
  if (faltantes.length) {
    throw new Error("Faltan columnas en la hoja: " + faltantes.join(", "));
  }
  const iFecha = COLUMNAS_PANEL.findIndex(par => par[1] === "fecha");

  const filas = [];
  for (let r = 1; r < datos.length; r++) {
    const fila = indices.map((col, j) =>
      j === iFecha ? fechaAISO(datos[r][col], zona) : texto(datos[r][col])
    );
    // Saltamos filas totalmente vacías.
    if (fila.some(celda => celda !== "")) filas.push(fila);
  }

  return JSON.stringify({
    columnas: COLUMNAS_PANEL.map(par => par[1]),
    filas: filas,
    generado: new Date().toISOString(),
    // Tiempos internos, para ver dónde se va el tiempo si vuelve a tardar.
    ms: { leer: msLeer, total: Date.now() - inicio },
  });
}

function normalizarCabecera(valor) {
  return String(valor)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // "REPARACIÓN" -> "REPARACION"
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

// ------------------------------------------------------------
// Caché (CacheService limita cada valor a 100 KB, así que partimos)
// ------------------------------------------------------------
function guardarCache(json) {
  const cache = CacheService.getScriptCache();
  const trozos = {};
  const cantidad = Math.ceil(json.length / CACHE_TAM_TROZO);
  for (let i = 0; i < cantidad; i++) {
    trozos[CACHE_PREFIJO + "_" + i] = json.substr(i * CACHE_TAM_TROZO, CACHE_TAM_TROZO);
  }
  trozos[CACHE_PREFIJO + "_n"] = String(cantidad);
  cache.putAll(trozos, CACHE_TTL_SEG);
}

// Devuelve el JSON guardado, o null si no hay caché o quedó incompleta.
function leerCache() {
  const cache = CacheService.getScriptCache();
  const cantidad = Number(cache.get(CACHE_PREFIJO + "_n"));
  if (!cantidad) return null;

  const claves = [];
  for (let i = 0; i < cantidad; i++) claves.push(CACHE_PREFIJO + "_" + i);
  const trozos = cache.getAll(claves);

  let json = "";
  for (let i = 0; i < claves.length; i++) {
    const trozo = trozos[claves[i]];
    if (trozo === undefined || trozo === null) return null;
    json += trozo;
  }
  return json;
}

// Es lo que ejecuta el disparador automático.
function refrescarCache() {
  guardarCache(construirResumenJson());
}

// Ejecútala UNA vez a mano desde el editor de Apps Script (pedirá
// permisos). Deja un único disparador que renueva la caché cada 10 min.
function instalarActualizacionAutomatica() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "refrescarCache") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("refrescarCache").timeBased().everyMinutes(10).create();
  refrescarCache(); // deja la primera caché lista ya mismo
}
