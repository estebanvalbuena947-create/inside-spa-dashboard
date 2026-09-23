/* Verificación del dashboard sin navegador.
   Uso:  node tools/verify.mjs
   Comprueba: sintaxis, IDs usados por el código vs index.html, KPIs,
   estados, montos en texto y exportación CSV. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const passes = [];

const check = (name, condition, detail = '') => {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
};

/* ---------- 1. IDs del DOM ---------- */
const html = readFileSync(join(root, 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const jsSources = readdirSync(join(root, 'js')).filter(file => file.endsWith('.js'));
/* IDs que el JS crea en tiempo de ejecución dentro de HTML dinámico. */
const DYNAMIC_IDS = new Set(['approveBtn', 'rejectBtn', 'requestInfoBtn', 'closeModalBtn']);
const referenced = new Set();
jsSources.forEach(file => {
  const source = readFileSync(join(root, 'js', file), 'utf8');
  for (const match of source.matchAll(/['"`]#([A-Za-z][\w-]*)['"`]/g)) {
    const id = match[1];
    if (/^[0-9a-fA-F]{6}$/.test(id)) continue; // colores hexadecimales, no IDs
    referenced.add(id);
  }
});
const missingIds = [...referenced].filter(id => !htmlIds.has(id) && !DYNAMIC_IDS.has(id));
check('Todos los #id usados por JS existen en index.html', missingIds.length === 0, missingIds.join(', '));
check('Los #id dinámicos siguen declarados en el JS', [...DYNAMIC_IDS].every(id => jsSources.some(file => readFileSync(join(root, 'js', file), 'utf8').includes(id))));

/* ---------- 2. Navegación ---------- */
const navTargets = [...html.matchAll(/class="nav-link[^"]*" href="#([\w-]+)"/g)].map(match => match[1]);
const missingSections = navTargets.filter(target => !htmlIds.has(target));
check('Cada enlace del menú tiene su sección', missingSections.length === 0, missingSections.join(', '));

/* ---------- 3. Sin datos falsos en la interfaz ---------- */
const fakePatterns = [[/>72<small>/, 'ocupación 72%'], [/13 de 18 cupos reservados/, 'cupos fijos'], [/↑ 12% vs\. ayer/, 'variación inventada'], [/↑ 8% vs\. ayer/, 'variación inventada'], [/Lunes, 21 de septiembre/, 'fecha fija']];
const fakeFound = fakePatterns.filter(([pattern]) => pattern.test(html)).map(([, label]) => label);
check('No quedan métricas ni fechas inventadas en el HTML', fakeFound.length === 0, fakeFound.join(', '));

/* ---------- 4. Lógica de negocio ---------- */
const { buildKpis, buildClients, buildReceipts, filterDrafts, indexByDraftId, isConfirmed, normalizeConfirmed, normalizeDecision, normalizeDraft, normalizeReceipt, receiptFromEvidence, serviceOptions, statusOf, visibleAmount } = await import(pathToFileURL(join(root, 'js/domain.js')).href);
const { toAmount, buildCsv, parseDate, isToday, dayKey, dayKeyInZone, todayKey } = await import(pathToFileURL(join(root, 'js/core.js')).href);

check('toAmount convierte "$1,200.50"', toAmount('$1,200.50') === 1200.5, String(toAmount('$1,200.50')));
check('toAmount convierte "1500"', toAmount('1500') === 1500, String(toAmount('1500')));
check('toAmount convierte "1.200,75"', toAmount('1.200,75') === 1200.75, String(toAmount('1.200,75')));
check('toAmount ignora vacíos', toAmount('') === 0 && toAmount(null) === 0);
check('toAmount no produce NaN', !Number.isNaN(toAmount('abc')));

const today = new Date();
const iso = date => date.toISOString();
const inTwoHours = new Date(today.getTime() + 2 * 3600 * 1000);
const tomorrow = new Date(today.getTime() + 26 * 3600 * 1000);

/* Fixtures con la MISMA forma que la base real: `monto_pagado` vacío y el dato
   económico dentro de `comprobante_revision_datos`. */
const evidenceOne = {
  media_url: 'https://files.test/c2.jpg',
  monto_documento: 1000,
  fecha_pago_documento: iso(today),
  comprobante_estado: 'revision',
  tipo_pago: 'transferencia',
  banco_emisor: 'BBVA',
  nombre_beneficiario: 'Juan Ricardo C',
  cuenta_visible: '•9553',
  motivos_revision_pago: ['ESTADO_PAGO_NO_CORROBORADO', 'FALTA_FOLIO_PARA_IDENTIFICAR_COMPROBANTE']
};
const draftRows = [
  { id: 1, nombre: 'Ana López', email: 'ana@test.com', nombre_servicio: 'Masaje relajante', servicio: 'masaje_relajante', masaje_inicio: iso(inTwoHours), monto_pagado: '1200', estado_reserva: 'requiere_revision_pago', comprobante_revision_at: iso(today) },
  { id: 2, nombre: 'Luis Pérez', email: 'luis@test.com', nombre_servicio: 'Jacuzzi', servicio: 'jacuzzi', jacuzzi_inicio: iso(tomorrow), monto_pagado: null, monto_esperado: 1000, comprobante_revision_datos: evidenceOne, estado_reserva: 'procesando_pabau', comprobante_revision_at: iso(today) },
  { id: 3, nombre: 'Marta Ruiz', nombre_servicio: 'Facial', servicio: 'facial', estado_reserva: 'confirmado', reserva_confirmada: true, monto_pagado: 800, comprobante_revision_at: iso(today) },
  { id: 4, nombre: 'Ana López', email: 'ana@test.com', nombre_servicio: 'Facial', servicio: 'facial', estado_reserva: 'requiere_revision' },
  { id: 5, nombre: 'Sofía Nava', email: 'sofia@test.com', nombre_servicio: 'Jacuzzi', servicio: 'jacuzzi', jacuzzi_inicio: iso(inTwoHours), monto_pagado: null, estado_reserva: 'creando_retencion', retencion_expira_at: iso(new Date(today.getTime() + 35 * 60000)), intentos_pago: 2 }
];
const confirmedRows = [
  { id: 91, nombre: 'Carlos Díaz', email: 'carlos@test.com', nombre_servicio: 'Masaje profundo', masaje_inicio: iso(inTwoHours), monto_pagado: 1500, pabau_confirmado_at: iso(today), reserva_confirmada: true },
  { id: 92, nombre: 'Carlos Díaz', email: 'carlos@test.com', nombre_servicio: 'Jacuzzi', jacuzzi_inicio: iso(tomorrow), monto_pagado: '700', pabau_confirmado_at: iso(new Date(today.getTime() - 3 * 86400000)) }
];
const receiptRows = [
  { reserva_draft_id: 1, estado: 'revision', datos: { monto_pago: '1200', media_url: 'https://files.test/c1.jpg', fecha_pago: iso(today), folio: 'REF-1', tipo_pago: 'transferencia' }, creado_at: iso(today), actualizado_at: iso(today) },
  { reserva_draft_id: 1, estado: 'revision', datos: { monto_pago: '1200' }, creado_at: iso(new Date(today.getTime() - 86400000)), actualizado_at: iso(new Date(today.getTime() - 86400000)) }
];
const decisionRows = [
  { id: 5, reservation_draft_id: 4, action: 'rejected', previous_status: 'requiere_revision', resulting_status: 'rechazado', decided_by_email: 'contacto@insidespa.com.mx', created_at: iso(today) },
  { id: 6, reservation_draft_id: 1, action: 'needs_info', previous_status: 'requiere_revision_pago', resulting_status: 'requiere_revision', decided_by_email: 'contacto@insidespa.com.mx', created_at: iso(new Date(today.getTime() - 3600000)) }
];
const drafts = draftRows.map(normalizeDraft);
/* Copia sin decisiones aplicadas, para probar los filtros sobre el estado base. */
const renormalized = drafts.map(row => ({ ...row, monto: toAmount(row.monto) }));
const confirmed = confirmedRows.map(normalizeConfirmed);
const decisions = decisionRows.map(normalizeDecision);
const receipts = new Map();
receiptRows.map(normalizeReceipt).forEach(receipt => {
  const current = receipts.get(receipt.draftId);
  const a = new Date(receipt.updatedAt || 0).getTime();
  const b = new Date(current?.updatedAt || 0).getTime();
  if (!current || a >= b) receipts.set(receipt.draftId, receipt);
});

check('Comprobante más reciente por reserva (folio)', receipts.get(1).reference === 'REF-1', String(receipts.get(1).reference));
check('Monto del comprobante leído de datos.monto_pago', receipts.get(1).amount === 1200, String(receipts.get(1).amount));
check('Monto de la reserva se usa cuando existe', visibleAmount(drafts[0], receipts.get(1)).amount === 1200 && visibleAmount(drafts[0], receipts.get(1)).source === 'reserva');
check('Monto tomado de la evidencia cuando monto_pagado es null', drafts[1].monto === 1000, String(drafts[1].monto));
check('Evidencia produce comprobante aunque no haya fila en la tabla', Boolean(receiptFromEvidence(drafts[1])), 'sin evidencia');
check('Motivos de revisión de n8n llegan al modelo', drafts[1].motivosPago.length === 2, String(drafts[1].motivosPago.length));
check('Tipo de pago y banco visibles', receiptFromEvidence(drafts[1]).bank === 'BBVA' && receiptFromEvidence(drafts[1]).method === 'transferencia');
check('Detecta confirmada por reserva_confirmada', isConfirmed(drafts[2]) === true);
check('Estado "requiere_revision_pago" => review', statusOf(drafts[0]).key === 'review', statusOf(drafts[0]).key);
check('Estado "procesando_pabau" => processing', statusOf(drafts[1]).key === 'processing', statusOf(drafts[1]).key);
check('Estado "creando_retencion" => processing', statusOf(drafts[4]).key === 'processing', statusOf(drafts[4]).key);
check('Rechazo previo manda sobre el estado base', statusOf(drafts[3], decisions.find(d => d.draftId === 4)).key === 'rejected');

const kpis = buildKpis(drafts, confirmed, decisions, receipts);
check('KPI "por gestionar" = 3 (info + confirmación + retención)', kpis.toManage === 3, String(kpis.toManage));
check('KPI confirmadas hoy = 2 (1 draft + 1 reserva)', kpis.confirmedTodayCount === 2, String(kpis.confirmedTodayCount));
check('KPI ingresos de hoy = 2300', kpis.confirmedAmountToday === 2300, String(kpis.confirmedAmountToday));
check('KPI por confirmar suma reserva + comprobante = 2200', Math.abs(kpis.pendingAmount - 2200) < 0.001, String(kpis.pendingAmount));
check('KPI próximas 24 h = 1', kpis.upcomingCount === 1, String(kpis.upcomingCount));
check('KPI rechazadas = 1', kpis.rejectedCount === 1, String(kpis.rejectedCount));
check('Alerta de retención próxima a vencer', kpis.expiringHolds.length === 1 && kpis.expiringHolds[0].id === 5, String(kpis.expiringHolds.length));
check('Lee el vencimiento y los intentos de pago', drafts[4].retencionExpiraAt instanceof Date && drafts[4].intentosPago === 2, String(drafts[4].intentosPago));

const statuses = kpis.statuses;
const baseStatuses = buildKpis(renormalized, confirmed, [], receipts).statuses;
check('Decisión "needs_info" produce estado propio', statuses.get(1)?.key === 'info', statuses.get(1)?.key);
check('Estado "en confirmación" no se pierde', statuses.get(2)?.key === 'processing', statuses.get(2)?.key);
const onlyReview = filterDrafts(renormalized, baseStatuses, { status: 'review' });
check('Filtro por estado "review" devuelve 2', onlyReview.length === 2, String(onlyReview.length));
check('Sin decisiones, 4 pre-reservas por gestionar', buildKpis(renormalized, confirmed, [], receipts).toManage === 4, String(buildKpis(renormalized, confirmed, [], receipts).toManage));
const onlyInfo = filterDrafts(drafts, statuses, { status: 'info' });
check('Filtro por estado "info" devuelve 1', onlyInfo.length === 1, String(onlyInfo.length));
const byQuery = filterDrafts(drafts, statuses, { query: 'ana' });
check('Búsqueda por nombre devuelve 2', byQuery.length === 2, String(byQuery.length));
const byService = filterDrafts(drafts, statuses, { service: 'Facial' });
check('Filtro por servicio devuelve 2', byService.length === 2, String(byService.length));
const byDay = filterDrafts(renormalized, baseStatuses, { date: new Date().toISOString().slice(0, 10) });
check('Filtro por día de hoy devuelve 3', byDay.length === 3, String(byDay.length));
check('dayKey no desfasa "YYYY-MM-DD"', dayKey('2026-09-23') === '2026-09-23', String(dayKey('2026-09-23')));
check('dayKey usa la hora local en ISO', dayKey('2026-09-23T18:30:00Z') === (() => { const d = new Date('2026-09-23T18:30:00Z'); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(), String(dayKey('2026-09-23T18:30:00Z')));
check('isToday acepta fecha sin hora', isToday(todayKey()) === true, todayKey());
check('dayKeyInZone usa la zona del negocio, no la del navegador', dayKeyInZone('2026-09-23T03:12:27+00:00', 'America/Mexico_City') === '2026-09-22', String(dayKeyInZone('2026-09-23T03:12:27+00:00', 'America/Mexico_City')));
check('Opciones de servicio ordenadas', serviceOptions(drafts).join('|') === 'Facial|Jacuzzi|Masaje relajante', serviceOptions(drafts).join('|'));

const clients = buildClients(drafts, confirmed);
check('Clientes consolidados = 5', clients.length === 5, String(clients.length));
check('Cliente repetido suma 2 reservas', clients.find(client => client.email === 'ana@test.com')?.total === 2);
check('Cliente confirmado acumula valor', clients.find(client => client.email === 'carlos@test.com')?.amount === 2200);

const receiptList = buildReceipts(drafts, receipts);
check('Lista de comprobantes enlaza la pre-reserva', receiptList.length === 2 && receiptList.every(item => item.draft));

const csv = buildCsv(['A', 'B'], [['1', 'texto, con coma'], ['2', 'con "comillas"']]);
check('CSV escapa comas y comillas', csv.includes('"texto, con coma"') && csv.includes('""comillas""'));
check('CSV incluye BOM para Excel', csv.startsWith('\uFEFF'));
check('isToday detecta la fecha actual', isToday(new Date()) === true);

/* ---------- 5. Columnas declaradas vs. esquema real ---------- */
const schemaPath = join(root, 'supabase/openapi-schema.json');
if (existsSync(schemaPath)) {
  const spec = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const definitions = spec.definitions || spec.components?.schemas || {};
  const dataSource = readFileSync(join(root, 'js/data.js'), 'utf8');
  const declared = [...dataSource.matchAll(/^\s{2}(reservas_draft|reservas|spa_comprobantes_pago|dashboard_reservation_decisions):\s*'([^']+)'/gm)];
  check('Se leyeron las listas de columnas de data.js', declared.length === 4, String(declared.length));
  declared.forEach(([, table, columns]) => {
    const available = Object.keys(definitions[table]?.properties || {});
    const unknown = columns.split(',').filter(column => !available.includes(column));
    check(`Columnas de ${table} existen en el esquema real`, unknown.length === 0, unknown.join(', '));
  });
  /* Las columnas de orden también deben existir: si no, la consulta falla y cae al comodín. */
  const orderBlock = dataSource.match(/const ORDER_CANDIDATES = \{([\s\S]*?)\n\};/)?.[1] || '';
  [...orderBlock.matchAll(/(\w+):\s*\[([^\]]+)\]/g)].forEach(([, table, list]) => {
    const available = Object.keys(definitions[table]?.properties || {});
    const unknown = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]).filter(column => !available.includes(column));
    check(`Columnas de orden de ${table} existen`, unknown.length === 0, unknown.join(', '));
  });
} else {
  console.log('   · sin supabase/openapi-schema.json: se omite la validación de columnas');
}

/* ---------- 6. Archivos requeridos ---------- */
const required = ['index.html', 'styles.css', 'dashboard.css', 'supabase-config.js', 'js/main.js', 'js/data.js', 'js/domain.js', 'js/core.js', 'js/view.js'];
const files = new Set(readdirSync(root, { recursive: true }).map(entry => String(entry).replaceAll('\\', '/')));
required.forEach(file => check(`Existe ${file}`, files.has(file)));

/* ---------- Resultado ---------- */
console.log(`\n✓ ${passes.length} comprobaciones correctas`);
if (failures.length) {
  console.log(`✗ ${failures.length} fallos:`);
  failures.forEach(failure => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Sin fallos: la lógica y la estructura del dashboard son consistentes.');
}
