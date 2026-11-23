// ============================================================
// 1. CONFIGURACIÓN
// ============================================================
// Esta es la URL de tu Apps Script (la que termina en /exec).
// Si vuelves a implementar una "Nueva versión" del script, la URL
// no cambia, así que normalmente no necesitas tocar esto de nuevo.
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxIRRSKngAHHfxOMtb-bNCDnWzPiU353fCy0-PFVkWXftGAM6Mkw1tcwEWrclyKgag9pg/exec";

// Script de Correos/JotForm (apps-script/correos.gs), creado dentro de
// catapu.serviciotecnico@gmail.com. Da el historial de un IMEI: falla
// inicial, diagnóstico técnico, conclusión, técnico y cuántos clientes
// distintos ha tenido el equipo.
const URL_CORREOS =
  "https://script.google.com/macros/s/AKfycby1AgKW9_Z6uhtjOR14HT6dlllfHtK63-OvrEmcOW9HZ-VVx4dLdD047TMabf-bujfK/exec";

// El historial de un IMEI no cambia mientras se está viendo la página,
// así que se guarda aquí para no volver a pedirlo si se abre dos veces.
const historialImeiCache = new Map();

// Aquí guardamos en memoria todos los registros que trae la hoja,
// sin filtrar. Cada vez que el usuario cambia un filtro, partimos
// de este arreglo y lo volvemos a filtrar — nunca volvemos a pedirle
// los datos a Google a menos que el usuario le dé "Actualizar".
let registrosOriginales = [];
let registrosEntregas = []; // hoja aparte "Equipos por tecnico" (ver cargarEntregas)
let mapaImeiTaller = new Map(); // IMEI -> {modelo, capacidad, color, grado} (de TALLER1), para enriquecer "Equipos por técnico"
// "abierto" (por defecto, al entrar): solo ABIERTO, ignorando el rango
// de fechas. "mostrar": todo (abierto + cerrado), respetando el rango.
let modoEntregas = "abierto";
// Escaneo de IMEI ("Registrar equipos"): se acumulan acá hasta que se
// confirma con "Aceptar" (ver aceptarEscaneo). Cada ítem es
// { imei, mensaje, destino, reparacion, categoria } — todo menos "imei"
// solo se usa en modo "cerrar", con valores propios por cada IMEI.
let escaneoImeis = [];
let escaneoModo = "abrir";
const MIN_DIGITOS_IMEI_ESCANEO = 6;
let cargando = false;
let esPrimeraCarga = true; // solo queremos fijar "último día" al abrir la página, no cada Actualizar

// ============================================================
// 2. REFERENCIAS A ELEMENTOS DEL DOM
// ============================================================
// Guardamos referencias una sola vez al cargar la página, en vez
// de buscar el elemento cada vez que lo necesitamos.
const el = {
  statusLine: document.getElementById("status-line"),
  rangoFechas: document.getElementById("rango-fechas"),
  avisoRango: document.getElementById("aviso-rango"),
  fechaDesde: document.getElementById("fecha-desde"),
  fechaHasta: document.getElementById("fecha-hasta"),
  filtroLote: document.getElementById("filtro-lote"),
  btnRefrescar: document.getElementById("btn-refrescar"),
  buscadorImei: document.getElementById("buscador-imei"),
  panelBusquedaImei: document.getElementById("panel-busqueda-imei"),
  resultadoImei: document.getElementById("resultado-imei"),

  statTotal: document.getElementById("stat-total"),
  statBaterias: document.getElementById("stat-baterias"),
  statChequeos: document.getElementById("stat-chequeos"),
  statPulidos: document.getElementById("stat-pulidos"),

  rankingBateria: document.getElementById("ranking-bateria"),
  rankingChequeo: document.getElementById("ranking-chequeo"),

  tablaModelos: document.querySelector("#tabla-modelos tbody"),
  tablaEntregas: document.querySelector("#tabla-entregas tbody"),
  entregasFechaDesde: document.getElementById("entregas-fecha-desde"),
  entregasFechaHasta: document.getElementById("entregas-fecha-hasta"),
  entregasBtnMostrar: document.getElementById("entregas-btn-mostrar"),
  entregasBtnAbierto: document.getElementById("entregas-btn-abierto"),
  entregasTotalAbiertos: document.getElementById("entregas-total-abiertos"),
  entregasTotalCerrados: document.getElementById("entregas-total-cerrados"),
  entregasTotalGeneral: document.getElementById("entregas-total-general"),

  escaneoModoAbrir: document.getElementById("escaneo-modo-abrir"),
  escaneoModoCerrar: document.getElementById("escaneo-modo-cerrar"),
  escaneoCamposAbrir: document.getElementById("escaneo-campos-abrir"),
  escaneoTecnico: document.getElementById("escaneo-tecnico"),
  escaneoCategoria: document.getElementById("escaneo-categoria"),
  escaneoImeiInput: document.getElementById("escaneo-imei-input"),
  escaneoLista: document.getElementById("escaneo-lista"),
  escaneoBtnAceptar: document.getElementById("escaneo-btn-aceptar"),
  escaneoBtnLimpiar: document.getElementById("escaneo-btn-limpiar"),
  escaneoStatus: document.getElementById("escaneo-status"),

  ultimaActualizacion: document.getElementById("ultima-actualizacion"),

  btnTema: document.getElementById("btn-tema"),
};

