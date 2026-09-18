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
let esPrimeraCarga = true; // solo queremos fijar "último día" al abrir la página, no cada Actualizar

// ============================================================
// 2. REFERENCIAS A ELEMENTOS DEL DOM
// ============================================================
// Guardamos referencias una sola vez al cargar la página, en vez
// de buscar el elemento cada vez que lo necesitamos.
const el = {
  statusLine: document.getElementById("status-line"),
  rangoFechas: document.getElementById("rango-fechas"),
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
  tablaPulido: document.querySelector("#tabla-pulido tbody"),

  ultimaActualizacion: document.getElementById("ultima-actualizacion"),
};

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
function cargarViaJSONP(url) {
  return new Promise((resolve, reject) => {
    const nombreCallback = "catapuCallback_" + Date.now();

    // Esta función será invocada por el <script> que insertamos,
    // con los datos ya listos como un objeto JavaScript real.
    window[nombreCallback] = (datos) => {
      resolve(datos);
      delete window[nombreCallback];
      etiquetaScript.remove();
    };

    const etiquetaScript = document.createElement("script");
    etiquetaScript.src = `${url}?callback=${nombreCallback}`;
    etiquetaScript.onerror = () => {
      reject(new Error("No se pudo contactar al Apps Script (revisa la URL o que esté implementado como 'Cualquier usuario')."));
      delete window[nombreCallback];
      etiquetaScript.remove();
    };

    document.body.appendChild(etiquetaScript);
  });
}

async function cargarDatos() {
  el.btnRefrescar.classList.add("is-loading");
  el.statusLine.textContent = "Cargando datos…";
  el.statusLine.classList.remove("is-error");

  try {
    const datos = await cargarViaJSONP(APPS_SCRIPT_URL);

    registrosOriginales = datos.map(normalizarRegistro);

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
    el.btnRefrescar.classList.remove("is-loading");
  }
}

// Convierte cada fila cruda del JSON en un objeto con nombres de
// campo consistentes y tipos ya "limpios" (fechas, números).
// Hacemos esto UNA vez al cargar, para no repetir esta lógica cada
// vez que filtramos o dibujamos la tabla.
function normalizarRegistro(fila) {
  return {
    raw: fila, // guardamos la fila completa, tal cual vino, para el detalle de búsqueda
    fechaIngreso: fila["FECHA"] ? new Date(fila["FECHA"]) : null,
    // Estas tres son las que de verdad importan para filtrar por rango:
    // cada actividad del taller quedó registrada en su propia columna.
    fechaPulido: fila["FECHA DE PULIDO"] ? new Date(fila["FECHA DE PULIDO"]) : null,
    fechaBateria: fila["FECHA CAMBIO BATERIA"] ? new Date(fila["FECHA CAMBIO BATERIA"]) : null,
    fechaChequeo: fila["FECHA DE CHEQUEO"] ? new Date(fila["FECHA DE CHEQUEO"]) : null,
    modelo: fila["MODELO"] || "",
    capacidad: fila["CAPACIDAD"] || "",
    imei: String(fila["IMEI"] || ""),
    imei2: String(fila["imei 2"] || ""),
    bateriaPct: fila["% BATERIA"] != null ? Number(fila["% BATERIA"]) : null,
    grado: fila["GRADO"] || "",
    color: fila["COLOR"] || "",
    pulidor: (fila["PULIDOR"] || "").trim(),
    pulido: (fila["PULIDO"] || "").trim().toUpperCase(),
    tecnicoBateria: (fila["BATERIA"] || "").trim(),
    tecnicoChequeo: (fila["CHEQUEO"] || "").trim(),
    lote: (fila["LOTE"] || "Sin lote").trim() || "Sin lote",
  };
}

