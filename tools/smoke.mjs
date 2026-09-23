/* Prueba de humo del dashboard sin navegador.
   Uso:  node tools/smoke.mjs

   Monta un DOM mínimo (con los mismos #id de index.html), intercepta la
   importación de la librería de Supabase (la respuesta de red se simula) y
   ejecuta js/main.js completo: arranque, carga de datos, render, filtros,
   apertura del modal, aprobación/rechazo y exportación CSV.
   Falla si cualquier paso lanza una excepción. */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDom, installSupabaseStub, root } from './dom-mock.mjs';

const failures = [];
const steps = [];
const warn = message => console.log(`   · ${message}`);
const step = (name, ok, detail = '') => {
  if (ok) steps.push(name);
  else failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
};

/* ---------- 1. DOM con los #id reales de index.html ---------- */
installDom({
  config: {
    url: 'https://ncutewymydclypuqlbfk.supabase.co',
    publishableKey: 'sb_publishable_prueba',
    allowedEmails: ['contacto@insidespa.com.mx', 'estebanvalbuena947@gmail.com'],
    timeZone: 'America/Mexico_City'
  }
});



/* ---------- 2. Datos simulados de Supabase ---------- */
const today = new Date();
const iso = date => date.toISOString();
const drafts = [
  { id: 1, nombre: 'Ana López', email: 'ana@test.com', phone: '5551111111', nombre_servicio: 'Masaje relajante', masaje_inicio: iso(new Date(today.getTime() + 7200000)), monto_pagado: '1200', moneda_pago: 'MXN', estado_reserva: 'requiere_revision_pago', comprobante_revision_at: iso(today) },
  { id: 2, nombre: 'Luis Pérez', email: 'luis@test.com', nombre_servicio: 'Jacuzzi', jacuzzi_inicio: iso(new Date(today.getTime() + 90000000)), monto_pagado: '$1.500,00', estado_reserva: 'procesando_pabau' },
  { id: 3, nombre: 'Marta Ruiz', nombre_servicio: 'Facial', estado_reserva: 'confirmado', reserva_confirmada: true, monto_pagado: 800, comprobante_revision_at: iso(today) }
];
const receipts = [
  { reserva_draft_id: 1, estado: 'revision', datos: { monto_pago: '1200', media_url: 'https://files.test/comprobante.jpg', fecha_pago: iso(today), referencia: 'REF-9' }, actualizado_at: iso(today) },
  { reserva_draft_id: 2, estado: 'pendiente', datos: {}, actualizado_at: iso(today) }
];
const decisions = [
  { id: 4, reservation_draft_id: 3, action: 'approved', previous_status: 'requiere_revision', resulting_status: 'confirmado', decided_by_email: 'contacto@insidespa.com.mx', created_at: iso(today) }
];
const confirmed = [
  { id: 91, nombre: 'Carlos Díaz', email: 'carlos@test.com', nombre_servicio: 'Masaje profundo', masaje_inicio: iso(new Date(today.getTime() + 3600000)), monto_pagado: 1500, pabau_confirmado_at: iso(today), reserva_confirmada: true, sucursal: 'Valle' }
];

const TABLES = {
  reservas_draft: drafts,
  spa_comprobantes_pago: receipts,
  dashboard_reservation_decisions: decisions,
  reservas: confirmed
};

function queryBuilder(table) {
  const rows = TABLES[table] || [];
  const state = { method: 'select', payload: null, filters: [] };
  const builder = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: (column, value) => { state.filters.push([column, value]); return builder; },
    update: payload => { state.method = 'update'; state.payload = payload; return builder; },
    delete: () => { state.method = 'delete'; return builder; },
    insert: payload => { state.method = 'insert'; state.payload = payload; return builder; },
    then: (resolvePromise, rejectPromise) => {
      if (state.method === 'update') dbWrites.push({ table, method: 'update', payload: state.payload, filters: state.filters });
      if (state.method === 'insert') dbWrites.push({ table, method: 'insert', payload: state.payload });
      if (state.method === 'delete') dbWrites.push({ table, method: 'delete', filters: state.filters });
      const data = state.method === 'insert' ? [{ id: '00000000-0000-0000-0000-0000000000ff', ...(state.payload || {}) }] : rows;
      return Promise.resolve({ data, error: null, count: data.length }).then(resolvePromise, rejectPromise);
    },
    catch: handler => Promise.resolve({ data: rows, error: null }).catch(handler)
  };
  return builder;
}

const rpcCalls = [];
const dbWrites = [];
/* El doble de la librería permite simular los dos caminos de una decisión:
   con RPC disponible (devuelve ok) o sin RPC (cae a la vía alternativa). */