// ============================================================
// 2b. TEMA (claro / oscuro)
// ============================================================
// El <head> de index.html ya decidió el tema inicial (para que no
// parpadee al cargar). Esta parte solo se encarga de: alternar cuando
// el usuario hace clic, guardar su elección, y mantener el ícono del
// botón acorde al tema activo.
function aplicarTema(tema) {
  if (tema === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try {
    localStorage.setItem("catapu-tema", tema);
  } catch (error) {
    // Sin localStorage, el tema simplemente no se recuerda entre visitas.
  }
  actualizarBotonTema(tema);
}

function actualizarBotonTema(tema) {
  if (!el.btnTema) return;
  const esClaro = tema === "light";
  el.btnTema.querySelector(".theme-toggle-icon").textContent = esClaro ? "☀" : "☾";
  el.btnTema.title = esClaro ? "Cambiar a modo oscuro" : "Cambiar a modo claro";
  el.btnTema.setAttribute("aria-label", el.btnTema.title);
}

function temaActual() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

actualizarBotonTema(temaActual()); // sincroniza el ícono con lo que el <head> ya decidió

// ============================================================
// 3. CARGA DE DATOS
// ============================================================
// Google Apps Script no agrega el encabezado que los navegadores
// exigen para leer una respuesta con fetch() desde otro origen
// (esto se llama CORS). La forma estándar de evitar ese bloqueo es
// JSONP: en vez de pedir los datos con fetch, los pedimos con una
// etiqueta <script>, que no está sujeta a esa restricción. El propio
// Apps Script (ver el doGet actualizado) envuelve el JSON en una
// llamada a la función que le indiquemos por la URL.
let contadorCallbacks = 0;
const TIMEOUT_CARGA_MS = 120000; // margen amplio: la carga "en frío" (sin caché) puede tardar

function cargarViaJSONP(url) {
  return new Promise((resolve, reject) => {
    // Contador en vez de solo Date.now() para que dos cargas nunca
    // compartan el mismo nombre de función.
    const nombreCallback = `catapuCallback_${Date.now()}_${contadorCallbacks++}`;
    const etiquetaScript = document.createElement("script");

    // Quita el callback, el <script> y el temporizador, pase lo que pase.
    const limpiar = () => {
      clearTimeout(temporizador);
      delete window[nombreCallback];
      etiquetaScript.remove();
    };

    // Si Apps Script responde con una página de error (HTML) o algo
    // que no es JS válido, onerror no siempre se dispara; el timeout
    // evita que la carga quede colgada para siempre.
    const temporizador = setTimeout(() => {
      limpiar();
      reject(new Error("El Apps Script no respondió a tiempo o no devolvió datos. Revisa que la implementación tenga acceso para 'Cualquier usuario'."));
    }, TIMEOUT_CARGA_MS);

    // Esta función será invocada por el <script> que insertamos,
    // con los datos ya listos como un objeto JavaScript real.
    window[nombreCallback] = (datos) => {
      limpiar();
      resolve(datos);
    };

    // window.claveAppsScript la deja auth.js apenas hay sesión (viene de
    // Supabase, tabla "config_privada"): los 4 Apps Script la exigen en
    // su doGet antes de responder nada, así que se agrega sola acá para
    // no tener que tocar cada llamada por separado.
    const separador = url.includes("?") ? "&" : "?";
    const clave = window.claveAppsScript ? `&clave=${encodeURIComponent(window.claveAppsScript)}` : "";
    etiquetaScript.src = `${url}${separador}callback=${nombreCallback}${clave}`;
    etiquetaScript.onerror = () => {
      limpiar();
      reject(new Error("No se pudo contactar al Apps Script (revisa la URL o que esté implementado como 'Cualquier usuario')."));
    };

    document.body.appendChild(etiquetaScript);
  });
}

// `forzar` = true (botón Actualizar) le pide al script que ignore su
// caché y relea la hoja: es más lento, pero trae lo último. La carga
// inicial usa la caché del script y suele responder en pocos segundos.
async function cargarDatos(forzar = false) {
  if (cargando) return; // ignora clics repetidos mientras hay una carga en curso
  cargando = true;
  el.btnRefrescar.classList.add("is-loading");
  el.statusLine.textContent = "Cargando datos…";
  el.statusLine.classList.remove("is-error");

  try {
    const inicio = performance.now();
    const datos = await cargarViaJSONP(forzar ? `${APPS_SCRIPT_URL}?fresco=1` : APPS_SCRIPT_URL);
    if (datos && datos.error) throw new Error(datos.error);
    if (!datos || !Array.isArray(datos.columnas) || !Array.isArray(datos.filas)) {
      throw new Error("Formato inesperado: publica la última versión de apps-script/produccion.gs.");
    }
    console.info(
      `Producción: ${datos.filas.length} filas en ${Math.round(performance.now() - inicio)} ms ` +
      `(datos generados ${datos.generado}; el script tardó ${JSON.stringify(datos.ms)} ms)`
    );

    registrosOriginales = datos.filas.map((fila) => normalizarRegistro(filaAObjeto(datos.columnas, fila)));
    mapaImeiTaller = construirMapaImei(registrosOriginales);
    renderizarEntregasFiltradas(); // por si ya habían cargado antes que TALLER1

    poblarSelectorDeLotes(registrosOriginales);
    mostrarRangoDeFechasDisponible(registrosOriginales);
    el.statusLine.textContent = `${registrosOriginales.length} registros cargados.`;

    const ahora = new Date();
    el.ultimaActualizacion.textContent =
      "Última actualización: " + ahora.toLocaleString("es-PE");

    aplicarFiltrosYRenderizar();
  } catch (error) {
    console.error(error);
    el.statusLine.textContent =
      "No se pudieron cargar los datos. Revisa tu conexión o la URL del script. (" +
      error.message + ")";
    el.statusLine.classList.add("is-error");
  } finally {
    cargando = false;
    el.btnRefrescar.classList.remove("is-loading");
  }
}

// Hoja APARTE ("Equipos por tecnico"), independiente de TALLER1: se
// carga y se avisa de errores por su cuenta, para que un problema acá
// no tumbe el resto del panel (mismo criterio que otras secciones
// secundarias del dashboard).
async function cargarEntregas() {
  try {
    const datos = await cargarViaJSONP(`${APPS_SCRIPT_URL}?entregas=1`);
    if (datos && datos.error) throw new Error(datos.error);
    if (!datos || !Array.isArray(datos.columnas) || !Array.isArray(datos.filas)) {
      throw new Error("Formato inesperado: publica la última versión de apps-script/produccion.gs.");
    }
    registrosEntregas = datos.filas.map((fila) => normalizarEntrega(filaAObjeto(datos.columnas, fila)));
    mostrarUltimaFechaEntregas(registrosEntregas);
    renderizarEntregasFiltradas();
  } catch (error) {
    console.error("No se pudieron cargar los equipos por técnico:", error);
    el.tablaEntregas.innerHTML =
      `<tr><td colspan="4" class="ranking-empty">No se pudo cargar (${escaparHtml(error.message)}).</td></tr>`;
  }
}

function normalizarEntrega(fila) {
  return {
    fecha: fila["FECHA"] || "",
    hora: fila["HORA"] || "",
    imei: String(fila["IMEI"] || "").trim(),
    tecnico: normalizarNombre(fila["TECNICO"]),
    categoria: String(fila["CATEGORIA"] || "").trim(),
    estado: String(fila["ESTADO"] || "").trim().toUpperCase(),
    // Cuándo el técnico entregó el equipo (columnas "FECHA C."/"HORA
    // C." bajo el grupo "CERRADO") — vacío mientras sigue ABIERTO.
    fechaEntrega: fila["FECHA C."] || "",
    horaEntrega: fila["HORA C."] || "",
  };
}

// El script envía las filas como listas cortas (sin repetir el nombre
// de cada columna en cada fila) para que la respuesta pese poco.
function filaAObjeto(columnas, fila) {
  const objeto = {};
  columnas.forEach((nombre, i) => (objeto[nombre] = fila[i]));
  return objeto;
}

// Convierte cada fila en un objeto con nombres de campo consistentes.
// Hacemos esto UNA vez al cargar, para no repetir esta lógica cada vez
// que filtramos o dibujamos la tabla. Las fechas ya vienen del script
// como texto "AAAA-MM-DD" (o "" si la celda está vacía).
function normalizarRegistro(fila) {
  return {
    // Estas tres son las que de verdad importan para filtrar por rango:
    // cada actividad del taller quedó registrada en su propia columna.
    fechaPulido: fila["FECHA DE PULIDO"] || "",
    fechaBateria: fila["FECHA CAMBIO BATERIA"] || "",
    fechaChequeo: fila["FECHA DE CHEQUEO"] || "",
    modelo: fila["MODELO"] || "",
    capacidad: fila["CAPACIDAD"] || "",
    color: normalizarNombre(fila["COLOR"]) || "SIN COLOR",
    grado: (fila["GRADO"] || "").trim(),
    pulido: (fila["PULIDO"] || "").trim().toUpperCase(),
    tecnicoBateria: normalizarNombre(fila["BATERIA"]),
    tecnicoChequeo: normalizarNombre(fila["CHEQUEO"]),
    lote: (fila["LOTE"] || "Sin lote").trim() || "Sin lote",
    // Para cruzar con "Equipos por técnico" (misma hoja de donde ya
    // viene IMEI para Garantías, ver arriba).
    imei: String(fila["IMEI"] || "").trim(),
  };
}

// Unifica "Juan", "JUAN" y "juan  perez " para que un mismo técnico
// no aparezca repetido en el ranking.
function normalizarNombre(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ").toUpperCase();
}

// IMEI -> {modelo, capacidad, color, grado}, para que "Equipos por
// técnico" (otra hoja, que solo trae IMEI/estado/categoría) pueda
// mostrar también el modelo/color/etc. que sí vive en TALLER1.
function construirMapaImei(registros) {
  const mapa = new Map();
  registros.forEach((r) => {
    if (r.imei) mapa.set(r.imei, { modelo: r.modelo, capacidad: r.capacidad, color: r.color, grado: r.grado });
  });
  return mapa;
}

// Le muestra al usuario qué rango de fechas existe realmente en los
// datos cargados, y limita los selectores de fecha a ese rango para
// que no elija fechas donde no hay ningún registro.
function mostrarRangoDeFechasDisponible(registros) {
  const fechasValidas = registros
    .flatMap((r) => [r.fechaPulido, r.fechaBateria, r.fechaChequeo])
    .filter(Boolean)
    .sort(); // "AAAA-MM-DD" ordena bien como texto

  if (fechasValidas.length === 0) {
    el.rangoFechas.textContent = "No se encontraron fechas válidas en las columnas de pulido, batería o chequeo.";
    return;
  }

  const minClave = fechasValidas[0];
  const maxClave = fechasValidas[fechasValidas.length - 1];

  el.fechaDesde.min = minClave;
  el.fechaDesde.max = maxClave;
  el.fechaHasta.min = minClave;
  el.fechaHasta.max = maxClave;

  // Al abrir la página por primera vez, mostramos solo el último día
  // con actividad (no todo el historial). Si el usuario ya eligió
  // sus propias fechas y le da "Actualizar", no se las pisamos.
  // Ignoramos fechas futuras (típicamente errores de digitación en la
  // hoja) para no abrir el panel en un día vacío.
  if (esPrimeraCarga) {
    const hoy = new Date();
    const claveHoy = [
      hoy.getFullYear(),
      String(hoy.getMonth() + 1).padStart(2, "0"),
      String(hoy.getDate()).padStart(2, "0"),
    ].join("-");
    const clavesPasadas = fechasValidas.filter((c) => c <= claveHoy);
    const claveInicial = clavesPasadas.length ? clavesPasadas[clavesPasadas.length - 1] : maxClave;
    el.fechaDesde.value = claveInicial;
    el.fechaHasta.value = claveInicial;
    esPrimeraCarga = false;
  }

  el.rangoFechas.textContent =
    `Actividad registrada del ${formatearClaveFecha(minClave)} ` +
    `al ${formatearClaveFecha(maxClave)} ` +
    `(considerando pulido, cambio de batería y chequeo).`;
}

// "2026-09-18" -> "18/09/2026"
function formatearClaveFecha(clave) {
  const [anio, mes, dia] = clave.split("-");
  return `${dia}/${mes}/${anio}`;
}

// "ABRIL 2026A" -> [4, 2026, "A"], para poder ordenar los lotes en
// orden calendario (no alfabético: "ABRIL" quedaría antes que "ENERO").
const ORDEN_MESES = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SETIEMBRE: 9, SEPTIEMBRE: 9, OCTUBRE: 10,
  NOVIEMBRE: 11, DICIEMBRE: 12,
};