// Le muestra al usuario qué rango de fechas existe realmente en los
// datos cargados, y limita los selectores de fecha a ese rango para
// que no elija fechas donde no hay ningún registro.
function mostrarRangoDeFechasDisponible(registros) {
  const fechasValidas = registros
    .flatMap((r) => [r.fechaPulido, r.fechaBateria, r.fechaChequeo])
    .filter((f) => f instanceof Date && !isNaN(f));

  if (fechasValidas.length === 0) {
    el.rangoFechas.textContent = "No se encontraron fechas válidas en las columnas de pulido, batería o chequeo.";
    return;
  }

  const minFecha = new Date(Math.min(...fechasValidas));
  const maxFecha = new Date(Math.max(...fechasValidas));

  const minClave = obtenerClaveFecha(minFecha);
  const maxClave = obtenerClaveFecha(maxFecha);

  el.fechaDesde.min = minClave;
  el.fechaDesde.max = maxClave;
  el.fechaHasta.min = minClave;
  el.fechaHasta.max = maxClave;

  // Al abrir la página por primera vez, mostramos solo el último día
  // con actividad (no todo el historial). Si el usuario ya eligió
  // sus propias fechas y le da "Actualizar", no se las pisamos.
  if (esPrimeraCarga) {
    el.fechaDesde.value = maxClave;
    el.fechaHasta.value = maxClave;
    esPrimeraCarga = false;
  }

  el.rangoFechas.textContent =
    `Actividad registrada del ${minFecha.toLocaleDateString("es-PE", { timeZone: "UTC" })} ` +
    `al ${maxFecha.toLocaleDateString("es-PE", { timeZone: "UTC" })} ` +
    `(considerando pulido, cambio de batería y chequeo).`;
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
// Convierte una fecha a "AAAA-MM-DD" usando sus componentes UTC.
// Hacemos esto porque las fechas que vienen de Google Sheets traen
// una hora pegada (por el desfase de zona horaria al convertirse a
// UTC), y comparar el instante exacto rompe el filtro cuando el
// usuario elige "Hasta" el mismo día de un registro. Comparando solo
// el día calendario, ese problema desaparece.
function obtenerClaveFecha(fecha) {
  if (!fecha) return null;
  const anio = fecha.getUTCFullYear();
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getUTCDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

// Filtro común para todas las secciones del panel (menos el buscador
// de IMEI, que ignora todo esto a propósito — ver sección 6).
function aplicarFiltrosComunes(registros) {
  const lote = el.filtroLote.value;
  return registros.filter((r) => !lote || r.lote === lote);
}

// true si `fecha` cae dentro de [desde, hasta]. Si desde/hasta están
// vacíos, no restringe por ese lado. Si `fecha` es null (esa columna
// está vacía en esa fila), el registro se excluye en cuanto se pide
// un rango — no tiene sentido "contarlo" en un rango si no sabemos
// cuándo pasó esa actividad.
function fechaDentroDeRango(fecha, desde, hasta) {
  if (!desde && !hasta) return true;
  const clave = obtenerClaveFecha(fecha);
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

function contarModelos(registros) {
  const conteo = new Map();
  registros.forEach((r) => {
    const clave = `${r.modelo}||${r.capacidad}`;
    conteo.set(clave, (conteo.get(clave) || 0) + 1);
  });
  return [...conteo.entries()]
    .map(([clave, cantidad]) => {
      const [modelo, capacidad] = clave.split("||");
      return { modelo, capacidad, cantidad };
    })
    .sort((a, b) => b.cantidad - a.cantidad);
}

function contarPulidoPorLote(registros) {
  const conteo = new Map();
  registros
    .filter((r) => r.pulido === "SI")
    .forEach((r) => {
      const clave = `${r.lote}||${r.pulidor || "Sin asignar"}`;
      conteo.set(clave, (conteo.get(clave) || 0) + 1);
    });
  return [...conteo.entries()]
    .map(([clave, cantidad]) => {
      const [lote, pulidor] = clave.split("||");
      return { lote, pulidor, cantidad };
    })
    .sort((a, b) => b.cantidad - a.cantidad);
}

// ============================================================
// 6. RENDERIZADO
// ============================================================
function aplicarFiltrosYRenderizar() {
  const base = aplicarFiltrosComunes(registrosOriginales);
  const { desde, hasta } = obtenerRangosSeleccionados();

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

  // Para "modelos" y para la tabla de búsqueda, consideramos que un
  // equipo "tuvo actividad en el rango" si CUALQUIERA de sus tres
  // fechas cae dentro de lo seleccionado. Si no hay rango elegido,
  // esto simplemente devuelve todos los registros (base).
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
  renderizarTablaPulido(contarPulidoPorLote(registrosPulido));
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

  entradas.slice(0, 8).forEach(([nombre, cantidad]) => {
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

function renderizarTablaModelos(filas) {
  el.tablaModelos.innerHTML = filas
    .map(
      (f) => `
      <tr>
        <td>${escaparHtml(f.modelo)}</td>
        <td>${escaparHtml(f.capacidad)}</td>
        <td>${f.cantidad}</td>
      </tr>`
    )
    .join("");
}

function renderizarTablaPulido(filas) {
  el.tablaPulido.innerHTML = filas
    .map(
      (f) => `
      <tr>
        <td>${escaparHtml(f.lote)}</td>
        <td>${escaparHtml(f.pulidor)}</td>
        <td>${f.cantidad}</td>
      </tr>`
    )
    .join("");
}

// ============================================================
// 6. BÚSQUEDA POR IMEI (independiente de fecha y lote)
// ============================================================
// El usuario pidió que esto busque en TODA la información sin
// importar los filtros de fecha o lote — por eso usa siempre
// `registrosOriginales` directamente, nunca el resultado de
// aplicarFiltrosComunes().
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
    const valor = formatearValorDetalle(registro.raw[clave], tipo);
    return `
      <div class="imei-field">
        <span class="imei-field-label">${escaparHtml(etiqueta)}</span>
        <span class="imei-field-value">${escaparHtml(valor)}</span>
      </div>`;
  }).join("");

  return `<div class="imei-result-block"><div class="imei-detail">${campos}</div></div>`;
}

function buscarPorImei() {
  const texto = el.buscadorImei.value.trim();

  if (!texto) {
    el.panelBusquedaImei.hidden = true;
    el.resultadoImei.innerHTML = "";
    return;
  }

  const busquedaLimpia = texto.replace(/\s+/g, "");
  const coincidencias = registrosOriginales.filter(
    (r) => r.imei.includes(busquedaLimpia) || r.imei2.includes(busquedaLimpia)
  );

  el.panelBusquedaImei.hidden = false;

  if (coincidencias.length === 0) {
    el.resultadoImei.innerHTML =
      '<p class="imei-not-found">No se encontró ningún equipo con ese IMEI.</p>';
    return;
  }

  el.resultadoImei.innerHTML = coincidencias.map(renderizarDetalleImei).join("");
}

// ============================================================
// 7. UTILIDADES
// ============================================================
function formatearFecha(fecha) {
  if (!fecha) return "—";
  return fecha.toLocaleDateString("es-PE");
}

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
el.btnRefrescar.addEventListener("click", cargarDatos);
el.fechaDesde.addEventListener("change", aplicarFiltrosYRenderizar);
el.fechaHasta.addEventListener("change", aplicarFiltrosYRenderizar);
el.filtroLote.addEventListener("change", aplicarFiltrosYRenderizar);
el.buscadorImei.addEventListener("input", buscarPorImei);

// ============================================================
// 9. ARRANQUE
// ============================================================
cargarDatos();
