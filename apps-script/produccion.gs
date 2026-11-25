// ============================================================
// Apps Script de PRODUCCIÓN (dashboard Catapu)
// ------------------------------------------------------------
// Va en el proyecto de Apps Script ligado al documento que tiene las
// pestañas "2026" (taller), "EQUI. POR TEC." y "REPARADOS". Es una
// copia de respaldo: si lo cambias aquí, pégalo
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
//   ?entregas=1       -> equipos por técnico (pestaña "EQUI. POR TEC.").
//                        Sin caché: se actualiza todo el día.
//   ?accion=registrarEntregas -> abre/cierra equipos escaneados desde el
//                        dashboard (y anota reparaciones en "REPARADOS").
//
// ANTES DE USAR: ejecuta una vez `instalarActualizacionAutomatica`
// desde el editor. Crea un disparador que renueva la caché cada 10
// minutos, así el panel casi nunca espera a que se lea la hoja.
// ============================================================

const HOJA_TALLER = "2026";
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
  "GRADO",
  "LOTE",
  "IMEI",
];
const COLUMNAS_CON_FECHA = ["FECHA DE PULIDO", "FECHA CAMBIO BATERIA", "FECHA DE CHEQUEO"];

const CACHE_PREFIJO = "prod_v4"; // súbelo si cambias COLUMNAS_PANEL, para no servir una caché con columnas viejas
// v3: se agregó IMEI, para que Garantías (apps-script/garantias.gs) pueda
// cruzar sus tickets de RepairDesk con el modelo/capacidad/color de aquí.
// v4: se agregó GRADO, para cruzar por IMEI con "Equipos por técnico"
// y mostrar modelo/capacidad/color/grado en esa lista.
const CACHE_TTL_SEG = 1500; // 25 min; el disparador la renueva cada 10 — el margen extra
// evita que la caché quede fría si algún disparo del trigger se demora
// o falla (Garantías depende de este caché para cruzar por IMEI, así
// que un caché frío ahí también hace lenta la carga de Garantías).
const CACHE_TAM_TROZO = 40000; // cada valor de caché admite hasta 100 KB

function doGet(e) {
  const params = (e && e.parameter) || {};

  if (!verificarClave(params.clave)) {
    return responder(JSON.stringify({ error: "No autorizado." }), params.callback);
  }

  let json;
  try {
    if (params.imei) {
      json = JSON.stringify(buscarPorImei(params.imei));
    } else if (params.entregas) {
      json = obtenerEntregasJson();
    } else if (params.accion === "registrarEntregas") {
      json = JSON.stringify(registrarEntregas(params));
    } else {
      json = obtenerResumenJson(params.fresco === "1");
    }
  } catch (err) {
    // El panel muestra este mensaje en pantalla en vez de quedarse cargando.
    json = JSON.stringify({ error: String(err.message || err) });
  }

  return responder(json, params.callback);
}

// Clave compartida (Supabase, tabla "config_privada") que solo se le
// entrega a un usuario ya logueado — ver auth.js del dashboard. Evita
// que alguien sin cuenta use esta URL directamente, aunque la
// encuentre en el código público de GitHub. Configúrala en
// Configuración del proyecto > Propiedades de secuencia de comandos >
// CLAVE_ACCESO, con el mismo valor que guardaste en Supabase.
function verificarClave(clave) {
  const esperada = PropertiesService.getScriptProperties().getProperty("CLAVE_ACCESO");
  return !!esperada && clave === esperada;
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

// ------------------------------------------------------------
// Equipos por técnico (pestaña "EQUI. POR TEC." del mismo documento).
// ------------------------------------------------------------
const HOJA_ENTREGAS = "EQUI. POR TEC.";
// "FECHA C."/"HORA C." (columnas bajo el grupo "CERRADO"): cuándo el
// técnico entregó el equipo — quedan vacías mientras sigue ABIERTO.
const ENTREGAS_COLUMNAS = ["FECHA", "HORA", "IMEI", "TECNICO", "CATEGORIA", "ESTADO", "FECHA C.", "HORA C."];
const ENTREGAS_COLUMNAS_FECHA = ["FECHA", "FECHA C."];
const ENTREGAS_COLUMNAS_HORA = ["HORA", "HORA C."];

function obtenerHojaEntregas() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_ENTREGAS);
  if (!hoja) throw new Error('No existe la pestaña "' + HOJA_ENTREGAS + '" en el documento.');
  return hoja;
}