function claveOrdenLote(lote) {
  const m = lote.match(/^([A-ZÁÉÍÓÚÑ]+)\s+(\d{4})([A-Z]*)$/i);
  if (!m) return [Infinity, Infinity, lote]; // "Sin lote" u otro formato: al final
  const [, mes, anio, sufijo] = m;
  const numeroMes = ORDEN_MESES[mes.toUpperCase()] || Infinity;
  return [Number(anio), numeroMes, sufijo];
}

function compararLotes(a, b) {
  const [anioA, mesA, sufijoA] = claveOrdenLote(a);
  const [anioB, mesB, sufijoB] = claveOrdenLote(b);
  if (anioA !== anioB) return anioA - anioB;
  if (mesA !== mesB) return mesA - mesB;
  return sufijoA < sufijoB ? -1 : sufijoA > sufijoB ? 1 : 0;
}

function poblarSelectorDeLotes(registros) {
  const loteActual = el.filtroLote.value;
  const lotes = [...new Set(registros.map((r) => r.lote))].sort(compararLotes);

  el.filtroLote.innerHTML = '<option value="">Todos</option>';
  lotes.forEach((lote) => {
    const opcion = document.createElement("option");
    opcion.value = lote;
    opcion.textContent = lote;
    el.filtroLote.appendChild(opcion);
  });

  // Si el lote que estaba seleccionado sigue existiendo, lo mantenemos.
  if (lotes.includes(loteActual)) {
    el.filtroLote.value = loteActual;
  }
}

// ============================================================
// 4. FILTRADO
// ============================================================
// Filtro común para todas las secciones del panel (menos el buscador
// de IMEI, que ignora todo esto a propósito — ver sección 6).
function aplicarFiltrosComunes(registros) {
  const lote = el.filtroLote.value;
  return registros.filter((r) => !lote || r.lote === lote);
}

// true si `clave` ("AAAA-MM-DD") cae dentro de [desde, hasta]. Si
// desde/hasta están vacíos, no restringe por ese lado. Si `clave` está
// vacía (esa columna no tiene fecha en esa fila), el registro se
// excluye en cuanto se pide un rango — no tiene sentido "contarlo" en
// un rango si no sabemos cuándo pasó esa actividad.
function fechaDentroDeRango(clave, desde, hasta) {
  if (!desde && !hasta) return true;
  if (!clave) return false;
  if (desde && clave < desde) return false;
  if (hasta && clave > hasta) return false;
  return true;
}

function obtenerRangosSeleccionados() {
  return {
    desde: el.fechaDesde.value || null,
    hasta: el.fechaHasta.value || null,
  };
}

// ============================================================
// 5. AGREGACIONES (convertir filas en resúmenes)
// ============================================================
function contarPorCampo(registros, campo) {
  const conteo = new Map();
  registros.forEach((r) => {
    const valor = r[campo];
    if (!valor) return;
    conteo.set(valor, (conteo.get(valor) || 0) + 1);
  });
  return [...conteo.entries()].sort((a, b) => b[1] - a[1]);
}

