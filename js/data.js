/* Capa de datos: consultas a Supabase tolerantes a diferencias de esquema.
   Nunca inventa datos: si algo falta o estÃ¡ bloqueado, lo reporta. */

import { pick } from './core.js?v=2.0.0';
import { normalizeConfirmed, normalizeDecision, normalizeDraft, normalizeReceipt } from './domain.js?v=2.0.0';

export const TABLE = {
  drafts: 'reservas_draft',
  confirmed: 'reservas',
  receipts: 'spa_comprobantes_pago',
  decisions: 'dashboard_reservation_decisions'
};

export const DECISION_RPC = 'process_dashboard_reservation_decision';
export const PAGE_LIMIT = 500;

/* Columnas confirmadas por auditorÃ­a externa. Si alguna no existe en el
   proyecto, la consulta cae automÃ¡ticamente a select('*'). */
const COLUMNS = {
  reservas_draft: 'id,nombre,email,phone,telefono,nombre_servicio,servicio,masaje_inicio,jacuzzi_inicio,fecha_reserva,monto_pagado,moneda_pago,estado_reserva,reserva_confirmada,comprobante_revision_at,actualizado_at,updated_at',
  reservas: 'id,nombre,email,phone,telefono,nombre_servicio,masaje_inicio,jacuzzi_inicio,fecha_reserva,monto_pagado,moneda_pago,reserva_confirmada,pabau_confirmado_at,sucursal,updated_at',
  spa_comprobantes_pago: 'reserva_draft_id,estado,datos,media_url,url,monto_pago,fecha_pago,referencia,metodo,creado_at,actualizado_at',
  dashboard_reservation_decisions: 'id,reservation_draft_id,action,note,previous_status,resulting_status,decided_by_email,created_at'
};

const ORDER_CANDIDATES = {
  reservas_draft: ['comprobante_revision_at', 'actualizado_at', 'updated_at', 'id'],
  reservas: ['pabau_confirmado_at', 'updated_at', 'id'],
  spa_comprobantes_pago: ['actualizado_at', 'creado_at', 'reserva_draft_id'],
  dashboard_reservation_decisions: ['created_at', 'id']
};

const MESSAGES = {
  not_logged: 'Inicia sesiÃ³n con una cuenta autorizada para ver los datos.',
  missing_table: table => `La tabla ${table} no existe en este proyecto de Supabase.`,
  missing_column: (table, message) => `Falta una columna esperada en ${table} (${message}). Revisa la migraciÃ³n SQL.`,
  permission: table => `Tu cuenta no tiene permiso de lectura sobre ${table} (falta GRANT/RLS). Hay que ejecutar la migraciÃ³n SQL.`,
  rls: table => `Las polÃ­ticas RLS de ${table} no permiten ver estas filas a tu cuenta. Hay que ejecutar la migraciÃ³n SQL.`,
  network: 'No se pudo conectar con Supabase. Revisa tu conexiÃ³n a internet.'
};

export class DataError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'DataError';
    this.kind = kind;
    this.detail = detail;
  }
}

export function classifyError(error, table) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (code === '42P01' || /does not exist/i.test(message) && /relation|table/i.test(message)) return 'missing_table';
  if (code === '42703' || /column .* does not exist/i.test(message)) return 'missing_column';
  if (code === '42501' || /permission denied/i.test(message)) return 'permission';
  if (/row-level security|violates row-level security/i.test(message)) return 'rls';
  if (code === 'PGRST301' || code === 'PGRST205' || /could not find the table/i.test(message)) return 'missing_table';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return 'network';
  if (code === 'PGRST202' || /could not find the function/i.test(message)) return 'missing_function';
  return table ? `${table}` : 'unknown';
}

export function describeError(error, table) {
  const kind = classifyError(error, table);
  if (kind === 'missing_table') return MESSAGES.missing_table(table);
  if (kind === 'missing_column') return MESSAGES.missing_column(table, String(error?.message || ''));
  if (kind === 'permission') return MESSAGES.permission(table);
  if (kind === 'rls') return MESSAGES.rls(table);
  if (kind === 'network') return MESSAGES.network;
  return String(error?.message || error || 'Error desconocido') + (table ? ` (${table})` : '');
}

