/* Reglas de negocio del dashboard: estados, decisiones, filtros y KPIs.
   Todo aquÃ­ es lÃ³gica pura para poder probarla sin navegador. */

import { dayKey, firstValue, isToday, isWithinHours, parseDate, toAmount } from './core.js?v=2.0.0';

/** Acciones de decisiÃ³n permitidas (deben coincidir con el SQL del RPC). */
export const DECISION_ACTIONS = ['approved', 'rejected', 'needs_info'];

export const ACTION_LABELS = {
  approved: { short: 'Aprobada', title: 'Comprobante aprobado', toast: 'Comprobante aprobado correctamente.', past: 'aprobÃ³ el comprobante de' },
  rejected: { short: 'Rechazada', title: 'Comprobante rechazado', toast: 'Comprobante rechazado.', past: 'rechazÃ³ el comprobante de' },
  needs_info: { short: 'InformaciÃ³n', title: 'InformaciÃ³n solicitada', toast: 'Se marcÃ³ la reserva como informaciÃ³n pendiente.', past: 'solicitÃ³ informaciÃ³n a' }
};

export const STATUS_LABELS = {
  pending: 'Pendiente de pago',
  review: 'Por revisar',
  info: 'InformaciÃ³n solicitada',
  processing: 'En confirmaciÃ³n',
  confirmed: 'Confirmada',
  rejected: 'Comprobante rechazado'
};

/** Claves de estado que el filtro puede mostrar (orden de la barra). */
export const STATUS_ORDER = ['pending', 'review', 'info', 'processing', 'confirmed', 'rejected'];

/** Estados que cuentan como "por gestionar" (requieren acciÃ³n del equipo). */
export const MANAGE_STATUSES = ['pending', 'review', 'info', 'processing'];

const asText = value => String(value ?? '').trim().toLowerCase();

/* ---------- NormalizaciÃ³n de filas ---------- */

export function normalizeDraft(row) {
  const schedule = firstValue(row.masaje_inicio, row.jacuzzi_inicio, row.fecha_reserva, row.fecha_servicio, row.inicio);
  return {
    ...row,
    id: Number(row.id),
    nombre: firstValue(row.nombre, row.cliente, row.nombre_cliente),
    email: firstValue(row.email, row.correo),
    phone: firstValue(row.phone, row.telefono, row.whatsapp, row.celular),
    servicio: firstValue(row.nombre_servicio, row.servicio, row.servicios),
    monto: toAmount(firstValue(row.monto_pagado, row.monto, row.valor, row.total)),
    estado: asText(row.estado_reserva),
    confirmada: Boolean(row.reserva_confirmada),
    scheduleAt: schedule,
    scheduleDate: parseDate(schedule),
    reviewAt: firstValue(row.comprobante_revision_at, row.actualizado_at, row.updated_at),
    createdAt: firstValue(row.created_at, row.creado_at, row.fecha_creacion, row.comprobante_revision_at),
    updatedAt: firstValue(row.updated_at, row.actualizado_at, row.comprobante_revision_at)
  };
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
  const amount = toAmount(firstValue(row.monto_pago, row.monto, datos.monto_pago, datos.monto));
  const paidAt = firstValue(row.fecha_pago, datos.fecha_pago, row.created_at, row.creado_at);
  return {
    ...row,
    draftId: Number(firstValue(row.reserva_draft_id, row.draft_id, row.reservation_draft_id)),
    estado: asText(firstValue(row.estado, row.status, 'revision')),
    datos,
    mediaUrl: mediaUrl || null,
    amount,
    paidAt,
    receivedAt: firstValue(row.creado_at, row.created_at, row.actualizado_at, row.updated_at),
    updatedAt: firstValue(row.updated_at, row.actualizado_at, row.creado_at, row.created_at),
    reference: firstValue(row.referencia, row.reference, datos.referencia, datos.folio, datos.reference),
    method: firstValue(row.metodo, row.metodo_pago, datos.metodo, datos.metodo_pago)
  };
}

/* ---------- Estado derivado ---------- */

