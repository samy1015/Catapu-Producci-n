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

  let esPrimeraCarga = true;

  const ui = {
    status: document.getElementById("gar-status-line"),
    avisoRango: document.getElementById("gar-aviso-rango"),
    avisoErrores: document.getElementById("gar-aviso-errores"),
    desde: document.getElementById("gar-fecha-desde"),
    hasta: document.getElementById("gar-fecha-hasta"),
    buscador: document.getElementById("gar-buscador-imei"),
    btn: document.getElementById("gar-btn-refrescar"),
    tiendas: document.getElementById("gar-tiendas"),
    ultima: document.getElementById("gar-ultima-actualizacion"),
  };

  let filasActuales = []; // lo último cargado, sin filtrar por el buscador de IMEI
  let tiendasActuales = [];

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
      ui.status.textContent = `${datos.filas.length} tickets de garantía en el rango.`;
      ui.ultima.textContent = "Última actualización: " + new Date().toLocaleString("es-PE");

      if (datos.errores && datos.errores.length) {
        ui.avisoErrores.hidden = false;
        ui.avisoErrores.textContent = "Algunas tiendas no se pudieron consultar: " + datos.errores.join(" · ");
      }

      aplicarBusquedaYRenderizar();
    } catch (error) {
      console.error(error);
      ui.status.textContent = "No se pudieron cargar los datos de garantías. (" + error.message + ")";
      ui.status.classList.add("is-error");
    } finally {
      ui.btn.classList.remove("is-loading");
    }
  }

  // ----------------------------------------------------------
  // Búsqueda por IMEI (filtra lo ya cargado, sin volver a pedir datos)
  // ----------------------------------------------------------
  function aplicarBusquedaYRenderizar() {
    const busqueda = ui.buscador.value.trim().replace(/\s+/g, "");
    const filtradas = busqueda
      ? filasActuales.filter((f) => f.imei.includes(busqueda))
      : filasActuales;
    pintar(tiendasActuales, filtradas);
  }

  // ----------------------------------------------------------
  // Render: un bloque por tienda, con sus tickets de garantía
  // ----------------------------------------------------------
  function pintar(tiendas, filas) {
    if (tiendas.length === 0) {
      ui.tiendas.innerHTML = '<p class="ranking-empty">Sin datos en este rango.</p>';
      return;
    }

    ui.tiendas.innerHTML = tiendas
      .map((tienda) => {
        const filasTienda = filas.filter((f) => f.tienda === tienda);
        return `
        <section class="panel panel-wide panel-garantia">
          <h2 class="panel-title">${escaparHtml(tienda)} <span class="panel-title-count">(${filasTienda.length})</span></h2>
          ${filasTienda.length ? renderizarTablaGarantias(filasTienda) : '<p class="ranking-empty">Sin garantías en este rango.</p>'}
        </section>`;
      })
      .join("");
  }

  function renderizarTablaGarantias(filas) {
    const filasHtml = filas
      .map(
        (f) => `
        <tr>
          <td>
            <span class="badge-estado ${claseEstado(f.estado)}">${escaparHtml(f.estado || "—")}</span>
            ${renderizarTraslado(f.trasladoDesde)}
          </td>
          <td>${escaparHtml(f.ticket)}</td>
          <td>${escaparHtml(formatearClave(f.fecha))}</td>
          <td>${escaparHtml(f.modelo || "—")}</td>
          <td>${escaparHtml(f.capacidad || "—")}</td>
          <td>${escaparHtml(f.color || "—")}</td>
          <td class="col-imei">${escaparHtml(f.imei || "—")}</td>
        </tr>`
      )
      .join("");

    return `
      <table class="data-table">
        <thead>
          <tr><th>Estado</th><th>Ticket</th><th>Fecha</th><th>Modelo</th><th>Capacidad</th><th>Color</th><th>IMEI</th></tr>
        </thead>
        <tbody>${filasHtml}</tbody>
      </table>`;
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

  function formatearClave(clave) {
    if (!clave) return "—";
    const [anio, mes, dia] = clave.split("-");
    return `${dia}/${mes}/${anio}`;
  }

  // ----------------------------------------------------------
  // Eventos y registro en la navegación
  // ----------------------------------------------------------
  ui.btn.addEventListener("click", () => cargarGarantias(true));
  ui.desde.addEventListener("change", () => cargarGarantias(false));
  ui.hasta.addEventListener("change", () => cargarGarantias(false));
  ui.buscador.addEventListener("input", aplicarBusquedaYRenderizar);

  cargadoresDeVista.garantias = () => cargarGarantias(false);
})();
