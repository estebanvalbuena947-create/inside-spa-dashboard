/* Reglas de negocio del dashboard: estados, decisiones, filtros y KPIs.
   Todo aquí es lógica pura para poder probarla sin navegador. */

import { dayKey, firstValue, isToday, isWithinHours, parseDate, toAmount } from './core.js?v=2.0.0';

/** Acciones de decisión permitidas (deben coincidir con el SQL del RPC). */
export const DECISION_ACTIONS = ['approved', 'rejected', 'needs_info'];

export const ACTION_LABELS = {
  approved: { short: 'Aprobada', title: 'Comprobante aprobado', toast: 'Comprobante aprobado correctamente.', past: 'aprobó el comprobante de' },
  rejected: { short: 'Rechazada', title: 'Comprobante rechazado', toast: 'Comprobante rechazado.', past: 'rechazó el comprobante de' },
  needs_info: { short: 'Información', title: 'Información solicitada', toast: 'Se marcó la reserva como información pendiente.', past: 'solicitó información a' }
};

export const STATUS_LABELS = {
  pending: 'Pendiente de pago',
  review: 'Por revisar',
  info: 'Información solicitada',
  processing: 'En confirmación',
  confirmed: 'Confirmada',
  rejected: 'Comprobante rechazado'
};

/** Claves de estado que el filtro puede mostrar (orden de la barra). */
export const STATUS_ORDER = ['pending', 'review', 'info', 'processing', 'confirmed', 'rejected'];

/** Estados que cuentan como "por gestionar" (requieren acción del equipo). */
export const MANAGE_STATUSES = ['pending', 'review', 'info', 'processing'];

const asText = value => String(value ?? '').trim().toLowerCase();

/* ---------- Normalización de filas ---------- */

/** Monto del comprobante: el dato que hoy usa la operación.
 *  En esta base `reservas_draft.monto_pagado` casi siempre es null; el monto
 *  real vive en `comprobante_revision_datos` (monto_documento / monto_pago). */
export function evidenceAmount(draft) {
  const evidence = draft?.evidencia || draft?.comprobante_revision_datos;
  if (evidence && typeof evidence === 'object') {
    const value = firstValue(evidence.monto_documento, evidence.monto_pago, evidence.monto, evidence.importe);
    if (value !== null) return toAmount(value);
  }
  return 0;
}

/** Monto visible de una pre-reserva, con el origen del dato. */
export function visibleAmount(draft, receipt) {
  const fromDraft = toAmount(firstValue(draft?.monto_pagado, draft?.monto));
  if (fromDraft) return { amount: fromDraft, source: 'reserva' };
  const fromReceipt = toAmount(firstValue(receipt?.amount, receipt?.datos?.monto_pago, receipt?.datos?.monto_documento));
  if (fromReceipt) return { amount: fromReceipt, source: 'comprobante' };
  const fromEvidence = evidenceAmount(draft);
  if (fromEvidence) return { amount: fromEvidence, source: 'comprobante' };
  const expected = toAmount(firstValue(draft?.montoEsperado, draft?.monto_esperado));
  if (expected) return { amount: expected, source: 'esperado' };
  return { amount: 0, source: 'sin monto' };
}

export const AMOUNT_SOURCE_LABELS = {
  reserva: 'monto registrado en la reserva',
  comprobante: 'monto leído del comprobante',
  esperado: 'monto esperado del servicio',
  'sin monto': 'sin monto registrado'
};

/** Motivos en texto legible que ya calcula n8n al clasificar el comprobante. */
export const PAYMENT_REASON_LABELS = {
  ESTADO_PAGO_NO_CORROBORADO: 'El estado del pago no está corroborado',
  SIN_RASTREO_NI_REFERENCIA_BANCARIA: 'Sin clave de rastreo ni referencia bancaria',
  FALTA_FOLIO_PARA_IDENTIFICAR_COMPROBANTE: 'Falta folio para identificar el comprobante',
  TITULAR_INCOMPLETO_O_NO_VISIBLE: 'Titular incompleto o no visible',
  MONTO_INSUFICIENTE_O_NO_LEGIBLE: 'Monto insuficiente o no legible'
};

/** Fecha en que la pre-reserva entró al sistema (no la fecha de la cita).
 *  `comprobante_revision_at` es la marca real del proyecto. */
export const enteredAtOf = row => firstValue(row.reviewAt, row.createdAt, row.updatedAt, row.comprobante_revision_at);
/** Fecha en que la reserva quedó confirmada (o falló). */
export const closedAtOf = row => firstValue(row.confirmedAt, row.retencionExpiraAt, row.updatedAt, row.reviewAt, row.createdAt);