// Agrupa por modelo + capacidad y, dentro de cada grupo, cuenta cuántos
// equipos hubo de cada color (para el detalle desplegable).
function contarModelos(registros) {
  const grupos = new Map();
  registros.forEach((r) => {
    const clave = `${r.modelo}||${r.capacidad}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { modelo: r.modelo, capacidad: r.capacidad, cantidad: 0, colores: new Map() });
    }
    const grupo = grupos.get(clave);
    grupo.cantidad++;
    grupo.colores.set(r.color, (grupo.colores.get(r.color) || 0) + 1);
  });
  return [...grupos.values()]
    .map((g) => ({ ...g, colores: [...g.colores.entries()].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.cantidad - a.cantidad);
}

// Agrupa los equipos de la hoja "Equipos por tecnico" por técnico,
// contando cuántos están ABIERTO (todavía en su mesa) y cuántos
// CERRADO (ya no los tiene), y guardando la lista completa para el
// detalle desplegable.
function agruparEntregasPorTecnico(registros) {
  const grupos = new Map();
  registros.forEach((r) => {
    if (!r.tecnico) return;
    if (!grupos.has(r.tecnico)) {
      grupos.set(r.tecnico, { tecnico: r.tecnico, abiertos: 0, cerrados: 0, equipos: [] });
    }
    const grupo = grupos.get(r.tecnico);
    if (r.estado === "ABIERTO") grupo.abiertos++;
    else if (r.estado === "CERRADO") grupo.cerrados++;
    // Datos del equipo (modelo/capacidad/color/grado) no viven en esta
    // hoja — se cruzan por IMEI con lo que ya trajo TALLER1.
    const datosTaller = mapaImeiTaller.get(r.imei);
    grupo.equipos.push({ ...r, ...(datosTaller || {}) });
  });
  return [...grupos.values()].sort((a, b) => (b.abiertos + b.cerrados) - (a.abiertos + a.cerrados));
}

// ============================================================
// 6. RENDERIZADO
// ============================================================
function aplicarFiltrosYRenderizar() {
  const base = aplicarFiltrosComunes(registrosOriginales);
  const { desde, hasta } = obtenerRangosSeleccionados();

  if (desde && hasta && desde > hasta) {
    el.avisoRango.hidden = false;
    renderizarHero({ total: 0, baterias: 0, chequeos: 0, pulidos: 0 });
    renderizarRanking(el.rankingBateria, []);
    renderizarRanking(el.rankingChequeo, []);
    renderizarTablaModelos([]);
    return;
  }
  el.avisoRango.hidden = true;

  // Cada actividad se mide con su propia columna de fecha.
  const registrosPulido = base.filter(
    (r) => r.pulido === "SI" && fechaDentroDeRango(r.fechaPulido, desde, hasta)
  );
  const registrosBateria = base.filter(
    (r) => r.tecnicoBateria && fechaDentroDeRango(r.fechaBateria, desde, hasta)
  );
  const registrosChequeo = base.filter(
    (r) => r.tecnicoChequeo && fechaDentroDeRango(r.fechaChequeo, desde, hasta)
  );

  // Para "modelos" consideramos que un equipo "tuvo actividad en el
  // rango" si CUALQUIERA de sus tres fechas cae dentro de lo
  // seleccionado. Si no hay rango elegido, devuelve todos (base).
  const registrosConActividad = base.filter(
    (r) =>
      fechaDentroDeRango(r.fechaPulido, desde, hasta) ||
      fechaDentroDeRango(r.fechaBateria, desde, hasta) ||
      fechaDentroDeRango(r.fechaChequeo, desde, hasta)
  );

  renderizarHero({
    total: registrosConActividad.length,
    baterias: registrosBateria.length,
    chequeos: registrosChequeo.length,
    pulidos: registrosPulido.length,
  });

  renderizarRanking(el.rankingBateria, contarPorCampo(registrosBateria, "tecnicoBateria"));
  renderizarRanking(el.rankingChequeo, contarPorCampo(registrosChequeo, "tecnicoChequeo"));
  // Solo equipos que tuvieron chequeo en el rango (no cualquier actividad).
  renderizarTablaModelos(contarModelos(registrosChequeo));
}

// "Equipos por tecnico" es una hoja totalmente aparte (distinta
// spreadsheet, distinta columna de fecha) — tiene su PROPIO filtro de
// fechas (#entregas-fecha-desde/hasta), independiente del Desde/Hasta
// general de arriba, que es solo para TALLER1.
//
// Dos modos (botones "Mostrar"/"Abierto", ver sección 9):
//   "abierto" (por defecto, al entrar): solo los ABIERTO, SIN
//             importar el rango de fechas — para ver de un vistazo
//             quién tiene equipos pendientes ahora mismo.
//   "mostrar": todo (abiertos + cerrados), respetando el rango Desde/Hasta.
function renderizarEntregasFiltradas() {
  const filtrados =
    modoEntregas === "abierto"
      ? registrosEntregas.filter((r) => r.estado === "ABIERTO")
      : registrosEntregas.filter((r) => {
          const desde = el.entregasFechaDesde.value || null;
          const hasta = el.entregasFechaHasta.value || null;
          return fechaDentroDeRango(r.fecha, desde, hasta);
        });
  renderizarTablaEntregas(agruparEntregasPorTecnico(filtrados));
}

function actualizarBotonesModoEntregas() {
  el.entregasBtnMostrar.classList.toggle("is-active", modoEntregas === "mostrar");
  el.entregasBtnAbierto.classList.toggle("is-active", modoEntregas === "abierto");
}

// Al cargar por primera vez, deja seleccionado el día más reciente que
// SÍ tiene datos (si el usuario ya eligió algo, no se lo pisamos).
function mostrarUltimaFechaEntregas(registros) {
  if (el.entregasFechaDesde.value || el.entregasFechaHasta.value) return;
  const fechas = registros.map((r) => r.fecha).filter(Boolean).sort();
  if (fechas.length === 0) return;
  const ultima = fechas[fechas.length - 1];
  el.entregasFechaDesde.value = ultima;
  el.entregasFechaHasta.value = ultima;
}

function renderizarHero({ total, baterias, chequeos, pulidos }) {
  el.statTotal.textContent = total;
  el.statBaterias.textContent = baterias;
  el.statChequeos.textContent = chequeos;
  el.statPulidos.textContent = pulidos;
}

function renderizarRanking(contenedor, entradas) {
  contenedor.innerHTML = "";

  if (entradas.length === 0) {
    contenedor.innerHTML = '<p class="ranking-empty">Sin datos en este rango.</p>';
    return;
  }

  const maximo = entradas[0][1];

  entradas.forEach(([nombre, cantidad]) => {
    const porcentaje = Math.round((cantidad / maximo) * 100);

    const fila = document.createElement("div");
    fila.className = "ranking-row";
    fila.innerHTML = `
      <span class="ranking-name">${escaparHtml(nombre)}</span>
      <span class="ranking-track">
        <span class="ranking-fill" style="width:${porcentaje}%"></span>
      </span>
      <span class="ranking-value">${cantidad}</span>
    `;
    contenedor.appendChild(fila);
  });
}

// Cada modelo es una fila clicable; justo debajo va una fila oculta con
// los colores que salieron. Se abre/cierra con clic o con Enter/Espacio.
function renderizarTablaModelos(filas) {
  if (filas.length === 0) {
    el.tablaModelos.innerHTML =
      '<tr><td colspan="3" class="ranking-empty">Sin datos en este rango.</td></tr>';
    return;
  }

  el.tablaModelos.innerHTML = filas
    .map((f, i) => {
      const colores = f.colores
        .map(([color, n]) => `<li><span>${escaparHtml(color)}</span> <strong>${n}</strong></li>`)
        .join("");
      return `
      <tr class="fila-modelo" tabindex="0" role="button" aria-expanded="false" aria-controls="colores-${i}">
        <td><span class="chevron" aria-hidden="true">▸</span>${escaparHtml(f.modelo || "(Sin modelo)")}</td>
        <td>${escaparHtml(f.capacidad)}</td>
        <td>${f.cantidad}</td>
      </tr>
      <tr class="fila-colores" id="colores-${i}" hidden>
        <td colspan="3"><ul class="lista-colores">${colores}</ul></td>
      </tr>`;
    })
    .join("");
}

function alternarColores(filaModelo) {
  const abierta = filaModelo.getAttribute("aria-expanded") === "true";
  filaModelo.setAttribute("aria-expanded", String(!abierta));
  filaModelo.nextElementSibling.hidden = abierta;
}

// Mismo patrón "fila clicable + detalle desplegable" que Modelos
// (reutiliza las clases .fila-modelo/.fila-colores/.lista-colores y el
// propio alternarColores — es el mismo comportamiento, solo cambia el
// contenido). IDs con prefijo distinto ("equipos-entrega-N") para no
// chocar con los de #tabla-modelos.
function renderizarTablaEntregas(filas) {
  const totalAbiertos = filas.reduce((suma, f) => suma + f.abiertos, 0);
  const totalCerrados = filas.reduce((suma, f) => suma + f.cerrados, 0);
  el.entregasTotalAbiertos.textContent = `(${totalAbiertos})`;
  el.entregasTotalCerrados.textContent = `(${totalCerrados})`;
  el.entregasTotalGeneral.textContent = `(${totalAbiertos + totalCerrados})`;

  if (filas.length === 0) {
    el.tablaEntregas.innerHTML =
      '<tr><td colspan="4" class="ranking-empty">Sin datos en este rango.</td></tr>';
    return;
  }

  el.tablaEntregas.innerHTML = filas
    .map((f, i) => {
      const filasEquipo = f.equipos
        .map((e) => {
          const clase = e.estado === "ABIERTO" ? "badge-estado--warn" : "badge-estado--good";
          return `
            <tr>
              <td>${escaparHtml(formatearFechaClave(e.fecha))}</td>
              <td>${escaparHtml(e.hora || "—")}</td>
              <td>${escaparHtml(e.imei || "—")}</td>
              <td>${escaparHtml(e.modelo || "—")}</td>
              <td>${escaparHtml(e.capacidad || "—")}</td>
              <td>${escaparHtml(e.color || "—")}</td>
              <td>${escaparHtml(e.grado || "—")}</td>
              <td>${escaparHtml(e.categoria || "—")}</td>
              <td><span class="badge-estado ${clase}">${escaparHtml(e.estado)}</span></td>
              <td>${escaparHtml(formatearFechaClave(e.fechaEntrega))}</td>
              <td>${escaparHtml(e.horaEntrega || "—")}</td>
            </tr>`;
        })
        .join("");
      const equipos = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Fecha</th><th>Hora</th><th>IMEI</th><th>Modelo</th><th>Capacidad</th>
              <th>Color</th><th>Grado</th><th>Categoría</th><th>Estado</th>
              <th>Fecha entrega</th><th>Hora entrega</th>
            </tr>
          </thead>
          <tbody>${filasEquipo}</tbody>
        </table>`;
      return `
      <tr class="fila-modelo" tabindex="0" role="button" aria-expanded="false" aria-controls="equipos-entrega-${i}">
        <td><span class="chevron" aria-hidden="true">▸</span>${escaparHtml(f.tecnico)}</td>
        <td>${f.abiertos}</td>
        <td>${f.cerrados}</td>
        <td>${f.abiertos + f.cerrados}</td>
      </tr>
      <tr class="fila-colores" id="equipos-entrega-${i}" hidden>
        <td colspan="4">${equipos}</td>
      </tr>`;
    })
    .join("");
}

