/* Render del dashboard. Recibe estado ya calculado y escribe HTML seguro. */

import {
  dayKey, formatDate, formatDateTime, formatDayLabel, formatTime, initials, isHttpsUrl, isToday, money, moneyExact, safe, timeAgo, truncate
} from './core.js?v=2.0.0';
import { ACTION_LABELS, AMOUNT_SOURCE_LABELS, PAYMENT_REASON_LABELS, STATUS_LABELS, visibleAmount } from './domain.js?v=2.0.0';

const $ = selector => document.querySelector(selector);
const setText = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
/** Marca ASCII (sin emoji) para no depender de la codificación del archivo. */
export const RECEIPT_MARK = '[C]';
export const DASH = '—';

/** Celda de valor con el origen del dato (reserva, comprobante o esperado). */
function amountCell(draft, receipt) {
  const { amount, source } = visibleAmount(draft, receipt);
  if (!amount) return `<span class="muted">${DASH}</span>`;
  const note = source === 'comprobante' ? '<small class="amount-source">según comprobante</small>'
    : source === 'esperado' ? '<small class="amount-source">monto esperado</small>' : '';
  return `${money(amount)}${note}`;
}

/* ---------- Cabecera y métricas ---------- */

export function renderHeader({ todayLabel, greeting, sync, connected }) {
  setText('#todayLabel', todayLabel);
  const greetingNode = $('#greeting');
  if (greetingNode) greetingNode.innerHTML = `${safe(greeting)} <span>·</span>`;
  const status = $('#syncStatus');
  if (status && sync) {
    status.textContent = sync;
    status.classList.toggle('connected', Boolean(connected));
  }
}

export function renderMetrics(state) {
  const { kpis, receipts } = state;
  const hasData = state.loaded;
  setText('#pendingMetric', hasData ? String(kpis.toManage) : DASH);
  setText('#pendingChange', hasData ? describePending(kpis) : 'Sin datos cargados');
  setText('#pendingBadge', String(kpis.toManage));
  setText('#reservationCount', String(kpis.toManage));
  setText('#confirmedMetric', hasData ? String(kpis.confirmedTodayCount) : DASH);
  setText('#confirmedChange', hasData
    ? (kpis.confirmedTodayCount
      ? 'Confirmadas con fecha de hoy'
      : (kpis.lastConfirmedAt ? `Última confirmación: ${formatDateTime(kpis.lastConfirmedAt)}` : 'Sin confirmaciones registradas'))
    : 'Sin datos cargados');
  setText('#revenueMetric', hasData ? money(kpis.confirmedAmountToday) : DASH);
  setText('#revenueChange', hasData ? `${moneyExact(kpis.pendingAmount)} por confirmar` : 'Sin datos cargados');
  setText('#clientsMetric', hasData ? String(kpis.upcomingCount) : DASH);
  setText('#clientsChange', hasData ? (kpis.upcomingCount ? 'Con servicio en las próximas 24 h' : 'Sin servicios en las próximas 24 h') : 'Próximas 24 horas');
  setText('#lastUpdate', state.loadedAt ? `${timeAgo(state.loadedAt)}` : DASH);
  setText('#receiptBadge', String(kpis.receiptsToCheck));
  setText('#receiptCount', String(receipts.length));

  /* Retenciones a punto de expirar: lo más urgente de la operación. */
  const holdNode = $('#holdAlert');
  if (holdNode) {
    const holds = kpis.expiringHolds || [];
    holdNode.hidden = holds.length === 0;
    if (holds.length) {
      const first = holds[0];
      const minutesLeft = Math.max(1, Math.round((first.retencionExpiraAt.getTime() - Date.now()) / 60000));
      const others = holds.length > 1 ? ` y ${holds.length - 1} más` : '';
      holdNode.innerHTML = `<strong>${holds.length === 1 ? 'Una retención vence pronto' : `${holds.length} retenciones vencen pronto`}:</strong> la de ${safe(first.nombre || `#${first.id}`)} expira en ${minutesLeft} min (${safe(formatTime(first.retencionExpiraAt))})${others}. Decide antes de que se libere el horario.`;
      holdNode.classList.add('alert-error');
    }
  }

  const alerts = [...(state.problems || []).map(problem => problem.message)];
  const alertNode = $('#globalAlert');
  if (alertNode) {
    const show = alerts.length > 0;
    alertNode.hidden = !show;
    alertNode.innerHTML = show
      ? `${safe(alerts[0])}${alerts.length > 1 ? ` <a href="#diagnostico">Ver los ${alerts.length} avisos</a>.` : ' <a href="#diagnostico">Ver diagnóstico</a>.'}`
      : '';
    alertNode.classList.toggle('alert-error', (state.problems || []).some(problem => problem.kind === 'permission' || problem.kind === 'missing_table' || problem.kind === 'rls'));
  }
  const badge = $('#alertBadge');
  if (badge) {
    badge.hidden = alerts.length === 0;
    badge.textContent = String(alerts.length);
  }
}