function obtenerEntregasJson() {
  const inicio = Date.now();
  const hoja = obtenerHojaEntregas();

  const datos = hoja.getDataRange().getValues();
  const { indiceFila, cabecera } = encontrarCabeceraEntregas(datos);
  const indices = ENTREGAS_COLUMNAS.map(nombre => {
    const i = cabecera.indexOf(nombre);
    if (i === -1) throw new Error('Falta la columna "' + nombre + '" en la pestaña "' + HOJA_ENTREGAS + '".');
    return i;
  });

  const zona = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const filas = [];
  for (let r = indiceFila + 1; r < datos.length; r++) {
    const valores = indices.map(col => datos[r][col]);
    const fila = valores.map((valor, j) => {
      const nombreColumna = ENTREGAS_COLUMNAS[j];
      const esFecha = ENTREGAS_COLUMNAS_FECHA.indexOf(nombreColumna) !== -1;
      const esHora = ENTREGAS_COLUMNAS_HORA.indexOf(nombreColumna) !== -1;
      if ((esFecha || esHora) && valor instanceof Date && !isNaN(valor)) {
        return Utilities.formatDate(valor, zona, esFecha ? "yyyy-MM-dd" : "HH:mm");
      }
      return valor === null || valor === undefined ? "" : String(valor).trim();
    });
    if (fila.some(celda => celda !== "")) filas.push(fila);
  }

  return JSON.stringify({
    columnas: ENTREGAS_COLUMNAS,
    filas: filas,
    generado: new Date().toISOString(),
    ms: { total: Date.now() - inicio },
  });
}

// La hoja trae una fila vacía arriba (los encabezados no están en la
// fila 1), así que se busca la fila que de verdad tiene "FECHA" y
// "TECNICO" en vez de asumir un número de fila fijo.
function encontrarCabeceraEntregas(datos) {
  for (let r = 0; r < Math.min(5, datos.length); r++) {
    const fila = datos[r].map(c => String(c).trim());
    if (fila.indexOf("FECHA") !== -1 && fila.indexOf("TECNICO") !== -1) {
      return { indiceFila: r, cabecera: fila };
    }
  }
  throw new Error('No se encontró la fila de encabezados ("FECHA"/"TECNICO") en la pestaña de entregas.');
}

// ------------------------------------------------------------
// Escaneo de IMEI desde el dashboard: abrir (nuevo ingreso) o cerrar
// (entrega) equipos en "EQUI. POR TEC.". Escribe en la MISMA pestaña
// que ya lee obtenerEntregasJson.
// ------------------------------------------------------------
function registrarEntregas(params) {
  const hoja = obtenerHojaEntregas();

  if (params.modo === "abrir") {
    let imeis;
    try {
      imeis = JSON.parse(params.imeis || "[]").map(s => String(s).trim()).filter(Boolean);
    } catch (err) {
      throw new Error("Lista de IMEI inválida.");
    }
    if (!imeis.length) throw new Error("No hay ningún IMEI para procesar.");
    return abrirEquipos(hoja, imeis, params.tecnico, params.categoria);
  }

  if (params.modo === "cerrar") {
    let items;
    try {
      const texto = v => String(v || "").trim();
      items = JSON.parse(params.imeis || "[]")
        .map(o => ({
          imei: texto(o.imei),
          mensaje: texto(o.mensaje),
          destino: texto(o.destino),
          reparacion: texto(o.reparacion),
          categoria: texto(o.categoria),
          tecnicoReparacion: texto(o.tecnicoReparacion),
          modelo: texto(o.modelo),
        }))
        .filter(o => o.imei);
    } catch (err) {
      throw new Error("Lista de IMEI inválida.");
    }
    if (!items.length) throw new Error("No hay ningún IMEI para procesar.");
    return cerrarEquipos(hoja, items);
  }

  throw new Error('Modo desconocido: "' + params.modo + '".');
}

// Agrega una fila nueva por cada IMEI: FECHA/HORA = ahora, ESTADO =
// ABIERTO. La columna "#" (y cualquier otra que no conozcamos) queda
// vacía a propósito.
function abrirEquipos(hoja, imeis, tecnico, categoria) {
  if (!tecnico) throw new Error("Falta elegir el técnico.");
  if (!categoria) throw new Error("Falta elegir la categoría.");

  const datos = hoja.getDataRange().getValues();
  const { cabecera } = encontrarCabeceraEntregas(datos);
  const col = nombre => {
    const i = cabecera.indexOf(nombre);
    if (i === -1) throw new Error('Falta la columna "' + nombre + '" en la hoja.');
    return i;
  };
  const colFecha = col("FECHA");
  const colHora = col("HORA");
  const colImei = col("IMEI");
  const colTecnico = col("TECNICO");
  const colCategoria = col("CATEGORIA");
  const colEstado = col("ESTADO");

  const ahora = new Date();
  const totalColumnas = hoja.getLastColumn();
  const filasNuevas = imeis.map(imei => {
    const fila = new Array(totalColumnas).fill("");
    fila[colFecha] = ahora;
    fila[colHora] = ahora; // misma fecha/hora en las 2 celdas: cada una se
                            // formatea distinto al leer (yyyy-MM-dd / HH:mm)
    fila[colImei] = imei;
    fila[colTecnico] = tecnico.toUpperCase();
    fila[colCategoria] = categoria.toUpperCase();
    fila[colEstado] = "ABIERTO";
    return fila;
  });
  const inicio = hoja.getLastRow() + 1;
  asegurarFilas(hoja, inicio, filasNuevas.length);
  hoja.getRange(inicio, 1, filasNuevas.length, totalColumnas).setValues(filasNuevas);
  return { ok: true, agregados: imeis.length };
}