export function normalizeDraft(row) {
  const schedule = firstValue(row.masaje_inicio, row.jacuzzi_inicio, row.fecha_reserva, row.fecha_servicio, row.inicio);
  const evidence = row.comprobante_revision_datos && typeof row.comprobante_revision_datos === 'object' ? row.comprobante_revision_datos : null;
  const draft = {
    ...row,
    id: Number(row.id),
    nombre: firstValue(row.nombre, row.cliente, row.nombre_cliente, evidence?.nombre_reserva, evidence?.nombre_perfil),
    email: firstValue(row.email, row.correo, evidence?.email),
    phone: firstValue(row.phone, row.telefono, row.whatsapp, row.celular, evidence?.phone),
    servicio: firstValue(row.nombre_servicio, row.servicio, row.servicios),
    servicioCodigo: firstValue(row.servicio, row.service_agua_id),
    monto: toAmount(firstValue(row.monto_pagado, evidence?.monto_documento, evidence?.monto_pago, row.monto, row.valor, row.total)),
    montoEsperado: toAmount(firstValue(evidence?.monto_esperado, evidence?.monto_documento)),
    estado: asText(row.estado_reserva),
    confirmada: Boolean(row.reserva_confirmada),
    pagoRecibido: Boolean(row.pago_recibido),
    horarioPendiente: Boolean(row.horario_pendiente),
    motivoRevision: firstValue(row.motivo_revision, evidence?.motivo_clasificacion),
    motivosPago: Array.isArray(evidence?.motivos_revision_pago) ? evidence.motivos_revision_pago : [],
    evidencia: evidence,
    retencionExpiraAt: parseDate(row.retencion_expira_at),
    procesandoDesde: parseDate(row.procesando_desde),
    intentosPago: Number.isFinite(Number(row.intentos_pago)) ? Number(row.intentos_pago) : null,
    scheduleAt: schedule,
    scheduleDate: parseDate(schedule),
    reviewAt: firstValue(row.comprobante_revision_at, row.actualizado_at, row.updated_at),
    createdAt: firstValue(row.created_at, row.creado_at, row.fecha_creacion, row.comprobante_revision_at),
    updatedAt: firstValue(row.updated_at, row.actualizado_at, row.comprobante_revision_at),
    confirmedAt: firstValue(row.pabau_confirmado_at, row.confirmado_at)
  };
  /* enteredAt: cuándo llegó la pre-reserva (la UI se rige por esta fecha, no por
     la de la cita). closedAt: cuándo se confirmó o cuándo falló. */
  draft.enteredAt = parseDate(enteredAtOf(draft));
  draft.closedAt = parseDate(closedAtOf(draft));
  return draft;
}

export function normalizeConfirmed(row) {
  const schedule = firstValue(row.masaje_inicio, row.jacuzzi_inicio, row.fecha_reserva, row.fecha_servicio);
  return {
    ...row,
    id: Number(row.id),
    nombre: firstValue(row.nombre, row.cliente, row.nombre_cliente),
    email: firstValue(row.email, row.correo),
    phone: firstValue(row.phone, row.telefono, row.whatsapp),
    servicio: firstValue(row.nombre_servicio, row.servicio, row.servicios),
    monto: toAmount(firstValue(row.monto_pagado, row.monto, row.valor, row.total)),
    scheduleAt: schedule,
    scheduleDate: parseDate(schedule),
    confirmedAt: firstValue(row.pabau_confirmado_at, row.confirmado_at, row.updated_at, row.created_at),
    sucursal: firstValue(row.sucursal, row.branch, row.localidad)
  };
}

export function normalizeDecision(row) {
  return {
    ...row,
    id: Number(row.id),
    draftId: Number(firstValue(row.reservation_draft_id, row.reserva_draft_id, row.draft_id)),
    action: asText(row.action) || 'needs_info',
    note: firstValue(row.note, row.nota, row.comentario),
    previousStatus: firstValue(row.previous_status, row.estado_anterior),
    resultingStatus: firstValue(row.resulting_status, row.estado_nuevo),
    byEmail: firstValue(row.decided_by_email, row.email, row.usuario),
    createdAt: firstValue(row.created_at, row.creado_at)
  };
}

