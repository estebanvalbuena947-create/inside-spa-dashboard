/* Compara lo publicado en Vercel con el código local (HEAD).
 * Sirve para saber si producción está al día o le falta algún cambio.
 *
 *   node tools/compare-deploy.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://inside-spa-dashboard.vercel.app';

const files = ['index.html', 'js/core.js', 'js/domain.js', 'js/data.js', 'js/view.js', 'js/main.js', 'dashboard.css'];
const marks = {
  'js/domain.js': ['visibleAmount', 'receiptFromEvidence', 'expiringHolds', 'creando_retencion', 'expirado_sin_pago', 'AMOUNT_SOURCE_LABELS', 'PAYMENT_REASON_LABELS'],
  'js/data.js': ['retencion_expira_at', 'intentos_pago', "classifyError", 'invalid_token'],
  'js/main.js': ['insideSpaCheck', 'commitDecision', 'timeZone'],
  'js/view.js': ['amount-source', 'reason-list', 'holdAlert'],
  'js/core.js': ['dayKeyInZone', 'setTimeZone'],
  'index.html': ['id="holdAlert"', 'id="diagnostico"', 'id="comprobantes"', 'id="clientes"', 'js/main.js?v=2.0.0']
};

console.log('\n=== COMPARACIÓN: PRODUCCIÓN vs. CÓDIGO LOCAL ===\n');
let differences = 0;

for (const file of files) {
  const remote = await (await fetch(`${BASE}/${file}`)).text();
  const local = readFileSync(join(root, file), 'utf8');
  const same = remote === local;
  console.log(`${same ? 'IGUAL ' : 'DISTINTO'} ${file.padEnd(16)} publicado: ${String(remote.length).padStart(6)} bytes · local: ${String(local.length).padStart(6)} bytes`);
  const fileMarks = marks[file] || [];
  const missing = fileMarks.filter(mark => !remote.includes(mark));
  if (missing.length) {
    differences += 1;
    console.log(`         falta en producción: ${missing.join(', ')}`);
  }
}

/* ¿La tabla reservas pide una columna inexistente? (bug del comodín) */
const remoteData = await (await fetch(`${BASE}/js/data.js`)).text();
const reserveList = remoteData.match(/reservas:\s*'([^']+)'/)?.[1] || '';
console.log(`\nConsulta de "reservas" publicada: ${reserveList.includes('updated_at') ? 'INCLUYE updated_at (bug del comodín)' : 'correcta'}`);

console.log(differences
  ? `\nProducción está DESACTUALIZADA: ${differences} archivo(s) con cambios sin publicar. Sube los commits con git push.`
  : '\nProducción coincide con el código local.');
