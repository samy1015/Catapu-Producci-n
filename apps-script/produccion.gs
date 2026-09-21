// ============================================================
// Apps Script de PRODUCCIÓN (dashboard Catapu)
// ------------------------------------------------------------
// Va en el proyecto de Apps Script ligado a la spreadsheet con la
// hoja TALLER1. Copia de respaldo: es el script original, sin cambios
// de comportamiento. Su URL es APPS_SCRIPT_URL en script.js.
// ============================================================

function doGet(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("TALLER1");
  const data = sheet.getDataRange().getValues();

  const headers = data[0];
  const rows = data.slice(1).map(row => {
    let obj = {};
    headers.forEach((header, i) => obj[header] = row[i]);
    return obj;
  });

  const jsonTexto = JSON.stringify(rows);

  // Si la petición pide un "callback" (como hace JSONP), envolvemos
  // el JSON en una llamada a esa función y lo mandamos como JavaScript.
  const callback = e.parameter.callback;
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + jsonTexto + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // Si no piden callback, respondemos como JSON normal (como antes).
  return ContentService
    .createTextOutput(jsonTexto)
    .setMimeType(ContentService.MimeType.JSON);
}