export function normalizeReceipt(row) {
  const datos = row.datos && typeof row.datos === 'object' ? row.datos : {};
  const mediaUrl = firstValue(row.media_url, row.url, row.comprobante_url, datos.media_url, datos.url, datos.comprobante_url);
  const amount = toAmount(firstValue(row.monto_pago, row.monto, datos.monto_pago, datos.monto_documento, datos.monto));
  const paidAt = firstValue(row.fecha_pago, datos.fecha_pago, datos.fecha_pago_documento, datos.fecha_pago_es_hoy ? row.creado_at : null);
  return {
    ...row,
    draftId: Number(firstValue(row.reserva_draft_id, row.draft_id, row.reservation_draft_id)),
    estado: asText(firstValue(row.estado, row.status, datos.comprobante_estado, datos.estado, 'revision')),
    datos,
    mediaUrl: mediaUrl || null,
    amount,
    paidAt,
    receivedAt: firstValue(row.creado_at, row.created_at, row.actualizado_at, row.updated_at),
    updatedAt: firstValue(row.actualizado_at, row.updated_at, row.creado_at, row.created_at),
    reference: firstValue(row.referencia, row.reference, datos.rastreo, datos.folio, datos.referencia, datos.numero_comprobante),
    method: firstValue(row.metodo, row.metodo_pago, datos.metodo, datos.metodo_pago, datos.tipo_pago),
    bank: firstValue(datos.banco_emisor, datos.banco_receptor),
    holder: firstValue(datos.nombre_beneficiario, datos.nombre_ordenante),
    account: firstValue(datos.cuenta_visible, datos.cuenta_beneficiaria_visible),
    reasons: Array.isArray(datos.motivos_revision_pago) ? datos.motivos_revision_pago : [],
    confidence: typeof datos.confianza_pago === 'number' ? datos.confianza_pago : null,
    expectedAmount: toAmount(firstValue(datos.monto_esperado, datos.monto_documento))
  };
}

/** Construye un comprobante a partir de la evidencia guardada en la pre-reserva.
 *  Sirve cuando la tabla spa_comprobantes_pago todavía no tiene fila para esa
 *  reserva: el dashboard muestra igual el archivo, el monto y los motivos. */
export function receiptFromEvidence(draft) {
  const evidence = draft?.evidencia || draft?.comprobante_revision_datos;
  if (!draft || !evidence || typeof evidence !== 'object') return null;
  const mediaUrl = firstValue(evidence.media_url, evidence.url, evidence.comprobante_url);
  const amount = evidenceAmount(draft);
  if (!mediaUrl && !amount && !evidence.fecha_pago_documento) return null;
  return {
    draftId: draft.id,
    estado: asText(firstValue(evidence.comprobante_estado, evidence.estado, 'revision')),
    datos: evidence,
    mediaUrl: mediaUrl || null,
    amount,
    paidAt: firstValue(evidence.fecha_pago_documento, evidence.fecha_pago),
    receivedAt: firstValue(draft.reviewAt, draft.updatedAt),
    updatedAt: firstValue(draft.reviewAt, draft.updatedAt),
    reference: firstValue(evidence.rastreo, evidence.folio, evidence.numero_comprobante),
    method: firstValue(evidence.tipo_pago, evidence.metodo_pago),
    bank: firstValue(evidence.banco_emisor, evidence.banco_receptor),
    holder: firstValue(evidence.nombre_beneficiario, evidence.nombre_ordenante),
    account: firstValue(evidence.cuenta_visible, evidence.cuenta_beneficiaria_visible),
    reasons: Array.isArray(evidence.motivos_revision_pago) ? evidence.motivos_revision_pago : [],
    confidence: typeof evidence.confianza_pago === 'number' ? evidence.confianza_pago : null,
    expectedAmount: toAmount(firstValue(evidence.monto_esperado, evidence.monto_documento)),
    fromEvidence: true
  };
}

/* ---------- Estado derivado ---------- */

const CONFIRMED_STATES = ['confirmado', 'confirmada', 'confirmed', 'completado', 'completada', 'pagado', 'reserva_confirmada', 'aprobado'];
const REVIEW_STATES = ['requiere_revision', 'requiere_revision_pago', 'revision_pago', 'en_revision', 'comprobante_en_revision', 'requiere_verificacion'];
const PROCESSING_STATES = ['procesando_pabau', 'procesando', 'en_proceso', 'pendiente_pabau', 'esperando_pabau', 'en_confirmacion', 'creando_retencion'];
const REJECTED_STATES = ['rechazado', 'rechazada', 'pago_rechazado', 'cancelado', 'cancelada', 'expirado', 'expirado_sin_pago', 'expirada', 'abandonado'];

export function isConfirmed(row) {
  if (!row) return false;
  if (row.confirmada || row.reserva_confirmada === true) return true;
  return CONFIRMED_STATES.includes(asText(row.estado ?? row.estado_reserva));
}

export function isReviewable(row) {
  return REVIEW_STATES.includes(asText(row?.estado)) && !isConfirmed(row);
}