export const errorCode = error => String(error?.code || error?.details?.code || '');

/* ---------- Consultas tolerantes ---------- */

async function selectWithFallback(supabase, table, columns, build) {
  const first = await build(supabase.from(table).select(columns));
  if (!first.error) return { data: first.data || [], error: null, usedWildcard: false };
  const kind = classifyError(first.error, table);
  if (kind !== 'missing_column') return { data: [], error: first.error, usedWildcard: false };
  const second = await build(supabase.from(table).select('*'));
  if (second.error) return { data: [], error: second.error, usedWildcard: true };
  return { data: second.data || [], error: null, usedWildcard: true, schemaWarning: first.error.message };
}

/** Aplica order/limit intentando columnas de orden alternativas. */
async function fetchTable(supabase, table, { columns = '*', limit = PAGE_LIMIT } = {}) {
  const candidates = ORDER_CANDIDATES[table] || [];
  let lastError = null;
  let usedWildcard = false;
  let schemaWarning = null;
  for (const orderColumn of [...candidates, null]) {
    const result = await selectWithFallback(supabase, table, columns, query => {
      let scoped = query.limit(limit);
      if (orderColumn) scoped = scoped.order(orderColumn, { ascending: false, nullsFirst: false });
      return scoped;
    });
    usedWildcard = usedWildcard || result.usedWildcard;
    schemaWarning = schemaWarning || result.schemaWarning || null;
    if (!result.error) return { data: result.data, error: null, usedWildcard, schemaWarning, orderColumn };
    lastError = result.error;
    const kind = classifyError(result.error, table);
    // Solo el orden puede justificar el siguiente intento; permisos/tabla no.
    if (!['missing_column', 'unknown', 'missing_function'].includes(kind)) break;
  }
  return { data: [], error: lastError, usedWildcard, schemaWarning, orderColumn: null };
}

export async function loadDashboard(supabase, { onProgress } = {}) {
  const startedAt = Date.now();
  const notify = (step, percent) => onProgress?.({ step, percent });

  notify('Pre-reservas', 15);
  const draftsResult = await fetchTable(supabase, TABLE.drafts, { columns: COLUMNS.reservas_draft });
  notify('Comprobantes', 40);
  const receiptsResult = await fetchTable(supabase, TABLE.receipts, { columns: COLUMNS.spa_comprobantes_pago });
  notify('Decisiones', 65);
  const decisionsResult = await fetchTable(supabase, TABLE.decisions, { columns: COLUMNS.dashboard_reservation_decisions });
  notify('Reservas confirmadas', 85);
  const confirmedResult = await fetchTable(supabase, TABLE.confirmed, { columns: COLUMNS.reservas });

  const problems = [];
  const addProblem = (table, result) => {
    if (result.error) problems.push({ table, message: describeError(result.error, table), code: errorCode(result.error), kind: classifyError(result.error, table) });
  };
  addProblem(TABLE.drafts, draftsResult);
  addProblem(TABLE.receipts, receiptsResult);
  addProblem(TABLE.decisions, decisionsResult);
  addProblem(TABLE.confirmed, confirmedResult);

  const receipts = new Map();
  (receiptsResult.data || [])
    .map(normalizeReceipt)
    .filter(receipt => Number.isFinite(receipt.draftId))
    .forEach(receipt => {
      const current = receipts.get(receipt.draftId);
      const a = new Date(receipt.updatedAt || receipt.receivedAt || 0).getTime();
      const b = new Date(current?.updatedAt || current?.receivedAt || 0).getTime();
      if (!current || a >= b) receipts.set(receipt.draftId, receipt);
    });

  const drafts = (draftsResult.data || []).map(normalizeDraft).filter(row => Number.isFinite(row.id));
  const decisions = (decisionsResult.data || []).map(normalizeDecision);
  const confirmed = (confirmedResult.data || []).map(normalizeConfirmed).filter(row => Number.isFinite(row.id));

  notify('Listo', 100);
  return {
    drafts,
    receipts,
    decisions,
    confirmed,
    problems,
    warnings: [draftsResult.schemaWarning, receiptsResult.schemaWarning, decisionsResult.schemaWarning, confirmedResult.schemaWarning].filter(Boolean),
    durationMs: Date.now() - startedAt,
    loadedAt: new Date()
  };
}

