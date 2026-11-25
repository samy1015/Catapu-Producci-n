// ============================================================
// Edge Function "produccion" (dashboard Catapu)
// ------------------------------------------------------------
// Reemplaza a apps-script/produccion.gs y apps-script/reparaciones.gs:
// lee y escribe PRODUCCION.xlsx (OneDrive de serviciotecnico@catapu.com)
// con Microsoft Graph, usando la app "TallerDashboard" de Entra.
//
// Secretos (Supabase > Edge Functions > Secrets):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   (obligatorios)
//   MS_USUARIO   (opcional, por defecto serviciotecnico@catapu.com)
//   MS_ARCHIVO   (opcional, por defecto PRODUCCION.xlsx, ruta desde la raíz)
//
// Solo responde a usuarios logueados en el dashboard (JWT de Supabase).
//
// Rutas (GET salvo la última):
//   ?accion=diagnostico      -> prueba la conexión: lista las pestañas
//   (sin accion)             -> resumen de la pestaña "2026" para el panel
//   ?imei=XXXX               -> filas completas cuyo IMEI / imei 2 contiene XXXX
//   ?entregas=1              -> pestaña "EQUI. POR TEC."
//   ?accion=reparaciones[&desde=AAAA-MM-DD][&hasta=AAAA-MM-DD] -> pestaña "REPARADOS"
//   POST {accion:"registrarEntregas", modo, imeis, tecnico?, categoria?}
// ============================================================

// El Deno global (el que da Supabase), con otro nombre para que ni VS
// Code ni el editor de Supabase lo marquen en rojo.
// deno-lint-ignore no-explicit-any
const entorno = (globalThis as any).Deno;

const TENANT = entorno.env.get("MS_TENANT_ID") ?? "";
const CLIENT_ID = entorno.env.get("MS_CLIENT_ID") ?? "";
const CLIENT_SECRET = entorno.env.get("MS_CLIENT_SECRET") ?? "";
const USUARIO = entorno.env.get("MS_USUARIO") ?? "serviciotecnico@catapu.com";
const ARCHIVO = entorno.env.get("MS_ARCHIVO") ?? "PRODUCCION.xlsx";

const HOJA_TALLER = "2026";
const HOJA_ENTREGAS = "EQUI. POR TEC.";
const HOJA_REPARADOS = "REPARADOS";
const MAX_RESULTADOS_IMEI = 20;

// Perú no tiene horario de verano: siempre UTC-5.
const DESFASE_LIMA_MS = -5 * 3600 * 1000;

const COLUMNAS_PANEL = [
  "FECHA DE PULIDO", "PULIDO", "FECHA CAMBIO BATERIA", "BATERIA", "FECHA DE CHEQUEO",
  "CHEQUEO", "MODELO", "CAPACIDAD", "COLOR", "GRADO", "LOTE", "IMEI",
];
const COLUMNAS_PANEL_FECHA = ["FECHA DE PULIDO", "FECHA CAMBIO BATERIA", "FECHA DE CHEQUEO"];

const ENTREGAS_COLUMNAS = ["FECHA", "HORA", "IMEI", "TECNICO", "CATEGORIA", "ESTADO", "FECHA C.", "HORA C."];
const ENTREGAS_FECHA = ["FECHA", "FECHA C."];
const ENTREGAS_HORA = ["HORA", "HORA C."];

const REPARADOS_COLUMNAS: [string, string][] = [
  ["FECHA DE REPARACION", "fecha"],
  ["TECNICO", "tecnico"],
  ["MODELO", "modelo"],
  ["FALLA", "falla"],
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type Celda = string | number | boolean | null;

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------
entorno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (!esUsuarioLogueado(req)) return responder({ error: "No autorizado." }, 401);

    const url = new URL(req.url);
    const p = Object.fromEntries(url.searchParams);
    const cuerpo = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const accion = cuerpo.accion || p.accion || "";

    let resultado: unknown;
    if (accion === "diagnostico") resultado = await diagnostico();
    else if (accion === "registrarEntregas") resultado = await registrarEntregas(cuerpo);
    else if (accion === "reparaciones") resultado = await reparaciones(fechaValida(p.desde), fechaValida(p.hasta));
    else if (p.imei) resultado = await buscarPorImei(p.imei);
    else if (p.entregas) resultado = await entregas();
    else resultado = await resumen();

    return responder(resultado);
  } catch (err) {
    console.error(err);
    // El panel muestra este mensaje en pantalla en vez de quedarse cargando.
    return responder({ error: String((err as Error)?.message || err) });
  }
});

