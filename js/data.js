/* Capa de datos: consultas a Supabase tolerantes a diferencias de esquema.
   Nunca inventa datos: si algo falta o está bloqueado, lo reporta. */

import { pick } from './core.js?v=2.0.0';
import {
  normalizeConfirmed, normalizeDecision, normalizeDraft, normalizeReceipt, receiptFromEvidence, visibleAmount
} from './domain.js?v=2.0.0';

export const TABLE = {
  drafts: 'reservas_draft',
  confirmed: 'reservas',
  receipts: 'spa_comprobantes_pago',
  decisions: 'dashboard_reservation_decisions'
};

export const DECISION_RPC = 'process_dashboard_reservation_decision';
export const PAGE_LIMIT = 500;

/* Columnas reales del proyecto (verificadas contra la base). Si alguna no
   existiera, la consulta cae automáticamente a select('*'). */
const COLUMNS = {
  reservas_draft: 'id,nombre,email,phone,nombre_servicio,servicio,masaje_inicio,jacuzzi_inicio,monto_pagado,moneda_pago,estado_reserva,reserva_confirmada,pago_recibido,horario_pendiente,motivo_revision,comprobante_revision_at,comprobante_revision_datos,retencion_expira_at,intentos_pago,procesando_desde',
  reservas: 'id,nombre,email,phone,nombre_servicio,masaje_inicio,jacuzzi_inicio,monto_pagado,moneda_pago,reserva_confirmada,pabau_confirmado_at,sucursal',
  spa_comprobantes_pago: 'huella,reserva_draft_id,subscriber_id,estado,datos,creado_at,actualizado_at',
  dashboard_reservation_decisions: 'id,reservation_draft_id,action,note,previous_status,resulting_status,decided_by_email,created_at'
};

const ORDER_CANDIDATES = {
  reservas_draft: ['comprobante_revision_at', 'id'],
  reservas: ['pabau_confirmado_at', 'id'],
  spa_comprobantes_pago: ['actualizado_at', 'creado_at', 'reserva_draft_id'],
  dashboard_reservation_decisions: ['created_at', 'id']
};

const MESSAGES = {
  not_logged: 'Inicia sesión con una cuenta autorizada para ver los datos.',
  missing_table: table => `La tabla ${table} no existe en este proyecto de Supabase.`,
  missing_column: (table, message) => `Falta una columna esperada en ${table} (${message}). Revisa la migración SQL.`,
  permission: (table, operation) => `Tu cuenta no tiene permiso de ${operation === 'write' ? 'escritura' : 'lectura'} sobre ${table}. Falta el GRANT en la migración SQL (supabase/APLICAR_EN_SUPABASE.sql).`,
  rls: (table, operation) => `Las políticas RLS de ${table} no permiten ${operation === 'write' ? 'guardar cambios' : 'ver estas filas'} con tu cuenta. Hay que ejecutar la migración SQL.`,
  invalid_token: 'Tu sesión venció o el enlace de acceso ya no es válido. Vuelve a iniciar sesión.',
  network: 'No se pudo conectar con Supabase. Revisa tu conexión a internet.'
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
  /* PGRST301 lo devuelve PostgREST tanto si falta la tabla como si el token de la
     sesión no es válido ("No suitable key or wrong key type"). Se distinguen por
     el texto para no decirle al equipo que falta una tabla cuando en realidad
     solo tiene que volver a iniciar sesión. */
  if (code === 'PGRST301' && /jwt|token|claims|expired|key|decode|signature|verify/i.test(message)) return 'invalid_token';
  if (code === 'PGRST301' || code === 'PGRST205' || /could not find the table/i.test(message)) return 'missing_table';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return 'network';
  if (code === 'PGRST202' || /could not find the function/i.test(message)) return 'missing_function';
  return table ? `${table}` : 'unknown';
}

