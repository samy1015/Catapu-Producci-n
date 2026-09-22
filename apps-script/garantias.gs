// ============================================================
// Apps Script de GARANTÍAS (dashboard Catapu)
// ------------------------------------------------------------
// Este es un proyecto de Apps Script NUEVO e INDEPENDIENTE: no va
// ligado a ninguna spreadsheet (a diferencia de produccion.gs y
// reparaciones.gs). Créalo desde script.google.com > Proyecto nuevo.
//
// Qué hace: junta los tickets de tipo "Garantía" de las 3 tiendas de
// RepairDesk (vía su API pública) y, para cada uno, busca su IMEI en
// el resumen de Producción (apps-script/produccion.gs) para completar
// capacidad y color, que RepairDesk no guarda.
//
// SOLO LECTURA: este script nunca crea, modifica ni borra tickets en
// RepairDesk. Únicamente hace peticiones GET.
//
// ------------------------------------------------------------
// CONFIGURACIÓN OBLIGATORIA ANTES DE PUBLICAR
// ------------------------------------------------------------
// Ve a "Configuración del proyecto" (ícono de engranaje) > "Propiedades
// de secuencia de comandos" > "Añadir propiedad de script", y crea
// estas tres, con la API key de cada tienda (RepairDesk > Almacenar >
// Configuración de la tienda > API key), cambiando de tienda con el
// selector de arriba a la izquierda antes de copiar cada una:
//   RD_API_KEY_MIRAFLORES
//   RD_API_KEY_CAMINOS
//   RD_API_KEY_TALLER
// Las claves NUNCA van escritas en este archivo ni suben a GitHub.
// ------------------------------------------------------------
//
// Parámetros del doGet (todos opcionales, &callback=nombre para JSONP):
//   desde=AAAA-MM-DD, hasta=AAAA-MM-DD   rango por fecha de creación
//                                        del ticket (por defecto: hoy)
//   fresco=1                             ignora la caché de 5 minutos
// ============================================================

// Nombre a mostrar -> propiedad de script con su API key. El orden
// de este objeto es el orden en que aparecen los bloques en el panel.
const TIENDAS = {
  "Caminos del Inca": "RD_API_KEY_CAMINOS",
  "Miraflores": "RD_API_KEY_MIRAFLORES",
  "Taller": "RD_API_KEY_TALLER",
};

const REPAIRDESK_BASE = "https://api.repairdesk.co/api/web/v1/tickets";
const ZONA_HORARIA = "America/Lima";

// Endpoint ya existente de Producción: su resumen (sin parámetros)
// ahora incluye IMEI, así que con una sola llamada armamos el cruce
// modelo/capacidad/color por IMEI, sin tocar la spreadsheet directamente.
const URL_PRODUCCION =
  "https://script.google.com/macros/s/AKfycbxIRRSKngAHHfxOMtb-bNCDnWzPiU353fCy0-PFVkWXftGAM6Mkw1tcwEWrclyKgag9pg/exec";

// Un ticket se considera "de garantía" si el nombre de su producto o
// servicio contiene esta palabra (insensible a mayúsculas). Usamos
// repairProdItems (lo que el técnico elige al crear el ticket, ej.
// "INGRESO POR GARANTIA") en vez de task_type: en el endpoint de
// listado, task_type llega como un simple número/ID (ej. 13), sin su
// nombre — solo el detalle de UN ticket a la vez lo trae completo.
const PATRON_GARANTIA = /garant/i;

const CACHE_PREFIJO = "gar_v1";
const CACHE_TTL_SEG = 300; // 5 min: los tickets de garantía son del día, conviene que esté fresco
const CACHE_TAM_TROZO = 40000;

function doGet(e) {
  const params = (e && e.parameter) || {};
  let json;

  try {
    const desde = fechaValida(params.desde) || claveDeHoy();
    const hasta = fechaValida(params.hasta) || desde;
    json = obtenerGarantiasJson(desde, hasta, params.fresco === "1");
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

function fechaValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || "")) ? String(valor) : "";
}

function claveDeHoy() {
  return Utilities.formatDate(new Date(), ZONA_HORARIA, "yyyy-MM-dd");
}

// ------------------------------------------------------------
// Orquestación (con caché de 5 minutos por rango de fechas)
// ------------------------------------------------------------
function obtenerGarantiasJson(desde, hasta, forzar) {
  const clave = CACHE_PREFIJO + "_" + desde + "_" + hasta;
  if (!forzar) {
    const enCache = leerCache(clave);
    if (enCache) return enCache;
  }
  const json = construirGarantiasJson(desde, hasta);
  guardarCache(clave, json);
  return json;
}