function responder(datos: unknown, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Supabase ya validó la firma del token antes de llegar aquí ("Verify
// JWT" activado). Solo falta confirmar que es un usuario logueado y no
// la clave pública del proyecto.
function esUsuarioLogueado(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const partes = token.split(".");
  if (partes.length !== 3) return false;
  try {
    const datos = JSON.parse(atob(partes[1].replace(/-/g, "+").replace(/_/g, "/")));
    return datos.role === "authenticated" && (!datos.exp || datos.exp * 1000 > Date.now());
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Microsoft Graph
// ------------------------------------------------------------
let tokenCache: { valor: string; vence: number } | null = null;
let idArchivoCache = "";

async function tokenGraph() {
  if (tokenCache && tokenCache.vence > Date.now() + 60_000) return tokenCache.valor;
  if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Faltan los secretos MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET en Supabase.");
  }
  const resp = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const datos = await resp.json();
  if (!resp.ok) {
    throw new Error("Microsoft rechazó las credenciales: " + (datos.error_description || datos.error || resp.status));
  }
  tokenCache = { valor: datos.access_token, vence: Date.now() + datos.expires_in * 1000 };
  return tokenCache.valor;
}

async function graph(ruta: string, opciones: { method?: string; body?: unknown } = {}): Promise<any> {
  for (let intento = 0; ; intento++) {
    const resp = await fetch("https://graph.microsoft.com/v1.0" + ruta, {
      method: opciones.method || "GET",
      headers: {
        Authorization: "Bearer " + (await tokenGraph()),
        "Content-Type": "application/json",
      },
      body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    });
    // Excel en línea a veces responde 429/503/504 al "despertar" el archivo.
    if ([409, 429, 503, 504].includes(resp.status) && intento < 3) {
      const espera = Number(resp.headers.get("Retry-After")) || 2 ** intento;
      await new Promise((r) => setTimeout(r, espera * 1000));
      continue;
    }
    const texto = await resp.text();
    const datos = texto ? JSON.parse(texto) : {};
    if (!resp.ok) {
      const msg = datos?.error?.message || resp.statusText;
      if (resp.status === 403) {
        throw new Error(`Sin permiso (403) en ${ruta.split("?")[0].replace(/^\/users\/[^/]+/, "")}: ${msg}`);
      }
      const hoja = ruta.match(/\/worksheets\/([^/]+)/);
      if (resp.status === 404 && hoja) {
        throw new Error(`No existe la pestaña "${decodeURIComponent(hoja[1])}" en el Excel (404).`);
      }
      throw new Error(`Error de Microsoft (${resp.status}): ${msg}`);
    }
    return datos;
  }
}

async function rutaLibro() {
  const drive = `/users/${encodeURIComponent(USUARIO)}/drive`;
  if (!idArchivoCache) idArchivoCache = (await ubicarArchivo(drive)).id;
  return `${drive}/items/${idArchivoCache}/workbook`;
}

// Primero prueba la ruta exacta (MS_ARCHIVO); si no está ahí, lo busca
// por nombre en todo el OneDrive (puede estar dentro de una carpeta).
async function ubicarArchivo(drive: string): Promise<{ id: string; ruta: string }> {
  try {
    await graph(`${drive}?$select=id`);
  } catch (err) {
    throw new Error(`No se encontró el OneDrive de "${USUARIO}". ${(err as Error).message}`);
  }

  const ruta = ARCHIVO.split("/").map(encodeURIComponent).join("/");
  try {
    const item = await graph(`${drive}/root:/${ruta}?$select=id,name,parentReference`);
    return { id: item.id, ruta: ARCHIVO };
  } catch (err) {
    if (!String((err as Error).message).includes("(404)")) throw err;
  }

  // El buscador de OneDrive (search) no funciona con este tipo de acceso
  // (app sin usuario), así que se recorren las carpetas, nivel por nivel.
  const nombre = ARCHIVO.split("/").pop()!.toLowerCase();
  let nivel: { id: string; ruta: string }[] = [{ id: "root", ruta: "" }];
  for (let profundidad = 0; profundidad < 4 && nivel.length; profundidad++) {
    const siguiente: { id: string; ruta: string }[] = [];
    for (const carpeta of nivel.slice(0, 40)) {
      const hijos = await graph(`${drive}/items/${carpeta.id}/children?$select=id,name,folder,file&$top=200`);
      for (const h of hijos.value || []) {
        const ruta = carpeta.ruta ? `${carpeta.ruta}/${h.name}` : h.name;
        if (h.file && String(h.name).toLowerCase() === nombre) return { id: h.id, ruta };
        if (h.folder) siguiente.push({ id: h.id, ruta });
      }
    }
    nivel = siguiente;
  }
  throw new Error(`No se encontró "${ARCHIVO}" en el OneDrive de ${USUARIO}.`);
}

function rutaHoja(libro: string, hoja: string) {
  return `${libro}/worksheets/${encodeURIComponent(hoja)}`;
}

function rangoUrl(libro: string, hoja: string, direccion: string) {
  return `${rutaHoja(libro, hoja)}/range(address='${encodeURIComponent(direccion)}')`;
}

// Último renglón/columna con datos (1-index). Una hoja vacía da 1x1.
async function tamanoUsado(libro: string, hoja: string) {
  const r = await graph(`${rutaHoja(libro, hoja)}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`);
  const m = String(r.address).match(/!([A-Z]+)(\d+)/);
  const filaInicio = m ? Number(m[2]) : 1;
  const colInicio = m ? numeroColumna(m[1]) : 1;
  return {
    ultimaFila: filaInicio + r.rowCount - 1,
    ultimaColumna: colInicio + r.columnCount - 1,
  };
}

async function leerRango(libro: string, hoja: string, direccion: string): Promise<Celda[][]> {
  const r = await graph(`${rangoUrl(libro, hoja, direccion)}?$select=values`);
  return r.values || [];
}

async function escribirRango(libro: string, hoja: string, direccion: string, values: Celda[][], numberFormat?: (string | null)[][]) {
  const cuerpo: Record<string, unknown> = { values };
  if (numberFormat) cuerpo.numberFormat = numberFormat;
  await graph(rangoUrl(libro, hoja, direccion), { method: "PATCH", body: cuerpo });
}

// Lee solo las columnas pedidas (una petición por columna, en paralelo):
// mucho más liviano que bajar toda la hoja.
async function leerColumnas(libro: string, hoja: string, indices: number[], filaDesde: number, filaHasta: number) {
  if (filaHasta < filaDesde) return indices.map(() => [] as Celda[]);
  return Promise.all(
    indices.map(async (i) => {
      const letra = letraColumna(i + 1);
      const valores = await leerRango(libro, hoja, `${letra}${filaDesde}:${letra}${filaHasta}`);
      return valores.map((f) => f[0]);
    }),
  );
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
function letraColumna(n: number) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function numeroColumna(letras: string) {
  return letras.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}

function normalizarCabecera(v: Celda) {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

function texto(v: Celda) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function fechaValida(v?: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

const EPOCA_EXCEL = Date.UTC(1899, 11, 30);

// Excel guarda fechas como número de días desde 30/12/1899.
function serialAFecha(v: Celda) {
  if (typeof v === "number" && v > 0) {
    const d = new Date(EPOCA_EXCEL + Math.round(v * 86400000));
    return d.toISOString().slice(0, 10);
  }
  // A veces la fecha está escrita como texto "d/m/aaaa".
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}

function serialAHora(v: Celda) {
  if (typeof v !== "number") return texto(v);
  let minutos = Math.round((v - Math.floor(v)) * 1440);
  if (minutos >= 1440) minutos = 0;
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

// "Ahora" en Lima como número de serie de Excel (fecha + hora).
function ahoraSerial() {
  return (Date.now() + DESFASE_LIMA_MS - EPOCA_EXCEL) / 86400000;
}

function indiceObligatorio(cabecera: string[], nombre: string, hoja: string) {
  const i = cabecera.indexOf(nombre);
  if (i === -1) throw new Error(`Falta la columna "${nombre}" en la pestaña "${hoja}".`);
  return i;
}

// ------------------------------------------------------------
// Diagnóstico
// ------------------------------------------------------------
// Prueba cada paso por separado y no se detiene en el primer error, para
// ver exactamente dónde falla. No devuelve ningún secreto.
async function diagnostico() {
  tokenCache = null; // fuerza un token nuevo (con los permisos actuales)
  const pasos: Record<string, unknown> = {};
  const probar = async (nombre: string, fn: () => Promise<unknown>) => {
    try {
      pasos[nombre] = await fn();
      return true;
    } catch (err) {
      pasos[nombre] = "ERROR: " + (err as Error).message;
      return false;
    }
  };

  await probar("1_permisos_del_token", async () => {
    const t = await tokenGraph();
    const datos = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { roles: datos.roles || [], app: datos.app_displayname };
  });

  const usuario = `/users/${encodeURIComponent(USUARIO)}`;
  await probar("2_onedrive", async () => {
    const d = await graph(`${usuario}/drive?$select=id,driveType,webUrl`);
    return { tipo: d.driveType, url: d.webUrl };
  });

  await probar("3_archivos_en_raiz", async () => {
    const r = await graph(`${usuario}/drive/root/children?$select=name&$top=50`);
    return r.value.map((i: { name: string }) => i.name);
  });

  let id = "";
  await probar("4_archivo", async () => {
    const a = await ubicarArchivo(`${usuario}/drive`);
    id = a.id;
    return a.ruta;
  });

  if (id) {
    idArchivoCache = id;
    await probar("5_pestanas_excel", async () => {
      const hojas = await graph(`${usuario}/drive/items/${id}/workbook/worksheets?$select=name`);
      const pestanas = hojas.value.map((h: { name: string }) => h.name);
      const faltan = [HOJA_TALLER, HOJA_ENTREGAS, HOJA_REPARADOS].filter((n) => !pestanas.includes(n));
      return { pestanas, faltan };
    });
  }
  return { usuario: USUARIO, archivo: ARCHIVO, pasos };
}

// ------------------------------------------------------------
// Resumen (pestaña "2026")
// ------------------------------------------------------------
async function resumen() {
  const inicio = Date.now();
  const libro = await rutaLibro();
  const { ultimaFila, ultimaColumna } = await tamanoUsado(libro, HOJA_TALLER);
  const cabecera = (await leerRango(libro, HOJA_TALLER, `A1:${letraColumna(ultimaColumna)}1`))[0].map((c) => texto(c));
  const indices = COLUMNAS_PANEL.map((n) => indiceObligatorio(cabecera, n, HOJA_TALLER));
  const columnas = await leerColumnas(libro, HOJA_TALLER, indices, 2, ultimaFila);
  const msLeer = Date.now() - inicio;

  const esFecha = COLUMNAS_PANEL.map((n) => COLUMNAS_PANEL_FECHA.includes(n));
  const filas: string[][] = [];
  const total = Math.max(0, ultimaFila - 1);
  for (let r = 0; r < total; r++) {
    const fila = columnas.map((col, j) => (esFecha[j] ? serialAFecha(col[r]) : texto(col[r])));
    if (fila.some((c) => c !== "")) filas.push(fila);
  }

  return {
    columnas: COLUMNAS_PANEL,
    filas,
    generado: new Date().toISOString(),
    ms: { leer: msLeer, total: Date.now() - inicio },
  };
}

// ------------------------------------------------------------
// Búsqueda por IMEI (filas completas)
// ------------------------------------------------------------
async function buscarPorImei(textoBuscado: string) {
  const buscado = String(textoBuscado).replace(/\s+/g, "");
  if (buscado.length < 4) return { total: 0, filas: [] };

  const libro = await rutaLibro();
  const { ultimaFila, ultimaColumna } = await tamanoUsado(libro, HOJA_TALLER);
  if (ultimaFila < 2) return { total: 0, filas: [] };
  const letraFin = letraColumna(ultimaColumna);
  const cabecera = (await leerRango(libro, HOJA_TALLER, `A1:${letraFin}1`))[0].map((c) => texto(c));

  const indicesImei = ["IMEI", "imei 2"].map((n) => cabecera.indexOf(n)).filter((i) => i !== -1);
  const columnas = await leerColumnas(libro, HOJA_TALLER, indicesImei, 2, ultimaFila);
  const coincidencias = new Set<number>();
  columnas.forEach((col) =>
    col.forEach((v, i) => {
      if (texto(v).includes(buscado)) coincidencias.add(i + 2);
    })
  );

  const numeros = [...coincidencias].sort((a, b) => a - b);
  const filas = await Promise.all(
    numeros.slice(0, MAX_RESULTADOS_IMEI).map(async (n) => {
      const valores = (await leerRango(libro, HOJA_TALLER, `A${n}:${letraFin}${n}`))[0] || [];
      const objeto: Record<string, Celda> = {};
      cabecera.forEach((nombre, i) => {
        if (!nombre) return;
        // Las columnas de fecha viajan como "AAAA-MM-DD" (el panel las muestra en es-PE).
        objeto[nombre] = normalizarCabecera(nombre).startsWith("FECHA") ? serialAFecha(valores[i]) : valores[i];
      });
      return objeto;
    }),
  );
  return { total: numeros.length, filas };
}

// ------------------------------------------------------------
// Equipos por técnico (pestaña "EQUI. POR TEC.")
// ------------------------------------------------------------
// La cabecera no está en la fila 1: se busca la fila con FECHA y TECNICO.
async function cabeceraEntregas(libro: string) {
  const { ultimaFila, ultimaColumna } = await tamanoUsado(libro, HOJA_ENTREGAS);
  const primeras = await leerRango(libro, HOJA_ENTREGAS, `A1:${letraColumna(ultimaColumna)}5`);
  for (let r = 0; r < primeras.length; r++) {
    const fila = primeras[r].map((c) => texto(c));
    if (fila.includes("FECHA") && fila.includes("TECNICO")) {
      return { filaCabecera: r + 1, cabecera: fila, ultimaFila, ultimaColumna };
    }
  }
  throw new Error(`No se encontró la fila de encabezados ("FECHA"/"TECNICO") en la pestaña "${HOJA_ENTREGAS}".`);
}

async function entregas() {
  const inicio = Date.now();
  const libro = await rutaLibro();
  const { filaCabecera, cabecera, ultimaFila } = await cabeceraEntregas(libro);
  const indices = ENTREGAS_COLUMNAS.map((n) => indiceObligatorio(cabecera, n, HOJA_ENTREGAS));
  const columnas = await leerColumnas(libro, HOJA_ENTREGAS, indices, filaCabecera + 1, ultimaFila);

  const filas: string[][] = [];
  const total = Math.max(0, ultimaFila - filaCabecera);
  for (let r = 0; r < total; r++) {
    const fila = columnas.map((col, j) => {
      const nombre = ENTREGAS_COLUMNAS[j];
      const v = col[r];
      if (ENTREGAS_FECHA.includes(nombre)) return typeof v === "number" ? serialAFecha(v) : texto(v);
      if (ENTREGAS_HORA.includes(nombre)) return serialAHora(v);
      return texto(v);
    });
    if (fila.some((c) => c !== "")) filas.push(fila);
  }

  return { columnas: ENTREGAS_COLUMNAS, filas, generado: new Date().toISOString(), ms: { total: Date.now() - inicio } };
}

// ------------------------------------------------------------
// Escaneo: abrir / cerrar equipos
// ------------------------------------------------------------
type ItemCierre = {
  imei: string; mensaje: string; destino: string; reparacion: string;
  categoria: string; tecnicoReparacion: string; modelo: string;
};

async function registrarEntregas(c: any) {
  const lista = Array.isArray(c.imeis) ? c.imeis : [];
  const t = (v: unknown) => String(v ?? "").trim();

  if (c.modo === "abrir") {
    const imeis = lista.map(t).filter(Boolean);
    if (!imeis.length) throw new Error("No hay ningún IMEI para procesar.");
    return abrirEquipos(imeis, t(c.tecnico), t(c.categoria));
  }
  if (c.modo === "cerrar") {
    const items: ItemCierre[] = lista
      .map((o: any) => ({
        imei: t(o?.imei), mensaje: t(o?.mensaje), destino: t(o?.destino), reparacion: t(o?.reparacion),
        categoria: t(o?.categoria), tecnicoReparacion: t(o?.tecnicoReparacion), modelo: t(o?.modelo),
      }))
      .filter((o: ItemCierre) => o.imei);
    if (!items.length) throw new Error("No hay ningún IMEI para procesar.");
    return cerrarEquipos(items);
  }
  throw new Error(`Modo desconocido: "${c.modo}".`);
}

// IMEI como número (la columna tiene formato "número sin decimales").
// Los IMEI tienen 15 dígitos: caben exactos en un número.
function imeiCelda(imei: string): Celda {
  return /^\d{1,15}$/.test(imei) ? Number(imei) : imei;
}

async function abrirEquipos(imeis: string[], tecnico: string, categoria: string) {
  if (!tecnico) throw new Error("Falta elegir el técnico.");
  if (!categoria) throw new Error("Falta elegir la categoría.");

  const libro = await rutaLibro();
  const { cabecera, ultimaFila, ultimaColumna } = await cabeceraEntregas(libro);
  const col = (n: string) => indiceObligatorio(cabecera, n, HOJA_ENTREGAS);
  const iFecha = col("FECHA"), iHora = col("HORA"), iImei = col("IMEI");
  const iTecnico = col("TECNICO"), iCategoria = col("CATEGORIA"), iEstado = col("ESTADO");

  const ahora = ahoraSerial();
  const valores: Celda[][] = [];
  const formatos: (string | null)[][] = [];
  imeis.forEach((imei) => {
    const fila: Celda[] = new Array(ultimaColumna).fill(null);
    const formato: (string | null)[] = new Array(ultimaColumna).fill(null);
    fila[iFecha] = Math.floor(ahora); formato[iFecha] = "dd/mm/yyyy";
    fila[iHora] = ahora - Math.floor(ahora); formato[iHora] = "hh:mm";
    fila[iImei] = imeiCelda(imei); formato[iImei] = "0";
    fila[iTecnico] = tecnico.toUpperCase();
    fila[iCategoria] = categoria.toUpperCase();
    fila[iEstado] = "ABIERTO";
    valores.push(fila);
    formatos.push(formato);
  });

  await escribirFilasNuevas(libro, HOJA_ENTREGAS, ultimaFila + 1, ultimaColumna, valores, formatos);
  return { ok: true, agregados: imeis.length };
}

// Un solo PATCH para todo el bloque. En Graph, una celda con null en
// "values"/"numberFormat" se deja tal cual: así no se pisan fórmulas ni
// otras columnas (como "#").
async function escribirFilasNuevas(
  libro: string, hoja: string, filaInicio: number, ancho: number,
  valores: Celda[][], formatos: (string | null)[][],
) {
  const filaFin = filaInicio + valores.length - 1;
  await escribirRango(libro, hoja, `A${filaInicio}:${letraColumna(ancho)}${filaFin}`, valores, formatos);
}

async function cerrarEquipos(items: ItemCierre[]) {
  const libro = await rutaLibro();
  const { filaCabecera, cabecera, ultimaFila } = await cabeceraEntregas(libro);
  const col = (n: string) => indiceObligatorio(cabecera, n, HOJA_ENTREGAS);
  const iImei = col("IMEI"), iEstado = col("ESTADO"), iFechaC = col("FECHA C."), iHoraC = col("HORA C.");
  const iTecnico = col("TECNICO");
  const iMensaje = cabecera.indexOf("MENSAJE"), iDestino = cabecera.indexOf("DESTINO");

  const [colImei, colEstado, colTecnico] = await leerColumnas(
    libro, HOJA_ENTREGAS, [iImei, iEstado, iTecnico], filaCabecera + 1, ultimaFila,
  );

  const ahora = ahoraSerial();
  const cerrados: string[] = [];
  const noEncontrados: string[] = [];
  const reparaciones: { item: ItemCierre; tecnico: string }[] = [];
  const yaCerradas = new Set<number>();
  const usadas = [iEstado, iFechaC, iHoraC, iMensaje, iDestino].filter((i) => i !== -1);
  const colMin = Math.min(...usadas), colMax = Math.max(...usadas);

  for (const item of items) {
    // De abajo hacia arriba: la fila ABIERTO más reciente con ese IMEI.
    let r = colImei.length - 1;
    for (; r >= 0; r--) {
      if (yaCerradas.has(r)) continue;
      if (texto(colImei[r]) === item.imei && texto(colEstado[r]).toUpperCase() === "ABIERTO") break;
    }
    if (r < 0) {
      noEncontrados.push(item.imei);
      continue;
    }
    yaCerradas.add(r);
    const fila = filaCabecera + 1 + r;
    // Un PATCH por fila, del primer al último campo que se toca; lo del
    // medio va en null (no se modifica).
    const valores: Celda[] = new Array(colMax - colMin + 1).fill(null);
    const formatos: (string | null)[] = new Array(colMax - colMin + 1).fill(null);
    const poner = (i: number, valor: Celda, formato?: string) => {
      valores[i - colMin] = valor;
      if (formato) formatos[i - colMin] = formato;
    };
    poner(iEstado, "CERRADO");
    poner(iFechaC, Math.floor(ahora), "dd/mm/yyyy");
    poner(iHoraC, ahora - Math.floor(ahora), "hh:mm");
    if (iMensaje !== -1 && item.mensaje) poner(iMensaje, item.mensaje);
    if (iDestino !== -1 && item.destino) poner(iDestino, item.destino.toUpperCase());
    // Una escritura a la vez: Excel en línea rechaza escrituras simultáneas al mismo archivo.
    await escribirRango(
      libro, HOJA_ENTREGAS, `${letraColumna(colMin + 1)}${fila}:${letraColumna(colMax + 1)}${fila}`,
      [valores], [formatos],
    );

    cerrados.push(item.imei);
    // Si no se eligió quién reparó, se asume el técnico que tenía el equipo.
    if (item.reparacion) reparaciones.push({ item, tecnico: item.tecnicoReparacion || texto(colTecnico[r]) });
  }

  if (reparaciones.length) await anotarReparaciones(libro, reparaciones);
  return { ok: true, cerrados, noEncontrados, reparados: reparaciones.length };
}

// ------------------------------------------------------------
// REPARADOS
// ------------------------------------------------------------
async function cabeceraReparados(libro: string) {
  const { ultimaFila, ultimaColumna } = await tamanoUsado(libro, HOJA_REPARADOS);
  const cabecera = (await leerRango(libro, HOJA_REPARADOS, `A1:${letraColumna(ultimaColumna)}1`))[0].map(normalizarCabecera);
  return { cabecera, ultimaFila, ultimaColumna };
}

async function anotarReparaciones(libro: string, reparaciones: { item: ItemCierre; tecnico: string }[]) {
  const { cabecera, ultimaFila, ultimaColumna } = await cabeceraReparados(libro);
  const col = (n: string) => indiceObligatorio(cabecera, n, HOJA_REPARADOS);
  const iFecha = col("FECHA DE REPARACION"), iModelo = col("MODELO"), iImei = col("IMEI");
  const iFalla = col("FALLA"), iCategoria = col("CATEGORIA"), iTecnico = col("TECNICO");

  const hoy = Math.floor(ahoraSerial());
  const valores: Celda[][] = [];
  const formatos: (string | null)[][] = [];
  reparaciones.forEach(({ item, tecnico }) => {
    const fila: Celda[] = new Array(ultimaColumna).fill(null);
    const formato: (string | null)[] = new Array(ultimaColumna).fill(null);
    fila[iFecha] = hoy; formato[iFecha] = "dd/mm/yyyy";
    fila[iModelo] = item.modelo.toUpperCase();
    fila[iImei] = imeiCelda(item.imei); formato[iImei] = "0";
    fila[iFalla] = item.reparacion.toUpperCase();
    fila[iCategoria] = item.categoria.toUpperCase();
    fila[iTecnico] = tecnico.toUpperCase();
    valores.push(fila);
    formatos.push(formato);
  });

  await escribirFilasNuevas(libro, HOJA_REPARADOS, ultimaFila + 1, ultimaColumna, valores, formatos);
}

async function reparaciones(desde: string, hasta: string) {
  const inicio = Date.now();
  const libro = await rutaLibro();
  const { cabecera, ultimaFila } = await cabeceraReparados(libro);
  const faltantes = REPARADOS_COLUMNAS.filter(([n]) => !cabecera.includes(n)).map(([n]) => n);
  if (faltantes.length) throw new Error("Faltan columnas en la hoja REPARADOS: " + faltantes.join(", "));

  const indices = REPARADOS_COLUMNAS.map(([n]) => cabecera.indexOf(n));
  const columnas = await leerColumnas(libro, HOJA_REPARADOS, indices, 2, ultimaFila);
  const msLeer = Date.now() - inicio;

  const filas: string[][] = [];
  const total = Math.max(0, ultimaFila - 1);
  for (let r = 0; r < total; r++) {
    const fila = columnas.map((col, j) => (j === 0 ? serialAFecha(col[r]) : texto(col[r])));
    if (!fila.some((c) => c !== "")) continue;
    if (desde || hasta) {
      const fecha = fila[0];
      if (!fecha || (desde && fecha < desde) || (hasta && fecha > hasta)) continue;
    }
    filas.push(fila);
  }

  return {
    columnas: REPARADOS_COLUMNAS.map(([, alias]) => alias),
    filas,
    generado: new Date().toISOString(),
    ms: { leer: msLeer, total: Date.now() - inicio },
  };
}
