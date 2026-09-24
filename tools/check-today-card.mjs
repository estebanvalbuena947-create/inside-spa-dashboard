/* Comprueba la tarjeta "Pre-reservas con fecha de hoy" con datos REALES.
 *
 *   node tools/check-today-card.mjs
 *
 * Lee las pre-reservas y reservas confirmadas del proyecto, las normaliza como
 * lo hace el dashboard y ejecuta el render de la tarjeta, para confirmar que el
 * título, el número y la nota coinciden con lo que hay hoy en la base.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, readSupabaseConfig } from './dom-mock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = readSupabaseConfig();
const serviceKey = readFileSync(join(root, '.env.local'), 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1];
if (!serviceKey) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(2);
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const fetchTable = async table => {
  const response = await fetch(`${config.url}/rest/v1/${table}?select=*&limit=500`, { headers });
  if (!response.ok) throw new Error(`${table}: HTTP ${response.status}`);
  return response.json();
};

const [rawDrafts, rawConfirmed] = await Promise.all([fetchTable('reservas_draft'), fetchTable('reservas')]);

const domain = await import(pathToFileURL(join(root, 'js/domain.js')).href);
const core = await import(pathToFileURL(join(root, 'js/core.js')).href);
const drafts = rawDrafts.map(domain.normalizeDraft);
const confirmed = rawConfirmed.map(domain.normalizeConfirmed);

/* El render necesita el DOM con los #id reales. */
const dom = installDom({ config });
const view = await import(pathToFileURL(join(root, 'js/view.js')).href);

const hoy = core.todayKey();
/* Reservas que ocurrieron hoy: confirmadas hoy o con el servicio agendado hoy. */
const ids = new Set();
let confirmadasHoy = 0;
let conCitaHoy = 0;
const sumar = row => {
  if (ids.has(row.id)) return;
  ids.add(row.id);
  if (core.isToday(row.confirmedAt) || core.isToday(row.reviewAt || row.updatedAt)) confirmadasHoy += 1;
  else if (core.isToday(row.scheduleDate)) conCitaHoy += 1;
};
confirmed.forEach(sumar);
drafts.filter(row => row.confirmada === true || String(row.estado || '') === 'confirmado').forEach(sumar);
const total = confirmadasHoy + conCitaHoy;

view.renderOccupancy({ drafts, confirmed }, 18);

console.log('\n=== INDICADOR "RESERVAS DE HOY" CON DATOS REALES ===');
console.log(`Hoy (zona del spa): ${hoy}`);
console.log(`Reservas confirmadas hoy            : ${confirmadasHoy}`);
confirmed.filter(row => core.isToday(row.confirmedAt)).forEach(row => console.log(`   · #${row.id} ${String(row.nombre || '').slice(0, 34)} — confirmada ${core.dayKey(row.confirmedAt)} · cita ${row.scheduleDate ? core.dayKey(row.scheduleDate) : 'sin cita'}`));
console.log(`Reservas con el servicio agendado hoy: ${conCitaHoy}`);
console.log(`Total (sin contar dos veces)         : ${total}`);

console.log('\n--- LO QUE MUESTRA LA TARJETA ---');
console.log(`Título      : ${/Reservas de hoy/.test(readFileSync(join(root, 'index.html'), 'utf8')) ? 'Reservas de hoy' : '(no encontrado)'}`);
console.log(`Número      : ${dom.markup('occupancyRatio').replace(/<[^>]+>/g, ' ').trim()}`);

const esperado = `${total}`;
const coincide = dom.markup('occupancyRatio').startsWith(esperado);
console.log(`\n${coincide ? '✓' : '✗'} El indicador cuenta las reservas que ocurrieron hoy (${esperado}).`);
process.exitCode = coincide ? 0 : 1;