function describePending(kpis) {
  const parts = [];
  if (kpis.pendingCount) parts.push(`${kpis.pendingCount} sin comprobante`);
  if (kpis.reviewCount) parts.push(`${kpis.reviewCount} por revisar`);
  if (kpis.processingCount) parts.push(`${kpis.processingCount} en confirmación`);
  if (kpis.rejectedCount) parts.push(`${kpis.rejectedCount} rechazada(s)`);
  return parts.length ? parts.join(' · ') : 'Todo al día';
}

export function renderOccupancy(state, capacity = 18) {
  const today = state.confirmed.filter(row => isSameDay(row.scheduleDate));
  const draftsToday = state.drafts.filter(row => isSameDay(row.scheduleDate));
  const used = today.length + draftsToday.length;
  const percent = capacity > 0 ? Math.round((used / capacity) * 100) : 0;
  const ratioNode = $('#occupancyRatio');
  if (ratioNode) ratioNode.innerHTML = `${used || 0}<small>/${capacity}</small>`;
  const percentNode = $('#occupancyPercent');
  if (percentNode) percentNode.innerHTML = `${Math.min(percent, 999)}<small>%</small>`;
  setText('#occupancyChange', today.length ? `${today.length} confirmadas hoy` : 'Sin confirmaciones hoy');
  setText('#occupancyNote', used
    ? `${used} de ${capacity} cupos con actividad hoy (confirmadas + pre-reservas con fecha de hoy).`
    : 'No hay cupos ocupados hoy según las reservas registradas.');
  const circle = $('.circle-progress');
  if (circle) circle.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
}

const isSameDay = value => isToday(value);

/* ---------- Tabla de pre-reservas ---------- */

export function renderReservations(state) {
  const rows = state.visibleDrafts;
  const body = $('#reservationBody');
  if (!body) return;
  body.innerHTML = rows.map(row => {
    const status = state.statuses.get(row.id) || { key: 'pending', label: STATUS_LABELS.pending };
    const receipt = state.receipts.get(row.id);
    const actionLabel = status.key === 'confirmed' ? 'Ver detalle' : 'Gestionar';
    return `<tr>
      <td><div class="client-cell"><div class="avatar">${safe(initials(row.nombre))}</div><div><span class="client-name">${safe(row.nombre || 'Cliente sin nombre')}</span><span class="client-email">${safe(row.email || row.phone || 'Sin contacto')}</span></div></div></td>
      <td class="service">${safe(row.servicio || 'Servicio por confirmar')}</td>
      <td><span class="date">${safe(formatDayLabel(row.scheduleDate) || 'Horario pendiente')}</span><span class="time">${safe(formatTime(row.scheduleDate) || 'Por definir')}</span></td>
      <td class="price">${amountCell(row, receipt)}</td>
      <td><span class="badge ${safe(status.key)}">${safe(status.label)}</span></td>
      <td><button class="row-action" data-id="${row.id}" aria-label="${safe(actionLabel)}">${receipt ? `${RECEIPT_MARK} ` : ''}${safe(actionLabel)}</button></td>
    </tr>`;
  }).join('');
  const empty = $('#emptyState');
  if (empty) {
    empty.hidden = rows.length > 0;
    empty.textContent = state.drafts.length
      ? 'No hay reservas que coincidan con los filtros.'
      : (state.loaded ? 'No hay pre-reservas registradas todavía. Cuando un cliente envíe su comprobante aparecerá aquí.' : 'Cargando datos…');
  }
}

