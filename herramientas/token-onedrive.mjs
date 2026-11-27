// Saca el refresh token de tu cuenta personal de Microsoft (una sola vez)
// para el secreto MS_REFRESH_TOKEN de la Edge Function "produccion".
//
// Uso:   node herramientas/token-onedrive.mjs TU_CLIENT_ID [archivo donde guardarlo]
//
// Te muestra un código: ábrelo en https://microsoft.com/devicelogin, entra
// con la cuenta dueña del Excel y acepta. El token queda copiado en el
// portapapeles (no se imprime) para pegarlo directo en Supabase.
import { execSync } from "child_process";
import { writeFileSync } from "fs";

const clientId = process.argv[2];
if (!clientId) {
  console.error("Falta el Client ID:  node herramientas/token-onedrive.mjs TU_CLIENT_ID");
  process.exit(1);
}
const base = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const scope = "openid Files.ReadWrite offline_access";

const codigo = await (
  await fetch(`${base}/devicecode`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, scope }),
  })
).json();
if (!codigo.device_code) {
  console.error("Microsoft no dio el código:", codigo.error_description || codigo.error);
  process.exit(1);
}
console.log(`\n1) Abre ${codigo.verification_uri}\n2) Escribe el código:  ${codigo.user_code}\n3) Entra con la cuenta dueña del Excel y acepta.\n\nEsperando…`);

let espera = (codigo.interval || 5) * 1000;
const limite = Date.now() + codigo.expires_in * 1000;
while (Date.now() < limite) {
  await new Promise((r) => setTimeout(r, espera));
  const datos = await (
    await fetch(`${base}/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codigo.device_code,
      }),
    })
  ).json();
  if (datos.refresh_token) {
    // Prueba que el token se pueda renovar (como hará la función) y en qué dirección.
    const tid = datos.id_token ? JSON.parse(Buffer.from(datos.id_token.split(".")[1], "base64url")).tid : "?";
    console.log(`\nSesión iniciada (directorio ${tid}). Probando renovación…`);
    let autoridad = "";
    for (const a of ["consumers", "common", tid]) {
      const r = await fetch(`https://login.microsoftonline.com/${a}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: datos.refresh_token, scope }),
      });
      const j = await r.json();
      console.log(`  ${a}: ${r.ok ? "OK" : (j.error_description || j.error || "").split("\n")[0].slice(0, 120)}`);
      if (r.ok && !autoridad) autoridad = a;
    }
    execSync("pbcopy", { input: datos.refresh_token });
    if (process.argv[3]) writeFileSync(process.argv[3], datos.refresh_token, { mode: 0o600 });
    console.log("\nEl token quedó copiado en el portapapeles: pégalo en Supabase como MS_REFRESH_TOKEN.");
    if (autoridad && autoridad !== "consumers") console.log(`Además crea el secreto MS_AUTORIDAD = ${autoridad}`);
    process.exit(0);
  }
  if (datos.error === "slow_down") espera += 5000;
  else if (datos.error !== "authorization_pending") {
    console.error("\nError:", datos.error_description || datos.error);
    process.exit(1);
  }
}
console.error("\nSe acabó el tiempo; vuelve a ejecutarlo.");
process.exit(1);