// ============================================================
// 6b. ESCANEO DE IMEI ("Registrar equipos") — abrir/cerrar equipos en
// "Equipos por tecnico" directo desde el dashboard. Reutiliza el
// mismo look de ".tk-fotos-seleccionadas" (lista con "✕" para quitar)
// que ya usa Tickets para fotos elegidas.
// ============================================================
const ESCANEO_DESTINOS = ["Encaje", "Reparación", "Piezas", "Muerto"];
const ESCANEO_CATEGORIAS_REPARACION = ["Lote", "Reparación"];

// Misma lista que el selector "Técnico" del modo Abrir (index.html).
function tecnicosEscaneo() {
  return Array.from(el.escaneoTecnico.options)
    .map((opcion) => opcion.value)
    .filter(Boolean);
}

function etiquetaMensaje(mensaje) {
  return mensaje.length ? mensaje.slice().sort((a, b) => a - b).join(" - ") : "Mensaje…";
}

function opcionesSelect(placeholder, valores, elegido) {
  return (
    `<option value="">${placeholder}</option>` +
    valores
      .map((v) => `<option value="${escaparHtml(v)}" ${v === elegido ? "selected" : ""}>${escaparHtml(v)}</option>`)
      .join("")
  );
}

function renderizarListaEscaneo() {
  el.escaneoLista.hidden = escaneoImeis.length === 0;
  el.escaneoLista.innerHTML = escaneoImeis
    .map(({ imei, mensaje, destino, reparacion, categoria, tecnicoReparacion }, indice) => {
      const camposCierre =
        escaneoModo === "cerrar"
          ? `
        <div class="tk-mensaje-dropdown">
          <button type="button" class="tk-mensaje-dropdown-boton" data-indice="${indice}"
                  aria-haspopup="true" aria-expanded="false">${escaparHtml(etiquetaMensaje(mensaje))}</button>
          <div class="tk-mensaje-dropdown-panel" role="group" aria-label="Mensaje de ${escaparHtml(imei)}" hidden>
            ${[1, 2, 3, 4, 5]
              .map(
                (n) => `
              <label class="tk-mensaje-dropdown-opcion">
                <input type="checkbox" data-indice="${indice}" data-valor="${n}" ${mensaje.includes(n) ? "checked" : ""} />${n}
              </label>`
              )
              .join("")}
          </div>
        </div>
        <select class="tk-escaneo-campo" data-indice="${indice}" data-campo="destino" aria-label="Destino de ${escaparHtml(imei)}">
          ${opcionesSelect("Destino…", ESCANEO_DESTINOS, destino)}
        </select>
        <input type="text" class="tk-escaneo-campo tk-escaneo-reparacion" data-indice="${indice}" data-campo="reparacion"
               placeholder="Reparación" value="${escaparHtml(reparacion)}" aria-label="Reparación de ${escaparHtml(imei)}" />
        <select class="tk-escaneo-campo" data-indice="${indice}" data-campo="categoria" aria-label="Categoría de ${escaparHtml(imei)}">
          ${opcionesSelect("Categoría…", ESCANEO_CATEGORIAS_REPARACION, categoria)}
        </select>
        <select class="tk-escaneo-campo" data-indice="${indice}" data-campo="tecnicoReparacion" aria-label="Técnico que reparó ${escaparHtml(imei)}">
          ${opcionesSelect("Técnico…", tecnicosEscaneo(), tecnicoReparacion)}
        </select>`
          : "";
      return `
      <div class="tk-foto-seleccionada">
        <span class="tk-foto-seleccionada-nombre">${escaparHtml(imei)}</span>
        ${camposCierre}
        <button type="button" class="tk-foto-quitar" data-indice="${indice}" aria-label="Quitar ${escaparHtml(imei)}">✕</button>
      </div>`;
    })
    .join("");
}

// Se cierra tocando el DOM (sin re-renderizar) para no quitarle el foco
// al campo "Reparación" si el clic que cierra el menú cae ahí.
function cerrarMenusMensaje(excepto) {
  el.escaneoLista.querySelectorAll(".tk-mensaje-dropdown").forEach((menu) => {
    if (menu === excepto) return;
    menu.querySelector(".tk-mensaje-dropdown-panel").hidden = true;
    menu.querySelector(".tk-mensaje-dropdown-boton").setAttribute("aria-expanded", "false");
  });
}

function agregarImeiEscaneo(valorCrudo) {
  const imei = String(valorCrudo || "").replace(/\D/g, "");
  if (imei.length < MIN_DIGITOS_IMEI_ESCANEO) {
    el.escaneoStatus.textContent = `Escribe/escanea un IMEI de al menos ${MIN_DIGITOS_IMEI_ESCANEO} dígitos.`;
    el.escaneoStatus.classList.add("is-error");
    return;
  }
  if (escaneoImeis.some((item) => item.imei === imei)) {
    el.escaneoStatus.textContent = `El IMEI ${imei} ya está en la lista.`;
    el.escaneoStatus.classList.add("is-error");
    return;
  }
  escaneoImeis.push({ imei, mensaje: [], destino: "", reparacion: "", categoria: "", tecnicoReparacion: "" });
  el.escaneoStatus.textContent = "";
  el.escaneoStatus.classList.remove("is-error");
  renderizarListaEscaneo();
}

function quitarImeiEscaneo(indice) {
  escaneoImeis.splice(indice, 1);
  renderizarListaEscaneo();
}