/* ---------- Actividad e histórico ---------- */

export function renderActivity(state) {
  const list = $('#activityList');
  if (!list) return;
  const items = state.decisions.slice(0, 5);
  list.innerHTML = items.length ? items.map(decision => {
    const draft = state.draftById.get(decision.draftId);
    const labels = ACTION_LABELS[decision.action] || ACTION_LABELS.needs_info;
    const color = decision.action === 'approved' ? '#3b8a72' : decision.action === 'rejected' ? '#c26a68' : '#c28d49';
    return `<li style="--activity-color:${color}"><strong>${safe(decision.byEmail || 'Equipo')}</strong> ${safe(labels.past)} <strong>${safe(draft?.nombre || `reserva #${decision.draftId}`)}</strong>.<time>${safe(formatDateTime(decision.createdAt) || timeAgo(decision.createdAt))}</time></li>`;
  }).join('') : '<li><strong>Sin decisiones todavía.</strong><time>Las aprobaciones, rechazos y solicitudes aparecerán aquí.</time></li>';
}

export function renderHistory(state) {
  const container = $('#decisionList');
  if (!container) return;
  const decisionMarkup = state.decisions.slice(0, 30).map(decision => {
    const draft = state.draftById.get(decision.draftId);
    const labels = ACTION_LABELS[decision.action] || ACTION_LABELS.needs_info;
    const transition = decision.previousStatus || decision.resultingStatus
      ? `${safe(decision.previousStatus || DASH)} → ${safe(decision.resultingStatus || DASH)}`
      : 'Cambio de estado no registrado';
    return `<article class="decision-item"><strong>${safe(labels.title)} · ${safe(draft?.nombre || `#${decision.draftId}`)}</strong><p>${transition}${decision.note ? ` · ${safe(decision.note)}` : ''}</p><time>${safe(formatDateTime(decision.createdAt) || 'Sin fecha')} · ${safe(decision.byEmail || 'sin usuario')}</time></article>`;
  }).join('');
  const confirmedMarkup = state.confirmed.slice(0, 30).map(row => `<article class="decision-item"><strong>Reserva confirmada · ${safe(row.nombre || `#${row.id}`)}</strong><p>${safe(row.servicio || 'Servicio confirmado')} · ${money(row.monto)}${row.sucursal ? ` · ${safe(row.sucursal)}` : ''}</p><time>${safe(formatDateTime(row.scheduleAt) || formatDateTime(row.confirmedAt) || 'Fecha no disponible')}</time></article>`).join('');
  const markup = decisionMarkup + confirmedMarkup;
  container.innerHTML = markup;
  const empty = $('#decisionEmpty');
  if (empty) empty.hidden = Boolean(markup);
}

/* ---------- Comprobantes ---------- */

export function renderReceipts(state) {
  const container = $('#receiptList');
  if (!container) return;
  container.innerHTML = state.receiptsList.map(receipt => {
    const draft = receipt.draft;
    const link = isHttpsUrl(receipt.mediaUrl)
      ? `<a href="${safe(receipt.mediaUrl)}" target="_blank" rel="noopener noreferrer">Abrir archivo</a>`
      : '<span class="muted">Sin archivo adjunto</span>';
    const status = draft ? (state.statuses.get(draft.id) || { key: 'pending', label: '' }) : null;
    return `<article class="receipt-card">
      <div class="receipt-head"><strong>${safe(draft?.nombre || `Reserva #${receipt.draftId}`)}</strong><span class="badge ${safe(receiptStateKey(receipt.estado))}">${safe(receipt.estado || 'revisión')}</span></div>
      <p class="receipt-amount">${money(receipt.amount || draft?.monto || 0)}<small>${safe(formatDateTime(receipt.paidAt) || 'sin fecha de pago')}</small></p>
      ${draft?.servicio ? `<p class="muted">${safe(draft.servicio)}${draft.scheduleDate ? ` · ${safe(formatDayLabel(draft.scheduleDate))} ${safe(formatTime(draft.scheduleDate))}` : ''}</p>` : ''}
      ${receipt.bank || receipt.holder || receipt.account ? `<div class="receipt-meta">${receipt.bank ? `<span>Banco: <strong>${safe(receipt.bank)}</strong></span>` : ''}${receipt.holder ? `<span>Beneficiario: <strong>${safe(receipt.holder)}</strong></span>` : ''}${receipt.account ? `<span>Cuenta: <strong>${safe(receipt.account)}</strong></span>` : ''}${receipt.confidence !== null ? `<span>Confianza del clasificador: <strong>${Math.round(receipt.confidence * 100)}%</strong></span>` : ''}</div>` : ''}
      ${receipt.reference ? `<p class="muted">Referencia: ${safe(receipt.reference)}</p>` : ''}
      ${receipt.method ? `<p class="muted">Tipo de pago: ${safe(receipt.method)}</p>` : ''}
      ${reasonListMarkup(receipt.reasons)}
      ${receipt.fromEvidence ? '<p class="muted receipt-source">Evidencia guardada en la pre-reserva (sin fila propia en la tabla de comprobantes).</p>' : ''}
      <div class="receipt-actions">${link}${draft ? `<button class="row-action" data-id="${draft.id}" type="button">Gestionar</button>${status ? `<span class="badge ${safe(status.key)}">${safe(status.label)}</span>` : ''}` : ''}</div>
      <time>Recibido ${safe(timeAgo(receipt.receivedAt))}</time>
    </article>`;
  }).join('');
  const empty = $('#receiptEmpty');
  if (empty) empty.hidden = state.receiptsList.length > 0;
}

function reasonListMarkup(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return '';
  return `<ul class="reason-list">${reasons.map(reason => `<li>${safe(PAYMENT_REASON_LABELS[reason] || String(reason).replaceAll('_', ' ').toLowerCase())}</li>`).join('')}</ul>`;
}

const receiptStateKey = estado => {
  const text = String(estado || '').toLowerCase();
  if (['aprobado', 'approved', 'confirmado'].includes(text)) return 'confirmed';
  if (['rechazado', 'rejected'].includes(text)) return 'rejected';
  if (['revision', 'en_revision', 'requiere_revision', 'pendiente'].includes(text)) return 'review';
  return 'pending';
};

/* ---------- Clientes ---------- */

export function renderClients(state) {
  const body = $('#clientBody');
  if (!body) return;
  setText('#clientCount', String(state.clients.length));
  body.innerHTML = state.clients.map(client => `<tr>
    <td><div class="client-cell"><div class="avatar">${safe(initials(client.nombre))}</div><div><span class="client-name">${safe(client.nombre)}</span><span class="client-email">${safe(client.email || client.phone || 'Sin contacto')}</span></div></div></td>
    <td>${safe(client.phone || DASH)}<span class="client-email">${safe(client.email || '')}</span></td>
    <td class="service">${safe(client.services.join(', ') || DASH)}</td>
    <td>${client.total}<span class="client-email">${client.confirmedCount} confirmada(s) · ${client.pendingCount} en gestión</span></td>
    <td class="price">${money(client.amount)}</td>
    <td><span class="date">${safe(client.lastAt ? formatDate(client.lastAt) : DASH)}</span><span class="time">${safe(client.lastAt ? formatTime(client.lastAt) : '')}</span></td>
  </tr>`).join('');
  const empty = $('#clientEmpty');
  if (empty) empty.hidden = state.clients.length > 0;
}

/* ---------- Diagnóstico ---------- */

export function renderDiagnostics(checks, note) {
  const container = $('#checksList');
  if (!container) return;
  container.innerHTML = checks.map(check => `<div class="check ${safe(check.status)}"><span class="check-dot"></span><strong>${safe(check.name)}</strong><p>${safe(check.detail)}</p></div>`).join('');
  setText('#checksNote', note || '');
}

export function renderDiagnosticsLoading() {
  const container = $('#checksList');
  if (container) container.innerHTML = '<div class="check warn"><span class="check-dot"></span><strong>Ejecutando diagnóstico…</strong><p>Consultando tablas y permisos con tu sesión.</p></div>';
}

/* ---------- Modal de detalle ---------- */

export function renderReservationModal(state, draftId) {
  const draft = state.draftById.get(Number(draftId));
  if (!draft) return false;
  const status = state.statuses.get(draft.id) || { key: 'pending', label: STATUS_LABELS.pending };
  const receipt = state.receipts.get(draft.id);
  const decision = state.decisions.find(item => item.draftId === draft.id);
  const { amount, source } = visibleAmount(draft, receipt);
  const mediaLink = isHttpsUrl(receipt?.mediaUrl)
    ? `<a href="${safe(receipt.mediaUrl)}" target="_blank" rel="noopener noreferrer">Abrir comprobante</a>`
    : '<span>Archivo no disponible</span>';
  const receiptSummary = receipt
    ? `${safe(receipt.estado || 'revisión')} · ${safe(formatDateTime(receipt.paidAt) || 'sin fecha de pago')} · ${money(receipt.amount || amount)}`
    : 'No hay comprobante asociado.';
  const evidenceRows = [
    receipt?.method ? ['Tipo de pago', receipt.method] : null,
    receipt?.bank ? ['Banco', receipt.bank] : null,
    receipt?.holder ? ['Beneficiario', receipt.holder] : null,
    receipt?.account ? ['Cuenta destino', receipt.account] : null,
    receipt?.reference ? ['Referencia o rastreo', receipt.reference] : null,
    receipt?.confidence !== null && receipt?.confidence !== undefined ? ['Confianza del clasificador', `${Math.round(receipt.confidence * 100)}%`] : null
  ].filter(Boolean).map(([label, value]) => `<div><span>${safe(label)}</span>${safe(truncate(value, 60))}</div>`).join('');
  const reasons = [...(draft.motivosPago || []), ...(receipt?.reasons || [])];

  setText('#modalCode', `PRE-${draft.id}`);
  setText('#modalTitle', draft.nombre || 'Detalle de pre-reserva');
  const content = $('#modalContent');
  if (content) {
    content.innerHTML = `<div class="detail-grid">
      <div><span>Servicio</span>${safe(draft.servicio || DASH)}</div>
      <div><span>Valor</span><strong>${amount ? money(amount) : DASH}</strong><small class="amount-source">${safe(AMOUNT_SOURCE_LABELS[source] || '')}</small></div>
      <div><span>Fecha y hora</span>${safe(formatDayLabel(draft.scheduleDate) || 'Pendiente')} · ${safe(formatTime(draft.scheduleDate) || 'por definir')}</div>
      <div><span>Estado actual</span><span class="badge ${safe(status.key)}">${safe(status.label)}</span></div>
      <div><span>Contacto</span>${safe(draft.email || draft.phone || DASH)}</div>
      <div><span>Última actualización</span>${safe(formatDateTime(draft.updatedAt || draft.reviewAt) || DASH)}</div>
      ${draft.motivoRevision ? `<div><span>Motivo de revisión</span>${safe(draft.motivoRevision)}</div>` : ''}
      ${draft.retencionExpiraAt ? `<div><span>Retención vence</span>${safe(formatTime(draft.retencionExpiraAt))} · ${safe(formatDate(draft.retencionExpiraAt))}</div>` : ''}
      ${draft.procesandoDesde ? `<div><span>En proceso desde</span>${safe(formatDateTime(draft.procesandoDesde))}</div>` : ''}
      ${draft.intentosPago ? `<div><span>Intentos de pago</span>${draft.intentosPago}</div>` : ''}
      ${evidenceRows}
    </div>
    <div class="receipt"><strong>Comprobante de pago</strong><p>${receiptSummary}</p>${mediaLink}${reasonListMarkup(reasons)}</div>
    ${decision ? `<div class="receipt"><strong>Última decisión</strong><p>${safe(ACTION_LABELS[decision.action]?.title || decision.action)} · ${safe(formatDateTime(decision.createdAt) || '')} · ${safe(decision.byEmail || '')}${decision.note ? ` · ${safe(decision.note)}` : ''}</p></div>` : ''}`;
  }
  const form = $('#decisionForm');
  if (form) form.hidden = status.key === 'confirmed';
  const note = $('#decisionNote');
  if (note) note.value = '';
  return true;
}

export function renderModalActions(state, draftId) {
  const draft = state.draftById.get(Number(draftId));
  const actions = $('#modalActions');
  if (!actions || !draft) return;
  const status = state.statuses.get(draft.id) || { key: 'pending' };
  if (status.key === 'confirmed' || status.key === 'rejected') {
    actions.innerHTML = '<button value="cancel" class="primary-btn" type="button" id="closeModalBtn">Cerrar</button>';
  } else {
    actions.innerHTML = '<button type="button" class="reject-btn" id="requestInfoBtn">Pedir información</button><button type="button" class="reject-btn" id="rejectBtn">Rechazar</button><button type="button" class="primary-btn" id="approveBtn">Aprobar comprobante</button>';
  }
}

export function openDialog(selector) {
  const dialog = $(selector);
  if (dialog && !dialog.open) dialog.showModal();
}

export function closeDialog(selector) {
  const dialog = $(selector);
  if (dialog?.open) dialog.close();
}

export const decisionNote = () => $('#decisionNote')?.value?.trim() || '';

export const confirmCopy = action => {
  if (action === 'approved') return { title: 'Aprobar comprobante', copy: 'La pre-reserva quedará confirmada y se reflejará en las métricas del día.', accept: 'Sí, aprobar', code: 'Aprobación' };
  if (action === 'rejected') return { title: 'Rechazar comprobante', copy: 'El comprobante quedará rechazado y la reserva marcada como rechazada en el histórico.', accept: 'Sí, rechazar', code: 'Rechazo' };
  return { title: 'Pedir información', copy: 'La reserva quedará marcada como pendiente de información adicional del cliente.', accept: 'Sí, solicitar', code: 'Solicitud' };
};

export const alertMessage = message => { const node = $('#toastMessage'); if (node) node.textContent = message; const toast = $('#toast'); if (toast) { toast.show(); setTimeout(() => toast.close(), 4200); } };

/* ---------- Diálogo de confirmación ---------- */

export function confirmDialog({ title, copy, accept, code }) {
  setText('#confirmTitle', title);
  setText('#confirmCopy', copy);
  setText('#confirmCode', code);
  setText('#confirmAccept', accept);
  openDialog('#confirmDialog');
}

export function awaitConfirm() {
  const dialog = $('#confirmDialog');
  if (!dialog) return Promise.resolve(false);
  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
  });
}

export const setLoading = (loading, label = 'Cargando…') => {
  const status = $('#syncStatus');
  if (!status) return;
  if (loading) { status.textContent = label; status.classList.remove('connected'); }
};

export const rowActionId = event => {
  const button = event.target.closest('.row-action');
  return button ? Number(button.dataset.id) : null;
};