export function describeError(error, table, operation = 'read') {
  const kind = classifyError(error, table);
  if (kind === 'missing_table') return MESSAGES.missing_table(table);
  if (kind === 'missing_column') return MESSAGES.missing_column(table, String(error?.message || ''));
  if (kind === 'permission') return MESSAGES.permission(table, operation);
  if (kind === 'rls') return MESSAGES.rls(table, operation);
  if (kind === 'invalid_token') return MESSAGES.invalid_token;
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

  /* La evidencia guardada en la pre-reserva completa lo que falte del comprobante
     (monto, archivo, motivos de revisión) cuando no hay fila en la tabla. */
  drafts.forEach(draft => {
    const stored = receipts.get(draft.id);
    const fromEvidence = receiptFromEvidence(draft);
    if (!stored && fromEvidence) { receipts.set(draft.id, fromEvidence); return; }
    if (stored && fromEvidence) {
      receipts.set(draft.id, {
        ...fromEvidence,
        ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length))),
        datos: { ...fromEvidence.datos, ...stored.datos },
        fromEvidence: false
      });
    }
    if (!draft.monto) {
      const resolved = visibleAmount(draft, receipts.get(draft.id));
      if (resolved.amount) draft.monto = resolved.amount;
    }
  });

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
/** Estado de partida cuando el llamador no lo conoce (columnas NOT NULL del histórico). */
const PREVIOUS_STATE_FALLBACK = 'pendiente_pago';

/** Traduce el estado visible ("Por revisar") al valor que guarda la base. */
export function statusToStateCode(label) {
  const text = String(label || '').toLowerCase();
  if (text.includes('confirmada') || text.includes('aprobada')) return 'confirmado';
  if (text.includes('rechaz')) return 'rechazado';
  if (text.includes('informaci')) return 'requiere_revision';
  if (text.includes('revis')) return 'requiere_revision_pago';
  if (text.includes('confirmaci')) return 'procesando_pabau';
  return PREVIOUS_STATE_FALLBACK;
}

/**
 * Registra una decisión. Primero intenta el RPC oficial; si no existe,
 * usa una vía alternativa equivalente y avisa cuál se usó.
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
    throw new DataError(rpcKind === 'permission' ? 'permission' : rpcKind, describeError(rpc.error, TABLE.decisions, 'write'), { step: 'rpc', error: rpc.error });
  }

  // Vía alternativa: registrar la decisión y actualizar el estado de la pre-reserva.
  /* El histórico exige previous_status y resulting_status (NOT NULL), así que se
     envían siempre: el llamador puede pasar el estado visible y aquí se traduce. */
  const previousStatusValue = statusToStateCode(previousStatus) || PREVIOUS_STATE_FALLBACK;
  const resultingStatusValue = NEXT_STATE[action] || 'requiere_revision';
  const payloads = [
    {
      reservation_draft_id: Number(draftId),
      action,
      note: note ? String(note) : null,
      previous_status: previousStatusValue,
      resulting_status: resultingStatusValue,
      decided_by_email: userEmail || null
    },
    /* Variantes por si el esquema tuviera otros nombres de columna. */
    { reservation_draft_id: Number(draftId), action, note: note ? String(note) : null, previous_status: previousStatusValue, resulting_status: resultingStatusValue },
    { reserva_draft_id: Number(draftId), action, note: note ? String(note) : null, previous_status: previousStatusValue, resulting_status: resultingStatusValue }
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
    throw new DataError('fallback_failed', `No se pudo registrar la decisión: ${describeError(stateError, TABLE.drafts, 'write')}`, { insertError, stateError });
  }
  if (!inserted && !stateError) return { via: 'status_only' };
  if (inserted && stateError) return { via: 'decision_only', warning: describeError(stateError, TABLE.drafts, 'write') };
  return { via: 'fallback' };
}