function actualizarModoEscaneo() {
  escaneoModo = el.escaneoModoCerrar.checked ? "cerrar" : "abrir";
  el.escaneoCamposAbrir.hidden = escaneoModo === "cerrar";
  renderizarListaEscaneo(); // muestra/oculta los campos de cierre por IMEI
}

async function aceptarEscaneo() {
  if (escaneoImeis.length === 0) {
    el.escaneoStatus.textContent = "Escanea al menos un IMEI antes de aceptar.";
    el.escaneoStatus.classList.add("is-error");
    return;
  }

  const parametros = new URLSearchParams();
  parametros.set("accion", "registrarEntregas");
  parametros.set("modo", escaneoModo);

  if (escaneoModo === "abrir") {
    const tecnico = el.escaneoTecnico.value;
    const categoria = el.escaneoCategoria.value;
    if (!tecnico || !categoria) {
      el.escaneoStatus.textContent = "Elige técnico y categoría antes de aceptar.";
      el.escaneoStatus.classList.add("is-error");
      return;
    }
    parametros.set("tecnico", tecnico.toUpperCase());
    parametros.set("categoria", categoria);
    parametros.set("imeis", JSON.stringify(escaneoImeis.map((item) => item.imei)));
  } else {
    const sinCategoria = escaneoImeis.filter((item) => item.reparacion.trim() && !item.categoria);
    if (sinCategoria.length) {
      el.escaneoStatus.textContent = `Elige la categoría de la reparación de: ${sinCategoria.map((item) => item.imei).join(", ")}.`;
      el.escaneoStatus.classList.add("is-error");
      return;
    }
    const items = escaneoImeis.map((item) => ({
      imei: item.imei,
      mensaje: item.mensaje.slice().sort((a, b) => a - b).join(" - "),
      destino: item.destino,
      reparacion: item.reparacion.trim(),
      categoria: item.categoria,
      tecnicoReparacion: item.tecnicoReparacion.toUpperCase(),
      modelo: (mapaImeiTaller.get(item.imei) || {}).modelo || "",
    }));
    parametros.set("imeis", JSON.stringify(items));
  }

  el.escaneoBtnAceptar.disabled = true;
  el.escaneoStatus.classList.remove("is-error");
  el.escaneoStatus.textContent = "Guardando…";

  try {
    const datos = await cargarViaJSONP(`${APPS_SCRIPT_URL}?${parametros.toString()}`);
    if (datos && datos.error) throw new Error(datos.error);

    if (escaneoModo === "abrir") {
      el.escaneoStatus.textContent = `${datos.agregados} equipo(s) agregado(s).`;
    } else {
      const aviso = datos.noEncontrados.length
        ? ` No se encontró abierto: ${datos.noEncontrados.join(", ")}.`
        : "";
      const reparados = datos.reparados ? ` ${datos.reparados} reparación(es) anotada(s).` : "";
      el.escaneoStatus.textContent = `${datos.cerrados.length} cerrado(s).${reparados}${aviso}`;
      if (datos.noEncontrados.length) el.escaneoStatus.classList.add("is-error");
    }

    escaneoImeis = [];
    renderizarListaEscaneo();
    cargarEntregas(); // refresca "Equipos por técnico" con el cambio recién hecho
  } catch (error) {
    console.error(error);
    el.escaneoStatus.textContent = "No se pudo guardar. (" + error.message + ")";
    el.escaneoStatus.classList.add("is-error");
  } finally {
    el.escaneoBtnAceptar.disabled = false;
  }
}

// ============================================================
// 7. BÚSQUEDA POR IMEI (independiente de fecha y lote)
// ============================================================
// Busca en TODA la información sin importar los filtros de fecha o
// lote. Como el panel ya no descarga las columnas de detalle, la
// búsqueda se le pide al Apps Script (?imei=...), que devuelve solo las
// filas que coinciden con todas sus columnas.
const ETIQUETAS_DETALLE_IMEI = [
  ["MODELO", "Modelo", "texto"],
  ["CAPACIDAD", "Capacidad", "texto"],
  ["IMEI", "IMEI", "texto"],
  ["imei 2", "IMEI 2", "texto"],
  ["% BATERIA", "% Batería", "porcentaje"],
  ["CICLOS", "Ciclos", "texto"],
  ["GRADO", "Grado", "texto"],
  ["COLOR", "Color", "texto"],
  ["N° MODELO", "N° modelo", "texto"],
  ["LOTE", "Lote", "texto"],
  ["FECHA", "Fecha de ingreso", "fecha"],
  ["PULIDOR", "Pulidor", "texto"],
  ["FECHA DE PULIDO", "Fecha de pulido", "fecha"],
  ["PULIDO", "Pulido", "texto"],
  ["HABILITADOR", "Habilitador", "texto"],
  ["FECHA CAMBIO BATERIA", "Fecha cambio de batería", "fecha"],
  ["BATERIA", "Técnico batería", "texto"],
  ["FECHA DE CHEQUEO", "Fecha de chequeo", "fecha"],
  ["CHEQUEO", "Técnico chequeo", "texto"],
  ["MANCHA DE CAMARA", "Mancha de cámara", "texto"],
  ["FALLA", "Falla", "texto"],
  ["MENSAJE", "Mensaje", "texto"],
  ["OBSERVACIONES", "Observaciones", "texto"],
  ["PIEZA CAMBIADA (ORIGINAL)", "Pieza cambiada (original)", "texto"],
  ["GRADO ORIGEN", "Grado origen", "texto"],
];

function formatearValorDetalle(valor, tipo) {
  if (valor === null || valor === undefined || valor === "") return "—";

  if (tipo === "fecha") {
    const fecha = new Date(valor);
    if (isNaN(fecha)) return "—";
    return fecha.toLocaleDateString("es-PE", { timeZone: "UTC" });
  }

  if (tipo === "porcentaje") {
    const numero = Number(valor);
    return isNaN(numero) ? "—" : Math.round(numero * 100) + "%";
  }

  return String(valor);
}

function renderizarDetalleImei(registro) {
  const campos = ETIQUETAS_DETALLE_IMEI.map(([clave, etiqueta, tipo]) => {
    const valor = formatearValorDetalle(registro[clave], tipo);
    return `
      <div class="imei-field">
        <span class="imei-field-label">${escaparHtml(etiqueta)}</span>
        <span class="imei-field-value">${escaparHtml(valor)}</span>
      </div>`;
  }).join("");

  const imei = String(registro["IMEI"] || "").replace(/\D/g, "");

  return `
    <div class="imei-result-block">
      <div class="imei-detail">${campos}</div>
      ${imei ? `
        <button type="button" class="btn-historial-imei" data-imei="${escaparHtml(imei)}">Ver historial de correos ▾</button>
        <div class="historial-imei-panel" data-imei="${escaparHtml(imei)}" hidden></div>
      ` : ""}
    </div>`;
}

// ----------------------------------------------------------
// Historial de un IMEI (correos de JotForm: recepción + informe técnico)
// Mismo endpoint y misma forma de datos que usa Garantías.
// ----------------------------------------------------------
// Solo un historial abierto a la vez: al abrir uno, se cierra el que
// estuviera abierto antes (si era otro).
let panelHistorialAbierto = null; // { boton, panel } o null