let rpcMode = 'missing';
globalThis.__smokeSetRpcMode = mode => { rpcMode = mode; };
globalThis.__supabaseStub = {
  createClient: () => ({
    from: table => queryBuilder(table),
    rpc: async (name, params) => {
      rpcCalls.push({ name, params, mode: rpcMode });
      if (name !== 'process_dashboard_reservation_decision') {
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.x' } };
      }
      if (Number(params.p_reservation_draft_id) === -1) {
        return { data: null, error: { code: 'P0001', message: 'Not authorized for Inside Spa dashboard' } };
      }
      if (rpcMode === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.process_dashboard_reservation_decision' } };
      if (rpcMode === 'denied') return { data: null, error: { code: '42501', message: 'permission denied for function process_dashboard_reservation_decision' } };
      return { data: { ok: true, action: params.p_action }, error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: { user: { email: 'contacto@insidespa.com.mx' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
      getUser: async () => ({ data: { user: { email: 'contacto@insidespa.com.mx' } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
      signInWithOtp: async () => ({ error: null })
    },
    storage: {}
  })
};

/* ---------- 3. Interceptar la importación del módulo de Supabase ---------- */
await installSupabaseStub({ createClient: globalThis.__supabaseStub.createClient });
warn('hook de importación activo: la librería de Supabase se sustituye por un doble de prueba');

/* ---------- 4. Ejecutar main.js ---------- */
async function runDiagnosticsForTest(app) {
  const { runDiagnostics } = await import(pathToFileURL(join(root, 'js/data.js')).href);
  return runDiagnostics(app.state.supabase, {
    userEmail: app.state.userEmail,
    allowedEmails: ['contacto@insidespa.com.mx', 'estebanvalbuena947@gmail.com'],
    session: app.state.session
  });
}

let mainModule = null;
try {
  mainModule = await import(pathToFileURL(join(root, 'js/main.js')).href);
  step('main.js se importa sin errores', true);
} catch (error) {
  step('main.js se importa sin errores', false, error.stack?.split('\n').slice(0, 4).join(' | '));
}

if (mainModule) {
  const app = globalThis.window.__INSIDE_SPA__;
  step('main.js expone el estado de la app', Boolean(app && app.state));

  if (app) {
    /* Esperar el arranque: carga de datos y render inicial. */
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    const state = app.state;
    step('Arranque con sesión: email detectado', state.userEmail === 'contacto@insidespa.com.mx', String(state.userEmail));
    step('Datos cargados desde las 4 tablas', state.drafts.length === 3 && state.confirmed.length === 1 && state.decisions.length === 1,
      `drafts=${state.drafts.length} confirmadas=${state.confirmed.length} decisiones=${state.decisions.length}`);
    step('Comprobantes indexados por pre-reserva', state.receipts.size === 2, String(state.receipts.size));
    step('KPIs calculados', state.kpis.toManage === 2 && state.kpis.confirmedTodayCount >= 2,
      `porGestionar=${state.kpis.toManage} confirmadasHoy=${state.kpis.confirmedTodayCount} ingresos=${state.kpis.confirmedAmountToday}`);
    step('Montos de texto interpretados', state.drafts.find(row => row.id === 2)?.monto === 1500,
      String(state.drafts.find(row => row.id === 2)?.monto));

    const pendingBadge = document.getElementById('pendingBadge');
    step('Contador del menú actualizado', pendingBadge?.textContent === '2', String(pendingBadge?.textContent));
    const sync = document.getElementById('syncStatus');
    step('Estado de sincronización mostrado', /sincroniz|avisos/i.test(sync?.textContent || ''), sync?.textContent);
    const body = document.getElementById('reservationBody');
    step('Tabla de pre-reservas renderizada', /Ana López/.test(body?.innerHTML || '') && /Pendiente de pago|Por revisar|En confirmación/.test(body?.innerHTML || ''),
      (body?.innerHTML || '').slice(0, 80));
    step('Comprobantes renderizados', /Ana López/.test(document.getElementById('receiptList')?.innerHTML || ''));
    step('Histórico con decisiones', /Comprobante aprobado/.test(document.getElementById('decisionList')?.innerHTML || ''));
    step('Clientes consolidados', /Carlos Díaz/.test(document.getElementById('clientBody')?.innerHTML || ''));
    step('Aviso global coherente', document.getElementById('globalAlert')?.hidden === true, String(document.getElementById('globalAlert')?.hidden));

    /* Filtros */
    document.getElementById('searchInput').value = 'ana';
    document.getElementById('searchInput').dispatch('input');
    step('Filtro de búsqueda aplicado', app.state.visibleDrafts.length === 1, String(app.state.visibleDrafts.length));
    document.getElementById('searchInput').value = '';
    document.getElementById('statusFilter').value = 'processing';
    document.getElementById('statusFilter').dispatch('change');
    step('Filtro por estado aplicado', app.state.visibleDrafts.length === 1, String(app.state.visibleDrafts.length));
    document.getElementById('statusFilter').value = '';
    document.getElementById('statusFilter').dispatch('change');

    /* Diagnóstico: se validan los datos, no el HTML (evita problemas de codificación). */
    await app.diagnostics({ announce: false });
    const checks = await runDiagnosticsForTest(app);
    /* La consola de Windows altera los acentos: se comparan solo fragmentos ASCII. */
    const names = checks.map(check => check.name);
    const hasName = fragment => names.some(name => name.includes(fragment));
    step('Diagnóstico revisa todas las tablas', ['Pre-reservas', 'Comprobantes', 'Decisiones', 'Reservas confirmadas'].every(hasName), names.length + ' comprobaciones');
    step('Diagnóstico valida la sesión', hasName('Correo autorizado') && names.some(name => /^Sesi/.test(name)), names.length + ' comprobaciones');
    step('Diagnóstico valida el RPC de decisiones', names.some(name => name.includes('RPC')), names.length + ' comprobaciones');
    step('Diagnóstico sin fallos con el doble de prueba', checks.every(check => check.status !== 'fail'), JSON.stringify(checks.filter(check => check.status === 'fail')));
    step('Diagnóstico pintado en pantalla', (document.getElementById('checksList')?.innerHTML || '').includes('check'));

    /* Modal y botones de decisión */
    const { renderReservationModal, renderModalActions } = await import(pathToFileURL(join(root, 'js/view.js')).href);
    const opened = renderReservationModal(state, 1);
    step('Modal de detalle se construye', opened === true);
    renderModalActions(state, 1);
    step('Botones "Aprobar", "Rechazar" y "Pedir información"', ['approveBtn', 'rejectBtn', 'requestInfoBtn'].every(id => globalThis.document.getElementById(id)), '');
    step('Nota de decisión presente', Boolean(document.getElementById('decisionNote')));
    step('Modal no ofrece decidir sobre una confirmada', (() => { renderModalActions(state, 3); return Boolean(document.getElementById('closeModalBtn')); })());

    /* Decisión por la vía alternativa: el RPC no existe en el doble. */
    const { decide: commitDecision } = await import(pathToFileURL(join(root, 'js/data.js')).href);
    const writesBefore = dbWrites.length;
    const fallback = await commitDecision(app.state.supabase, {
      draftId: 1, action: 'approved', note: 'aprobado en la prueba', previousStatus: 'Por revisar', userEmail: app.state.userEmail
    });
    step('Decisión sin RPC usa la vía alternativa', fallback.via === 'fallback', String(fallback.via));
    step('Vía alternativa actualiza la pre-reserva', dbWrites.slice(writesBefore).some(write => write.table === 'reservas_draft' && write.method === 'update' && write.payload?.estado_reserva === 'confirmado'),
      JSON.stringify(dbWrites.slice(writesBefore)));
    step('Vía alternativa registra la decisión', dbWrites.slice(writesBefore).some(write => write.table === 'dashboard_reservation_decisions' && write.method === 'insert' && write.payload?.action === 'approved'));

    /* Decisión con RPC disponible: camino normal. */
    globalThis.__smokeSetRpcMode('ok');
    const viaRpc = await commitDecision(app.state.supabase, {
      draftId: 2, action: 'rejected', note: null, previousStatus: 'En confirmación', userEmail: app.state.userEmail
    });
    step('Decisión con RPC usa el camino oficial', viaRpc.via === 'rpc', String(viaRpc.via));
    step('El RPC recibe id, acción y nota', (() => {
      const call = rpcCalls.filter(item => item.mode === 'ok').pop();
      return call?.name === 'process_dashboard_reservation_decision' && call.params.p_reservation_draft_id === 2 && call.params.p_action === 'rejected';
    })(), JSON.stringify(rpcCalls.slice(-1)));

    /* Decisión sin permisos: se reporta el fallo en vez de fingir éxito. */
    globalThis.__smokeSetRpcMode('denied');
    let deniedMessage = '';
    try {
      await commitDecision(app.state.supabase, { draftId: 1, action: 'needs_info', note: null, previousStatus: 'x', userEmail: app.state.userEmail });
    } catch (error) {
      deniedMessage = error.message || '';
    }
    step('Sin permisos se informa el error (no hay falso éxito)', /permiso|permission/i.test(deniedMessage), deniedMessage.slice(0, 120));
    globalThis.__smokeSetRpcMode('missing');

    await app.refresh({ reason: 'prueba' });
    step('Refresco manual sin errores', app.state.loaded === true);
    step('La tabla se vuelve a pintar tras decidir', /Ana López/.test(document.getElementById('reservationBody')?.innerHTML || ''));
  }
}

/* ---------- Resultado ---------- */
console.log(`\n✓ ${steps.length} pasos correctos`);
if (failures.length) {
  console.log(`✗ ${failures.length} fallos:`);
  failures.forEach(failure => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log('La aplicación arranca, carga datos, renderiza todas las vistas y no lanza errores.');
}
