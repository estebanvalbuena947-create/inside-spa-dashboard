/* Backend PostgREST mínimo que imita la base real del dashboard.
 *
 *   node tools/mock-backend.mjs [--port 4599]
 *
 * Reproduce, con las columnas reales del proyecto:
 *   - las 4 tablas y su RLS (sin sesión no se ven filas; con sesión sí),
 *   - el GRANT de lectura como una tabla aparte que responde 42501 (igual que
 *     spa_comprobantes_pago hoy), para comprobar que el dashboard lo explica,
 *   - el RPC process_dashboard_reservation_decision con la misma validación de
 *     autorización, y la actualización del estado y del histórico.
 *
 * Sirve para probar el dashboard de punta a punta (lectura, métricas y
 * decisiones) sin depender de credenciales ni de datos reales.
 */

import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 4599);
export const JWT_SECRET = 'secreto-local-de-prueba';
export const TEST_EMAIL = 'contacto@insidespa.com.mx';

const today = new Date();
const iso = date => date.toISOString();
const plus = (minutes) => iso(new Date(today.getTime() + minutes * 60000));

/* Datos con la MISMA forma que la base real. */
const db = {
  reservas_draft: [
    {
      id: 189, nombre: 'Daniela Cisneros', email: 'dany@test.com', phone: '2461288393',
      nombre_servicio: 'Masaje Full Day Spa pareja', servicio: 'full_day_spa_pareja',
      jacuzzi_inicio: plus(60 * 24 * 3), masaje_inicio: plus(60 * 24 * 3 + 40),
      monto_pagado: null, moneda_pago: null, estado_reserva: 'requiere_revision_pago',
      reserva_confirmada: null, pago_recibido: false, horario_pendiente: false,
      motivo_revision: 'COMPROBANTE_RECIBIDO_PENDIENTE_VALIDACION',
      comprobante_revision_at: iso(new Date(today.getTime() - 30 * 60000)),
      comprobante_revision_datos: {
        monto_documento: 1000, monto_pago: 1000, moneda: 'MXN', fecha_pago_documento: iso(today).slice(0, 10),
        media_url: 'https://files.test/comprobante-189.jpg', tipo_pago: 'transferencia', banco_emisor: 'BBVA',
        nombre_beneficiario: 'Juan Ricardo C', cuenta_visible: '•9553', confianza_pago: 0.9,
        motivos_revision_pago: ['ESTADO_PAGO_NO_CORROBORADO', 'FALTA_FOLIO_PARA_IDENTIFICAR_COMPROBANTE']
      },
      retencion_expira_at: plus(35), intentos_pago: 1, procesando_desde: iso(new Date(today.getTime() - 20 * 60000))
    },
    {
      id: 150, nombre: 'Miguel Ángel Quintero', email: 'miguel@test.com', phone: '5512345678',
      nombre_servicio: 'Jacuzzi', servicio: 'jacuzzi', jacuzzi_inicio: plus(60 * 30), masaje_inicio: plus(60 * 30 + 40),
      monto_pagado: null, estado_reserva: 'pendiente_pago', reserva_confirmada: null, pago_recibido: false,
      motivo_revision: 'RETENCION_CONSERVADA_POR_ASESORA', retencion_expira_at: plus(60 * 20), intentos_pago: 0
    },
    {
      id: 140, nombre: 'Emilio Alfaro', email: 'emilio@test.com', nombre_servicio: 'Masaje Premium Budha 70 pareja',
      servicio: 'budha_70_pareja', jacuzzi_inicio: plus(60 * 48), estado_reserva: 'creando_retencion',
      pago_recibido: false, monto_pagado: null
    },
    {
      id: 188, nombre: 'Alejandra Zaldívar', email: 'ale@test.com', nombre_servicio: 'Facial', servicio: 'facial',
      estado_reserva: 'expirado_sin_pago', pago_recibido: false, monto_pagado: null
    },
    {
      id: 97, nombre: 'Francisco Jimenez', email: 'fran@test.com', nombre_servicio: 'Masaje relajante',
      servicio: 'masaje_relajante', masaje_inicio: plus(60 * 24 * 2), estado_reserva: 'confirmado',
      reserva_confirmada: true, pago_recibido: true, monto_pagado: 800
    }
  ],
  reservas: [
    { id: 185, nombre: 'Moses Cortez', email: 'moses@test.com', nombre_servicio: 'Masaje Full Day Spa pareja',
      masaje_inicio: plus(120), jacuzzi_inicio: plus(80), monto_pagado: 1000, moneda_pago: 'MXN',
      reserva_confirmada: true, pabau_confirmado_at: iso(new Date(today.getTime() - 60 * 60000)), sucursal: '24221' },
    { id: 183, nombre: 'Diana María', email: 'diana@test.com', nombre_servicio: 'Masaje Full Day Spa pareja',
      masaje_inicio: plus(60 * 26), jacuzzi_inicio: plus(60 * 26 - 40), monto_pagado: 1000, moneda_pago: 'MXN',
      reserva_confirmada: true, pabau_confirmado_at: iso(new Date(today.getTime() - 26 * 3600000)), sucursal: '24077' }
  ],
  spa_comprobantes_pago: [
    { huella: 'revision_pendiente|189|2066248269', reserva_draft_id: 189, subscriber_id: '2066248269',
      estado: 'revision', datos: { monto_pago: 1000, media_url: 'https://files.test/c189.jpg', fecha_pago: iso(today).slice(0, 10), tipo_pago: 'transferencia', banco_emisor: 'BBVA' },
      creado_at: iso(new Date(today.getTime() - 30 * 60000)), actualizado_at: iso(new Date(today.getTime() - 30 * 60000)) }
  ],
  dashboard_reservation_decisions: []
};

