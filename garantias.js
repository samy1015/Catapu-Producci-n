// ============================================================
// VISTA GARANTÍAS
// ============================================================
// Se carga después de script.js y reutiliza sus utilidades globales:
// cargarViaJSONP, escaparHtml.
(function () {
  // Reemplaza esto por la URL /exec del proyecto de Apps Script
  // "garantias.gs" (ver ese archivo: es un proyecto NUEVO, no ligado a
  // ninguna spreadsheet). Hasta que lo publiques, esta pestaña mostrará
  // un error de carga.
  const URL_GARANTIAS =
    "https://script.google.com/macros/s/AKfycbzPlWmtDOCWymL8Nc8TWw5tt5qnssJZqTdQ5762ZNz2qW8Avq7Ek-iryH4c3QIagLQo/exec";

  // Reemplaza esto por la URL /exec del proyecto de Apps Script
  // "correos.gs" (ver ese archivo: es un proyecto NUEVO, creado DESDE
  // ADENTRO de catapu.serviciotecnico@gmail.com — Apps Script solo
  // puede leer el Gmail de la cuenta que lo ejecuta). Hasta que lo
  // publiques, "Ver historial" mostrará un error de carga.
  const URL_CORREOS = "https://script.google.com/macros/s/AKfycby1AgKW9_Z6uhtjOR14HT6dlllfHtK63-OvrEmcOW9HZ-VVx4dLdD047TMabf-bujfK/exec";

  let esPrimeraCarga = true;

  // El historial de un IMEI no cambia mientras estás viendo la pestaña
  // (no depende del rango de fechas ni del buscador), así que se guarda
  // aquí para no volver a pedirlo si el usuario lo abre dos veces.
  const historialImeiCache = new Map();

  const ui = {
    status: document.getElementById("gar-status-line"),
    avisoRango: document.getElementById("gar-aviso-rango"),
    avisoErrores: document.getElementById("gar-aviso-errores"),
    desde: document.getElementById("gar-fecha-desde"),
    hasta: document.getElementById("gar-fecha-hasta"),
    buscador: document.getElementById("gar-buscador-imei"),
    panelHistorialImei: document.getElementById("gar-panel-historial-imei"),
    historialImeiTitulo: document.getElementById("gar-historial-imei-titulo"),
    historialImeiResultado: document.getElementById("gar-historial-imei-resultado"),
    btn: document.getElementById("gar-btn-refrescar"),
    tiendas: document.getElementById("gar-tiendas"),
    ultima: document.getElementById("gar-ultima-actualizacion"),
  };

  let filasActuales = []; // lo último cargado, sin filtrar por el buscador de IMEI ni los de estado
  let tiendasActuales = [];

  // Cada tienda filtra su propio estado, sin afectar a las otras. Como
  // RepairDesk no tiene una lista fija de estados (cada tienda puede
  // tener los suyos), el filtro se arma con lo que traiga cada carga.
  // Guardamos los que el usuario DESMARCÓ (por tienda) — así, un estado
  // nuevo que aparezca después sigue visible por defecto, en vez de
  // quedar oculto sin que nadie lo haya pedido.
  const estadosOcultosPorTienda = {}; // { "Miraflores": Set(...), ... }

  // Solo un desplegable de estado abierto a la vez (el de la tienda
  // indicada aquí, o ninguno).
  let tiendaMenuAbierta = null;

  function claveDeHoy() {
    const hoy = new Date();
    return [
      hoy.getFullYear(),
      String(hoy.getMonth() + 1).padStart(2, "0"),
      String(hoy.getDate()).padStart(2, "0"),
    ].join("-");
  }

  // ----------------------------------------------------------
  // Carga
  // ----------------------------------------------------------
  async function cargarGarantias(forzar = false) {
    ui.btn.classList.add("is-loading");
    ui.status.textContent = "Cargando datos…";
    ui.status.classList.remove("is-error");
    ui.avisoErrores.hidden = true;

    if (esPrimeraCarga) {
      // Por defecto, solo hoy: es lo que de verdad importa para garantías.
      ui.desde.value = ui.hasta.value = claveDeHoy();
      esPrimeraCarga = false;
    }

    const desde = ui.desde.value || claveDeHoy();
    const hasta = ui.hasta.value || desde;

    if (desde > hasta) {
      ui.avisoRango.hidden = false;
      pintar([], []);
      ui.btn.classList.remove("is-loading");
      return;
    }
    ui.avisoRango.hidden = true;

    try {
      const parametros = [`desde=${desde}`, `hasta=${hasta}`];
      if (forzar) parametros.push("fresco=1");
      const url = `${URL_GARANTIAS}?${parametros.join("&")}`;

      const inicio = performance.now();
      const datos = await cargarViaJSONP(url);
      if (datos && datos.error) throw new Error(datos.error);
      if (!datos || !Array.isArray(datos.tiendas) || !Array.isArray(datos.filas)) {
        throw new Error("Formato inesperado: revisa que apps-script/garantias.gs esté publicado.");
      }
      console.info(
        `Garantías: ${datos.filas.length} tickets en ${Math.round(performance.now() - inicio)} ms ` +
        `(el script tardó ${datos.ms} ms)`
      );

      filasActuales = datos.filas;
      tiendasActuales = datos.tiendas;
      tiendaMenuAbierta = null;
      ui.status.textContent = `${datos.filas.length} tickets de garantía en el rango.`;
      ui.ultima.textContent = "Última actualización: " + new Date().toLocaleString("es-PE");

      if (datos.errores && datos.errores.length) {
        ui.avisoErrores.hidden = false;
        ui.avisoErrores.textContent = "Algunas tiendas no se pudieron consultar: " + datos.errores.join(" · ");
      }

      renderizarTodo();
    } catch (error) {
      console.error(error);
      ui.status.textContent = "No se pudieron cargar los datos de garantías. (" + error.message + ")";
      ui.status.classList.add("is-error");
    } finally {
      ui.btn.classList.remove("is-loading");
    }
  }

  // ----------------------------------------------------------
  // Búsqueda por IMEI (aplica a las 3 tiendas por igual). El filtro de
  // estado, en cambio, es independiente por tienda — se aplica dentro
  // de pintar(), no aquí.
  // ----------------------------------------------------------
  function renderizarTodo() {
    const busqueda = ui.buscador.value.trim().replace(/\s+/g, "");
    const filtradas = busqueda ? filasActuales.filter((f) => f.imei.includes(busqueda)) : filasActuales;
    pintar(tiendasActuales, filtradas);
  }

  function estadosDeTienda(tienda) {
    // Ignora la búsqueda por IMEI a propósito: las opciones del filtro
    // no deben aparecer/desaparecer mientras alguien escribe en el buscador.
    return [...new Set(filasActuales.filter((f) => f.tienda === tienda).map((f) => f.estado).filter(Boolean))].sort();
  }

  function ocultosDeTienda(tienda) {
    if (!estadosOcultosPorTienda[tienda]) estadosOcultosPorTienda[tienda] = new Set();
    return estadosOcultosPorTienda[tienda];
  }

  // ----------------------------------------------------------
  // Render: un bloque por tienda, con sus tickets de garantía
  // ----------------------------------------------------------
  function pintar(tiendas, filasBuscadas) {
    if (tiendas.length === 0) {
      ui.tiendas.innerHTML = '<p class="ranking-empty">Sin datos en este rango.</p>';
      return;
    }

    ui.tiendas.innerHTML = tiendas
      .map((tienda) => {
        const ocultos = ocultosDeTienda(tienda);
        const estados = estadosDeTienda(tienda);
        const filasTienda = filasBuscadas.filter((f) => f.tienda === tienda && !ocultos.has(f.estado));
        return `
        <section class="panel panel-wide panel-garantia">
          <h2 class="panel-title">${escaparHtml(tienda)} <span class="panel-title-count">(${filasTienda.length})</span></h2>
          ${filasTienda.length || estados.length
            ? renderizarTablaGarantias(tienda, filasTienda, estados)
            : '<p class="ranking-empty">Sin garantías en este rango.</p>'}
        </section>`;
      })
      .join("");

    posicionarMenuAbierto();
  }

  // El panel de cada tabla tiene overflow-x: auto (para el scroll
  // horizontal), lo que también recorta cualquier hijo absoluto que se
  // salga por arriba o por abajo del panel. Para que el desplegable se
  // vea completo, se posiciona con coordenadas fijas respecto a la
  // pantalla (calculadas aquí), en vez de depender de su elemento padre.
  function posicionarMenuAbierto() {
    if (!tiendaMenuAbierta) return;
    const boton = ui.tiendas.querySelector('.filtro-estado-btn-mini[aria-expanded="true"]');
    const menu = ui.tiendas.querySelector(".filtro-estado-menu:not([hidden])");
    if (!boton || !menu) return;

    const rect = boton.getBoundingClientRect();
    menu.style.top = rect.bottom + 6 + "px";

    // Si no cabe hacia la derecha, se alinea contra el borde derecho de
    // la pantalla en vez de salirse.
    const izquierdaIdeal = rect.left;
    const seSale = izquierdaIdeal + menu.offsetWidth > window.innerWidth - 8;
    menu.style.left = (seSale ? window.innerWidth - menu.offsetWidth - 8 : izquierdaIdeal) + "px";
  }

  function renderizarTablaGarantias(tienda, filas, estados) {
    const filasHtml = filas
      .map(
        (f) => `
        <tr>
          <td>
            <span class="badge-estado ${claseEstado(f.estado)}">${escaparHtml(f.estado || "—")}</span>
            ${renderizarTraslado(f.trasladoDesde)}
          </td>
          <td>${escaparHtml(f.ticket)}</td>
          <td>${escaparHtml(formatearFechaClave(f.fecha))}</td>
          <td>${escaparHtml(f.nombre || "—")}</td>
          <td>${escaparHtml(f.correo || "—")}</td>
          <td>${escaparHtml(f.documento || "—")}</td>
          <td>${escaparHtml(f.telefono || "—")}</td>
          <td>${escaparHtml(f.modelo || "—")}</td>
          <td class="col-imei">
            ${escaparHtml(f.imei || "—")}
            ${f.imei ? `<button type="button" class="btn-historial-imei" data-imei="${escaparHtml(f.imei)}">Ver historial ▾</button>` : ""}
          </td>
        </tr>
        ${f.imei ? `<tr class="fila-historial-imei" data-imei="${escaparHtml(f.imei)}" hidden><td colspan="9"></td></tr>` : ""}`
      )
      .join("");

    return `
      <table class="data-table">
        <thead>
          <tr>
            <th class="th-estado">Estado ${renderizarFiltroEstado(tienda, estados)}</th>
            <th>Ticket</th><th>Fecha</th>
            <th>Nombre</th><th>Correo</th><th>Documento</th><th>Teléfono</th>
            <th>Modelo</th><th>IMEI</th>
          </tr>
        </thead>
        <tbody>${filas.length ? filasHtml : '<tr><td colspan="9" class="ranking-empty">Ningún ticket coincide con el filtro de estado.</td></tr>'}</tbody>
      </table>`;
  }

  // Ícono + desplegable de checkboxes, dentro del propio encabezado
  // "Estado" de la tabla de esa tienda.
  function renderizarFiltroEstado(tienda, estados) {
    if (estados.length === 0) return "";

    const ocultos = ocultosDeTienda(tienda);
    const activo = ocultos.size > 0;
    const abierto = tiendaMenuAbierta === tienda;
    const tiendaAttr = escaparHtml(tienda);

    const items = estados
      .map(
        (estado, i) => `
        <label class="filtro-estado-item">
          <input type="checkbox" data-indice="${i}" ${ocultos.has(estado) ? "" : "checked"} />
          <span>${escaparHtml(estado)}</span>
        </label>`
      )
      .join("");

    return `
      <span class="filtro-estado-col">
        <button
          type="button"
          class="filtro-estado-btn-mini ${activo ? "filtro-estado-btn-mini--activo" : ""}"
          data-tienda="${tiendaAttr}"
          title="Filtrar por estado"
          aria-haspopup="true"
          aria-expanded="${abierto}"
        >▽</button>
        <div class="filtro-estado-menu" data-tienda="${tiendaAttr}" ${abierto ? "" : "hidden"}>
          ${items}
          <div class="filtro-estado-acciones" data-tienda="${tiendaAttr}">
            <button type="button" data-accion="todos">Marcar todos</button>
            <button type="button" data-accion="ninguno">Desmarcar todos</button>
          </div>
        </div>
      </span>`;
  }

  function renderizarTraslado(trasladoDesde) {
    if (!trasladoDesde || trasladoDesde.length === 0) return "";
    return `<div class="nota-traslado">↪ Trasladado desde ${escaparHtml(trasladoDesde.join(", "))}</div>`;
  }

  // "Entregado" = resuelto (bien); "cancelad_" = malo; cualquier otro
  // estado de garantía en curso (cambio, reembolso…) = pendiente.
  function claseEstado(estado) {
    const texto = (estado || "").toLowerCase();
    if (texto.includes("cancelad")) return "badge-estado--bad";
    if (texto.includes("entregado") || texto.includes("complet")) return "badge-estado--good";
    return "badge-estado--warn";
  }

  // ----------------------------------------------------------
  // Historial de un IMEI, buscado directamente (independiente del rango
  // de fechas y de si el ticket está visible en alguna tabla de abajo:
  // busca en Gmail sin importar qué tienda cargó o qué fechas se eligieron).
  // ----------------------------------------------------------
  const MIN_DIGITOS_HISTORIAL_IMEI = 6;
  let temporizadorHistorialImei = null;
  let idBusquedaHistorialImei = 0;

  function programarBusquedaImeiHistorial() {
    clearTimeout(temporizadorHistorialImei);
    temporizadorHistorialImei = setTimeout(buscarHistorialImeiIndependiente, 400);
  }

  async function buscarHistorialImeiIndependiente() {
    const id = ++idBusquedaHistorialImei;
    const imei = ui.buscador.value.trim().replace(/\D/g, "");

    if (imei.length < MIN_DIGITOS_HISTORIAL_IMEI) {
      ui.panelHistorialImei.hidden = true;
      return;
    }

    // Solo un historial visible a la vez: si había uno abierto por fila
    // (el botón "Ver historial" de un ticket), se cierra al mostrar este.
    if (filaHistorialAbierta) {
      filaHistorialAbierta.fila.hidden = true;
      filaHistorialAbierta.boton.textContent = "Ver historial ▾";
      filaHistorialAbierta = null;
    }

    ui.panelHistorialImei.hidden = false;
    ui.historialImeiTitulo.textContent = imei;

    if (historialImeiCache.has(imei)) {
      ui.historialImeiResultado.innerHTML = renderizarHistorialImei(historialImeiCache.get(imei), CLASE_VACIO_HISTORIAL);
      return;
    }

    ui.historialImeiResultado.innerHTML = '<p class="ranking-empty">Buscando…</p>';
    try {
      const datos = await cargarViaJSONP(`${URL_CORREOS}?imei=${encodeURIComponent(imei)}`);
      if (id !== idBusquedaHistorialImei) return; // el usuario ya escribió otra cosa
      if (datos && datos.error) throw new Error(datos.error);
      if (!datos || !Array.isArray(datos.eventos)) {
        throw new Error("Formato inesperado: revisa que apps-script/correos.gs esté publicado.");
      }
      historialImeiCache.set(imei, datos);
      ui.historialImeiResultado.innerHTML = renderizarHistorialImei(datos, CLASE_VACIO_HISTORIAL);
    } catch (error) {
      if (id !== idBusquedaHistorialImei) return;
      console.error(error);
      ui.historialImeiResultado.innerHTML = `<p class="ranking-empty">No se pudo cargar el historial. (${escaparHtml(error.message)})</p>`;
    }
  }

  // ----------------------------------------------------------
  // Historial de un IMEI (correos de JotForm: recepción + informe técnico)
  // — versión desplegable, por fila de ticket
  // ----------------------------------------------------------
  // Solo un historial abierto a la vez: al abrir uno, se cierra el que
  // estuviera abierto antes (si era otro).
  let filaHistorialAbierta = null; // { boton, fila } o null

  async function alternarHistorialImei(boton) {
    const filaDatos = boton.closest("tr");
    const filaHistorial = filaDatos.nextElementSibling;
    if (!filaHistorial || !filaHistorial.classList.contains("fila-historial-imei")) return;

    const yaAbierta = !filaHistorial.hidden;

    if (filaHistorialAbierta && filaHistorialAbierta.fila !== filaHistorial) {
      filaHistorialAbierta.fila.hidden = true;
      filaHistorialAbierta.boton.textContent = "Ver historial ▾";
    }

    const abrir = !yaAbierta;

    // Solo un historial visible a la vez: si el buscador de IMEI tenía
    // su propio panel abierto, se cierra al mostrar el de esta fila.
    if (abrir && !ui.panelHistorialImei.hidden) {
      ui.panelHistorialImei.hidden = true;
    }

    filaHistorial.hidden = !abrir;
    boton.textContent = abrir ? "Ocultar historial ▴" : "Ver historial ▾";
    filaHistorialAbierta = abrir ? { boton, fila: filaHistorial } : null;
    if (!abrir) return; // se cerró: no hay nada más que hacer

    const imei = boton.dataset.imei;
    const celda = filaHistorial.querySelector("td");

    if (historialImeiCache.has(imei)) {
      celda.innerHTML = renderizarHistorialImei(historialImeiCache.get(imei), CLASE_VACIO_HISTORIAL);
      return;
    }

    celda.innerHTML = '<p class="ranking-empty">Cargando historial…</p>';
    try {
      const datos = await cargarViaJSONP(`${URL_CORREOS}?imei=${encodeURIComponent(imei)}`);
      if (datos && datos.error) throw new Error(datos.error);
      if (!datos || !Array.isArray(datos.eventos)) {
        throw new Error("Formato inesperado: revisa que apps-script/correos.gs esté publicado.");
      }
      historialImeiCache.set(imei, datos);
      celda.innerHTML = renderizarHistorialImei(datos, CLASE_VACIO_HISTORIAL);
    } catch (error) {
      console.error(error);
      celda.innerHTML = `<p class="ranking-empty">No se pudo cargar el historial. (${escaparHtml(error.message)})</p>`;
    }
  }

  // renderizarHistorialImei/renderizarEventoHistorial/columnaHistorial/
  // cajaTextoHistorial viven en script.js (se cargan antes que este
  // archivo) — Garantías solo le pasa su propia clase para los mensajes
  // vacíos, para que combine con el resto de esta vista.
  const CLASE_VACIO_HISTORIAL = "ranking-empty";

  // ----------------------------------------------------------
  // Eventos y registro en la navegación
  // ----------------------------------------------------------
  ui.btn.addEventListener("click", () => cargarGarantias(true));
  ui.desde.addEventListener("change", () => cargarGarantias(false));
  ui.hasta.addEventListener("change", () => cargarGarantias(false));
  ui.buscador.addEventListener("input", () => {
    renderizarTodo(); // filtra al instante lo ya visible (dentro del rango de fechas)
    programarBusquedaImeiHistorial(); // busca el historial completo, sin importar el rango
  });

  // Delegado en ui.tiendas: el contenido se reconstruye por completo en
  // cada pintar(), así que no tiene sentido enganchar listeners a
  // elementos que van a desaparecer.
  ui.tiendas.addEventListener("click", (evento) => {
    // "Ver historial" es independiente del resto (no pasa por
    // renderizarTodo(): abre/cierra su propia fila con manipulación
    // directa del DOM, sin reconstruir toda la tabla).
    const botonHistorial = evento.target.closest(".btn-historial-imei");
    if (botonHistorial) {
      alternarHistorialImei(botonHistorial);
      return;
    }

    // Cualquier clic dentro del filtro (botón, checkbox, "todos"/"ninguno")
    // no debe llegar al listener de "clic afuera" de document — si no, el
    // menú se cerraría solo justo al marcar una casilla, porque para
    // entonces renderizarTodo() ya reemplazó el HTML y el nodo clicado
    // queda desconectado del árbol.
    if (!evento.target.closest(".filtro-estado-col")) return;
    evento.stopPropagation();

    const boton = evento.target.closest(".filtro-estado-btn-mini");
    if (boton) {
      const tienda = boton.dataset.tienda;
      tiendaMenuAbierta = tiendaMenuAbierta === tienda ? null : tienda;
      renderizarTodo();
      return;
    }

    const accion = evento.target.closest("[data-accion]");
    if (accion) {
      const tienda = accion.closest("[data-tienda]").dataset.tienda;
      const ocultos = ocultosDeTienda(tienda);
      if (accion.dataset.accion === "todos") ocultos.clear();
      else estadosDeTienda(tienda).forEach((estado) => ocultos.add(estado));
      renderizarTodo();
    }
  });

  ui.tiendas.addEventListener("change", (evento) => {
    const casilla = evento.target.closest(".filtro-estado-item input");
    if (!casilla) return;
    const tienda = casilla.closest(".filtro-estado-menu").dataset.tienda;
    const estado = estadosDeTienda(tienda)[Number(casilla.dataset.indice)];
    const ocultos = ocultosDeTienda(tienda);
    if (casilla.checked) ocultos.delete(estado);
    else ocultos.add(estado);
    renderizarTodo();
  });

  document.addEventListener("click", (evento) => {
    if (tiendaMenuAbierta && !evento.target.closest(".filtro-estado-col")) {
      tiendaMenuAbierta = null;
      renderizarTodo();
    }
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && tiendaMenuAbierta) {
      tiendaMenuAbierta = null;
      renderizarTodo();
    }
  });
  // El menú usa coordenadas fijas, calculadas UNA vez al abrirse; si la
  // página se desplaza, se cierra en vez de quedar flotando en el lugar
  // viejo (capture:true para enterarse aunque el scroll ocurra dentro
  // de un panel con su propio overflow, que no burbujea como 'scroll').
  window.addEventListener(
    "scroll",
    () => {
      if (tiendaMenuAbierta) {
        tiendaMenuAbierta = null;
        renderizarTodo();
      }
    },
    true
  );

  cargadoresDeVista.garantias = () => cargarGarantias(false);
})();
