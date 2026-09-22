// ============================================================
// Apps Script de PRODUCCIÓN (dashboard Catapu)
// ------------------------------------------------------------
// Va en el proyecto de Apps Script ligado a la spreadsheet con la
// hoja TALLER1. Es una copia de respaldo: si lo cambias aquí, pégalo
// en el proyecto y publica una "Nueva versión" de la implementación
// (la URL /exec no cambia). Su URL es APPS_SCRIPT_URL en script.js.
//
// Rutas (todas aceptan &callback=nombre, JSONP):
//   (sin parámetros)  -> resumen liviano para el panel: solo las
//                        columnas que se usan, fechas como AAAA-MM-DD,
//                        filas como listas. Sale de una CACHÉ.
//   ?fresco=1         -> igual, pero relee la hoja y renueva la caché
//                        (botón "Actualizar" del panel).
//   ?imei=XXXX        -> filas completas cuyo IMEI o IMEI 2 contiene
//                        ese texto (máx. 20), para el buscador.
//
// ANTES DE USAR: ejecuta una vez `instalarActualizacionAutomatica`
// desde el editor. Crea un disparador que renueva la caché cada 10
// minutos, así el panel casi nunca espera a que se lea la hoja.
// ============================================================

const HOJA_TALLER = "TALLER1";
const MAX_RESULTADOS_IMEI = 20;

// Solo estas columnas viajan al panel (el detalle completo se pide
// aparte con ?imei=). El orden define el orden de cada fila enviada.
const COLUMNAS_PANEL = [
  "FECHA DE PULIDO",
  "PULIDO",
  "FECHA CAMBIO BATERIA",
  "BATERIA",
  "FECHA DE CHEQUEO",
  "CHEQUEO",
  "MODELO",
  "CAPACIDAD",
  "COLOR",
  "LOTE",
  "IMEI",
];
const COLUMNAS_CON_FECHA = ["FECHA DE PULIDO", "FECHA CAMBIO BATERIA", "FECHA DE CHEQUEO"];

const CACHE_PREFIJO = "prod_v3"; // súbelo si cambias COLUMNAS_PANEL, para no servir una caché con columnas viejas
// v3: se agregó IMEI, para que Garantías (apps-script/garantias.gs) pueda
// cruzar sus tickets de RepairDesk con el modelo/capacidad/color de aquí.
const CACHE_TTL_SEG = 1500; // 25 min; el disparador la renueva cada 10 — el margen extra
// evita que la caché quede fría si algún disparo del trigger se demora
// o falla (Garantías depende de este caché para cruzar por IMEI, así
// que un caché frío ahí también hace lenta la carga de Garantías).
const CACHE_TAM_TROZO = 40000; // cada valor de caché admite hasta 100 KB

function doGet(e) {
  const params = (e && e.parameter) || {};
  let json;

  try {
    if (params.imei) {
      json = JSON.stringify(buscarPorImei(params.imei));
    } else {
      json = obtenerResumenJson(params.fresco === "1");
    }
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

function obtenerHoja() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_TALLER);
  if (!hoja) throw new Error('No existe la hoja "' + HOJA_TALLER + '".');
  return hoja;
}

// ------------------------------------------------------------
// Resumen para el panel (con caché)
// ------------------------------------------------------------
function obtenerResumenJson(forzar) {
  if (!forzar) {
    const enCache = leerCache();
    if (enCache) return enCache;
  }
  const json = construirResumenJson();
  guardarCache(json);
  return json;
}

function construirResumenJson() {
  const inicio = Date.now();
  const hoja = obtenerHoja();
  const datos = hoja.getDataRange().getValues();
  const msLeer = Date.now() - inicio;

  const cabecera = datos[0].map(h => String(h).trim());
  const indices = COLUMNAS_PANEL.map(nombre => {
    const i = cabecera.indexOf(nombre);
    if (i === -1) throw new Error('Falta la columna "' + nombre + '" en ' + HOJA_TALLER + ".");
    return i;
  });
  const esFecha = COLUMNAS_PANEL.map(nombre => COLUMNAS_CON_FECHA.indexOf(nombre) !== -1);

  // Las fechas se repiten muchísimo (unos cientos de días distintos en
  // miles de filas), así que damos formato una sola vez por instante.
  const zona = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const memoria = {};
  const aTexto = valor => {
    if (!(valor instanceof Date) || isNaN(valor)) return "";
    const clave = valor.getTime();
    if (!(clave in memoria)) memoria[clave] = Utilities.formatDate(valor, zona, "yyyy-MM-dd");
    return memoria[clave];
  };

  const filas = [];
  for (let r = 1; r < datos.length; r++) {
    const fila = indices.map((col, j) => {
      const valor = datos[r][col];
      return esFecha[j] ? aTexto(valor) : (valor === null || valor === undefined ? "" : String(valor).trim());
    });
    // Saltamos filas totalmente vacías.
    if (fila.some(celda => celda !== "")) filas.push(fila);
  }

  return JSON.stringify({
    columnas: COLUMNAS_PANEL,
    filas: filas,
    generado: new Date().toISOString(),
    // Tiempos internos, para poder ver dónde se va el tiempo si vuelve a tardar.
    ms: { leer: msLeer, total: Date.now() - inicio },
  });
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

// ------------------------------------------------------------
// Búsqueda por IMEI (filas completas, sin caché)
// ------------------------------------------------------------
// Solo lee las dos columnas de IMEI para encontrar coincidencias y luego
// trae completas únicamente esas filas: mucho más liviano que leer toda
// la hoja.
function buscarPorImei(texto) {
  const buscado = String(texto).replace(/\s+/g, "");
  if (buscado.length < 4) return { total: 0, filas: [] };

  const hoja = obtenerHoja();
  const ultimaFila = hoja.getLastRow();
  const ultimaColumna = hoja.getLastColumn();
  if (ultimaFila < 2) return { total: 0, filas: [] };

  const cabecera = hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0].map(h => String(h).trim());
  const columnasImei = ["IMEI", "imei 2"]
    .map(nombre => cabecera.indexOf(nombre))
    .filter(i => i !== -1);

  const coincidencias = {}; // número de fila -> true
  columnasImei.forEach(col => {
    const valores = hoja.getRange(2, col + 1, ultimaFila - 1, 1).getValues();
    valores.forEach((celda, i) => {
      if (String(celda[0]).indexOf(buscado) !== -1) coincidencias[i + 2] = true;
    });
  });

  const numerosDeFila = Object.keys(coincidencias).map(Number).sort((a, b) => a - b);
  const filas = numerosDeFila.slice(0, MAX_RESULTADOS_IMEI).map(numero => {
    const valores = hoja.getRange(numero, 1, 1, ultimaColumna).getValues()[0];
    const objeto = {};
    cabecera.forEach((nombre, i) => (objeto[nombre] = valores[i]));
    return objeto;
  });

  return { total: numerosDeFila.length, filas: filas };
}