const CONFIRMED_STATES = ['confirmado', 'confirmada', 'confirmed', 'completado', 'completada', 'pagado', 'reserva_confirmada', 'aprobado'];
const REVIEW_STATES = ['requiere_revision', 'requiere_revision_pago', 'revision_pago', 'en_revision', 'comprobante_en_revision', 'requiere_verificacion'];
const PROCESSING_STATES = ['procesando_pabau', 'procesando', 'en_proceso', 'pendiente_pabau', 'esperando_pabau', 'en_confirmacion'];
const REJECTED_STATES = ['rechazado', 'rechazada', 'pago_rechazado', 'cancelado', 'cancelada', 'expirado', 'expirada', 'abandonado'];

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
 * Prioridad: confirmada por reservas > Ãºltima decisiÃ³n > estado de la tabla.
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

/** Motivo para pedir informaciÃ³n o rechazar, sugerido segÃºn el estado real. */
export function reviewHint(row) {
  if (!row) return 'Sin comprobante asociado todavÃ­a.';
  if (row.estado === 'procesando_pabau') return 'El pago estÃ¡ en proceso de confirmaciÃ³n automÃ¡tica.';
  if (row.estado === 'requiere_revision_pago') return 'El comprobante requiere verificaciÃ³n manual del equipo.';
  if (row.estado === 'requiere_revision') return 'La reserva requiere revisiÃ³n manual.';
  return 'Revisa el comprobante antes de decidir.';
}

/* ---------- Ãndices ---------- */

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
  const draftsConfirmedToday = drafts.filter(row => keyOf(row) === 'confirmed' && isToday(row.reviewAt || row.updatedAt));
  const confirmedToday = confirmed.filter(row => isToday(row.confirmedAt));
  const confirmedAmountToday = [...confirmedToday, ...draftsConfirmedToday].reduce((total, row) => total + toAmount(row.monto), 0);
  const pendingAmount = manageable.reduce((total, row) => {
    const receipt = receiptMap.get(row.id);
    return total + toAmount(row.monto || receipt?.amount);
  }, 0);
  const upcoming = confirmed.filter(row => isWithinHours(row.scheduleDate, 24));
  const receiptsToCheck = drafts.filter(row => Boolean(receiptMap.get(row.id))).length;
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
    lastDecisionAt: lastDecisionAt ? new Date(lastDecisionAt) : null
  };
}

/** Filtra pre-reservas segÃºn la barra de filtros. */
export function filterDrafts(drafts, statuses, { query = '', service = '', status = '', date = '' } = {}) {
  const text = query.trim().toLowerCase();
  const targetDay = date ? dayKey(date) : null;
  return drafts.filter(row => {
    const state = statuses.get(row.id)?.key || 'pending';
    if (status && state !== status) return false;
    if (service && row.servicio !== service) return false;
    if (targetDay && dayKey(row.scheduleDate || row.reviewAt || row.createdAt) !== targetDay) return false;
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
    client.amount += toAmount(row.monto);
    if (row.servicio) client.services.add(row.servicio);
    const when = row.scheduleDate || parseDate(row.reviewAt);
    if (when && (!client.lastAt || when > client.lastAt)) client.lastAt = when;
  });
  confirmed.forEach(row => {
    const client = ensure(row);
    client.total += 1;
    client.confirmedCount += 1;
    client.amount += toAmount(row.monto);
    if (row.servicio) client.services.add(row.servicio);
    const when = row.scheduleDate || parseDate(row.confirmedAt);
    if (when && (!client.lastAt || when > client.lastAt)) client.lastAt = when;
  });
  return [...map.values()]
    .map(client => ({ ...client, services: [...client.services] }))
    .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

/** Comprobantes en formato de lista, con la pre-reserva asociada. */
export function buildReceipts(drafts, receiptMap) {
  return [...receiptMap.values()]
    .map(receipt => {
      const draft = drafts.find(row => row.id === receipt.draftId) || null;
      return { ...receipt, draft };
    })
    .sort((a, b) => (parseDate(b.updatedAt)?.getTime() ?? 0) - (parseDate(a.updatedAt)?.getTime() ?? 0));
}
