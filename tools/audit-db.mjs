/* Auditoría real del dashboard contra la base de datos.
 *
 * Uso:
 *   node tools/audit-db.mjs                 # usa .env.local (service_role)
 *   node tools/audit-db.mjs --json          # salida JSON
 *   node tools/audit-db.mjs --sample 500    # filas a analizar
 *
 * Sin service_role key audita solo lo público. Con ella:
 *   - esquema real de las 4 tablas (desde el esquema OpenAPI del proyecto),
 *   - filas reales, estados reales y montos reales,
 *   - calcula los KPIs del dashboard con esos datos,
 *   - guarda la instantánea del esquema en supabase/openapi-schema.json.
 *
 * La clave se lee de .env.local (ignorado por git) o SUPABASE_SERVICE_ROLE_KEY.
 * NOTA: usa la service_role key, que salta RLS. No la compartas ni la subas al repo.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const url = configSource.match(/url:\s*'([^']+)'/)?.[1];
const publishableKey = configSource.match(/publishableKey:\s*'([^']+)'/)?.[1];
const envPath = join(root, '.env.local');
let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
if (!serviceKey && existsSync(envPath)) {
  serviceKey = readFileSync(envPath, 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1] || null;
}

const TABLES = ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions'];
const HEADERS = serviceKey
  ? { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  : { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` };

const results = { url, mode: serviceKey ? 'service_role' : 'publishable', tables: {}, problems: [], checks: [] };
const line = (label, text) => console.log(`${String(label).padEnd(38)} ${text}`);
const problem = message => { results.problems.push(message); };

async function rest(path, headers = HEADERS) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function count(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*`, {
    headers: { ...HEADERS, Prefer: 'count=exact', Range: '0-0' }
  });
  const range = response.headers.get('content-range') || '';
  const total = range.includes('/') ? Number(range.split('/')[1]) : null;
  return { status: response.status, total: Number.isFinite(total) ? total : null };
}

console.log('\n=== AUDITORÍA REAL DEL DASHBOARD · INSIDE SPA ===');
line('Proyecto', url);
line('Credencial', serviceKey ? 'service_role (acceso completo, saltando RLS)' : 'clave pública (limitado)');
line('Fecha', new Date().toLocaleString('es-MX'));

/* ---------- 1. Esquema real ---------- */
let schema = null;
try {
  const response = await fetch(`${url}/rest/v1/`, { headers: HEADERS });
  if (response.ok) {
    schema = await response.json();
    writeFileSync(join(root, 'supabase/openapi-schema.json'), JSON.stringify(schema, null, 1), 'utf8');
    const definitions = schema.definitions || schema.components?.schemas || {};
    results.tablesInSchema = Object.keys(definitions);
    console.log('\n--- ESQUEMA REAL (guardado en supabase/openapi-schema.json) ---');
    line('Tablas en el proyecto', results.tablesInSchema.length);
    results.columns = {};
    TABLES.forEach(table => {
      const properties = definitions[table]?.properties;
      if (!properties) { problem(`La tabla ${table} no aparece en el esquema`); line(table, 'NO ENCONTRADA'); return; }
      results.columns[table] = Object.keys(properties);
      line(table, `${results.columns[table].length} columnas`);
    });
  } else {
    problem(`No se pudo leer el esquema (HTTP ${response.status})`);
  }
} catch (error) {
  problem(`Error leyendo el esquema: ${error.message}`);
}

/* ---------- 2. Acceso por tabla ---------- */
console.log('\n--- ACCESO A DATOS ---');
for (const table of TABLES) {
  const probe = await rest(`${table}?select=*&limit=1`);
  const counts = await count(table);
  const code = probe.body?.code || 'ok';
  results.tables[table] = { status: probe.status, code, total: counts.total };
  line(table, `HTTP ${probe.status} · ${code}${counts.total !== null ? ` · ${counts.total} fila(s)` : ''}`);
  if (probe.status >= 400) problem(`Sin acceso a ${table}: ${code} ${probe.body?.message || ''}`);
}

if (!serviceKey) {
  console.log('\nCon la clave pública solo se ve lo anterior (RLS oculta las filas).');
  console.log('Para auditar datos, permisos y KPIs reales: crea .env.local con');
  console.log('   SUPABASE_SERVICE_ROLE_KEY=<service_role key>');
  console.log('y vuelve a ejecutar. Después elimina el archivo.');
  if (flag('--json')) console.log(`\n${JSON.stringify(results, null, 2)}`);
  process.exit(0);
}

/* ---------- 3. Datos reales ---------- */
const sampleSize = Number(value('--sample') || 500);
const fetchAll = async table => (await rest(`${table}?select=*&limit=${sampleSize}`)).body || [];
const [draftRows, receiptRows, decisionRows, confirmedRows] = await Promise.all([
  fetchAll('reservas_draft'),
  fetchAll('spa_comprobantes_pago'),
  fetchAll('dashboard_reservation_decisions'),
  fetchAll('reservas')
]);

console.log('\n--- ESTADOS REALES EN reservas_draft ---');
const stateCounts = {};
draftRows.forEach(row => { const key = String(row.estado_reserva); stateCounts[key] = (stateCounts[key] || 0) + 1; });
results.states = stateCounts;
Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).forEach(([estado, total]) => line(estado, `${total} reserva(s)`));