/**
 * Estado visible de una pre-reserva.
 * Prioridad: confirmada por reservas > última decisión > estado de la tabla.
 */
export function statusOf(row, latestDecision) {
  if (isConfirmed(row)) return { key: 'confirmed', label: STATUS_LABELS.confirmed };
  if (latestDecision) {
    if (latestDecision.action === 'rejected') return { key: 'rejected', label: STATUS_LABELS.rejected };
    if (latestDecision.action === 'needs_info') return { key: 'info', label: STATUS_LABELS.info };
    if (latestDecision.action === 'approved') return { key: 'confirmed', label: 'Aprobada por el equipo' };
  }
  const estado = asText(row?.estado);
  if (REJECTED_STATES.includes(estado)) return { key: 'rejected', label: STATUS_LABELS.rejected };
  if (REVIEW_STATES.includes(estado)) return { key: 'review', label: STATUS_LABELS.review };
  if (PROCESSING_STATES.includes(estado)) return { key: 'processing', label: STATUS_LABELS.processing };
  if (estado) return { key: 'pending', label: STATUS_LABELS.pending };
  return { key: 'pending', label: 'Sin estado registrado' };
}

/** Motivo para pedir información o rechazar, sugerido según el estado real. */
export function reviewHint(row) {
  if (!row) return 'Sin comprobante asociado todavía.';
  if (row.estado === 'procesando_pabau') return 'El pago está en proceso de confirmación automática.';
  if (row.estado === 'requiere_revision_pago') return 'El comprobante requiere verificación manual del equipo.';
  if (row.estado === 'requiere_revision') return 'La reserva requiere revisión manual.';
  return 'Revisa el comprobante antes de decidir.';
}

/* ---------- Índices ---------- */

export function indexDecisions(decisions) {
  const map = new Map();
  decisions.forEach(decision => {
    const current = map.get(decision.draftId);
    if (!current) { map.set(decision.draftId, decision); return; }
    const a = parseDate(decision.createdAt)?.getTime() ?? 0;
    const b = parseDate(current.createdAt)?.getTime() ?? 0;
    if (a > b) map.set(decision.draftId, decision);
  });
  return map;
}

export function indexByDraftId(rows, key = 'draftId') {
  const map = new Map();
  rows.forEach(row => { if (!map.has(row[key])) map.set(row[key], row); });
  return map;
}

/* ---------- KPIs ---------- */

export function buildKpis(drafts, confirmed, decisions, receiptMap) {
  const index = indexDecisions(decisions);
  const statuses = new Map(drafts.map(row => [row.id, statusOf(row, index.get(row.id))]));
  const keyOf = row => statuses.get(row.id).key;
  const pending = drafts.filter(row => keyOf(row) === 'pending');
  const review = drafts.filter(row => ['review', 'info'].includes(keyOf(row)));
  const processing = drafts.filter(row => keyOf(row) === 'processing');
  const rejected = drafts.filter(row => keyOf(row) === 'rejected');
  const manageable = [...pending, ...review, ...processing];
  /* "Hoy" se rige por la fecha en que la reserva se confirmó, no por la fecha de
     la cita: una pre-reserva puede entrar hoy y tener cita en otra semana. */
  const draftsConfirmedToday = drafts.filter(row => keyOf(row) === 'confirmed' && isToday(closedAtOf(row)));
  const confirmedToday = confirmed.filter(row => isToday(row.confirmedAt));
  const amountOf = row => {
    const receipt = receiptMap.get(row.id) || receiptFromEvidence(row);
    return visibleAmount(row, receipt).amount;
  };
  const confirmedAmountToday = [...confirmedToday, ...draftsConfirmedToday].reduce((total, row) => total + toAmount(row.monto), 0);
  const pendingAmount = manageable.reduce((total, row) => total + amountOf(row), 0);
  const upcoming = confirmed.filter(row => isWithinHours(row.scheduleDate, 24));
  const receiptsToCheck = drafts.filter(row => Boolean(receiptMap.get(row.id))).length;
  /* Retenciones de Pabau a punto de expirar: si vencen, el horario se libera y
     el equipo pierde la reserva. Es el aviso más urgente del panel. */
  const expiringHolds = manageable
    .filter(row => row.retencionExpiraAt && row.retencionExpiraAt.getTime() > Date.now() && row.retencionExpiraAt.getTime() - Date.now() <= 60 * 60 * 1000)
    .sort((a, b) => a.retencionExpiraAt - b.retencionExpiraAt);
  const lastConfirmedAt = [...confirmedToday, ...draftsConfirmedToday].reduce((latest, row) => {
    const time = parseDate(row.confirmedAt || row.reviewAt || row.updatedAt)?.getTime() ?? 0;
    return time > latest ? time : latest;
  }, 0);
  const lastDecisionAt = decisions.reduce((latest, decision) => {
    const time = parseDate(decision.createdAt)?.getTime() ?? 0;
    return time > latest ? time : latest;
  }, 0);
  return {
    statuses,
    index,
    pendingCount: pending.length,
    reviewCount: review.length,
    processingCount: processing.length,
    rejectedCount: rejected.length,
    toManage: manageable.length,
    confirmedTodayCount: confirmedToday.length + draftsConfirmedToday.length,
    confirmedAmountToday,
    pendingAmount,
    upcomingCount: upcoming.length,
    receiptsToCheck,
    expiringHolds,
    lastConfirmedAt: lastConfirmedAt ? new Date(lastConfirmedAt) : null,
    lastDecisionAt: lastDecisionAt ? new Date(lastDecisionAt) : null
  };
}

