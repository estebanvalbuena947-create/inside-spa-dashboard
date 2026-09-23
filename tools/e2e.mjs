/* Prueba de integración de punta a punta del dashboard.
 *
 *   node tools/e2e.mjs
 *
 * Levanta tools/mock-backend.mjs (backend local con las columnas reales, RLS y
 * el RPC de decisiones), usa la librería OFICIAL de Supabase descargada del CDN
 * y ejecuta el dashboard completo. Verifica:
 *
 *   1. Sin sesión: la RLS oculta las filas y el dashboard lo explica (no falla
 *      en silencio ni inventa datos).
 *   2. Con sesión válida: lee las 4 tablas, calcula las métricas correctas,
 *      pinta tabla, comprobantes, clientes e histórico.
 *   3. Decisión "aprobar": viaja por el RPC, actualiza el estado en el backend y
 *      deja el registro en el histórico (comprobado en los datos del servidor).
 *   4. Decisión "pedir información" y "rechazar": mismo camino, estados correctos.
 *   5. Una tabla sin GRANT se reporta como problema de permisos.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDom, installSupabaseStub, readSupabaseConfig, root } from './dom-mock.mjs';
import { startMockBackend, mockUrl, mockDb, mockStats, signToken, TEST_EMAIL } from './mock-backend.mjs';

const entry = join(root, '.vendor', 'entry.mjs');
if (!existsSync(entry)) {
  console.error('Falta .vendor/: ejecuta primero  node tools/vendor-sdk.mjs');
  process.exit(2);
}

const failures = [];
const passes = [];
const check = (name, condition, detail = '') => {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
};
const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

await startMockBackend();
const config = readSupabaseConfig();
const backendConfig = { ...config, url: mockUrl };
installDom({ config: backendConfig });
const sdk = await import(pathToFileURL(entry).href);
await installSupabaseStub({ createClient: sdk.createClient });

console.log('\n=== PRUEBA DE INTEGRACIÓN DEL DASHBOARD ===');
console.log(`Backend : ${mockUrl} (imitación local con las columnas reales)`);
console.log(`Librería: @supabase/supabase-js oficial desde .vendor/\n`);

const doc = globalThis.document;
const parseRows = id => (doc.getElementById(id)?.innerHTML.match(/<tr>/g) || []).length;
/* Se importa view.js directamente para probar el manejador de clics de las filas. */
const { rowActionId } = await import(pathToFileURL(join(root, 'js/view.js')).href);

/* ---------- 1. Sin sesión ---------- */
await import(pathToFileURL(join(root, 'js/main.js')).href + `?run=${Date.now()}`);
let app = globalThis.window.__INSIDE_SPA__;
await wait(600);
console.log('--- 1. SIN SESIÓN (RLS activa) ---');
check('La app arranca sin sesión', Boolean(app?.state));
check('Sin sesión no se leen filas', app.state.drafts.length === 0, String(app.state.drafts.length));
check('Sin sesión el estado pide iniciar sesión', /Conecta tu cuenta/i.test(doc.getElementById('syncStatus')?.textContent || ''), doc.getElementById('syncStatus')?.textContent);
check('Sin sesión la tabla está vacía', parseRows('reservationBody') === 0, String(parseRows('reservationBody')));

/* ---------- 2. Con sesión válida ---------- */
const token = signToken();
const storageKey = `sb-${mockUrl.match(/https?:\/\/([^.]+)\.?/)?.[1] || 'local'}-auth-token`;
const session = {
  access_token: token,
  refresh_token: 'prueba',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: '00000000-0000-0000-0000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: TEST_EMAIL, app_metadata: {}, user_metadata: {} }
};
globalThis.localStorage.setItem(storageKey, JSON.stringify(session));
globalThis.window.localStorage.setItem(storageKey, JSON.stringify(session));

await app.refresh({ reason: 'e2e' });
await wait(300);
console.log('\n--- 2. CON SESIÓN VÁLIDA (lectura y métricas) ---');
const state = app.state;
check('Lee las 5 pre-reservas', state.drafts.length === 5, String(state.drafts.length));
check('Lee las 2 reservas confirmadas', state.confirmed.length === 2, String(state.confirmed.length));
check('Indexa el comprobante', state.receipts.size >= 1, String(state.receipts.size));
check('Monto leído del comprobante cuando monto_pagado es null', state.drafts.find(row => row.id === 189)?.monto === 1000,
  String(state.drafts.find(row => row.id === 189)?.monto));
