// ============================================================
// VISTA REPARACIÓN
// ============================================================
// Se carga después de script.js y reutiliza sus utilidades globales:
// cargarViaJSONP, normalizarNombre, contarPorCampo,
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

  let registros = [];
  let cargando = false;
  let esPrimeraCarga = true;

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
  async function cargarReparaciones() {
    if (cargando) return;
    cargando = true;
    ui.btn.classList.add("is-loading");
    ui.status.textContent = "Cargando datos…";
    ui.status.classList.remove("is-error");

    try {
      const datos = await cargarViaJSONP(URL_REPARACIONES);
      if (!Array.isArray(datos)) {
        // El script devuelve { error: "..." } cuando algo falla de su lado.
        throw new Error((datos && datos.error) || "El Apps Script no devolvió una lista de registros.");
      }

      registros = datos.map(normalizar);
      poblarTecnicos();
      prepararFechas();
      ui.status.textContent = `${registros.length} registros cargados.`;
      ui.ultima.textContent = "Última actualización: " + new Date().toLocaleString("es-PE");
      renderizar();
    } catch (error) {
      console.error(error);
      ui.status.textContent = "No se pudieron cargar los datos de reparación. (" + error.message + ")";
      ui.status.classList.add("is-error");
    } finally {
      cargando = false;
      ui.btn.classList.remove("is-loading");
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

  function claveDeHoy() {
    const hoy = new Date();
    return [
      hoy.getFullYear(),
      String(hoy.getMonth() + 1).padStart(2, "0"),
      String(hoy.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function prepararFechas() {
    const fechas = registros.map((r) => r.fecha).filter(Boolean).sort();
    if (fechas.length === 0) {
      ui.rango.textContent = "No se encontraron fechas de reparación válidas.";
      return;
    }

    const min = fechas[0];
    const max = fechas[fechas.length - 1];
    ui.desde.min = ui.hasta.min = min;
    ui.desde.max = ui.hasta.max = max;

    // Igual que en Producción: al abrir, el último día con actividad
    // (ignorando fechas futuras, que suelen ser errores de digitación).
    if (esPrimeraCarga) {
      const hoy = claveDeHoy();
      const pasadas = fechas.filter((f) => f <= hoy);
      const inicial = pasadas.length ? pasadas[pasadas.length - 1] : max;
      ui.desde.value = inicial;
      ui.hasta.value = inicial;
      esPrimeraCarga = false;
    }

    ui.rango.textContent = `Reparaciones registradas del ${formatearClave(min)} al ${formatearClave(max)}.`;
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

  // ----------------------------------------------------------
  // Eventos y registro en la navegación
  // ----------------------------------------------------------
  ui.btn.addEventListener("click", cargarReparaciones);
  ui.desde.addEventListener("change", renderizar);
  ui.hasta.addEventListener("change", renderizar);
  ui.tecnico.addEventListener("change", renderizar);

  cargadoresDeVista.reparacion = cargarReparaciones;
})();