/* ---------- 4. KPIs con la lógica del dashboard ---------- */
const domain = await import(pathToFileURL(join(root, 'js/domain.js')).href);
const drafts = draftRows.map(domain.normalizeDraft).filter(row => Number.isFinite(row.id));
const receipts = new Map();
receiptRows.map(domain.normalizeReceipt).filter(row => Number.isFinite(row.draftId)).forEach(receipt => {
  const current = receipts.get(receipt.draftId);
  const a = new Date(receipt.updatedAt || receipt.receivedAt || 0).getTime();
  const b = new Date(current?.updatedAt || current?.receivedAt || 0).getTime();
  if (!current || a >= b) receipts.set(receipt.draftId, receipt);
});
let evidenceReceipts = 0;
drafts.forEach(draft => {
  const fromEvidence = domain.receiptFromEvidence(draft);
  if (!fromEvidence) return;
  evidenceReceipts += 1;
  const stored = receipts.get(draft.id);
  if (!stored) receipts.set(draft.id, fromEvidence);
  else receipts.set(draft.id, { ...fromEvidence, ...stored, datos: { ...fromEvidence.datos, ...stored.datos } });
  if (!draft.monto) draft.monto = domain.visibleAmount(draft, receipts.get(draft.id)).amount;
});
const decisions = decisionRows.map(domain.normalizeDecision);
const confirmed = confirmedRows.map(domain.normalizeConfirmed);
const kpis = domain.buildKpis(drafts, confirmed, decisions, receipts);
const clients = domain.buildClients(drafts, confirmed);
const receiptsList = domain.buildReceipts(drafts, receipts);

console.log('\n--- KPIs DEL DASHBOARD CON DATOS REALES ---');
line('Pre-reservas analizadas', drafts.length);
line('Reservas confirmadas', confirmed.length);
line('Decisiones registradas', decisions.length);
line('Por gestionar', kpis.toManage);
line('  · pendientes de pago', kpis.pendingCount);
line('  · por revisar + info', kpis.reviewCount);
line('  · en confirmación', kpis.processingCount);
line('  · rechazadas o expiradas', kpis.rejectedCount);
line('Confirmadas hoy', kpis.confirmedTodayCount);
line('Ingresos confirmados hoy', kpis.confirmedAmountToday);
line('Monto por confirmar', kpis.pendingAmount);
line('Clientes próximas 24 h', kpis.upcomingCount);
line('Comprobantes visibles', receiptsList.length);
line('  · recuperados de la evidencia', evidenceReceipts);
line('Clientes consolidados', clients.length);
results.kpis = {
  drafts: drafts.length, confirmed: confirmed.length, decisions: decisions.length,
  toManage: kpis.toManage, pendingCount: kpis.pendingCount, reviewCount: kpis.reviewCount,
  processingCount: kpis.processingCount, rejectedCount: kpis.rejectedCount,
  confirmedTodayCount: kpis.confirmedTodayCount, confirmedAmountToday: kpis.confirmedAmountToday,
  pendingAmount: kpis.pendingAmount, upcomingCount: kpis.upcomingCount,
  receipts: receiptsList.length, evidenceReceipts, clients: clients.length
};

console.log('\n--- MUESTRA DE GESTIÓN (5 más recientes) ---');
drafts
  .slice()
  .sort((a, b) => (new Date(b.reviewAt || 0).getTime()) - (new Date(a.reviewAt || 0).getTime()))
  .slice(0, 5)
  .forEach(draft => {
    const status = kpis.statuses.get(draft.id);
    /* Se reporta el origen real del monto, no el valor ya resuelto. */
    const raw = domain.visibleAmount({ ...draft, monto: draft.monto_pagado }, receipts.get(draft.id));
    line(`#${draft.id} ${String(draft.nombre || '').slice(0, 20)}`, `${status?.label || '?'} · ${raw.amount} (${raw.source}) · ${draft.servicio || 'sin servicio'}`);
  });

/* ---------- 5. Coherencia de datos ---------- */
console.log('\n--- COHERENCIA ---');
if (drafts.length && kpis.toManage === 0) {
  problem('Hay pre-reservas pero ninguna queda "por gestionar": revisar los valores de estado_reserva.');
}
const withoutAmount = drafts.filter(draft => !domain.visibleAmount({ ...draft, monto: draft.monto_pagado }, receipts.get(draft.id)).amount);
if (withoutAmount.length) {
  const byState = withoutAmount.reduce((acc, draft) => { acc[draft.estado] = (acc[draft.estado] || 0) + 1; return acc; }, {});
  line('Sin monto registrado', `${withoutAmount.length} pre-reserva(s) · ${JSON.stringify(byState)}`);
  results.checks.push(`Sin monto (normal en reservas que aún no pagan): ${withoutAmount.length}`);
}
const orphans = [...receipts.values()].filter(receipt => !drafts.some(draft => draft.id === receipt.draftId));
if (orphans.length) line('Aviso', `Comprobantes sin pre-reserva asociada: ${orphans.length}`);
if (!decisions.length) {
  line('Estado del flujo', 'Sin decisiones registradas todavía: la primera aprobación o rechazo aparecerá aquí.');
}

console.log('\n--- CONCLUSIÓN ---');
if (results.problems.length) {
  results.problems.forEach(item => console.log(`   ✗ ${item}`));
  console.log('\n   Solución: ejecuta supabase/APLICAR_EN_SUPABASE.sql en el SQL Editor de Supabase.');
} else {
  console.log('   ✓ El dashboard puede leer todo lo que necesita y los datos son coherentes.');
  console.log('     Queda pendiente confirmar los permisos de la sesión autenticada (RLS),');
  console.log('     que se validan con el panel Diagnóstico dentro del dashboard.');
}

if (flag('--json')) console.log(`\n${JSON.stringify(results, null, 2)}`);
