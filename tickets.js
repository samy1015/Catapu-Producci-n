// ============================================================
// VISTA TICKETS (ingreso propio de equipos — reemplaza a RepairDesk
// para Garantía y Servicio Técnico)
// ------------------------------------------------------------
// A diferencia de las otras 3 vistas, esta NO pasa por Apps Script:
// habla directo con Supabase desde el navegador con su librería
// (cargada en index.html antes de este archivo). Ver supabase/*.sql
// para la tabla, sus políticas de acceso y el bucket de fotos.
// ============================================================
// Se carga después de auth.js y script.js, y reutiliza sus globales:
// supabaseCliente (ya logueado — las políticas de "tickets" exigen
// sesión iniciada), escaparHtml, formatearFechaClave, cargarViaJSONP,
// APPS_SCRIPT_URL (esta última solo para autocompletar el modelo por
// IMEI, buscando en la misma hoja de Producción).
(function () {
  const cliente = supabaseCliente;

  const TIENDAS_TICKETS = ["Caminos del Inca", "Miraflores", "Taller"];
  const ESTADOS_TICKET = [
    "Ingresado",
    "En diagnóstico",
    "En reparación",
    "Listo para entrega",
    "Entregado",
    "Cancelado",
  ];
  const BUCKET_FOTOS = "fotos-tickets";

  let esPrimeraCarga = true;
  let filasActuales = [];

  const ui = {
    status: document.getElementById("tk-status-line"),
    avisoRango: document.getElementById("tk-aviso-rango"),
    desde: document.getElementById("tk-fecha-desde"),
    hasta: document.getElementById("tk-fecha-hasta"),
    btn: document.getElementById("tk-btn-refrescar"),
    btnNuevo: document.getElementById("tk-btn-nuevo"),
    btnCancelar: document.getElementById("tk-btn-cancelar"),
    panelForm: document.getElementById("tk-panel-form"),
    form: document.getElementById("tk-form"),
    formStatus: document.getElementById("tk-form-status"),
    tienda: document.getElementById("tk-tiendas"),
    ultima: document.getElementById("tk-ultima-actualizacion"),
    fTipoGrupo: document.getElementById("tk-f-tipo-grupo"),
    fTiendaGrupo: document.getElementById("tk-f-tienda-grupo"),
    fNombres: document.getElementById("tk-f-nombres"),
    fApellidos: document.getElementById("tk-f-apellidos"),
    fCorreo: document.getElementById("tk-f-correo"),
    fDocumento: document.getElementById("tk-f-documento"),
    fTelefono: document.getElementById("tk-f-telefono"),
    fModelo: document.getElementById("tk-f-modelo"),
    fImei: document.getElementById("tk-f-imei"),
    fFalla: document.getElementById("tk-f-falla"),
    fContrasena: document.getElementById("tk-f-contrasena"),
    fFechaCompra: document.getElementById("tk-f-fecha-compra"),
    fComprobante: document.getElementById("tk-f-comprobante"),
    fAccesorios: document.getElementById("tk-f-accesorios"),
    fAccNinguno: document.getElementById("tk-f-acc-ninguno"),
    fProbadoGrupo: document.getElementById("tk-f-probado-grupo"),
    fFotos: document.getElementById("tk-f-fotos"),
    fFechaHoy: document.getElementById("tk-f-fecha-hoy"),
    fFechaEntrega: document.getElementById("tk-f-fecha-entrega"),
    fTecnico: document.getElementById("tk-f-tecnico"),
  };

  // Una sola casilla marcada a la vez dentro de un grupo (para que se
  // vea como el papel, con cuadraditos, pero se comporte como un
  // selector único). Con `forzarUnaMarcada` nunca queda el grupo
  // entero vacío (Razón/Sede siempre necesitan un valor); sin eso,
  // el grupo puede quedar sin ninguna marcada (ej. "¿Pudo ser probado?",
  // que es opcional).
  function activarGrupoExclusivo(contenedor, { forzarUnaMarcada = false } = {}) {
    contenedor.addEventListener("change", (evento) => {
      const casilla = evento.target;
      if (casilla.type !== "checkbox") return;
      const todas = [...contenedor.querySelectorAll("input[type=checkbox]")];
      if (casilla.checked) {
        todas.forEach((c) => {
          if (c !== casilla) c.checked = false;
        });
      } else if (forzarUnaMarcada && !todas.some((c) => c.checked)) {
        casilla.checked = true;
      }
    });
  }

  activarGrupoExclusivo(ui.fTipoGrupo, { forzarUnaMarcada: true });
  activarGrupoExclusivo(ui.fTiendaGrupo, { forzarUnaMarcada: true });
  activarGrupoExclusivo(ui.fProbadoGrupo);

  function claveDeHoy() {
    const hoy = new Date();
    return [
      hoy.getFullYear(),
      String(hoy.getMonth() + 1).padStart(2, "0"),
      String(hoy.getDate()).padStart(2, "0"),
    ].join("-");
  }

  // 7 -> "T-0007"
  function numeroFormateado(numero) {
    return "T-" + String(numero).padStart(4, "0");
  }

  // La tabla muestra un solo "Nombre" (como en Garantías), aunque en
  // la base de datos vayan en columnas separadas.
  function nombreCompleto(f) {
    return `${f.nombres || ""} ${f.apellidos || ""}`.trim();
  }

  // ----------------------------------------------------------
  // Carga (consulta directa a Supabase; sin caché intermedia: un
  // cambio de estado se ve al instante en la próxima carga)
  // ----------------------------------------------------------
  async function cargarTickets() {
    ui.btn.classList.add("is-loading");
    ui.status.textContent = "Cargando datos…";
    ui.status.classList.remove("is-error");

    if (esPrimeraCarga) {
      // Por defecto, solo hoy — igual que Garantías.
      ui.desde.value = ui.hasta.value = claveDeHoy();
      esPrimeraCarga = false;
    }

    const desde = ui.desde.value || claveDeHoy();
    const hasta = ui.hasta.value || desde;

    if (desde > hasta) {
      ui.avisoRango.hidden = false;
      pintar([]);
      ui.btn.classList.remove("is-loading");
      return;
    }
    ui.avisoRango.hidden = true;

    try {
      const inicio = performance.now();
      const { data, error } = await cliente
        .from("tickets")
        .select("*")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .order("fecha", { ascending: false })
        .order("numero", { ascending: false });
      if (error) throw new Error(error.message);

      filasActuales = data;
      console.info(`Tickets: ${data.length} tickets en ${Math.round(performance.now() - inicio)} ms`);
      ui.status.textContent = `${data.length} tickets en el rango.`;
      ui.ultima.textContent = "Última actualización: " + new Date().toLocaleString("es-PE");
      pintar(filasActuales);
    } catch (error) {
      console.error(error);
      ui.status.textContent = "No se pudieron cargar los tickets. (" + error.message + ")";
      ui.status.classList.add("is-error");
    } finally {
      ui.btn.classList.remove("is-loading");
    }
  }

  // ----------------------------------------------------------
  // Render: un bloque por tienda, igual que Garantías
  // ----------------------------------------------------------
  function pintar(filas) {
    ui.tienda.innerHTML = TIENDAS_TICKETS
      .map((tienda) => {
        const filasTienda = filas.filter((f) => f.tienda === tienda);
        return `
        <section class="panel panel-wide panel-garantia">
          <h2 class="panel-title">${escaparHtml(tienda)} <span class="panel-title-count">(${filasTienda.length})</span></h2>
          ${filasTienda.length
            ? renderizarTablaTickets(filasTienda)
            : '<p class="ranking-empty">Sin tickets en este rango.</p>'}
        </section>`;
      })
      .join("");
  }

  // Cada ticket es una fila clicable (como "Modelos" en Producción):
  // debajo se despliega una fila con el resto de los campos que no
  // caben en la tabla (contraseña, accesorios, técnico, fotos, etc.).
  function renderizarTablaTickets(filas) {
    const filasHtml = filas
      .map(
        (f) => `
        <tr class="fila-ticket" tabindex="0" role="button" aria-expanded="false" aria-controls="tk-detalle-${escaparHtml(f.id)}">
          <td>${renderizarSelectEstado(f)}</td>
          <td><span class="chevron" aria-hidden="true">▸</span>${escaparHtml(numeroFormateado(f.numero))}</td>
          <td>${escaparHtml(f.tipo)}</td>
          <td>${escaparHtml(formatearFechaClave(f.fecha))}</td>
          <td>${escaparHtml(nombreCompleto(f) || "—")}</td>
          <td>${escaparHtml(f.correo || "—")}</td>
          <td>${escaparHtml(f.documento || "—")}</td>
          <td>${escaparHtml(f.telefono || "—")}</td>
          <td>${escaparHtml(f.modelo || "—")}</td>
          <td class="col-imei">${escaparHtml(f.imei || "—")}</td>
        </tr>
        <tr class="fila-detalle-ticket" id="tk-detalle-${escaparHtml(f.id)}" hidden>
          <td colspan="10">${renderizarDetalleTicket(f)}</td>
        </tr>`
      )
      .join("");

    return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Estado</th><th>Ticket</th><th>Razón</th><th>Fecha</th>
            <th>Nombre</th><th>Correo</th><th>Documento</th><th>Teléfono</th>
            <th>Modelo</th><th>IMEI</th>
          </tr>
        </thead>
        <tbody>${filasHtml}</tbody>
      </table>`;
  }

  function renderizarDetalleTicket(f) {
    const campos = [
      ["Contraseña", f.contrasena],
      ["Fecha de compra", f.fecha_compra ? formatearFechaClave(f.fecha_compra) : ""],
      ["N° de comprobante", f.comprobante],
      ["Accesorios", f.accesorios && f.accesorios.length ? f.accesorios.join(", ") : "Ninguno"],
      ["¿Pudo ser probado?", f.probado],
      ["Fecha estimada de entrega", f.fecha_entrega_estimada ? formatearFechaClave(f.fecha_entrega_estimada) : ""],
      ["Técnico", f.tecnico],
    ]
      .filter(([, valor]) => valor)
      .map(
        ([etiqueta, valor]) => `
        <div class="imei-field">
          <span class="imei-field-label">${escaparHtml(etiqueta)}</span>
          <span class="imei-field-value">${escaparHtml(valor)}</span>
        </div>`
      )
      .join("");

    const fotos = f.fotos && f.fotos.length
      ? `<div class="tk-fotos-miniaturas">${f.fotos
          .map((url) => `<a href="${escaparHtml(url)}" target="_blank" rel="noopener"><img src="${escaparHtml(url)}" alt="Foto del equipo" loading="lazy" /></a>`)
          .join("")}</div>`
      : "";

    return `<div class="imei-detail">${campos}</div>${fotos}`;
  }

  function alternarDetalleTicket(filaTicket) {
    const abierta = filaTicket.getAttribute("aria-expanded") === "true";
    filaTicket.setAttribute("aria-expanded", String(!abierta));
    filaTicket.nextElementSibling.hidden = abierta;
  }

  function renderizarSelectEstado(f) {
    const opciones = ESTADOS_TICKET
      .map((estado) => `<option value="${escaparHtml(estado)}" ${estado === f.estado ? "selected" : ""}>${escaparHtml(estado)}</option>`)
      .join("");
    return `
      <select class="select-estado-ticket badge-estado ${claseEstado(f.estado)}" data-id="${escaparHtml(f.id)}">
        ${opciones}
      </select>`;
  }

  // "Entregado" = resuelto (bien); "Cancelado" = malo; cualquier otro
  // paso intermedio = pendiente. Mismas clases que ya usa Garantías.
  function claseEstado(estado) {
    if (estado === "Cancelado") return "badge-estado--bad";
    if (estado === "Entregado") return "badge-estado--good";
    return "badge-estado--warn";
  }

  // ----------------------------------------------------------
  // Cambiar el estado de un ticket ya creado
  // ----------------------------------------------------------
  async function cambiarEstado(select) {
    const id = select.dataset.id;
    const estado = select.value;
    const claseAnterior = select.className;
    select.disabled = true;

    try {
      const { error } = await cliente
        .from("tickets")
        .update({ estado, actualizado: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(error.message);

      const fila = filasActuales.find((f) => f.id === id);
      if (fila) fila.estado = estado;
      select.className = `select-estado-ticket badge-estado ${claseEstado(estado)}`;
    } catch (error) {
      console.error(error);
      alert("No se pudo actualizar el estado. (" + error.message + ")");
      select.className = claseAnterior;
    } finally {
      select.disabled = false;
    }
  }

  // ----------------------------------------------------------
  // Formulario de alta
  // ----------------------------------------------------------
  function mostrarFormulario(mostrar) {
    ui.panelForm.hidden = !mostrar;
    if (mostrar) {
      ui.formStatus.textContent = "";
      ui.fFechaHoy.value = claveDeHoy(); // solo visual: no se manda, la pone la base de datos
      modeloEditadoManualmente = false;
      ui.fNombres.focus();
    }
  }

  function limpiarFormulario() {
    ui.form.reset();
    modeloEditadoManualmente = false;
  }

  // ----------------------------------------------------------
  // Autocompletar el modelo a partir del IMEI (busca en Producción,
  // que es donde queda registrado el modelo de cada equipo que vendió
  // o reparó Catapu — mismo endpoint que ya usa el buscador de IMEI de
  // esa pestaña, vía APPS_SCRIPT_URL de script.js).
  // ----------------------------------------------------------
  const MIN_DIGITOS_AUTOCOMPLETAR = 6;
  let temporizadorAutocompletar = null;
  // Si el usuario ya escribió el modelo a mano, no se lo pisamos.
  let modeloEditadoManualmente = false;

  function programarAutocompletarModelo() {
    clearTimeout(temporizadorAutocompletar);
    temporizadorAutocompletar = setTimeout(autocompletarModeloPorImei, 400);
  }

  async function autocompletarModeloPorImei() {
    const imei = ui.fImei.value.trim().replace(/\D/g, "");
    if (imei.length < MIN_DIGITOS_AUTOCOMPLETAR || modeloEditadoManualmente) return;

    try {
      const respuesta = await cargarViaJSONP(`${APPS_SCRIPT_URL}?imei=${encodeURIComponent(imei)}`);
      if (respuesta.error || !respuesta.filas || !respuesta.filas.length) return;
      const modelo = respuesta.filas[0]["MODELO"];
      if (modelo && !modeloEditadoManualmente) ui.fModelo.value = modelo;
    } catch (error) {
      console.error(error); // silencioso: no interrumpe el llenado del formulario
    }
  }

  // Sube cada foto a su propia carpeta (el id del ticket) dentro del
  // bucket, y devuelve la URL pública de cada una (el bucket es
  // público — ver supabase/tickets.sql).
  async function subirFotos(idTicket, archivos) {
    const urls = [];
    for (let i = 0; i < archivos.length; i++) {
      const archivo = archivos[i];
      const nombreSeguro = archivo.name.replace(/[^\w.-]+/g, "_");
      const ruta = `${idTicket}/${Date.now()}_${i}_${nombreSeguro}`;
      const { error } = await cliente.storage.from(BUCKET_FOTOS).upload(ruta, archivo);
      if (error) throw new Error(error.message);
      const { data } = cliente.storage.from(BUCKET_FOTOS).getPublicUrl(ruta);
      urls.push(data.publicUrl);
    }
    return urls;
  }

  async function crearTicket(evento) {
    evento.preventDefault();
    const boton = ui.form.querySelector('button[type="submit"]');
    boton.disabled = true;
    ui.formStatus.textContent = "Guardando…";
    ui.formStatus.classList.remove("is-error");

    const accesorios = [...ui.fAccesorios.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    const probado = ui.fProbadoGrupo.querySelector("input:checked");
    const tipo = ui.fTipoGrupo.querySelector("input:checked");
    const tienda = ui.fTiendaGrupo.querySelector("input:checked");

    const datos = {
      tipo: tipo.value,
      tienda: tienda.value,
      nombres: ui.fNombres.value.trim(),
      apellidos: ui.fApellidos.value.trim(),
      correo: ui.fCorreo.value.trim(),
      documento: ui.fDocumento.value.trim(),
      telefono: ui.fTelefono.value.trim(),
      modelo: ui.fModelo.value.trim(),
      imei: ui.fImei.value.trim(),
      falla: ui.fFalla.value.trim(),
      contrasena: ui.fContrasena.value.trim(),
      fecha_compra: ui.fFechaCompra.value || null,
      comprobante: ui.fComprobante.value.trim(),
      accesorios: accesorios,
      probado: probado ? probado.value : null,
      fecha_entrega_estimada: ui.fFechaEntrega.value || null,
      tecnico: ui.fTecnico.value || null,
    };

    try {
      const { data, error } = await cliente.from("tickets").insert(datos).select().single();
      if (error) throw new Error(error.message);
      let ticketCreado = data;

      // Si subir las fotos falla, el ticket ya quedó creado igual —
      // solo avisamos, no deshacemos el alta por eso.
      let avisoFotos = "";
      if (ui.fFotos.files.length) {
        ui.formStatus.textContent = "Subiendo fotos…";
        try {
          const urls = await subirFotos(ticketCreado.id, ui.fFotos.files);
          const { data: conFotos, error: errorFotos } = await cliente
            .from("tickets")
            .update({ fotos: urls })
            .eq("id", ticketCreado.id)
            .select()
            .single();
          if (errorFotos) throw new Error(errorFotos.message);
          ticketCreado = conFotos;
        } catch (errorSubida) {
          console.error(errorSubida);
          avisoFotos = ` (el ticket se creó, pero las fotos no se pudieron subir: ${errorSubida.message})`;
        }
      }

      limpiarFormulario();
      mostrarFormulario(false);

      // Si el ticket recién creado cae dentro del rango de fechas ya
      // mostrado, lo agregamos sin recargar todo; si no, no hace falta
      // tocar la pantalla (aparecerá cuando el usuario elija ese rango).
      const desde = ui.desde.value || claveDeHoy();
      const hasta = ui.hasta.value || desde;
      if (ticketCreado.fecha >= desde && ticketCreado.fecha <= hasta) {
        filasActuales.unshift(ticketCreado);
        pintar(filasActuales);
      }
      ui.status.textContent = `Ticket ${numeroFormateado(ticketCreado.numero)} creado.${avisoFotos}`;
    } catch (error) {
      console.error(error);
      ui.formStatus.textContent = "No se pudo guardar. (" + error.message + ")";
      ui.formStatus.classList.add("is-error");
    } finally {
      boton.disabled = false;
    }
  }

  // "Ningún Accesorio" es excluyente con el resto: marcar uno
  // desmarca al otro, para no guardar una combinación contradictoria.
  ui.fAccesorios.addEventListener("change", (evento) => {
    const casilla = evento.target;
    if (casilla.type !== "checkbox") return;
    if (casilla === ui.fAccNinguno) {
      if (casilla.checked) {
        ui.fAccesorios.querySelectorAll("input[type=checkbox]").forEach((c) => {
          if (c !== ui.fAccNinguno) c.checked = false;
        });
      }
    } else if (casilla.checked) {
      ui.fAccNinguno.checked = false;
    }
  });

  // ----------------------------------------------------------
  // Eventos y registro en la navegación
  // ----------------------------------------------------------
  ui.btn.addEventListener("click", cargarTickets);
  ui.desde.addEventListener("change", cargarTickets);
  ui.hasta.addEventListener("change", cargarTickets);
  ui.btnNuevo.addEventListener("click", () => mostrarFormulario(ui.panelForm.hidden));
  ui.btnCancelar.addEventListener("click", () => {
    limpiarFormulario();
    mostrarFormulario(false);
  });
  ui.form.addEventListener("submit", crearTicket);
  ui.fImei.addEventListener("input", programarAutocompletarModelo);
  ui.fModelo.addEventListener("input", () => {
    modeloEditadoManualmente = true;
  });

  ui.tienda.addEventListener("change", (evento) => {
    const select = evento.target.closest(".select-estado-ticket");
    if (select) cambiarEstado(select);
  });

  // El clic para abrir/cerrar el detalle no debe interferir con el
  // <select> de estado que vive dentro de la misma fila.
  ui.tienda.addEventListener("click", (evento) => {
    if (evento.target.closest(".select-estado-ticket")) return;
    const filaTicket = evento.target.closest(".fila-ticket");
    if (filaTicket) alternarDetalleTicket(filaTicket);
  });
  ui.tienda.addEventListener("keydown", (evento) => {
    const filaTicket = evento.target.closest(".fila-ticket");
    if (filaTicket && (evento.key === "Enter" || evento.key === " ")) {
      evento.preventDefault();
      alternarDetalleTicket(filaTicket);
    }
  });

  cargadoresDeVista.tickets = cargarTickets;
})();