function cerrarEquipos(hoja, items) {
  const cerrados = [];
  const noEncontrados = [];
  const reparaciones = [];
  items.forEach(item => {
    const tecnico = cerrarEnHoja(hoja, item);
    if (tecnico === null) {
      noEncontrados.push(item.imei);
      return;
    }
    cerrados.push(item.imei);
    // Si no se eligió quién reparó, se asume el técnico que tenía el equipo.
    if (item.reparacion) reparaciones.push({ item: item, tecnico: item.tecnicoReparacion || tecnico });
  });

  if (reparaciones.length) anotarReparaciones(reparaciones);
  return { ok: true, cerrados: cerrados, noEncontrados: noEncontrados, reparados: reparaciones.length };
}

// Busca de abajo hacia arriba (la más reciente primero) la última fila
// ABIERTO con ese IMEI y la marca CERRADO con fecha/hora de hoy, más
// mensaje ("1 - 3 - 5") y destino si se eligieron.
// Devuelve el técnico de esa fila (para "EQUIPOS REPARADOS"), o null si
// no había ninguna abierta.
function cerrarEnHoja(hoja, item) {
  const datos = hoja.getDataRange().getValues();
  const { indiceFila, cabecera } = encontrarCabeceraEntregas(datos);
  const colImei = cabecera.indexOf("IMEI");
  const colEstado = cabecera.indexOf("ESTADO");
  const colFechaC = cabecera.indexOf("FECHA C.");
  const colHoraC = cabecera.indexOf("HORA C.");
  const colMensaje = cabecera.indexOf("MENSAJE");
  const colDestino = cabecera.indexOf("DESTINO");
  const colTecnico = cabecera.indexOf("TECNICO");

  for (let r = datos.length - 1; r > indiceFila; r--) {
    const imeiFila = String(datos[r][colImei] || "").trim();
    const estadoFila = String(datos[r][colEstado] || "").trim().toUpperCase();
    if (imeiFila === item.imei && estadoFila === "ABIERTO") {
      const ahora = new Date();
      const filaReal = r + 1; // getDataRange es 0-index; las filas de Sheets son 1-index
      hoja.getRange(filaReal, colEstado + 1).setValue("CERRADO");
      hoja.getRange(filaReal, colFechaC + 1).setValue(ahora);
      hoja.getRange(filaReal, colHoraC + 1).setValue(ahora);
      if (colMensaje !== -1 && item.mensaje) hoja.getRange(filaReal, colMensaje + 1).setValue(item.mensaje);
      if (colDestino !== -1 && item.destino) hoja.getRange(filaReal, colDestino + 1).setValue(item.destino.toUpperCase());
      return colTecnico !== -1 ? String(datos[r][colTecnico] || "").trim() : "";
    }
  }
  return null;
}

// ------------------------------------------------------------
// Equipos reparados (pestaña del mismo documento): una fila por cada
// equipo cerrado al que se le anotó una reparación.
// ------------------------------------------------------------
const REPARADOS_HOJA = "REPARADOS";

// "FECHA DE REPARACIÓN" con o sin tilde, mayúsculas o no, da igual.
function normalizarCabecera(texto) {
  return String(texto).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
}

function anotarReparaciones(reparaciones) {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPARADOS_HOJA);
  if (!hoja) throw new Error('No existe la pestaña "' + REPARADOS_HOJA + '" en el documento.');

  const totalColumnas = hoja.getLastColumn();
  const cabecera = hoja.getRange(1, 1, 1, totalColumnas).getValues()[0].map(normalizarCabecera);
  const col = nombre => {
    const i = cabecera.indexOf(nombre);
    if (i === -1) throw new Error('Falta la columna "' + nombre + '" en la pestaña ' + REPARADOS_HOJA + '.');
    return i;
  };
  const colFecha = col("FECHA DE REPARACION");
  const colModelo = col("MODELO");
  const colImei = col("IMEI");
  const colFalla = col("FALLA");
  const colCategoria = col("CATEGORIA");
  const colTecnico = col("TECNICO");

  const hoy = new Date();
  const filas = reparaciones.map(({ item, tecnico }) => {
    const fila = new Array(totalColumnas).fill("");
    fila[colFecha] = hoy;
    fila[colModelo] = item.modelo.toUpperCase();
    fila[colImei] = item.imei;
    fila[colFalla] = item.reparacion.toUpperCase();
    fila[colCategoria] = item.categoria.toUpperCase();
    fila[colTecnico] = tecnico.toUpperCase();
    return fila;
  });

  const inicio = hoja.getLastRow() + 1;
  asegurarFilas(hoja, inicio, filas.length);
  hoja.getRange(inicio, 1, filas.length, totalColumnas).setValues(filas);
  hoja.getRange(inicio, colFecha + 1, filas.length, 1).setNumberFormat("dd/MM/yyyy");
}

// getRange() falla si se sale del tamaño de la hoja; si ya no quedan
// filas vacías al final, se agregan las que falten.
function asegurarFilas(hoja, filaInicio, cantidad) {
  const faltan = filaInicio + cantidad - 1 - hoja.getMaxRows();
  if (faltan > 0) hoja.insertRowsAfter(hoja.getMaxRows(), faltan);
}
