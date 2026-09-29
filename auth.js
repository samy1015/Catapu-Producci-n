// ============================================================
// AUTENTICACIÓN (Supabase Auth) — protege las 4 pestañas del dashboard
// ------------------------------------------------------------
// Se carga ANTES que script.js/reparacion.js/garantias.js/tickets.js
// (necesita registrar `supabaseCliente` como global antes de que
// tickets.js lo use, y `iniciarApp` de script.js debe existir antes de
// que este archivo intente llamarlo). No está en un IIFE a propósito:
// `supabaseCliente` es global porque tickets.js lo reutiliza en vez de
// crear su propio cliente.
//
// Qué hace: mientras no haya sesión, muestra #pantalla-login y mantiene
// #app-shell oculto. Al loguearse (o si ya había sesión guardada),
// pide la clave compartida de los Apps Script (ver supabase/tickets.sql,
// tabla "config_privada") y recién ahí muestra el dashboard y arranca
// la carga de datos.
// ============================================================
const SUPABASE_URL = "https://rblulsylqgkhiszkhozu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2jjeR-dl13PNvF37-5LHCA_5oNvmAcj";

const supabaseCliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const elLogin = {
  pantalla: document.getElementById("pantalla-login"),
  appShell: document.getElementById("app-shell"),
  form: document.getElementById("login-form"),
  correo: document.getElementById("login-correo"),
  clave: document.getElementById("login-clave"),
  boton: document.getElementById("login-boton"),
  error: document.getElementById("login-error"),
  btnSalir: document.getElementById("btn-cerrar-sesion"),
};

let appIniciada = false;

// La clave para Producción/Reparación/Garantías/Correos (Apps Script,
// que no usan Supabase) vive en la tabla "config_privada", legible
// solo por cuentas logueadas — cargarViaJSONP (script.js) la agrega
// sola a cada pedido una vez que queda en window.claveAppsScript.
async function cargarClaveAppsScript() {
  try {
    const { data, error } = await supabaseCliente
      .from("config_privada")
      .select("valor")
      .eq("clave", "apps_script_secreto")
      .single();
    if (!error && data) window.claveAppsScript = data.valor;
  } catch (error) {
    console.error("No se pudo obtener la clave de Apps Script:", error);
  }
}

async function mostrarApp() {
  await cargarClaveAppsScript();
  elLogin.pantalla.hidden = true;
  elLogin.appShell.hidden = false;
  if (!appIniciada) {
    appIniciada = true;
    window.iniciarApp();
  }
}

function mostrarLogin() {
  elLogin.pantalla.hidden = false;
  elLogin.appShell.hidden = true;
}

elLogin.form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLogin.error.hidden = true;
  elLogin.boton.disabled = true;
  elLogin.boton.textContent = "Ingresando…";

  const { error } = await supabaseCliente.auth.signInWithPassword({
    email: elLogin.correo.value.trim(),
    password: elLogin.clave.value,
  });

  elLogin.boton.disabled = false;
  elLogin.boton.textContent = "Ingresar";

  if (error) {
    elLogin.error.textContent = error.message;
    elLogin.error.hidden = false;
    return;
  }

  await mostrarApp();
});

if (elLogin.btnSalir) {
  elLogin.btnSalir.addEventListener("click", async () => {
    await supabaseCliente.auth.signOut();
    location.reload();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Se espera a DOMContentLoaded para que reparacion.js/garantias.js/
  // tickets.js ya hayan registrado sus cargadores en cargadoresDeVista
  // antes de que iniciarApp() los dispare.
  const { data } = await supabaseCliente.auth.getSession();
  if (data.session) await mostrarApp();
  else mostrarLogin();
});