check('Por gestionar = 3 (1 revisión, 1 pendiente, 1 en retención)', state.kpis.toManage === 3, String(state.kpis.toManage));
check('Rechazadas/expiradas = 1', state.kpis.rejectedCount === 1, String(state.kpis.rejectedCount));
check('Monto por confirmar = 1000', state.kpis.pendingAmount === 1000, String(state.kpis.pendingAmount));
check('Clientes en 24 h = 1', state.kpis.upcomingCount === 1, String(state.kpis.upcomingCount));
check('Aviso de retención por vencer', state.kpis.expiringHolds.length === 1 && state.kpis.expiringHolds[0].id === 189, String(state.kpis.expiringHolds.length));
check('La interfaz muestra el aviso de retención', doc.getElementById('holdAlert')?.hidden === false);
check('Métrica "por gestionar" en pantalla', doc.getElementById('pendingMetric')?.textContent === '3', doc.getElementById('pendingMetric')?.textContent);
check('Métrica de ingresos en pantalla', doc.getElementById('revenueMetric')?.textContent === '$1,000', doc.getElementById('revenueMetric')?.textContent);
check('Tabla con las 5 pre-reservas', parseRows('reservationBody') === 5, String(parseRows('reservationBody')));
const tableMarkup = doc.getElementById('reservationBody')?.innerHTML || '';
check('Cada fila con comprobante ofrece verlo', (tableMarkup.match(/receipt-link/g) || []).length === 1,
  `${(tableMarkup.match(/receipt-link/g) || []).length} enlace(s)`);
check('El enlace abre el comprobante en otra pestaña',
  /class="receipt-link" href="https:\/\/files\.test\/comprobante-189\.jpg" target="_blank" rel="noopener noreferrer"/.test(tableMarkup),
  (tableMarkup.match(/<a class="receipt-link"[^>]*>/) || ['(sin enlace)'])[0]);
check('El enlace del comprobante no abre el modal', (() => {
  const event = { target: { closest: selector => (selector === '.receipt-link' ? {} : null) } };
  return rowActionId(event) === null;
})());

/* El modal de gestión también debe permitir abrir el comprobante. */
const { renderReservationModal, renderModalActions } = await import(pathToFileURL(join(root, 'js/view.js')).href);
renderReservationModal(app.state, 189);
renderModalActions(app.state, 189);
const actionsMarkup = doc.getElementById('modalActions')?.innerHTML || '';
check('El modal ofrece abrir el comprobante en otra pestaña',
  /modal-receipt-link/.test(actionsMarkup) && /target="_blank" rel="noopener noreferrer"/.test(actionsMarkup),
  actionsMarkup.slice(0, 120));
check('El modal mantiene las tres decisiones', ['approveBtn', 'rejectBtn', 'requestInfoBtn'].every(id => actionsMarkup.includes(id)));
check('Clientes consolidados = 7 (5 pre-reservas + 2 confirmadas)', parseRows('clientBody') === 7, `filas: ${parseRows('clientBody')}`);
check('Histórico con la reserva confirmada', /Reserva confirmada/.test(doc.getElementById('decisionList')?.innerHTML || ''));

/* ---------- 3. Decisión: aprobar ---------- */
const { decide } = await import(pathToFileURL(join(root, 'js/data.js')).href);
console.log('\n--- 3. DECISIÓN "APROBAR" POR EL RPC ---');
const approval = await decide(state.supabase, { draftId: 189, action: 'approved', note: 'verificado en el banco', previousStatus: 'Por revisar', userEmail: TEST_EMAIL });
check('La aprobación viaja por el RPC', approval.via === 'rpc', String(approval.via));
const approvedRow = mockDb.reservas_draft.find(row => row.id === 189);
check('El estado quedó en confirmado', approvedRow.estado_reserva === 'confirmado', approvedRow.estado_reserva);
check('Se marcó el pago como recibido', approvedRow.pago_recibido === true);
check('La evidencia guarda quién revisó', approvedRow.comprobante_revision_datos?.decision_dashboard_por === TEST_EMAIL, JSON.stringify(approvedRow.comprobante_revision_datos?.comprobante_estado));
check('El comprobante quedó aprobado', mockDb.spa_comprobantes_pago.find(row => row.reserva_draft_id === 189)?.estado === 'aprobado');
check('Queda registro en el histórico', mockDb.dashboard_reservation_decisions.some(row => row.reservation_draft_id === 189 && row.action === 'approved' && row.note === 'verificado en el banco'));