/** Filtra pre-reservas según la barra de filtros. */
export function filterDrafts(drafts, statuses, { query = '', service = '', status = '', date = '' } = {}) {
  const text = query.trim().toLowerCase();
  const targetDay = date ? dayKey(date) : null;
  return drafts.filter(row => {
    const state = statuses.get(row.id)?.key || 'pending';
    if (status && state !== status) return false;
    if (service && row.servicio !== service) return false;
    /* El filtro por día es por la fecha en que ENTRÓ la pre-reserva. */
    if (targetDay && dayKey(row.enteredAt || enteredAtOf(row)) !== targetDay) return false;
    if (!text) return true;
    return [row.nombre, row.email, row.phone, row.id, row.servicio]
      .some(value => String(value ?? '').toLowerCase().includes(text));
  });
}

export function serviceOptions(drafts) {
  return [...new Set(drafts.map(row => row.servicio).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
}

/** Conteo por estado para los contadores visibles del filtro. */
export function statusCounts(drafts, statuses) {
  const counts = { all: drafts.length };
  STATUS_ORDER.forEach(key => { counts[key] = 0; });
  drafts.forEach(row => {
    const key = statuses.get(row.id)?.key || 'pending';
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

/** Mezcla confirmadas + pre-reservas para la vista de Clientes. */
export function buildClients(drafts, confirmed) {
  const map = new Map();
  const keyOf = row => String(row.email || row.phone || row.nombre || row.id).toLowerCase();
  const remember = (client, when) => {
    if (when && (!client.lastAt || when > client.lastAt)) client.lastAt = when;
  };
  const ensure = row => {
    const key = keyOf(row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        nombre: row.nombre || 'Cliente sin nombre',
        email: row.email || null,
        phone: row.phone || null,
        total: 0,
        confirmedCount: 0,
        pendingCount: 0,
        lastAt: null,
        amount: 0,
        services: new Set()
      });
    }
    return map.get(key);
  };
  drafts.forEach(row => {
    const client = ensure(row);
    client.total += 1;
    client.pendingCount += 1;
    client.amount += visibleAmount(row, null).amount;
    if (row.servicio) client.services.add(row.servicio);
    /* Última actividad: la más reciente entre la cita y el ingreso. */
    remember(client, row.scheduleDate);
    remember(client, parseDate(enteredAtOf(row)));
  });
  confirmed.forEach(row => {
    const client = ensure(row);
    client.total += 1;
    client.confirmedCount += 1;
    client.amount += toAmount(row.monto);
    if (row.servicio) client.services.add(row.servicio);
    remember(client, row.scheduleDate);
    remember(client, parseDate(row.confirmedAt));
  });
  return [...map.values()]
    .map(client => ({ ...client, services: [...client.services] }))
    .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

/** Comprobantes en formato de lista, con la pre-reserva asociada.
 *  Incluye los que solo existen como evidencia dentro de la pre-reserva. */
export function buildReceipts(drafts, receiptMap) {
  const items = [...receiptMap.values()].map(receipt => ({
    ...receipt,
    draft: drafts.find(row => row.id === receipt.draftId) || null
  }));
  const covered = new Set(items.map(item => item.draftId));
  drafts.forEach(draft => {
    if (covered.has(draft.id)) return;
    const synthetic = receiptFromEvidence(draft);
    if (synthetic) items.push({ ...synthetic, draft });
  });
  return items.sort((a, b) => {
    const aTime = parseDate(a.updatedAt)?.getTime() ?? 0;
    const bTime = parseDate(b.updatedAt)?.getTime() ?? 0;
    return bTime - aTime;
  });
}