async function alternarHistorialImei(boton) {
  const panel = boton.nextElementSibling;
  if (!panel || !panel.classList.contains("historial-imei-panel")) return;

  const yaAbierto = !panel.hidden;

  if (panelHistorialAbierto && panelHistorialAbierto.panel !== panel) {
    panelHistorialAbierto.panel.hidden = true;
    panelHistorialAbierto.boton.textContent = "Ver historial de correos ▾";
  }

  const abrir = !yaAbierto;
  panel.hidden = !abrir;
  boton.textContent = abrir ? "Ocultar historial ▴" : "Ver historial de correos ▾";
  panelHistorialAbierto = abrir ? { boton, panel } : null;
  if (!abrir) return;

  const imei = boton.dataset.imei;

  if (historialImeiCache.has(imei)) {
    panel.innerHTML = renderizarHistorialImei(historialImeiCache.get(imei));
    return;
  }

  panel.innerHTML = '<p class="imei-not-found">Cargando historial…</p>';
  try {
    const datos = await cargarViaJSONP(`${URL_CORREOS}?imei=${encodeURIComponent(imei)}`);
    if (datos && datos.error) throw new Error(datos.error);
    if (!datos || !Array.isArray(datos.eventos)) {
      throw new Error("Formato inesperado: revisa que apps-script/correos.gs esté publicado.");
    }
    historialImeiCache.set(imei, datos);
    panel.innerHTML = renderizarHistorialImei(datos);
  } catch (error) {
    console.error(error);
    panel.innerHTML = `<p class="imei-not-found">No se pudo cargar el historial. (${escaparHtml(error.message)})</p>`;
  }
}

// `claseVacio` es la clase CSS de los mensajes informativos (no error):
// Producción usa "imei-not-found", pero Garantías (que reutiliza esta
// misma función) usa "ranking-empty" para que combine con el resto de
// su vista.
function renderizarHistorialImei(datos, claseVacio = "imei-not-found") {
  if (datos.eventos.length === 0) {
    return `<p class="${claseVacio}">No se encontraron correos de JotForm para este IMEI.</p>`;
  }

  const avisoClientes = datos.clientesDistintos > 1
    ? `<p class="aviso-clientes-imei">⚠ ${datos.clientesDistintos} clientes distintos han tenido este equipo: ${escaparHtml(datos.clientes.map((c) => c.nombre || c.correo).join(", "))}</p>`
    : `<p class="${claseVacio}">${datos.clientesDistintos} cliente registrado para este equipo.</p>`;

  const eventosHtml = datos.eventos.map((ev) => renderizarEventoHistorial(ev, datos.imei)).join("");

  return `<div class="historial-imei">${avisoClientes}${eventosHtml}</div>`;
}

// Un ticket trae dos correos separados (Recepción e Informe Técnico).
// Se muestran como una sola tarjeta con dos secciones (una por cada
// correo), separadas por una línea — cada una repite el ticket y su
// propia fecha, igual que en el papel que arma JotForm.
function renderizarEventoHistorial(ev, imei) {
  const seccionRecepcion = ev.fechaRecepcion || ev.falla
    ? `
      <div class="historial-seccion">
        <div class="historial-seccion-titulo">
          <span class="historial-seccion-nombre">Recepción</span>
          <span class="historial-seccion-meta"><strong>${escaparHtml(ev.ticket || "—")}</strong>${escaparHtml(formatearFechaClave(ev.fechaRecepcion))}</span>
        </div>
        <div class="historial-columnas">
          ${columnaHistorial([
            ["Razón", ev.razon],
            ["Sede", ev.sede],
            ["Comprobante", ev.comprobante],
            // fechaComprobante no se reformatea: a diferencia de
            // fechaRecepcion/fechaInforme (que arma este script con
            // Utilities.formatDate), este texto es tal cual lo escribió
            // JotForm en la tabla del correo (ya en formato DD-MM-AAAA).
            ["Fecha de comprobante", ev.fechaComprobante],
          ])}
          ${columnaHistorial([
            ["Nombre", ev.nombre],
            ["Correo", ev.correo],
            ["Teléfono", ev.telefono],
            ["Modelo", ev.modelo],
            ["IMEI", imei],
          ])}
        </div>
        ${cajaTextoHistorial("Problema reportado por el cliente", ev.falla)}
      </div>`
    : "";

  const seccionInforme = ev.fechaInforme || ev.diagnostico
    ? `
      <div class="historial-seccion">
        <div class="historial-seccion-titulo">
          <span class="historial-seccion-nombre">Informe</span>
          <span class="historial-seccion-meta"><strong>${escaparHtml(ev.ticket || "—")}</strong>${escaparHtml(formatearFechaClave(ev.fechaInforme))}</span>
        </div>
        <div class="historial-columnas">
          ${columnaHistorial([["Conclusión del caso/ticket", ev.conclusion]])}
          ${columnaHistorial([["Técnico", ev.tecnico]])}
        </div>
        ${cajaTextoHistorial("Diagnostico técnico y conclusión", ev.diagnostico)}
      </div>`
    : "";

  return `<div class="historial-evento">${seccionRecepcion}${seccionInforme}</div>`;
}

// Una columna de "etiqueta: valor" (el mismo look que ya usa el detalle
// de Producción). Los pares sin valor no ocupan espacio; si la columna
// entera queda vacía, no se dibuja.
function columnaHistorial(pares) {
  const campos = pares
    .filter(([, valor]) => valor)
    .map(
      ([etiqueta, valor]) => `
      <div class="imei-field">
        <span class="imei-field-label">${escaparHtml(etiqueta)}</span>
        <span class="imei-field-value">${escaparHtml(valor)}</span>
      </div>`
    )
    .join("");
  return campos ? `<div class="historial-columna">${campos}</div>` : "";
}

// Recuadro para el texto largo (falla / diagnóstico), con los saltos
// de línea que ya vienen del correo.
function cajaTextoHistorial(titulo, texto) {
  if (!texto) return "";
  return `
    <div class="historial-caja-texto">
      <span class="historial-caja-titulo">${escaparHtml(titulo)}</span>
      ${escaparHtml(texto).replace(/\n/g, "<br>")}
    </div>`;
}

function formatearFechaClave(clave) {
  if (!clave) return "—";
  const [anio, mes, dia] = clave.split("-");
  return `${dia}/${mes}/${anio}`;
}

const MIN_DIGITOS_IMEI = 4;

let temporizadorImei = null;
let idBusquedaImei = 0;

// Espera a que el usuario deje de escribir antes de consultar, para no
// mandar una petición por cada tecla.
function programarBusquedaImei() {
  clearTimeout(temporizadorImei);
  temporizadorImei = setTimeout(buscarPorImei, 400);
}

async function buscarPorImei() {
  const texto = el.buscadorImei.value.trim();
  const id = ++idBusquedaImei; // invalida cualquier búsqueda anterior aún en curso

  if (!texto) {
    el.panelBusquedaImei.hidden = true;
    el.resultadoImei.innerHTML = "";
    return;
  }

  const busquedaLimpia = texto.replace(/\s+/g, "");

  el.panelBusquedaImei.hidden = false;

  if (busquedaLimpia.length < MIN_DIGITOS_IMEI) {
    el.resultadoImei.innerHTML =
      `<p class="imei-not-found">Escribe al menos ${MIN_DIGITOS_IMEI} dígitos del IMEI.</p>`;
    return;
  }

  el.resultadoImei.innerHTML = '<p class="imei-not-found">Buscando…</p>';

  try {
    const url = `${APPS_SCRIPT_URL}?imei=${encodeURIComponent(busquedaLimpia)}`;
    const respuesta = await cargarViaJSONP(url);
    if (id !== idBusquedaImei) return; // el usuario ya escribió otra cosa
    if (respuesta.error) throw new Error(respuesta.error);

    if (respuesta.filas.length === 0) {
      el.resultadoImei.innerHTML =
        '<p class="imei-not-found">No se encontró ningún equipo con ese IMEI.</p>';
      return;
    }

    let html = respuesta.filas.map(renderizarDetalleImei).join("");
    if (respuesta.total > respuesta.filas.length) {
      html += `<p class="imei-not-found">Mostrando ${respuesta.filas.length} de ${respuesta.total} coincidencias. Escribe más dígitos para acotar.</p>`;
    }
    el.resultadoImei.innerHTML = html;
  } catch (error) {
    if (id !== idBusquedaImei) return;
    console.error(error);
    el.resultadoImei.innerHTML =
      `<p class="imei-not-found">No se pudo buscar. (${escaparHtml(error.message)})</p>`;
  }
}