/* ---------- Decisiones ---------- */

const NEXT_STATE = { approved: 'confirmado', rejected: 'rechazado', needs_info: 'requiere_revision' };

/**
 * Registra una decisiÃ³n. Primero intenta el RPC oficial; si no existe,
 * usa una vÃ­a alternativa equivalente y avisa cuÃ¡l se usÃ³.
 */
export async function decide(supabase, { draftId, action, note, previousStatus, userEmail }) {
  const rpc = await supabase.rpc(DECISION_RPC, {
    p_reservation_draft_id: Number(draftId),
    p_action: action,
    p_note: note ? String(note) : null
  });
  if (!rpc.error) return { via: 'rpc', data: rpc.data };

  const rpcKind = classifyError(rpc.error, TABLE.decisions);
  if (rpcKind !== 'missing_function') {
    throw new DataError(rpcKind === 'permission' ? 'permission' : rpcKind, describeError(rpc.error, TABLE.decisions), { step: 'rpc', error: rpc.error });
  }

  // VÃ­a alternativa: registrar la decisiÃ³n y actualizar el estado de la pre-reserva.
  const payloads = [
    { reservation_draft_id: Number(draftId), action, note: note ? String(note) : null, previous_status: previousStatus || null, resulting_status: NEXT_STATE[action] || null, decided_by_email: userEmail || null },
    { reservation_draft_id: Number(draftId), action, note: note ? String(note) : null },
    { reserva_draft_id: Number(draftId), action, note: note ? String(note) : null }
  ];
  let inserted = false;
  let insertError = null;
  for (const payload of payloads) {
    const attempt = await supabase.from(TABLE.decisions).insert(payload).select().limit(1);
    if (!attempt.error) { inserted = true; break; }
    insertError = attempt.error;
    if (classifyError(attempt.error, TABLE.decisions) !== 'missing_column') break;
  }

  const stateError = await applyDraftState(supabase, draftId, action);
  if (!inserted && stateError) {
    throw new DataError('fallback_failed', `No se pudo registrar la decisiÃ³n: ${describeError(stateError, TABLE.drafts)}`, { insertError, stateError });
  }
  if (!inserted && !stateError) return { via: 'status_only' };
  if (inserted && stateError) return { via: 'decision_only', warning: describeError(stateError, TABLE.drafts) };
  return { via: 'fallback' };
}

async function applyDraftState(supabase, draftId, action) {
  const nextState = NEXT_STATE[action];
  const attempts = [
    { estado_reserva: nextState },
    { reserva_confirmada: action === 'approved' },
    { estado: nextState }
  ];
  let lastError = null;
  for (const patch of attempts) {
    const attempt = await supabase.from(TABLE.drafts).update(patch).eq('id', Number(draftId));
    if (!attempt.error) return null;
    lastError = attempt.error;
    const kind = classifyError(attempt.error, TABLE.drafts);
    if (kind !== 'missing_column') return lastError;
  }
  return lastError;
}

/* ---------- DiagnÃ³stico ---------- */

