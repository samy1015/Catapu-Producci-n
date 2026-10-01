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
    "Presupuesto enviado",
    "Aprobado por el cliente",
    "En reparación",
    "Reparado",
    "No presentó fallas",
    "Entregado",
    "No reparado/Irreparable",
    "Garantía anulada",
    "Presupuesto no aprobado",
    "Cambio de equipo o reembolso",
    "Cambio de equipo",
    "Reembolso",
  ];
  // Misma lista que ya usa el <select> de técnico del alta (tk-f-tecnico);
  // el formulario del Informe Técnico la vuelve a usar para elegir quién
  // hizo la reparación.
  const TECNICOS = ["Víctor A.", "Mario L.", "Samy B.", "Bruce M.", "Pierre B.", "Jhon R.", "Hermes R."];
  // Checklist de "Conclusión de reparación" del Informe Técnico. "Otro"
  // se maneja aparte: cuando se marca, su valor final es el texto que
  // el usuario escriba al lado, no la palabra "Otro".
  const CONCLUSIONES_REPARACION = [
    "Reparado - Equipo en garantía",
    "Reparado - Equipo fuera de garantía",
    "Equipo en garantía procede para cambio o devolución",
    "Reparado - Servicio Técnico",
    "Reparado - Garantía Servicio Técnico",
    "Fuera de Garantía - No fue posible reparar",
    "Fuera de Garantía - Pendiente de autorización",
    "No fue posible repararlo - Servicio Técnico",
    "No presentó fallas - Servicio Técnico",
    "No presentó fallas - Equipo en garantía",
    "Extensión de plazo de reparación",
  ];
  const BUCKET_FOTOS = "fotos-tickets";

  // Ningún flujo (cambiar estado, comentar) tiene todavía un login
  // por persona de verdad — todos los "técnico" de la app son
  // selects manuales. Este es el mismo truco: un <select> en la caja
  // de comentar que recuerda, en este navegador, quién fue la última
  // persona que lo usó.
  const TECNICO_ACTUAL_KEY = "catapu-tecnico-actual";
  let tecnicoActual = localStorage.getItem(TECNICO_ACTUAL_KEY) || "";

  let esPrimeraCarga = true;
  let filasActuales = [];

  // El detalle de un ticket se abre en una sola tarjeta compartida
  // debajo de las 3 sedes (no adentro de la columna angosta de cada
  // una): hace falta recordar cuál fila/ticket está activo para poder
  // cerrarla si se hace clic en otra, o si se vuelve a hacer clic en
  // la misma.
  let idTicketAbierto = null;
  let filaTicketActiva = null;

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
    detalleContenedor: document.getElementById("tk-detalle-contenedor"),
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

  // 7 -> "T-7"
  function numeroFormateado(numero) {
    return "T-" + numero;
  }

  // Fecha y hora de Ingreso/Entrega del encabezado van en columnas
  // separadas (fecha en un recuadro, hora aparte — como en el papel),
  // así que se formatean por separado en vez de en un solo texto.
  // "2026-09-29T13:05:00.000Z" -> "29/09/2026"
  function formatearFecha(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("es-PE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  // "2026-09-29T13:05:00.000Z" -> "1:05 p. m."
  function formatearHora(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("es-PE", {
      hour: "numeric",
      minute: "2-digit",
    });
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
            ? renderizarListaTickets(filasTienda)
            : '<p class="ranking-empty">Sin tickets en este rango.</p>'}
        </section>`;
      })
      .join("");

    // Las filas de arriba se acaban de recrear (la que estaba "activa"
    // ya no existe en el DOM), así que el detalle compartido se cierra.
    idTicketAbierto = null;
    filaTicketActiva = null;
    ui.detalleContenedor.hidden = true;
    ui.detalleContenedor.innerHTML = "";
  }

  // Cada ticket es una fila clicable y compacta (solo Estado, Ticket,
  // Razón y Fecha de ingreso). Al hacer clic se despliega la ficha
  // completa (renderizarDetalleTicket) en #tk-detalle-contenedor, una
  // sola tarjeta compartida por las 3 sedes debajo de ellas — no
  // adentro de cada columna, que mide solo 1/3 de la pantalla y no le
  // alcanza a la ficha (2 columnas: falla/informe + datos).
  function renderizarListaTickets(filas) {
    return filas
      .map(
        (f) => `
        <div class="fila-ticket" tabindex="0" role="button" aria-expanded="false" aria-controls="tk-detalle-contenedor" data-id="${escaparHtml(f.id)}">
          ${renderizarBadgeEstado(f)}
          <span class="tk-fila-numero"><span class="chevron" aria-hidden="true">▸</span>${escaparHtml(numeroFormateado(f.numero))}</span>
          <span class="tk-fila-razon">${escaparHtml(f.tipo)}</span>
          <span class="tk-fila-fecha">${escaparHtml(formatearFechaClave(f.fecha))}</span>
        </div>`
      )
      .join("");
  }

  // Nombre largo "del papel" para la sede, a partir del valor corto
  // que se guarda (mismo mapeo que usan las casillas de "Sede de
  // ingreso" del formulario de alta).
  const TIENDAS_NOMBRE_LARGO = {
    Miraflores: "Expocentro, Miraflores",
    "Caminos del Inca": "Caminos del Inca, Surco",
    Taller: "Laboratorio principal",
  };

  // Filas "etiqueta :  valor" (Datos del cliente/del equipo, panel
  // lateral), todas alineadas en las mismas 2 columnas — a diferencia
  // de .imei-field (buscador de IMEI), que apila la etiqueta arriba
  // del valor. .tk-dato-fila usa display:contents (no es su propia
  // grilla): así todas las filas del grupo comparten el ancho de
  // columna de .tk-datos-grid, aunque el largo de cada etiqueta varíe.
  function renderizarDatosInline(pares) {
    const filas = pares
      .filter(([, valor]) => valor)
      .map(
        ([etiqueta, valor]) => `
        <div class="tk-dato-fila">
          <span class="tk-dato-label">${escaparHtml(etiqueta)} :</span>
          <span class="tk-dato-valor">${escaparHtml(valor)}</span>
        </div>`
      )
      .join("");
    return `<div class="tk-datos-grid">${filas}</div>`;
  }

  // Lista con viñetas "·" (Accesorios recibidos, ¿Pudo ser probado?).
  function renderizarListaBullets(items, dosColumnas) {
    if (!items.length) return `<p class="tk-dato-valor">Ninguno</p>`;
    return `<ul class="tk-lista-bullets${dosColumnas ? " tk-lista-bullets--col2" : ""}">${items
      .map((item) => `<li>${escaparHtml(item)}</li>`)
      .join("")}</ul>`;
  }

  // Miniaturas clicables: abren el lightbox compartido (#tk-lightbox)
  // en vez de navegar a otra pestaña.
  function renderizarFotos(urls) {
    return `<div class="tk-fotos-miniaturas">${urls
      .map(
        (url) => `<img class="tk-foto-mini" src="${escaparHtml(url)}" data-url="${escaparHtml(url)}" alt="Foto del equipo" loading="lazy" tabindex="0" role="button" />`
      )
      .join("")}</div>`;
  }

  // "Fotos" se ve como un campo más (una barra con flecha) y se
  // despliega recién al hacer clic — las miniaturas de adentro abren el
  // lightbox al hacer clic (ver renderizarFotos).
  function renderizarFotosAcordeon(urls) {
    if (!urls || !urls.length) return "";
    return `
      <button type="button" class="tk-fotos-toggle" aria-expanded="false">
        Fotos <span class="chevron" aria-hidden="true">▾</span>
      </button>
      <div class="tk-fotos-panel" hidden>${renderizarFotos(urls)}</div>`;
  }

  function renderizarDetalleTicket(f, eventos) {
    // 5 columnas fijas, iguales en las 2 filas, para que "Garantía"
    // quede bajo "IPHONE 14 PRO", "B1-345" bajo el casillero vacío de
    // la 1ª fila, etc. — igual que el papel. La 1ª fila no tiene
    // comprobante, por eso ese casillero queda vacío (no se omite: si
    // se omitiera, todo lo de la derecha se correría una columna).
    const encabezado = `
      <div class="tk-ficha-header">
        <span class="tk-ficha-numero">${escaparHtml(numeroFormateado(f.numero))}</span>
        <div class="tk-ficha-header-fila">
          <span class="tk-ficha-modelo">${escaparHtml(f.modelo || "—")}</span>
          <span>${escaparHtml(TIENDAS_NOMBRE_LARGO[f.tienda] || f.tienda)}</span>
          <span></span>
          <span class="tk-ficha-header-espaciador"></span>
          <span class="tk-ficha-fecha-campo">Ingreso <span class="tk-ficha-fecha-caja">${escaparHtml(formatearFecha(f.creado))}</span></span>
          <span class="tk-ficha-hora">${escaparHtml(formatearHora(f.creado))}</span>
        </div>
        <div class="tk-ficha-header-fila">
          <span>${escaparHtml(f.tipo)}</span>
          <span>Técnico: ${escaparHtml(f.tecnico || "Sin asignar")}</span>
          <span>${escaparHtml(f.comprobante || "—")}</span>
          <span class="tk-ficha-header-espaciador"></span>
          <span class="tk-ficha-fecha-campo">Entrega <span class="tk-ficha-fecha-caja tk-ficha-entrega" data-id="${escaparHtml(f.id)}">${
            f.entregado_en ? escaparHtml(formatearFecha(f.entregado_en)) : "Pendiente"
          }</span></span>
          <span class="tk-ficha-hora tk-ficha-entrega-hora" data-id="${escaparHtml(f.id)}">${escaparHtml(formatearHora(f.entregado_en))}</span>
        </div>
      </div>`;

    const fotosHtml = renderizarFotosAcordeon(f.fotos);

    const principal = `
      <section class="tk-ficha-seccion">
        <h4 class="tk-ficha-subtitulo">Descripción de Fallas / Problemas mencionado por el cliente</h4>
        <p class="tk-ficha-texto">${escaparHtml(f.falla || "—")}</p>
        ${f.informe_generado_en ? "" : fotosHtml}
      </section>
      <section class="tk-ficha-seccion">
        <h4 class="tk-ficha-subtitulo">Informe Técnico</h4>
        ${f.informe_generado_en ? renderizarInformeReporte(f, fotosHtml) : renderizarInformeFormulario(f)}
      </section>
      <section class="tk-ficha-seccion">
        <h4 class="tk-ficha-subtitulo">Historial</h4>
        ${renderizarHistorial(f.id, eventos || [])}
      </section>`;

    const lateral = `
      <aside class="tk-ficha-lateral">
        <div class="tk-ficha-top-fila">
          <div class="tk-ficha-alerta">
            <span class="control-label">Alerta de correo</span>
            <label class="tk-switch">
              <input type="checkbox" class="tk-alerta-toggle" data-id="${escaparHtml(f.id)}" ${f.alerta_correo === false ? "" : "checked"} />
              <span class="tk-switch-carril"></span>
            </label>
          </div>
          ${renderizarSelectEstado(f)}
        </div>

        <div class="tk-datos-grupo">
          <h4 class="tk-ficha-subtitulo">Datos del cliente</h4>
          ${renderizarDatosInline([
            ["Nombre", nombreCompleto(f)],
            ["Correo electrónico", f.correo],
            ["Documento", f.documento],
            ["Número de teléfono", f.telefono],
          ])}
        </div>

        <div class="tk-datos-grupo">
          <h4 class="tk-ficha-subtitulo">Datos del equipo</h4>
          ${renderizarDatosInline([
            ["Marca, Modelo, etc", f.modelo],
            ["IMEI", f.imei],
            ["Contraseña", f.contrasena],
            ["Fecha de compra", f.fecha_compra ? formatearFechaClave(f.fecha_compra) : ""],
            ["Número de comprobante", f.comprobante],
            ["Fecha estimada de entrega", f.fecha_entrega_estimada ? formatearFechaClave(f.fecha_entrega_estimada) : ""],
          ])}
          <div class="tk-dato-bloque tk-dato-bloque--divisor">
            <span class="tk-dato-label">Accesorios recibidos con el equipo :</span>
            ${renderizarListaBullets(f.accesorios || [], true)}
          </div>
          <div class="tk-dato-bloque">
            <span class="tk-dato-label">¿Pudo ser probado el equipo?</span>
            ${f.probado ? renderizarListaBullets([f.probado]) : `<p class="tk-dato-valor">—</p>`}
          </div>
        </div>
      </aside>`;

    // El encabezado va DENTRO de la columna principal (no arriba de las
    // 2 columnas): así "Alerta de correo"/estado del panel lateral
    // arrancan a la misma altura que el recuadro "T-436", en vez de
    // quedar más abajo — igual que el mockup.
    return `<div class="tk-ficha"><div class="tk-ficha-cuerpo"><div class="tk-ficha-principal">${encabezado}${principal}</div>${lateral}</div></div>`;
  }

  // ----------------------------------------------------------
  // Informe Técnico: formulario de redacción (mientras no exista) y
  // reporte de solo lectura (una vez guardado).
  // ----------------------------------------------------------
  function renderizarInformeFormulario(f) {
    const opcionesConclusion = CONCLUSIONES_REPARACION
      .map((texto) => `<label class="tk-check"><input type="checkbox" value="${escaparHtml(texto)}" /> ${escaparHtml(texto)}</label>`)
      .join("");
    const opcionesTecnico = TECNICOS
      .map((t) => `<option value="${escaparHtml(t)}" ${t === f.tecnico ? "selected" : ""}>${escaparHtml(t)}</option>`)
      .join("");

    return `
      <form class="tk-informe-form" data-id="${escaparHtml(f.id)}">
        <div class="tk-ficha-recuadro">
          <span class="tk-ficha-recuadro-titulo">Diagnóstico Técnico</span>
          <textarea class="tk-informe-diagnostico" rows="4"></textarea>
        </div>
        <div class="tk-ficha-recuadro">
          <span class="tk-ficha-recuadro-titulo">Observaciones</span>
          <textarea class="tk-informe-observaciones" rows="4"></textarea>
        </div>

        <div class="tk-ficha-conclusion-header">
          <span class="control-label">Conclusión de reparación</span>
          <label class="btn-refresh tk-agregar-fotos-btn">
            Agregar fotos
            <input type="file" class="tk-informe-fotos" accept="image/*" multiple hidden />
          </label>
        </div>
        <div class="tk-form-checks tk-form-checks--col tk-conclusion-grupo">
          ${opcionesConclusion}
          <label class="tk-check tk-check-otro">
            <input type="checkbox" value="Otro" class="tk-conclusion-otro-check" /> Otro
            <input type="text" class="tk-conclusion-otro" disabled placeholder="Especifica…" />
          </label>
        </div>

        <div class="tk-ficha-informe-footer">
          <div class="tk-ficha-recuadro tk-ficha-tecnico-recuadro">
            <span class="tk-ficha-recuadro-titulo">Técnico</span>
            <select class="tk-informe-tecnico" size="7">
              <option value="">Sin asignar</option>
              ${opcionesTecnico}
            </select>
          </div>
          <div class="tk-ficha-informe-footer-acciones">
            <button type="submit" class="btn-refresh">Guardar</button>
            <span class="status-line tk-informe-status"></span>
          </div>
        </div>
      </form>`;
  }

  function renderizarInformeReporte(f, fotosHtml) {
    const campo = (etiqueta, valor) => `
      <div class="tk-ficha-campo-simple">
        <span class="control-label">${escaparHtml(etiqueta)}</span>
        <p class="tk-ficha-texto">${escaparHtml(valor || "—")}</p>
      </div>`;
    return `
      ${campo("Diagnóstico Técnico", f.informe_diagnostico)}
      ${campo("Observaciones", f.informe_observaciones)}
      ${fotosHtml}
      ${campo("Conclusión de reparación", f.informe_conclusion)}
      ${campo("Técnico", f.tecnico)}`;
  }

  // ----------------------------------------------------------
  // Historial: eventos automáticos (creación, cambios de estado,
  // informe técnico) + comentarios manuales con fotos. Todo vive en la
  // tabla "ticket_eventos" (ver supabase/tickets_migracion_v6.sql).
  // ----------------------------------------------------------
  async function cargarEventos(ticketId) {
    const { data, error } = await cliente
      .from("ticket_eventos")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("creado", { ascending: true });
    if (error) {
      console.error(error);
      return [];
    }
    return data;
  }

  // Errores acá van solo a consola: el historial es secundario, no
  // debe hacer fallar ni avisar sobre la acción principal (crear el
  // ticket, cambiar el estado, etc.) si falla solo el registro.
  async function registrarEvento(ticketId, texto, autor, fotos) {
    try {
      const { error } = await cliente.from("ticket_eventos").insert({
        ticket_id: ticketId,
        texto: texto || null,
        autor: autor || null,
        fotos: fotos || [],
      });
      if (error) throw new Error(error.message);
    } catch (error) {
      console.error("No se pudo registrar el evento en el historial:", error);
    }
  }

  function renderizarEventoHistorial(evento) {
    const fotosHtml = evento.fotos && evento.fotos.length ? renderizarFotos(evento.fotos) : "";
    return `
      <div class="tk-evento">
        <div class="tk-evento-cabecera">
          <strong>${escaparHtml(evento.autor || "—")}</strong>
          <span class="tk-evento-fecha">${escaparHtml(formatearFecha(evento.creado))} ${escaparHtml(formatearHora(evento.creado))}</span>
        </div>
        ${evento.texto ? `<p class="tk-evento-texto">${escaparHtml(evento.texto)}</p>` : ""}
        ${fotosHtml}
      </div>`;
  }

  function renderizarHistorial(ticketId, eventos) {
    const opcionesTecnico = TECNICOS
      .map((t) => `<option value="${escaparHtml(t)}" ${t === tecnicoActual ? "selected" : ""}>${escaparHtml(t)}</option>`)
      .join("");
    const lista = eventos.length
      ? `<div class="tk-historial-lista">${eventos.map(renderizarEventoHistorial).join("")}</div>`
      : `<p class="ranking-empty tk-historial-lista">Todavía no hay movimientos.</p>`;

    return `
      <form class="tk-comentario-form" data-id="${escaparHtml(ticketId)}">
        <textarea class="tk-comentario-texto" rows="3" placeholder="Escribe un comentario…"></textarea>
        <div class="tk-comentario-acciones">
          <select class="tk-comentario-tecnico">
            <option value="">Comentando como…</option>
            ${opcionesTecnico}
          </select>
          <label class="btn-refresh tk-agregar-fotos-btn">
            Agregar fotos
            <input type="file" class="tk-comentario-fotos" accept="image/*" multiple hidden />
          </label>
          <button type="submit" class="btn-refresh">Guardar</button>
          <span class="status-line tk-comentario-status"></span>
        </div>
      </form>
      ${lista}`;
  }

  async function guardarComentario(formulario) {
    const id = formulario.dataset.id;
    const boton = formulario.querySelector('button[type="submit"]');
    const status = formulario.querySelector(".tk-comentario-status");
    const texto = formulario.querySelector(".tk-comentario-texto").value.trim();
    const archivos = formulario.querySelector(".tk-comentario-fotos").files;

    if (!texto && !archivos.length) {
      status.textContent = "Escribe un comentario o agrega una foto.";
      status.classList.add("is-error");
      return;
    }

    boton.disabled = true;
    status.classList.remove("is-error");
    status.textContent = "Guardando…";

    try {
      let urls = [];
      if (archivos.length) {
        status.textContent = "Subiendo fotos…";
        urls = await subirFotos(id, archivos);
      }
      // A diferencia de registrarEvento (que traga el error porque ahí
      // el historial es secundario a la acción principal), acá SÍ hace
      // falta que un error se vea: guardar el comentario es la acción
      // principal de este formulario.
      const { error } = await cliente.from("ticket_eventos").insert({
        ticket_id: id,
        texto: texto || null,
        autor: tecnicoActual || null,
        fotos: urls,
      });
      if (error) throw new Error(error.message);

      await refrescarDetalleAbierto(id);
    } catch (error) {
      console.error(error);
      status.textContent = "No se pudo guardar. (" + error.message + ")";
      status.classList.add("is-error");
      boton.disabled = false;
    }
  }

  // Si el ticket que acaba de cambiar (estado, informe, comentario) es
  // el que está abierto en #tk-detalle-contenedor, se vuelve a pedir
  // su historial y se repinta entero — ya hace falta igual para
  // mostrar el evento nuevo.
  async function refrescarDetalleAbierto(id) {
    if (id !== idTicketAbierto) return;
    const f = filasActuales.find((fila) => fila.id === id);
    if (!f) return;
    const eventos = await cargarEventos(id);
    if (id !== idTicketAbierto) return; // pudo cerrarse mientras tanto
    ui.detalleContenedor.innerHTML = renderizarDetalleTicket(f, eventos);
  }

  async function alternarDetalleTicket(filaTicket) {
    const id = filaTicket.dataset.id;

    // Clic en la fila que ya estaba abierta: se cierra.
    if (id === idTicketAbierto) {
      filaTicket.setAttribute("aria-expanded", "false");
      ui.detalleContenedor.hidden = true;
      ui.detalleContenedor.innerHTML = "";
      idTicketAbierto = null;
      filaTicketActiva = null;
      return;
    }

    // Clic en otra fila (de la misma sede o de otra): se cierra la que
    // estaba activa antes y se abre esta.
    if (filaTicketActiva) filaTicketActiva.setAttribute("aria-expanded", "false");

    const f = filasActuales.find((fila) => fila.id === id);
    if (!f) return;

    filaTicket.setAttribute("aria-expanded", "true");
    idTicketAbierto = id;
    filaTicketActiva = filaTicket;
    ui.detalleContenedor.hidden = false;
    ui.detalleContenedor.innerHTML = '<p class="status-line">Cargando…</p>';
    ui.detalleContenedor.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const eventos = await cargarEventos(id);
    if (id !== idTicketAbierto) return; // se hizo clic en otro ticket mientras tanto
    ui.detalleContenedor.innerHTML = renderizarDetalleTicket(f, eventos);
  }

  // Fila de la tabla: solo muestra el estado (como Garantías), no se
  // puede cambiar desde ahí. Cambiar el estado es solo desde el
  // <select> del panel del detalle (renderizarSelectEstado).
  function renderizarBadgeEstado(f) {
    return `<span class="badge-estado-ticket badge-estado ${claseEstado(f.estado)}" data-id="${escaparHtml(f.id)}">${escaparHtml(f.estado)}</span>`;
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

  const ESTADOS_MALOS = ["No reparado/Irreparable", "Garantía anulada", "Presupuesto no aprobado"];
  const ESTADOS_BUENOS = ["Entregado", "Cambio de equipo", "Reembolso", "Cambio de equipo o reembolso"];

  // Resuelto para el cliente (entregado/cambio/reembolso) = bien;
  // resuelto en contra (irreparable/garantía anulada/presupuesto no
  // aprobado) = malo; cualquier paso intermedio = pendiente. Mismas
  // clases que ya usa Garantías.
  function claseEstado(estado) {
    if (ESTADOS_MALOS.includes(estado)) return "badge-estado--bad";
    if (ESTADOS_BUENOS.includes(estado)) return "badge-estado--good";
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

    const fila = filasActuales.find((f) => f.id === id);
    const datos = { estado, actualizado: new Date().toISOString() };
    // Se registra una sola vez, la primera vez que pasa a "Entregado"
    // (si ya tenía fecha de entrega, no se pisa).
    if (estado === "Entregado" && fila && !fila.entregado_en) {
      datos.entregado_en = new Date().toISOString();
    }

    try {
      const { error } = await cliente.from("tickets").update(datos).eq("id", id);
      if (error) throw new Error(error.message);

      if (fila) Object.assign(fila, datos);

      // La insignia de solo lectura de la fila de la tabla (mismo
      // ticket) debe quedar al día — se actualiza a mano en vez de
      // repintar toda la tabla (eso cerraría cualquier detalle que el
      // usuario tenga abierto).
      document.querySelectorAll(`.badge-estado-ticket[data-id="${id}"]`).forEach((badge) => {
        badge.textContent = estado;
        badge.className = `badge-estado-ticket badge-estado ${claseEstado(estado)}`;
      });

      await registrarEvento(id, `Cambió el estado a "${estado}".`, tecnicoActual);
      // Repinta el detalle entero si es el que está abierto (el select
      // de estado de ahí adentro queda con el valor correcto solo, y
      // de paso aparece el evento nuevo en el historial).
      await refrescarDetalleAbierto(id);
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

  // ----------------------------------------------------------
  // Informe Técnico: se guarda una sola vez (el formulario deja de
  // existir para ese ticket en cuanto "informe_generado_en" queda con
  // fecha; renderizarDetalleTicket pasa a mostrar el reporte).
  // ----------------------------------------------------------
  async function guardarInforme(formulario) {
    const id = formulario.dataset.id;
    const boton = formulario.querySelector('button[type="submit"]');
    const status = formulario.querySelector(".tk-informe-status");
    const otroCasilla = formulario.querySelector(".tk-conclusion-otro-check");
    const otroTexto = formulario.querySelector(".tk-conclusion-otro");

    const conclusion = otroCasilla.checked
      ? otroTexto.value.trim()
      : (formulario.querySelector(".tk-conclusion-grupo input[type=checkbox]:checked:not(.tk-conclusion-otro-check)") || {}).value;

    if (!conclusion) {
      status.textContent = "Elige una conclusión de reparación (o escribe la tuya en \"Otro\").";
      status.classList.add("is-error");
      return;
    }

    boton.disabled = true;
    status.classList.remove("is-error");
    status.textContent = "Guardando…";

    const datos = {
      informe_diagnostico: formulario.querySelector(".tk-informe-diagnostico").value.trim(),
      informe_observaciones: formulario.querySelector(".tk-informe-observaciones").value.trim(),
      informe_conclusion: conclusion,
      tecnico: formulario.querySelector(".tk-informe-tecnico").value || null,
      informe_generado_en: new Date().toISOString(),
    };

    const archivos = formulario.querySelector(".tk-informe-fotos").files;

    try {
      if (archivos.length) {
        status.textContent = "Subiendo fotos…";
        const urlsNuevas = await subirFotos(id, archivos);
        const fila = filasActuales.find((f) => f.id === id);
        datos.fotos = [...((fila && fila.fotos) || []), ...urlsNuevas];
      }

      status.textContent = "Guardando…";
      const { data, error } = await cliente.from("tickets").update(datos).eq("id", id).select().single();
      if (error) throw new Error(error.message);

      const fila = filasActuales.find((f) => f.id === id);
      if (fila) Object.assign(fila, data);

      await registrarEvento(id, "Creó el informe técnico.", datos.tecnico || tecnicoActual);

      // Repinta el detalle compartido, para pasar del formulario al
      // reporte de solo lectura sin cerrar ni recargar el resto (y de
      // paso mostrar el evento nuevo en el historial).
      const eventos = await cargarEventos(id);
      ui.detalleContenedor.innerHTML = renderizarDetalleTicket(fila || data, eventos);
    } catch (error) {
      console.error(error);
      status.textContent = "No se pudo guardar. (" + error.message + ")";
      status.classList.add("is-error");
      boton.disabled = false;
    }
  }

  // ----------------------------------------------------------
  // Lightbox de fotos (uno solo, compartido por todos los tickets)
  // ----------------------------------------------------------
  const lightbox = {
    caja: document.getElementById("tk-lightbox"),
    img: document.getElementById("tk-lightbox-img"),
    descargar: document.getElementById("tk-lightbox-descargar"),
    cerrar: document.getElementById("tk-lightbox-cerrar"),
  };

  function abrirLightbox(url) {
    lightbox.img.src = url;
    lightbox.descargar.href = url;
    lightbox.caja.hidden = false;
  }

  function cerrarLightbox() {
    lightbox.caja.hidden = true;
    lightbox.img.src = "";
  }

  lightbox.cerrar.addEventListener("click", cerrarLightbox);
  lightbox.caja.addEventListener("click", (evento) => {
    if (evento.target === lightbox.caja) cerrarLightbox();
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && !lightbox.caja.hidden) cerrarLightbox();
  });

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

      await registrarEvento(ticketCreado.id, "Creó el ticket.", datos.tecnico || tecnicoActual);

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

  // #tk-tiendas (la lista) y #tk-detalle-contenedor (la ficha abierta)
  // son hermanos dentro del mismo <main>: estos 4 listeners se cuelgan
  // de ese padre en vez de #tk-tiendas, porque la ficha (con su
  // <select> de estado, el toggle de alerta, el formulario del informe
  // y las miniaturas de fotos) ya no vive adentro de #tk-tiendas.
  const uiContenido = ui.tienda.parentElement;

  uiContenido.addEventListener("change", (evento) => {
    const casilla = evento.target;

    const select = casilla.closest(".select-estado-ticket");
    if (select) return cambiarEstado(select);

    if (casilla.classList.contains("tk-comentario-tecnico")) {
      tecnicoActual = casilla.value;
      localStorage.setItem(TECNICO_ACTUAL_KEY, tecnicoActual);
      return;
    }

    if (casilla.classList.contains("tk-alerta-toggle")) {
      cliente.from("tickets").update({ alerta_correo: casilla.checked }).eq("id", casilla.dataset.id)
        .then(({ error }) => {
          if (error) console.error(error);
          const fila = filasActuales.find((f) => f.id === casilla.dataset.id);
          if (fila && !error) fila.alerta_correo = casilla.checked;
        });
      return;
    }

    // Checklist excluyente de "Conclusión de reparación" (igual que
    // activarGrupoExclusivo, pero delegado: el formulario del informe
    // se crea recién al abrir cada ticket, no existe desde el arranque).
    const grupoConclusion = casilla.closest(".tk-conclusion-grupo");
    if (grupoConclusion && casilla.type === "checkbox") {
      if (casilla.checked) {
        grupoConclusion.querySelectorAll("input[type=checkbox]").forEach((c) => {
          if (c !== casilla) c.checked = false;
        });
      }
      if (casilla.classList.contains("tk-conclusion-otro-check")) {
        const otroTexto = casilla.closest("label").querySelector(".tk-conclusion-otro");
        otroTexto.disabled = !casilla.checked;
        if (casilla.checked) otroTexto.focus();
        else otroTexto.value = "";
      } else {
        const otroTexto = grupoConclusion.querySelector(".tk-conclusion-otro");
        if (casilla.checked) {
          otroTexto.disabled = true;
          otroTexto.value = "";
          grupoConclusion.querySelector(".tk-conclusion-otro-check").checked = false;
        }
      }
    }
  });

  uiContenido.addEventListener("submit", (evento) => {
    const formularioInforme = evento.target.closest(".tk-informe-form");
    if (formularioInforme) {
      evento.preventDefault();
      return guardarInforme(formularioInforme);
    }

    const formularioComentario = evento.target.closest(".tk-comentario-form");
    if (formularioComentario) {
      evento.preventDefault();
      return guardarComentario(formularioComentario);
    }
  });

  // El clic para abrir/cerrar una fila no debe interferir con el
  // <select> de estado, las miniaturas de foto, ni nada dentro de la
  // ficha abierta (formularios, casillas, etc.).
  uiContenido.addEventListener("click", (evento) => {
    const foto = evento.target.closest(".tk-foto-mini");
    if (foto) return abrirLightbox(foto.dataset.url);

    const fotosToggle = evento.target.closest(".tk-fotos-toggle");
    if (fotosToggle) {
      const abierta = fotosToggle.getAttribute("aria-expanded") === "true";
      fotosToggle.setAttribute("aria-expanded", String(!abierta));
      fotosToggle.nextElementSibling.hidden = abierta;
      return;
    }

    if (evento.target.closest("#tk-detalle-contenedor")) return;
    if (evento.target.closest(".select-estado-ticket")) return;
    const filaTicket = evento.target.closest(".fila-ticket");
    if (filaTicket) alternarDetalleTicket(filaTicket);
  });
  uiContenido.addEventListener("keydown", (evento) => {
    const foto = evento.target.closest(".tk-foto-mini");
    if (foto && (evento.key === "Enter" || evento.key === " ")) {
      evento.preventDefault();
      return abrirLightbox(foto.dataset.url);
    }
    const filaTicket = evento.target.closest(".fila-ticket");
    if (filaTicket && (evento.key === "Enter" || evento.key === " ")) {
      evento.preventDefault();
      alternarDetalleTicket(filaTicket);
    }
  });

  cargadoresDeVista.tickets = cargarTickets;
})();