// ============================================================
// 8. UTILIDADES
// ============================================================
// Evita que texto proveniente de la hoja rompa el HTML o inyecte
// código si alguien escribe algo raro en una celda.
function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = String(texto);
  // textContent -> innerHTML escapa & < > pero NO las comillas (no hacen
  // falta dentro de un nodo de texto). Varias vistas también usan esta
  // función para armar atributos (ej. data-imei="${escaparHtml(...)}"),
  // donde una comilla sin escapar sí podría cortar el atributo — se
  // escapan aquí también, así el resultado es seguro en los dos casos.
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================
// 9. EVENTOS
// ============================================================
el.btnRefrescar.addEventListener("click", () => {
  cargarDatos(true);
  cargarEntregas();
});
el.fechaDesde.addEventListener("change", aplicarFiltrosYRenderizar);
el.fechaHasta.addEventListener("change", aplicarFiltrosYRenderizar);
el.entregasFechaDesde.addEventListener("change", renderizarEntregasFiltradas);
el.entregasFechaHasta.addEventListener("change", renderizarEntregasFiltradas);
el.entregasBtnMostrar.addEventListener("click", () => {
  modoEntregas = "mostrar";
  actualizarBotonesModoEntregas();
  renderizarEntregasFiltradas();
});
el.entregasBtnAbierto.addEventListener("click", () => {
  modoEntregas = "abierto";
  actualizarBotonesModoEntregas();
  renderizarEntregasFiltradas();
});
actualizarBotonesModoEntregas(); // estado visual inicial ("Abierto" activo)

el.escaneoModoAbrir.addEventListener("change", actualizarModoEscaneo);
el.escaneoModoCerrar.addEventListener("change", actualizarModoEscaneo);
el.escaneoImeiInput.addEventListener("keydown", (evento) => {
  if (evento.key !== "Enter") return;
  evento.preventDefault();
  agregarImeiEscaneo(el.escaneoImeiInput.value);
  el.escaneoImeiInput.value = "";
  el.escaneoImeiInput.focus(); // para seguir escaneando sin tocar el mouse
});
el.escaneoLista.addEventListener("click", (evento) => {
  const quitar = evento.target.closest(".tk-foto-quitar");
  if (quitar) {
    quitarImeiEscaneo(Number(quitar.dataset.indice));
    return;
  }
  const boton = evento.target.closest(".tk-mensaje-dropdown-boton");
  if (boton) {
    const menu = boton.closest(".tk-mensaje-dropdown");
    const panel = menu.querySelector(".tk-mensaje-dropdown-panel");
    cerrarMenusMensaje(menu);
    panel.hidden = !panel.hidden;
    boton.setAttribute("aria-expanded", String(!panel.hidden));
  }
});
el.escaneoLista.addEventListener("change", (evento) => {
  const casilla = evento.target.closest(".tk-mensaje-dropdown-panel input[type=checkbox]");
  if (casilla) {
    const item = escaneoImeis[Number(casilla.dataset.indice)];
    if (!item) return;
    const valor = Number(casilla.dataset.valor);
    if (casilla.checked) {
      if (!item.mensaje.includes(valor)) item.mensaje.push(valor);
    } else {
      item.mensaje = item.mensaje.filter((n) => n !== valor);
    }
    casilla.closest(".tk-mensaje-dropdown").querySelector(".tk-mensaje-dropdown-boton").textContent =
      etiquetaMensaje(item.mensaje);
    return;
  }
  const campo = evento.target.closest("select.tk-escaneo-campo");
  if (campo) {
    const item = escaneoImeis[Number(campo.dataset.indice)];
    if (item) item[campo.dataset.campo] = campo.value;
  }
});
el.escaneoLista.addEventListener("input", (evento) => {
  const campo = evento.target.closest("input.tk-escaneo-campo");
  if (!campo) return;
  const item = escaneoImeis[Number(campo.dataset.indice)];
  if (item) item[campo.dataset.campo] = campo.value;
});
// Cierra el desplegable de "Mensaje" al hacer clic fuera de él.
document.addEventListener("click", (evento) => {
  if (evento.target.closest(".tk-mensaje-dropdown")) return;
  cerrarMenusMensaje(null);
});
el.escaneoBtnLimpiar.addEventListener("click", () => {
  escaneoImeis = [];
  el.escaneoStatus.textContent = "";
  el.escaneoStatus.classList.remove("is-error");
  renderizarListaEscaneo();
});
el.escaneoBtnAceptar.addEventListener("click", aceptarEscaneo);
el.filtroLote.addEventListener("change", aplicarFiltrosYRenderizar);
el.buscadorImei.addEventListener("input", programarBusquedaImei);
if (el.btnTema) {
  el.btnTema.addEventListener("click", () => aplicarTema(temaActual() === "light" ? "dark" : "light"));
}
el.tablaModelos.addEventListener("click", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila) alternarColores(fila);
});
el.resultadoImei.addEventListener("click", (evento) => {
  const boton = evento.target.closest(".btn-historial-imei");
  if (boton) alternarHistorialImei(boton);
});
el.tablaModelos.addEventListener("keydown", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila && (evento.key === "Enter" || evento.key === " ")) {
    evento.preventDefault();
    alternarColores(fila);
  }
});
el.tablaEntregas.addEventListener("click", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila) alternarColores(fila);
});
el.tablaEntregas.addEventListener("keydown", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila && (evento.key === "Enter" || evento.key === " ")) {
    evento.preventDefault();
    alternarColores(fila);
  }
});

// ============================================================
// 10. NAVEGACIÓN ENTRE VISTAS
// ============================================================
// Cada vista registra su cargador en `cargadoresDeVista`. Al abrir la
// página se lanzan TODOS a la vez, así los datos de cada pestaña ya
// están listos (o casi) cuando el usuario cambia de una a otra.
const cargadoresDeVista = {
  produccion: () => {
    cargarDatos();
    cargarEntregas();
  },
};

function mostrarVista(nombre) {
  if (!document.getElementById(`vista-${nombre}`)) nombre = "produccion";

  document.querySelectorAll(".vista").forEach((vista) => {
    vista.hidden = vista.id !== `vista-${nombre}`;
  });
  document.querySelectorAll(".nav-link[data-vista]").forEach((enlace) => {
    enlace.classList.toggle("nav-link--active", enlace.dataset.vista === nombre);
  });
}

const vistaDesdeHash = () => location.hash.replace("#", "") || "produccion";

window.addEventListener("hashchange", () => mostrarVista(vistaDesdeHash()));

// ============================================================
// 11. ARRANQUE
// ============================================================
// No se auto-ejecuta: la dispara auth.js una sola vez que confirma que
// hay sesión iniciada (ver mostrarApp() ahí). Para ese entonces
// reparacion.js/garantias.js/tickets.js ya registraron su cargador en
// cargadoresDeVista (auth.js espera a DOMContentLoaded antes de llamarla).
window.iniciarApp = function () {
  mostrarVista(vistaDesdeHash());
  Object.values(cargadoresDeVista).forEach((cargar) => cargar());
};
