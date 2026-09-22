// ============================================================
// 1. CONFIGURACIÓN
// ============================================================
// Esta es la URL de tu Apps Script (la que termina en /exec).
// Si vuelves a implementar una "Nueva versión" del script, la URL
// no cambia, así que normalmente no necesitas tocar esto de nuevo.
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbxIRRSKngAHHfxOMtb-bNCDnWzPiU353fCy0-PFVkWXftGAM6Mkw1tcwEWrclyKgag9pg/exec";

// Aquí guardamos en memoria todos los registros que trae la hoja,
// sin filtrar. Cada vez que el usuario cambia un filtro, partimos
// de este arreglo y lo volvemos a filtrar — nunca volvemos a pedirle
// los datos a Google a menos que el usuario le dé "Actualizar".
let registrosOriginales = [];
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

    const separador = url.includes("?") ? "&" : "?";
    etiquetaScript.src = `${url}${separador}callback=${nombreCallback}`;
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
    pulido: (fila["PULIDO"] || "").trim().toUpperCase(),
    tecnicoBateria: normalizarNombre(fila["BATERIA"]),
    tecnicoChequeo: normalizarNombre(fila["CHEQUEO"]),
    lote: (fila["LOTE"] || "Sin lote").trim() || "Sin lote",
  };
}

// Unifica "Juan", "JUAN" y "juan  perez " para que un mismo técnico
// no aparezca repetido en el ranking.
function normalizarNombre(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ").toUpperCase();
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

function poblarSelectorDeLotes(registros) {
  const loteActual = el.filtroLote.value;
  const lotes = [...new Set(registros.map((r) => r.lote))].sort();

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
  renderizarTablaModelos(contarModelos(registrosConActividad));
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

// ============================================================
// 6. BÚSQUEDA POR IMEI (independiente de fecha y lote)
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

  return `<div class="imei-result-block"><div class="imei-detail">${campos}</div></div>`;
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
// 7. UTILIDADES
// ============================================================
// Evita que texto proveniente de la hoja rompa el HTML o inyecte
// código si alguien escribe algo raro en una celda.
function escaparHtml(texto) {
  const div = document.createElement("div");
  div.textContent = String(texto);
  return div.innerHTML;
}

// ============================================================
// 8. EVENTOS
// ============================================================
el.btnRefrescar.addEventListener("click", () => cargarDatos(true));
el.fechaDesde.addEventListener("change", aplicarFiltrosYRenderizar);
el.fechaHasta.addEventListener("change", aplicarFiltrosYRenderizar);
el.filtroLote.addEventListener("change", aplicarFiltrosYRenderizar);
el.buscadorImei.addEventListener("input", programarBusquedaImei);
if (el.btnTema) {
  el.btnTema.addEventListener("click", () => aplicarTema(temaActual() === "light" ? "dark" : "light"));
}
el.tablaModelos.addEventListener("click", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila) alternarColores(fila);
});
el.tablaModelos.addEventListener("keydown", (evento) => {
  const fila = evento.target.closest(".fila-modelo");
  if (fila && (evento.key === "Enter" || evento.key === " ")) {
    evento.preventDefault();
    alternarColores(fila);
  }
});

// ============================================================
// 9. NAVEGACIÓN ENTRE VISTAS
// ============================================================
// Cada vista registra su cargador en `cargadoresDeVista`. Al abrir la
// página se lanzan TODOS a la vez, así los datos de cada pestaña ya
// están listos (o casi) cuando el usuario cambia de una a otra.
const cargadoresDeVista = { produccion: cargarDatos };

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
// 10. ARRANQUE
// ============================================================
// Esperamos a DOMContentLoaded para que reparacion.js (que se carga
// después) ya haya registrado su cargador.
document.addEventListener("DOMContentLoaded", () => {
  mostrarVista(vistaDesdeHash());
  Object.values(cargadoresDeVista).forEach((cargar) => cargar());
});