export async function runDiagnostics(supabase, { userEmail, allowedEmails = [], session }) {
  const checks = [];
  const push = (name, status, detail, extra = {}) => checks.push({ name, status, detail, ...extra });

  const config = window.INSIDE_SPA_SUPABASE || {};
  push('Clave pÃºblica configurada', config.publishableKey?.startsWith?.('sb_') ? 'ok' : 'fail',
    config.publishableKey ? 'Clave publishable detectada.' : 'No hay publishableKey en supabase-config.js.');
  push('Proyecto Supabase', /^https:\/\/.+\.supabase\.co$/.test(String(config.url || '')) ? 'ok' : 'fail', config.url || 'URL invÃ¡lida.');

  if (!session?.user) {
    push('SesiÃ³n', 'fail', 'No hay sesiÃ³n activa.');
  } else {
    push('SesiÃ³n', 'ok', `SesiÃ³n iniciada como ${session.user.email}.`);
    const authorized = !allowedEmails.length || allowedEmails.includes(String(userEmail || '').toLowerCase());
    push('Correo autorizado', authorized ? 'ok' : 'fail', authorized ? 'El correo estÃ¡ en la lista permitida.' : 'El correo no estÃ¡ en allowedEmails.');
    const expires = session.expires_at ? new Date(session.expires_at * 1000) : null;
    push('Vigencia del token', expires && expires.getTime() > Date.now() ? 'ok' : 'warn',
      expires ? `Vence el ${expires.toLocaleString('es-MX')}.` : 'No se pudo leer la expiraciÃ³n.');
  }

  for (const [label, table] of [['Pre-reservas', TABLE.drafts], ['Comprobantes', TABLE.receipts], ['Decisiones', TABLE.decisions], ['Reservas confirmadas', TABLE.confirmed]]) {
    const probe = await supabase.from(table).select('*').limit(1);
    if (probe.error) {
      const kind = classifyError(probe.error, table);
      const status = kind === 'missing_table' ? 'fail' : kind === 'permission' || kind === 'rls' ? 'fail' : 'warn';
      push(`Lectura Â· ${label}`, status, `${describeError(probe.error, table)} [${kind}${probe.error.code ? ` Â· ${probe.error.code}` : ''}]`);
      continue;
    }
    const count = await supabase.from(table).select('*', { count: 'exact', head: true });
    const total = count.error ? null : count.count;
    push(`Lectura Â· ${label}`, 'ok', total === null ? 'Accesible.' : `Accesible Â· ${total} fila(s) visibles para tu cuenta.`);
  }

  const rpcProbe = await supabase.rpc(DECISION_RPC, {
    p_reservation_draft_id: -1,
    p_action: 'needs_info',
    p_note: 'diagnostico'
  });
  if (!rpcProbe.error) {
    push('DecisiÃ³n Â· RPC', 'warn', 'El RPC respondiÃ³ sin error para una reserva inexistente; revisa la validaciÃ³n interna.');
  } else {
    const kind = classifyError(rpcProbe.error, TABLE.decisions);
    if (kind === 'missing_function') push('DecisiÃ³n Â· RPC', 'fail', `La funciÃ³n ${DECISION_RPC} no estÃ¡ en el esquema.`);
    else if (/not authorized|no autorizado/i.test(String(rpcProbe.error.message))) push('DecisiÃ³n Â· RPC', 'ok', 'La funciÃ³n existe y valida al usuario autorizado.');
    else push('DecisiÃ³n Â· RPC', kind === 'permission' ? 'fail' : 'warn', `${rpcProbe.error.message} [${kind}]`);
  }

  const insertProbe = await supabase.from(TABLE.decisions).insert({
    reservation_draft_id: -1,
    action: 'needs_info',
    note: 'diagnostico-automatico-descartable'
  }).select().limit(1);
  if (!insertProbe.error) {
    push('Escritura Â· decisiones', 'ok', 'La tabla de decisiones acepta registros del dashboard.');
    const created = insertProbe.data?.[0];
    const id = pick(created || {}, 'id');
    if (id !== null && id !== undefined) {
      const cleanup = await supabase.from(TABLE.decisions).delete().eq('id', id);
      push('Limpieza Â· registro de prueba', cleanup.error ? 'warn' : 'ok', cleanup.error ? `No se pudo borrar el registro de prueba: ${cleanup.error.message}` : 'Registro de prueba eliminado.');
    }
  } else {
    const kind = classifyError(insertProbe.error, TABLE.decisions);
    push('Escritura Â· decisiones', 'fail', `${describeError(insertProbe.error, TABLE.decisions)} [${kind}]`);
  }

  return checks;
}

/* ---------- SesiÃ³n ---------- */

export async function getSession(supabase) {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data?.session || null;
}

export async function signOut(supabase) {
  await supabase.auth.signOut();
}

export async function sendMagicLink(supabase, email, redirectTo) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false }
  });
}
