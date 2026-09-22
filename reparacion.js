// ============================================================
// VISTA REPARACIÓN
// ============================================================
// Se carga después de script.js y reutiliza sus utilidades globales:
// cargarViaJSONP, filaAObjeto, normalizarNombre, contarPorCampo,
// renderizarRanking y escaparHtml.
(function () {
  // Script ligado a la spreadsheet "EQUIPOS REPARADOS" (apps-script/reparaciones.gs).
  const URL_REPARACIONES =
    "https://script.google.com/macros/s/AKfycbwlfxSe6qziEjuWZ9zrmebF5AKFIEuMGW4etHy6Mp4GCAZuy-6eNZR03keFnk98YFX8SA/exec";

  // Colores del gráfico de dona. Cada porción también lleva su nombre y
  // porcentaje en la leyenda, así que el color nunca es lo único que
  // la distingue.
  const COLORES_DONA = ["#ff8a3d", "#3ddc84", "#ffc24b", "#5cc8ff", "#b18cff", "#ff6b9d", "#8fa1a6"];
  const MAX_PORCIONES = COLORES_DONA.length - 1; // la última es "OTROS"

  // Al abrir la página solo pedimos los últimos meses; si el usuario elige
  // fechas anteriores, se vuelve a consultar al script con ese rango.
  const MESES_INICIALES = 5;

  let registros = [];
  let idCarga = 0; // solo la última petición actualiza la pantalla
  let esPrimeraCarga = true;
  // Fecha ("AAAA-MM-DD") desde la cual tenemos datos cargados; null = todo el historial.
  let cobertura = inicioDeMesHaceMeses(MESES_INICIALES);

  const ui = {
    status: document.getElementById("rep-status-line"),
    rango: document.getElementById("rep-rango-fechas"),
    avisoRango: document.getElementById("rep-aviso-rango"),
    desde: document.getElementById("rep-fecha-desde"),
    hasta: document.getElementById("rep-fecha-hasta"),
    tecnico: document.getElementById("rep-filtro-tecnico"),
    btn: document.getElementById("rep-btn-refrescar"),
    total: document.getElementById("rep-stat-total"),
    tecnicos: document.getElementById("rep-stat-tecnicos"),
    promedio: document.getElementById("rep-stat-promedio"),
    fallas: document.getElementById("rep-stat-fallas"),
    ranking: document.getElementById("rep-ranking"),
    dona: document.getElementById("rep-dona"),
    matrizHead: document.querySelector("#rep-matriz thead"),
    matrizBody: document.querySelector("#rep-matriz tbody"),
    ultima: document.getElementById("rep-ultima-actualizacion"),
  };

  // ----------------------------------------------------------
  // Carga
  // ----------------------------------------------------------
  // Carga los datos desde `cobertura`. La usan la carga inicial, el botón
  // Actualizar y los cambios de fecha que salen del rango ya cargado.
  // `forzar` (solo el botón Actualizar) le pide al script que ignore su
  // caché y relea la hoja: es más lento, pero trae lo último.
  async function cargarReparaciones(forzar = false) {
    const id = ++idCarga;
    ui.btn.classList.add("is-loading");
    ui.status.textContent = "Cargando datos…";
    ui.status.classList.remove("is-error");

    try {
      const parametros = [];
      if (cobertura) parametros.push(`desde=${cobertura}`);
      if (forzar) parametros.push("fresco=1");
      const url = parametros.length ? `${URL_REPARACIONES}?${parametros.join("&")}` : URL_REPARACIONES;

      const inicio = performance.now();
      const datos = await cargarViaJSONP(url);
      if (id !== idCarga) return; // ya se pidió otra cosa más reciente
      // El script devuelve { error: "..." } cuando algo falla de su lado.
      if (datos && datos.error) throw new Error(datos.error);
      if (!datos || !Array.isArray(datos.columnas) || !Array.isArray(datos.filas)) {
        throw new Error("Formato inesperado: publica la última versión de apps-script/reparaciones.gs.");
      }
      console.info(
        `Reparación: ${datos.filas.length} filas en ${Math.round(performance.now() - inicio)} ms ` +
        `(datos generados ${datos.generado}; el script tardó ${JSON.stringify(datos.ms)} ms)`
      );

      registros = datos.filas.map((fila) => normalizar(filaAObjeto(datos.columnas, fila)));
      poblarTecnicos();
      prepararFechas();
      ui.status.textContent = `${registros.length} registros cargados.`;
      ui.ultima.textContent = "Última actualización: " + new Date().toLocaleString("es-PE");
      renderizar();
    } catch (error) {
      if (id !== idCarga) return;
      console.error(error);
      ui.status.textContent = "No se pudieron cargar los datos de reparación. (" + error.message + ")";
      ui.status.classList.add("is-error");
    } finally {
      if (id === idCarga) ui.btn.classList.remove("is-loading");
    }
  }

  function normalizar(fila) {
    return {
      fecha: fila.fecha || "", // ya viene como "AAAA-MM-DD" desde el script
      modelo: normalizarNombre(fila.modelo) || "SIN MODELO",
      falla: normalizarNombre(fila.falla) || "SIN FALLA",
      tecnico: normalizarNombre(fila.tecnico) || "SIN TÉCNICO",
    };
  }

  function poblarTecnicos() {
    const actual = ui.tecnico.value;
    const tecnicos = [...new Set(registros.map((r) => r.tecnico))].sort();

    ui.tecnico.innerHTML = '<option value="">Todos</option>';
    tecnicos.forEach((nombre) => {
      const opcion = document.createElement("option");
      opcion.value = nombre;
      opcion.textContent = nombre;
      ui.tecnico.appendChild(opcion);
    });
    if (tecnicos.includes(actual)) ui.tecnico.value = actual;
  }

  function claveDeFecha(fecha) {
    return [
      fecha.getFullYear(),
      String(fecha.getMonth() + 1).padStart(2, "0"),
      String(fecha.getDate()).padStart(2, "0"),
    ].join("-");
  }

  // Día 1 del mes de hace `meses` meses (así siempre cubre al menos ese lapso).
  function inicioDeMesHaceMeses(meses) {
    const fecha = new Date();
    fecha.setDate(1);
    fecha.setMonth(fecha.getMonth() - meses);
    return claveDeFecha(fecha);
  }

  function prepararFechas() {
    const fechas = registros.map((r) => r.fecha).filter(Boolean).sort();
    if (fechas.length === 0) {
      ui.rango.textContent = "No se encontraron fechas de reparación válidas.";
      return;
    }

    const max = fechas[fechas.length - 1];
    // Sin límite inferior: el usuario puede elegir fechas anteriores a lo
    // ya cargado y entonces se consultan.
    ui.desde.max = ui.hasta.max = max;

    // Igual que en Producción: al abrir, el último día con actividad
    // (ignorando fechas futuras, que suelen ser errores de digitación).
    if (esPrimeraCarga) {
      const hoy = claveDeFecha(new Date());
      const pasadas = fechas.filter((f) => f <= hoy);
      const inicial = pasadas.length ? pasadas[pasadas.length - 1] : max;
      ui.desde.value = inicial;
      ui.hasta.value = inicial;
      esPrimeraCarga = false;
    }

    ui.rango.textContent = cobertura
      ? `Datos cargados desde el ${formatearClave(cobertura)} hasta el ${formatearClave(max)}. Al elegir fechas anteriores se consultan automáticamente.`
      : `Datos cargados de todo el historial, hasta el ${formatearClave(max)}.`;
  }

  function formatearClave(clave) {
    const [anio, mes, dia] = clave.split("-");
    return `${dia}/${mes}/${anio}`;
  }

  // ----------------------------------------------------------
  // Filtro
  // ----------------------------------------------------------
  function enRango(fecha, desde, hasta) {
    if (!desde && !hasta) return true;
    if (!fecha) return false; // sin fecha no sabemos cuándo se reparó
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  }

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  function renderizar() {
    const desde = ui.desde.value || null;
    const hasta = ui.hasta.value || null;

    if (desde && hasta && desde > hasta) {
      ui.avisoRango.hidden = false;
      pintar([]);
      return;
    }
    ui.avisoRango.hidden = true;

    const tecnico = ui.tecnico.value;
    pintar(
      registros.filter((r) => (!tecnico || r.tecnico === tecnico) && enRango(r.fecha, desde, hasta))
    );
  }

  function pintar(filtrados) {
    const porTecnico = contarPorCampo(filtrados, "tecnico");
    const porFalla = contarPorCampo(filtrados, "falla");
    const total = filtrados.length;

    ui.total.textContent = total;
    ui.tecnicos.textContent = porTecnico.length;
    ui.promedio.textContent = porTecnico.length ? (total / porTecnico.length).toFixed(1) : "—";
    ui.fallas.textContent = porFalla.length;

    renderizarRanking(ui.ranking, porTecnico);
    renderizarDona(porTecnico, total);
    renderizarMatriz(filtrados, porFalla.map(([falla]) => falla));
  }

  // Gráfico de dona con SVG. Truco: un círculo de radio 15.9155 mide
  // 100 de circunferencia, así que los porcentajes se usan tal cual
  // como largo de cada arco (stroke-dasharray).
  function renderizarDona(entradas, total) {
    if (total === 0) {
      ui.dona.innerHTML = '<p class="ranking-empty">Sin datos en este rango.</p>';
      return;
    }

    const principales = entradas.slice(0, MAX_PORCIONES);
    const resto = entradas.slice(MAX_PORCIONES).reduce((suma, [, n]) => suma + n, 0);
    const partes = resto ? [...principales, ["OTROS", resto]] : principales;

    let acumulado = 0;
    const arcos = partes
      .map(([, cantidad], i) => {
        const pct = (cantidad / total) * 100;
        const arco = `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="${COLORES_DONA[i]}"
          stroke-width="6" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${25 - acumulado}" />`;
        acumulado += pct;
        return arco;
      })
      .join("");

    const leyenda = partes
      .map(([nombre, cantidad], i) => {
        const pct = ((cantidad / total) * 100).toFixed(1);
        return `
        <li>
          <span class="dona-color" style="background:${COLORES_DONA[i]}"></span>
          <span class="dona-nombre">${escaparHtml(nombre)}</span>
          <span class="dona-valor">${cantidad} · ${pct}%</span>
        </li>`;
      })
      .join("");

    ui.dona.innerHTML = `
      <div class="dona">
        <svg viewBox="0 0 42 42" class="dona-svg" role="img" aria-label="Reparaciones por técnico">
          <circle cx="21" cy="21" r="15.9155" fill="none" class="dona-fondo" stroke-width="6" />
          ${arcos}
          <text x="21" y="22.6" text-anchor="middle" class="dona-total">${total}</text>
        </svg>
        <ul class="dona-leyenda">${leyenda}</ul>
      </div>`;
  }

  // Tabla cruzada: filas = técnico > modelo, columnas = fallas.
  function renderizarMatriz(filtrados, fallas) {
    if (filtrados.length === 0) {
      ui.matrizHead.innerHTML = "";
      ui.matrizBody.innerHTML =
        '<tr><td class="ranking-empty">Sin datos en este rango.</td></tr>';
      return;
    }

    // tecnico -> modelo -> falla -> cantidad
    const arbol = new Map();
    filtrados.forEach((r) => {
      if (!arbol.has(r.tecnico)) arbol.set(r.tecnico, new Map());
      const modelos = arbol.get(r.tecnico);
      if (!modelos.has(r.modelo)) modelos.set(r.modelo, new Map());
      const conteoFallas = modelos.get(r.modelo);
      conteoFallas.set(r.falla, (conteoFallas.get(r.falla) || 0) + 1);
    });

    const suma = (mapa) => [...mapa.values()].reduce((a, b) => a + b, 0);
    const celda = (n) => `<td class="num">${n || "–"}</td>`;

    ui.matrizHead.innerHTML = `
      <tr>
        <th>Técnico</th>
        <th>Modelo</th>
        ${fallas.map((f) => `<th class="num">${escaparHtml(f)}</th>`).join("")}
        <th class="num">Total</th>
      </tr>`;

    const totalTecnico = ([, modelos]) =>
      [...modelos.values()].reduce((a, conteo) => a + suma(conteo), 0);

    const filas = [];
    [...arbol.entries()]
      .sort((a, b) => totalTecnico(b) - totalTecnico(a))
      .forEach(([tecnico, modelos]) => {
        const listaModelos = [...modelos.entries()].sort((a, b) => suma(b[1]) - suma(a[1]));
        const subtotalPorFalla = new Map();

        listaModelos.forEach(([modelo, conteo], i) => {
          conteo.forEach((n, f) => subtotalPorFalla.set(f, (subtotalPorFalla.get(f) || 0) + n));
          filas.push(`
            <tr>
              <td class="matriz-tecnico">${i === 0 ? escaparHtml(tecnico) : ""}</td>
              <td>${escaparHtml(modelo)}</td>
              ${fallas.map((f) => celda(conteo.get(f))).join("")}
              <td class="num">${suma(conteo)}</td>
            </tr>`);
        });

        filas.push(`
          <tr class="fila-subtotal">
            <td></td>
            <td>Subtotal</td>
            ${fallas.map((f) => celda(subtotalPorFalla.get(f))).join("")}
            <td class="num">${suma(subtotalPorFalla)}</td>
          </tr>`);
      });

    ui.matrizBody.innerHTML = filas.join("");
  }

  // Si el rango pedido empieza antes de lo ya cargado (o se borra "Desde"
  // = todo el historial), hay que volver a consultar al script.
  function alCambiarFecha() {
    const desde = ui.desde.value || null;
    const faltanDatos = cobertura !== null && (desde === null || desde < cobertura);
    if (faltanDatos) {
      cobertura = desde;
      cargarReparaciones();
      return;
    }
    renderizar();
  }

  // ----------------------------------------------------------
  // Eventos y registro en la navegación
  // ----------------------------------------------------------
  ui.btn.addEventListener("click", () => cargarReparaciones(true));
  ui.desde.addEventListener("change", alCambiarFecha);
  ui.hasta.addEventListener("change", alCambiarFecha);
  ui.tecnico.addEventListener("change", renderizar);

  cargadoresDeVista.reparacion = () => cargarReparaciones();
})();