/* Como spa_comprobantes_pago hoy: sin GRANT para el rol authenticated. */
const DENIED = new Set(process.env.MOCK_DENY ? process.env.MOCK_DENY.split(',') : ['spa_comprobantes_pago']);
const RPC_MISSING = process.env.MOCK_RPC === 'missing';

const base64url = value => Buffer.from(value).toString('base64url');
export function signToken(payload = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { iss: 'supabase', role: 'authenticated', aud: 'authenticated', email: TEST_EMAIL, iat: now, exp: now + 3600, ...payload };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  return `${data}.${createHmac('sha256', JWT_SECRET).update(data).digest('base64url')}`;
}

function decodeToken(header) {
  const raw = String(header || '').replace(/^Bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (expected !== parts[2]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const json = (response, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Range': '0-0/0', ...headers });
  response.end(text);
};

const readBody = request => new Promise(resolvePromise => {
  let data = '';
  request.on('data', chunk => { data += chunk; });
  request.on('end', () => {
    try { resolvePromise(data ? JSON.parse(data) : null); } catch { resolvePromise(null); }
  });
});

/* Filtros mínimos: eq, order y limit, como los usa el dashboard. */
function applyQuery(rows, params) {
  let result = rows.slice();
  for (const [key, raw] of params.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    if (!raw.startsWith('eq.')) continue;
    const value = raw.slice(3);
    result = result.filter(row => String(row[key]) === String(value));
  }
  const order = params.get('order');
  if (order) {
    const column = order.replace(/\.(desc|asc).*$/, '');
    const descending = /desc/.test(order);
    result.sort((a, b) => {
      const av = a[column] ?? '';
      const bv = b[column] ?? '';
      return (av === bv ? 0 : av > bv ? 1 : -1) * (descending ? -1 : 1);
    });
  }
  const limit = Number(params.get('limit'));
  if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
  return result;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const session = decodeToken(request.headers.authorization);
  const restPath = url.pathname.replace(/^\/rest\/v1\/?/, '');

  if (url.pathname === '/health') { json(response, 200, { ok: true, tables: Object.keys(db) }); return; }

  /* RPC de decisiones: igual que el de Supabase. */
  if (restPath === 'rpc/process_dashboard_reservation_decision') {
    mockStats.decisionRpcCalls += 1;
    if (RPC_MISSING) { json(response, 404, { code: 'PGRST202', message: 'Could not find the function public.process_dashboard_reservation_decision' }); return; }
    const body = await readBody(request) || {};
    if (!session?.email) { json(response, 400, { code: 'P0001', message: 'Not authorized for Inside Spa dashboard' }); return; }
    const draft = db.reservas_draft.find(row => Number(row.id) === Number(body.p_reservation_draft_id));
    if (!draft) { json(response, 400, { code: 'P0001', message: `La pre-reserva ${body.p_reservation_draft_id} no existe` }); return; }
    const nextState = body.p_action === 'approved' ? 'confirmado' : body.p_action === 'rejected' ? 'rechazado' : 'requiere_revision';
    const previous = draft.estado_reserva;
    draft.estado_reserva = nextState;
    if (body.p_action === 'approved') { draft.reserva_confirmada = true; draft.pago_recibido = true; }
    if (body.p_action === 'rejected') draft.reserva_confirmada = false;
    draft.comprobante_revision_at = iso(new Date());
    draft.comprobante_revision_datos = {
      ...(draft.comprobante_revision_datos || {}),
      decision_dashboard: body.p_action,
      decision_dashboard_por: session.email,
      comprobante_estado: body.p_action === 'approved' ? 'aprobado' : body.p_action === 'rejected' ? 'rechazado' : 'revision_manual'
    };
    db.spa_comprobantes_pago.filter(row => Number(row.reserva_draft_id) === Number(draft.id))
      .forEach(row => { row.estado = body.p_action === 'approved' ? 'aprobado' : body.p_action === 'rejected' ? 'rechazado' : 'revision'; });
    db.dashboard_reservation_decisions.push({
      id: randomUUID(), reservation_draft_id: Number(draft.id), action: body.p_action,
      previous_status: previous, resulting_status: nextState, note: body.p_note ?? null,
      decided_by: '00000000-0000-0000-0000-0000000000a1', decided_by_email: session.email, created_at: iso(new Date())
    });
    json(response, 200, { ok: true, reservation_draft_id: draft.id, action: body.p_action, previous_status: previous, resulting_status: nextState, decided_by_email: session.email });
    return;
  }

  /* RPC de comprobación de escritura: inserta y borra en el mismo paso. */
  if (restPath === 'rpc/dashboard_decision_write_probe') {
    mockStats.writeProbeCalls += 1;
    const body = await readBody(request) || {};
    void body;
    if (!session?.email) { json(response, 400, { code: 'P0001', message: 'Not authorized for Inside Spa dashboard' }); return; }
    const draft = db.reservas_draft[0];
    const id = randomUUID();
    db.dashboard_reservation_decisions.push({
      id, reservation_draft_id: draft?.id ?? null, action: 'needs_info',
      previous_status: 'requiere_revision', resulting_status: 'requiere_revision',
      note: 'diagnostico-automatico-descartable', decided_by: '00000000-0000-0000-0000-0000000000a1',
      decided_by_email: session.email, created_at: iso(new Date())
    });
    db.dashboard_reservation_decisions = db.dashboard_reservation_decisions.filter(row => row.id !== id);
    json(response, 200, { ok: true, reservation_draft_id: draft?.id ?? null, probado_por: session.email });
    return;
  }

  const table = restPath.split('/')[0];
  if (!(table in db)) { json(response, 404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }); return; }

  /* GRANT: sin sesión, las tablas con grant solo a authenticated responden 42501. */
  if (DENIED.has(table)) { json(response, 401, { code: '42501', message: `permission denied for table ${table}`, hint: `Grant the required privileges to the current role with: GRANT SELECT ON public.${table} TO anon;` }); return; }

  /* RLS: sin sesión no se ve ninguna fila (como en el proyecto real). */
  const visible = session ? db[table] : [];

  if (request.method === 'GET') {
    const rows = applyQuery(visible, url.searchParams);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
    response.end(JSON.stringify(rows));
    return;
  }

  if (!session) { json(response, 401, { code: '42501', message: `permission denied for table ${table}` }); return; }

  if (request.method === 'POST') {
    const body = await readBody(request);
    const rows = Array.isArray(body) ? body : [body];
    const created = rows.map(row => ({ id: randomUUID(), created_at: iso(new Date()), decided_by_email: session.email, decided_by: '00000000-0000-0000-0000-0000000000a1', ...row }));
    db[table].push(...created);
    json(response, 201, created);
    return;
  }

  if (request.method === 'PATCH') {
    const body = await readBody(request) || {};
    const targets = applyQuery(visible, url.searchParams);
    targets.forEach(row => Object.assign(row, body));
    json(response, 200, targets);
    return;
  }

  if (request.method === 'DELETE') {
    const targets = applyQuery(visible, url.searchParams);
    db[table] = db[table].filter(row => !targets.includes(row));
    json(response, 200, []);
    return;
  }

  json(response, 405, { message: 'método no soportado' });
});

export function startMockBackend() {
  return new Promise(resolvePromise => server.listen(port, '127.0.0.1', () => resolvePromise(server)));
}

export const mockDb = db;
export const mockUrl = `http://127.0.0.1:${port}`;
/** Contadores de uso para las pruebas. */
export const mockStats = { writeProbeCalls: 0, decisionRpcCalls: 0 };

/* Si se ejecuta directamente, queda escuchando. */
if (process.argv[1] && process.argv[1].endsWith('mock-backend.mjs')) {
  await startMockBackend();
  console.log(`Backend de prueba en ${mockUrl}`);
  console.log(`Tablas: ${Object.keys(db).join(', ')} · sin GRANT: ${[...DENIED].join(', ')}${RPC_MISSING ? ' · RPC ausente' : ''}`);
  console.log(`Token de prueba: ${signToken().slice(0, 40)}...`);
}