function construirGarantiasJson(desde, hasta) {
  const inicio = Date.now();
  const desdeUnix = Math.floor(new Date(desde + "T00:00:00").getTime() / 1000);
  const hastaUnix = Math.floor(new Date(hasta + "T23:59:59").getTime() / 1000);

  let filas = [];
  const errores = [];

  Object.keys(TIENDAS).forEach(tienda => {
    try {
      const apiKey = PropertiesService.getScriptProperties().getProperty(TIENDAS[tienda]);
      if (!apiKey) throw new Error("Falta configurar la propiedad " + TIENDAS[tienda]);
      obtenerGarantiasDeTienda(tienda, apiKey, desdeUnix, hastaUnix).forEach(f => filas.push(f));
    } catch (err) {
      errores.push(tienda + ": " + (err.message || err));
    }
  });

  filas = quitarDuplicadosEntreSucursales(filas);

  // Cruce con Producción: una sola llamada trae TODO el resumen (con
  // caché propia de ese script), y aquí armamos un mapa IMEI -> datos.
  let mapaImei = {};
  try {
    mapaImei = obtenerMapaImeiDesdeProduccion();
  } catch (err) {
    errores.push("Producción (cruce de capacidad/color): " + (err.message || err));
  }
  filas.forEach(fila => {
    const extra = mapaImei[fila.imei];
    if (extra) {
      fila.capacidad = extra.capacidad;
      fila.color = extra.color;
    }
  });

  filas.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  // idInterno y modificado ya cumplieron su función (deduplicar); no
  // hace falta mandarlos al panel. trasladoDesde sí se queda.
  filas.forEach(f => { delete f.idInterno; delete f.modificado; });

  return JSON.stringify({
    tiendas: Object.keys(TIENDAS),
    filas: filas,
    generado: new Date().toISOString(),
    errores: errores, // el panel las muestra como aviso, sin bloquear lo que sí llegó
    ms: Date.now() - inicio,
  });
}

// ------------------------------------------------------------
// RepairDesk (una tienda). Solo GET — nunca escribe nada.
// ------------------------------------------------------------
function obtenerGarantiasDeTienda(tienda, apiKey, desdeUnix, hastaUnix) {
  const filas = [];
  const MAX_PAGINAS = 20; // tope de seguridad: 20 × 100 = 2000 tickets en el rango
  let pagina = 1;

  while (pagina <= MAX_PAGINAS) {
    const url = REPAIRDESK_BASE +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&from_date=" + desdeUnix +
      "&to_date=" + hastaUnix +
      "&pagesize=100&page=" + pagina;

    const respuesta = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
    if (respuesta.getResponseCode() !== 200) {
      throw new Error("RepairDesk respondió " + respuesta.getResponseCode());
    }
    const cuerpo = JSON.parse(respuesta.getContentText());
    if (!cuerpo.success) {
      // RepairDesk responde así cuando el rango simplemente no tiene
      // tickets — no es un error, es "cero resultados".
      if (cuerpo.statusCode === 100 || cuerpo.message === "No Result Found") break;
      throw new Error(cuerpo.message || "Respuesta sin éxito");
    }

    (cuerpo.data.ticketData || []).forEach(ticket => {
      (ticket.devices || []).forEach(dispositivo => {
        if (!esTicketDeGarantia(dispositivo)) return;

        filas.push({
          // El id interno del ticket es único en TODA la cuenta (no se
          // repite por tienda, a diferencia de order_id "T-123", que sí
          // es una numeración propia de cada tienda). Lo usamos abajo
          // para detectar el mismo ticket visto desde dos tiendas (por
          // ejemplo un traslado "In-house transfer").
          idInterno: ticket.summary.id,
          modificado: ticket.summary.modified_on || 0,
          tienda: tienda,
          ticket: ticket.summary.order_id,
          fecha: Utilities.formatDate(new Date(ticket.summary.created_date * 1000), ZONA_HORARIA, "yyyy-MM-dd"),
          modelo: (dispositivo.device && dispositivo.device.name) || "",
          capacidad: "", // se completa más abajo si el IMEI aparece en Producción
          color: "",
          estado: (dispositivo.status && dispositivo.status.name) || "",
          imei: dispositivo.imei || "",
        });
      });
    });

    const paginacion = cuerpo.data.pagination;
    if (!paginacion || !paginacion.next_page_exist) break;
    pagina++;
  }

  return filas;
}

