/* Comprueba que el filtro por día usa la fecha de CREACIÓN de la pre-reserva.
 *
 *   node tools/check-day-filter.mjs
 *
 * Lee las pre-reservas reales, aplica el mismo filtro que la interfaz con la
 * fecha de hoy y muestra qué filas entran, comparando con las que tienen cita hoy
 * para demostrar que el criterio es el de ingreso.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = await import(pathToFileURL(join(root, 'supabase-config.js')).href).catch(() => null);
void config;
const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const url = configSource.match(/url:\s*'([^']+)'/)?.[1];
const serviceKey = readFileSync(join(root, '.env.local'), 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1];

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const rows = await (await fetch(`${url}/rest/v1/reservas_draft?select=*&limit=500`, { headers })).json();

const domain = await import(pathToFileURL(join(root, 'js/domain.js')).href);
const core = await import(pathToFileURL(join(root, 'js/core.js')).href);
const drafts = rows.map(domain.normalizeDraft);
const statuses = domain.buildKpis(drafts, [], [], new Map()).statuses;

const hoy = core.todayKey();
const filtradas = domain.filterDrafts(drafts, statuses, { date: hoy });
const porCita = drafts.filter(row => core.dayKey(row.scheduleDate) === hoy);

console.log('\n=== FILTRO POR DÍA: FECHA DE CREACIÓN ===');
console.log(`Día seleccionado: ${hoy}\n`);

console.log(`Filas que devuelve el filtro (por ingreso): ${filtradas.length}`);
filtradas.forEach(row => console.log(`   · #${row.id} ${String(row.nombre || '').slice(0, 34)} — entró ${core.dayKey(row.enteredAt || row.reviewAt)} · cita ${row.scheduleDate ? core.dayKey(row.scheduleDate) : 'sin cita'}`));

console.log(`\nComparación: pre-reservas con CITA ese día: ${porCita.length}`);
porCita.forEach(row => console.log(`   · #${row.id} ${String(row.nombre || '').slice(0, 34)} — entró ${core.dayKey(row.enteredAt || row.reviewAt)} · cita ${core.dayKey(row.scheduleDate)}`));

const todasPorIngreso = filtradas.every(row => core.dayKey(row.enteredAt || row.reviewAt) === hoy);
const difiere = filtradas.length !== porCita.length;
console.log(`\n${todasPorIngreso ? '✓' : '✗'} Todas las filas devueltas ingresaron ese día.`);
console.log(`${difiere ? '✓' : '·'} El criterio es el de ingreso (no coincide con las citas de ese día: ${filtradas.length} vs ${porCita.length}).`);
process.exitCode = todasPorIngreso ? 0 : 1;