async function applyDraftState(supabase, draftId, action) {
  const nextState = NEXT_STATE[action];
  const attempts = [
    /* Igual que el RPC: estado, bandera de confirmación y marcas de revisión. */
    {
      estado_reserva: nextState,
      reserva_confirmada: action === 'approved' ? true : action === 'rejected' ? false : null,
      pago_recibido: action === 'approved' ? true : null,
      comprobante_revision_at: new Date().toISOString()
    },
    { estado_reserva: nextState },
    { reserva_confirmada: action === 'approved' }
  ];
  let lastError = null;
  for (const patch of attempts) {
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null));
    if (!Object.keys(clean).length) continue;
    const attempt = await supabase.from(TABLE.drafts).update(clean).eq('id', Number(draftId));
    if (!attempt.error) return null;
    lastError = attempt.error;
    const kind = classifyError(attempt.error, TABLE.drafts);
    if (kind !== 'missing_column') return lastError;
  }
  return lastError;
}

/* ---------- Diagnóstico ---------- */

const PROBE_NOTE = 'diagnostico-automatico-descartable';
/** RPC que prueba la escritura del histórico y limpia su propio registro. */
export const WRITE_PROBE_RPC = 'dashboard_decision_write_probe';

export async function runDiagnostics(supabase, { userEmail, allowedEmails = [], session, probeDraftId = null }) {
  const checks = [];
  const push = (name, status, detail, extra = {}) => checks.push({ name, status, detail, ...extra });

  const config = window.INSIDE_SPA_SUPABASE || {};
  push('Clave pública configurada', config.publishableKey?.startsWith?.('sb_') ? 'ok' : 'fail',
    config.publishableKey ? 'Clave publishable detectada.' : 'No hay publishableKey en supabase-config.js.');
  push('Proyecto Supabase', /^https:\/\/.+\.supabase\.co$/.test(String(config.url || '')) ? 'ok' : 'fail', config.url || 'URL inválida.');

  if (!session?.user) {
    push('Sesión', 'fail', 'No hay sesión activa.');
  } else {
    push('Sesión', 'ok', `Sesión iniciada como ${session.user.email}.`);
    const authorized = !allowedEmails.length || allowedEmails.includes(String(userEmail || '').toLowerCase());
    push('Correo autorizado', authorized ? 'ok' : 'fail', authorized ? 'El correo está en la lista permitida.' : 'El correo no está en allowedEmails.');
    const expires = session.expires_at ? new Date(session.expires_at * 1000) : null;
    push('Vigencia del token', expires && expires.getTime() > Date.now() ? 'ok' : 'warn',
      expires ? `Vence el ${expires.toLocaleString('es-MX')}.` : 'No se pudo leer la expiración.');
  }

  const hasSession = Boolean(session?.user);
  for (const [label, table] of [['Pre-reservas', TABLE.drafts], ['Comprobantes', TABLE.receipts], ['Decisiones', TABLE.decisions], ['Reservas confirmadas', TABLE.confirmed]]) {
    const probe = await supabase.from(table).select('*').limit(1);
    if (probe.error) {
      const kind = classifyError(probe.error, table);
      /* Sin sesión, estos avisos son lo esperado (la RLS y los GRANT son para
         usuarios autenticados): se informan como aviso, no como error. */
      const expectedWithoutSession = !hasSession && (kind === 'permission' || kind === 'rls');
      const status = expectedWithoutSession ? 'warn' : kind === 'missing_table' || kind === 'permission' || kind === 'rls' || kind === 'invalid_token' ? 'fail' : 'warn';
      const detail = expectedWithoutSession
        ? `Sin sesión no se puede leer ${table}, y eso es lo esperado: inicia sesión con un correo autorizado.`
        : describeError(probe.error, table);
      push(`Lectura · ${label}`, status, `${detail} [${kind}${probe.error.code ? ` · ${probe.error.code}` : ''}]`);
      continue;
    }
    const count = await supabase.from(table).select('*', { count: 'exact', head: true });
    const total = count.error ? null : count.count;
    push(`Lectura · ${label}`, 'ok', total === null ? 'Accesible.' : `Accesible · ${total} fila(s) visibles para tu cuenta.`);
  }

  const rpcProbe = await supabase.rpc(DECISION_RPC, {
    p_reservation_draft_id: -1,
    p_action: 'needs_info',
    p_note: 'diagnostico'
  });
  if (!rpcProbe.error) {
    push('Decisión · RPC', 'warn', 'El RPC respondió sin error para una reserva inexistente; revisa la validación interna.');
  } else {
    const kind = classifyError(rpcProbe.error, TABLE.decisions);
    const message = String(rpcProbe.error.message || '');
    if (kind === 'missing_function') push('Decisión · RPC', 'fail', `La función ${DECISION_RPC} no está en el esquema.`);
    else if (/not authorized|no autorizado/i.test(message)) push('Decisión · RPC', 'ok', 'La función existe y valida al usuario autorizado.');
    /* Con un id inexistente la respuesta correcta es "no existe": eso confirma
       que la función está instalada y que la sesión pasó la autorización. */
    else if (/no existe|does not exist|not found/i.test(message)) push('Decisión · RPC', 'ok', 'La función existe, autoriza tu sesión y valida que la reserva exista.');
    else push('Decisión · RPC', kind === 'permission' || kind === 'invalid_token' ? 'fail' : 'warn', `${describeError(rpcProbe.error, TABLE.decisions, 'write')} [${kind}]`);
  }

  /* Prueba de escritura: la hace una función de la base que inserta un registro
     de prueba en el histórico y lo borra en la misma transacción. Así se valida
     la escritura sin dar permiso de DELETE sobre el histórico y sin dejar basura. */
  const writeProbe = await supabase.rpc(WRITE_PROBE_RPC);
  if (!writeProbe.error) {
    const probado = writeProbe.data?.reservation_draft_id;
    push('Escritura · decisiones', 'ok',
      `La tabla de decisiones acepta registros del dashboard${probado ? ` (prueba con la pre-reserva #${probado}, ya borrada)` : ''}.`);
  } else {
    const kind = classifyError(writeProbe.error, TABLE.decisions);
    const message = String(writeProbe.error.message || '');
    if (kind === 'missing_function') {
      /* Compatibilidad: proyectos sin la función de prueba. Se intenta el insert
         directo (el registro quedaría pendiente de borrado manual). */
      const probeId = Number.isFinite(Number(probeDraftId)) ? Number(probeDraftId) : null;
      const insertProbe = probeId === null
        ? { error: null, skipped: true }
        : await supabase.from(TABLE.decisions).insert({
          reservation_draft_id: probeId,
          action: 'needs_info',
          previous_status: 'requiere_revision',
          resulting_status: 'requiere_revision',
          note: PROBE_NOTE,
          decided_by_email: userEmail || null
        }).select().limit(1);
      if (insertProbe.skipped) push('Escritura · decisiones', 'warn', 'Sin pre-reservas todavía: no se pudo probar la escritura.');
      else if (!insertProbe.error) push('Escritura · decisiones', 'ok', 'La tabla de decisiones acepta registros (falta la función de limpieza automática).');
      else push('Escritura · decisiones', 'fail', `${describeError(insertProbe.error, TABLE.decisions, 'write')} [${classifyError(insertProbe.error, TABLE.decisions)}]`);
    } else if (!hasSession && (kind === 'permission' || kind === 'rls')) {
      push('Escritura · decisiones', 'warn', 'Sin sesión no se puede escribir, y eso es lo esperado: inicia sesión para registrar decisiones.');
    } else if (/not authorized|no autorizado/i.test(message)) {
      push('Escritura · decisiones', 'fail', 'Tu correo no está autorizado para registrar decisiones.');
    } else {
      push('Escritura · decisiones', kind === 'permission' || kind === 'invalid_token' ? 'fail' : 'warn', `${describeError(writeProbe.error, TABLE.decisions, 'write')} [${kind}]`);
    }
  }

  return checks;
}

/* ---------- Sesión ---------- */

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