// Revisa los nombres de producto/servicio del dispositivo (y, por si
// alguna respuesta lo trae, el nombre del tipo de tarea).
function esTicketDeGarantia(dispositivo) {
  const nombres = (dispositivo.repairProdItems || []).map(item => item.name || "");
  if (dispositivo.task_type && typeof dispositivo.task_type === "object") {
    nombres.push(dispositivo.task_type.name || "");
  }
  return nombres.some(nombre => PATRON_GARANTIA.test(nombre));
}

// Un mismo ticket (mismo id interno) puede aparecer en más de una
// tienda — por ejemplo cuando un equipo se traslada entre locales
// ("In-house transfer"). Nos quedamos con la copia más reciente (mayor
// "modified_on"), así no se cuenta dos veces, pero anotamos en
// "trasladoDesde" de qué otra(s) tienda(s) venía, para no perder ese
// rastro.
function quitarDuplicadosEntreSucursales(filas) {
  const porTicket = new Map(); // idInterno -> [filas de ese ticket en cada tienda]
  filas.forEach(fila => {
    if (!porTicket.has(fila.idInterno)) porTicket.set(fila.idInterno, []);
    porTicket.get(fila.idInterno).push(fila);
  });

  const resultado = [];
  porTicket.forEach(copias => {
    copias.sort((a, b) => a.modificado - b.modificado); // más antigua primero
    const actual = copias[copias.length - 1];
    actual.trasladoDesde = copias.slice(0, -1).map(c => c.tienda);
    resultado.push(actual);
  });
  return resultado;
}

// ------------------------------------------------------------
// Cruce con Producción (por IMEI)
// ------------------------------------------------------------
function obtenerMapaImeiDesdeProduccion() {
  const respuesta = UrlFetchApp.fetch(URL_PRODUCCION, {
    method: "get",
    muteHttpExceptions: true,
    followRedirects: true,
  });
  if (respuesta.getResponseCode() !== 200) {
    // Incluimos el inicio del cuerpo de la respuesta: así, si vuelve a
    // fallar, el mensaje de error (visible en el JSON del panel) ya trae
    // la pista, sin tener que entrar al registro de ejecución.
    const cuerpo = respuesta.getContentText().slice(0, 200);
    throw new Error("Producción respondió " + respuesta.getResponseCode() + ": " + cuerpo);
  }
  const paquete = JSON.parse(respuesta.getContentText());
  if (paquete.error) throw new Error(paquete.error);

  const iImei = paquete.columnas.indexOf("IMEI");
  const iModelo = paquete.columnas.indexOf("MODELO");
  const iCapacidad = paquete.columnas.indexOf("CAPACIDAD");
  const iColor = paquete.columnas.indexOf("COLOR");
  if (iImei === -1) throw new Error("Producción no está enviando IMEI (publica la última versión de produccion.gs).");

  const mapa = {};
  paquete.filas.forEach(fila => {
    const imei = fila[iImei];
    if (!imei) return;
    mapa[imei] = {
      modelo: fila[iModelo] || "",
      capacidad: fila[iCapacidad] || "",
      color: fila[iColor] || "",
    };
  });
  return mapa;
}

// ------------------------------------------------------------
// Caché (CacheService limita cada valor a 100 KB, así que partimos)
// ------------------------------------------------------------
function guardarCache(clave, json) {
  const cache = CacheService.getScriptCache();
  const trozos = {};
  const cantidad = Math.ceil(json.length / CACHE_TAM_TROZO);
  for (let i = 0; i < cantidad; i++) {
    trozos[clave + "_" + i] = json.substr(i * CACHE_TAM_TROZO, CACHE_TAM_TROZO);
  }
  trozos[clave + "_n"] = String(cantidad);
  cache.putAll(trozos, CACHE_TTL_SEG);
}

function leerCache(clave) {
  const cache = CacheService.getScriptCache();
  const cantidad = Number(cache.get(clave + "_n"));
  if (!cantidad) return null;

  const claves = [];
  for (let i = 0; i < cantidad; i++) claves.push(clave + "_" + i);
  const trozos = cache.getAll(claves);

  let json = "";
  for (let i = 0; i < claves.length; i++) {
    const trozo = trozos[claves[i]];
    if (trozo === undefined || trozo === null) return null;
    json += trozo;
  }
  return json;
}