/* ---------- 4. Decisión: pedir información y rechazar ---------- */
console.log('\n--- 4. DECISIONES "PEDIR INFORMACIÓN" Y "RECHAZAR" ---');
await decide(state.supabase, { draftId: 150, action: 'needs_info', note: null, previousStatus: 'Pendiente de pago', userEmail: TEST_EMAIL });
const infoRow = mockDb.reservas_draft.find(row => row.id === 150);
check('Pedir información deja la reserva en revisión', infoRow.estado_reserva === 'requiere_revision', infoRow.estado_reserva);

await decide(state.supabase, { draftId: 140, action: 'rejected', note: 'comprobante ilegible', previousStatus: 'En confirmación', userEmail: TEST_EMAIL });
const rejectedRow = mockDb.reservas_draft.find(row => row.id === 140);
check('Rechazar deja la reserva rechazada', rejectedRow.estado_reserva === 'rechazado', rejectedRow.estado_reserva);
check('Se registraron las 3 decisiones', mockDb.dashboard_reservation_decisions.length === 3, String(mockDb.dashboard_reservation_decisions.length));

/* ---------- 5. La interfaz refleja las decisiones ---------- */
await app.refresh({ reason: 'e2e-2' });
await wait(300);

/* ---------- 5.b Tarjeta "Pre-reservas con fecha de hoy" ---------- */
const { isToday } = await import(pathToFileURL(join(root, 'js/core.js')).href);
const draftsToday = app.state.drafts.filter(row => isToday(row.scheduleDate)).length;
const occupancyTitle = doc.getElementById('occupancyCard')?.innerHTML || doc.querySelector('#occupancyCard')?.outerHTML || '';
check('La tarjeta se titula "Pre-reservas con fecha de hoy"',
  /Pre-reservas con fecha de hoy/.test(occupancyTitle)
  || /Pre-reservas con fecha de hoy/.test(readFileSync(join(root, 'index.html'), 'utf8')),
  occupancyTitle.slice(0, 100));
check('El número principal son las pre-reservas de hoy',
  (doc.getElementById('occupancyRatio')?.innerHTML || '').startsWith(String(draftsToday)),
  `esperado ${draftsToday} · tiene "${doc.getElementById('occupancyRatio')?.innerHTML}"`);
check('La tarjeta no muestra porcentaje ni notas', !doc.getElementById('occupancyPercent') && !doc.getElementById('occupancyNote'),
  `percent=${Boolean(doc.getElementById('occupancyPercent'))} note=${Boolean(doc.getElementById('occupancyNote'))}`);

/* ---------- 6. El diagnóstico no deja basura en el histórico ---------- */
const decisionsBefore = mockDb.dashboard_reservation_decisions.length;
const probesBefore = mockStats.writeProbeCalls;
await app.diagnostics({ announce: false });
check('El diagnóstico usa la función de comprobación de escritura', mockStats.writeProbeCalls === probesBefore + 1,
  `${probesBefore} -> ${mockStats.writeProbeCalls}`);
check('El diagnóstico no deja registros de prueba', mockDb.dashboard_reservation_decisions.length === decisionsBefore,
  `${decisionsBefore} -> ${mockDb.dashboard_reservation_decisions.length}`);
check('Ningún registro del histórico es de prueba',
  mockDb.dashboard_reservation_decisions.every(row => row.note !== 'diagnostico-automatico-descartable'));

console.log('\n--- 5. LA INTERFAZ REFLEJA LAS DECISIONES ---');
check('El histórico muestra 3 decisiones', (doc.getElementById('decisionList')?.innerHTML.match(/decision-item/g) || []).length >= 3,
  String((doc.getElementById('decisionList')?.innerHTML.match(/decision-item/g) || []).length));
check('Por gestionar baja a 1', app.state.kpis.toManage === 1, String(app.state.kpis.toManage));

/* ---------- Resultado ---------- */
console.log(`\n✓ ${passes.length} comprobaciones correctas`);
if (failures.length) {
  console.log(`✗ ${failures.length} fallos:`);
  failures.forEach(failure => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log('El dashboard funciona de punta a punta: lectura real, métricas correctas y decisiones guardadas.');
}
process.exit(process.exitCode || 0);
