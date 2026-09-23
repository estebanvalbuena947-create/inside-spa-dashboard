/* Render del dashboard. Recibe estado ya calculado y escribe HTML seguro. */

import {
  dayKey, formatDate, formatDateTime, formatDayLabel, formatTime, initials, isHttpsUrl, money, moneyExact, safe, timeAgo, truncate
} from './core.js?v=2.0.0';
import { ACTION_LABELS, STATUS_LABELS } from './domain.js?v=2.0.0';

const $ = selector => document.querySelector(selector);
const setText = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };

/* ---------- Cabecera y mÃ©tricas ---------- */

export function renderHeader({ todayLabel, greeting, sync, connected }) {
  setText('#todayLabel', todayLabel);
  const greetingNode = $('#greeting');
  if (greetingNode) greetingNode.innerHTML = `${safe(greeting)} <span>âœ¦</span>`;
  const status = $('#syncStatus');
  if (status && sync) {
    status.textContent = sync;
    status.classList.toggle('connected', Boolean(connected));
  }
}

export function renderMetrics(state) {
  const { kpis, receipts } = state;
  const hasData = state.loaded;
  setText('#pendingMetric', hasData ? String(kpis.toManage) : 'â€”');
  setText('#pendingChange', hasData ? describePending(kpis) : 'Sin datos cargados');
  setText('#pendingBadge', String(kpis.toManage));
  setText('#reservationCount', String(kpis.toManage));
  setText('#confirmedMetric', hasData ? String(kpis.confirmedTodayCount) : 'â€”');
  setText('#confirmedChange', hasData ? (kpis.confirmedTodayCount ? 'Reservas confirmadas con fecha de hoy' : 'AÃºn no hay confirmaciones hoy') : 'Sin datos cargados');
  setText('#revenueMetric', hasData ? money(kpis.confirmedAmountToday) : 'â€”');
  setText('#revenueChange', hasData ? `${moneyExact(kpis.pendingAmount)} por confirmar` : 'Sin datos cargados');
  setText('#clientsMetric', hasData ? String(kpis.upcomingCount) : 'â€”');
  setText('#clientsChange', hasData ? (kpis.upcomingCount ? 'Con servicio en las prÃ³ximas 24 h' : 'Sin servicios en las prÃ³ximas 24 h') : 'PrÃ³ximas 24 horas');
  setText('#lastUpdate', state.loadedAt ? `${timeAgo(state.loadedAt)}` : 'â€”');
  setText('#receiptBadge', String(kpis.receiptsToCheck));
  setText('#receiptCount', String(receipts.length));

  const alerts = [...(state.problems || []).map(problem => problem.message)];
  const alertNode = $('#globalAlert');
  if (alertNode) {
    const show = alerts.length > 0;
    alertNode.hidden = !show;
    alertNode.innerHTML = show
      ? `${safe(alerts[0])}${alerts.length > 1 ? ` <a href="#diagnostico">Ver los ${alerts.length} avisos</a>.` : ' <a href="#diagnostico">Ver diagnÃ³stico</a>.'}`
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
  if (kpis.processingCount) parts.push(`${kpis.processingCount} en confirmaciÃ³n`);
  if (kpis.rejectedCount) parts.push(`${kpis.rejectedCount} rechazada(s)`);
  return parts.length ? parts.join(' Â· ') : 'Todo al dÃ­a';
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
    : 'No hay cupos ocupados hoy segÃºn las reservas registradas.');
  const circle = $('.circle-progress');
  if (circle) circle.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
}

const isSameDay = value => {
  const key = dayKey(value);
  return key !== null && key === dayKey(new Date());
};

/* ---------- Tabla de pre-reservas ---------- */

export function renderReservations(state) {
  const rows = state.visibleDrafts;
  const body = $('#reservationBody');
  if (!body) return;
  body.innerHTML = rows.map(row => {
    const status = state.statuses.get(row.id) || { key: 'pending', label: STATUS_LABELS.pending };
    const receipt = state.receipts.get(row.id);
    const amount = row.monto || receipt?.amount || 0;
    const actionLabel = status.key === 'confirmed' ? 'Ver detalle' : 'Gestionar';
    return `<tr>
      <td><div class="client-cell"><div class="avatar">${safe(initials(row.nombre))}</div><div><span class="client-name">${safe(row.nombre || 'Cliente sin nombre')}</span><span class="client-email">${safe(row.email || row.phone || 'Sin contacto')}</span></div></div></td>
      <td class="service">${safe(row.servicio || 'Servicio por confirmar')}</td>
      <td><span class="date">${safe(formatDayLabel(row.scheduleDate) || 'Horario pendiente')}</span><span class="time">${safe(formatTime(row.scheduleDate) || 'Por definir')}</span></td>
      <td class="price">${amount ? money(amount) : 'â€”'}</td>
      <td><span class="badge ${safe(status.key)}">${safe(status.label)}</span></td>
      <td><button class="row-action" data-id="${row.id}" aria-label="${safe(actionLabel)}">${receipt ? 'ðŸ“„ ' : ''}${safe(actionLabel)}</button></td>
    </tr>`;
  }).join('');
  const empty = $('#emptyState');
  if (empty) {
    empty.hidden = rows.length > 0;
    empty.textContent = state.drafts.length
      ? 'No hay reservas que coincidan con los filtros.'
      : (state.loaded ? 'No hay pre-reservas registradas todavÃ­a. Cuando un cliente envÃ­e su comprobante aparecerÃ¡ aquÃ­.' : 'Cargando datosâ€¦');
  }
}

/* ---------- Actividad e histÃ³rico ---------- */

export function renderActivity(state) {
  const list = $('#activityList');
  if (!list) return;
  const items = state.decisions.slice(0, 5);
  list.innerHTML = items.length ? items.map(decision => {
    const draft = state.draftById.get(decision.draftId);
    const labels = ACTION_LABELS[decision.action] || ACTION_LABELS.needs_info;
    const color = decision.action === 'approved' ? '#3b8a72' : decision.action === 'rejected' ? '#c26a68' : '#c28d49';
    return `<li style="--activity-color:${color}"><strong>${safe(decision.byEmail || 'Equipo')}</strong> ${safe(labels.past)} <strong>${safe(draft?.nombre || `reserva #${decision.draftId}`)}</strong>.<time>${safe(formatDateTime(decision.createdAt) || timeAgo(decision.createdAt))}</time></li>`;
  }).join('') : '<li><strong>Sin decisiones todavÃ­a.</strong><time>Las aprobaciones, rechazos y solicitudes aparecerÃ¡n aquÃ­.</time></li>';
}

export function renderHistory(state) {
  const container = $('#decisionList');
  if (!container) return;
  const decisionMarkup = state.decisions.slice(0, 30).map(decision => {
    const draft = state.draftById.get(decision.draftId);
    const labels = ACTION_LABELS[decision.action] || ACTION_LABELS.needs_info;
    const transition = decision.previousStatus || decision.resultingStatus
      ? `${safe(decision.previousStatus || 'â€”')} â†’ ${safe(decision.resultingStatus || 'â€”')}`
      : 'Cambio de estado no registrado';
    return `<article class="decision-item"><strong>${safe(labels.title)} Â· ${safe(draft?.nombre || `#${decision.draftId}`)}</strong><p>${transition}${decision.note ? ` Â· ${safe(decision.note)}` : ''}</p><time>${safe(formatDateTime(decision.createdAt) || 'Sin fecha')} Â· ${safe(decision.byEmail || 'sin usuario')}</time></article>`;
  }).join('');
  const confirmedMarkup = state.confirmed.slice(0, 30).map(row => `<article class="decision-item"><strong>Reserva confirmada Â· ${safe(row.nombre || `#${row.id}`)}</strong><p>${safe(row.servicio || 'Servicio confirmado')} Â· ${money(row.monto)}${row.sucursal ? ` Â· ${safe(row.sucursal)}` : ''}</p><time>${safe(formatDateTime(row.scheduleAt) || formatDateTime(row.confirmedAt) || 'Fecha no disponible')}</time></article>`).join('');
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
      ? `<a href="${safe(receipt.mediaUrl)}" target="_blank" rel="noopener noreferrer">Abrir archivo â†—</a>`
      : `<span class="muted">Sin archivo adjunto</span>`;
    const details = receipt.datos || {};
    const extras = Object.entries(details)
      .filter(([key, value]) => !['media_url', 'url'].includes(key) && value !== null && value !== '' && typeof value !== 'object')
      .slice(0, 4)
      .map(([key, value]) => `<span>${safe(key.replaceAll('_', ' '))}: <strong>${safe(truncate(value, 40))}</strong></span>`)
      .join('');
    return `<article class="receipt-card">
      <div class="receipt-head"><strong>${safe(draft?.nombre || `Reserva #${receipt.draftId}`)}</strong><span class="badge ${safe(receiptStateKey(receipt.estado))}">${safe(receipt.estado || 'revisiÃ³n')}</span></div>
      <p>${money(receipt.amount || draft?.monto || 0)} Â· ${safe(formatDateTime(receipt.paidAt) || 'Fecha de pago no registrada')}</p>
      ${receipt.reference ? `<p class="muted">Referencia: ${safe(receipt.reference)}</p>` : ''}
      ${receipt.method ? `<p class="muted">MÃ©todo: ${safe(receipt.method)}</p>` : ''}
      <div class="receipt-meta">${extras}</div>
      <div class="receipt-actions">${link}${draft ? `<button class="row-action" data-id="${draft.id}" type="button">Gestionar</button>` : ''}</div>
      <time>Recibido ${safe(timeAgo(receipt.receivedAt))}</time>
    </article>`;
  }).join('');
  const empty = $('#receiptEmpty');
  if (empty) empty.hidden = state.receiptsList.length > 0;
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
    <td>${safe(client.phone || 'â€”')}<span class="client-email">${safe(client.email || '')}</span></td>
    <td class="service">${safe(client.services.join(', ') || 'â€”')}</td>
    <td>${client.total}<span class="client-email">${client.confirmedCount} confirmada(s) Â· ${client.pendingCount} en gestiÃ³n</span></td>
    <td class="price">${money(client.amount)}</td>
    <td><span class="date">${safe(client.lastAt ? formatDate(client.lastAt) : 'â€”')}</span><span class="time">${safe(client.lastAt ? formatTime(client.lastAt) : '')}</span></td>
  </tr>`).join('');
  const empty = $('#clientEmpty');
  if (empty) empty.hidden = state.clients.length > 0;
}

/* ---------- DiagnÃ³stico ---------- */

export function renderDiagnostics(checks, note) {
  const container = $('#checksList');
  if (!container) return;
  container.innerHTML = checks.map(check => `<div class="check ${safe(check.status)}"><span class="check-dot"></span><strong>${safe(check.name)}</strong><p>${safe(check.detail)}</p></div>`).join('');
  setText('#checksNote', note || '');
}

export function renderDiagnosticsLoading() {
  const container = $('#checksList');
  if (container) container.innerHTML = '<div class="check warn"><span class="check-dot"></span><strong>Ejecutando diagnÃ³sticoâ€¦</strong><p>Consultando tablas y permisos con tu sesiÃ³n.</p></div>';
}

/* ---------- Modal de detalle ---------- */

export function renderReservationModal(state, draftId) {
  const draft = state.draftById.get(Number(draftId));
  if (!draft) return false;
  const status = state.statuses.get(draft.id) || { key: 'pending', label: STATUS_LABELS.pending };
  const receipt = state.receipts.get(draft.id);
  const decision = state.decisions.find(item => item.draftId === draft.id);
  const details = receipt?.datos || {};
  const mediaLink = isHttpsUrl(receipt?.mediaUrl)
    ? `<a href="${safe(receipt.mediaUrl)}" target="_blank" rel="noopener noreferrer">Abrir comprobante â†—</a>`
    : '<span>Archivo no disponible</span>';
  const receiptSummary = receipt
    ? `${safe(receipt.estado || 'revisiÃ³n')} Â· ${safe(formatDateTime(receipt.paidAt) || 'sin fecha de pago')} Â· ${money(receipt.amount || draft.monto)}`
    : 'No hay comprobante asociado.';
  const extraRows = Object.entries(details)
    .filter(([key, value]) => !['media_url', 'url'].includes(key) && value !== null && value !== '' && typeof value !== 'object')
    .slice(0, 6)
    .map(([key, value]) => `<div><span>${safe(key.replaceAll('_', ' '))}</span>${safe(truncate(value, 60))}</div>`)
    .join('');

  setText('#modalCode', `PRE-${draft.id}`);
  setText('#modalTitle', draft.nombre || 'Detalle de pre-reserva');
  const content = $('#modalContent');
  if (content) {
    content.innerHTML = `<div class="detail-grid">
      <div><span>Servicio</span>${safe(draft.servicio || 'â€”')}</div>
      <div><span>Valor</span><strong>${money(draft.monto || receipt?.amount || 0)}</strong></div>
      <div><span>Fecha y hora</span>${safe(formatDayLabel(draft.scheduleDate) || 'Pendiente')} Â· ${safe(formatTime(draft.scheduleDate) || 'por definir')}</div>
      <div><span>Estado actual</span><span class="badge ${safe(status.key)}">${safe(status.label)}</span></div>
      <div><span>Contacto</span>${safe(draft.email || draft.phone || 'â€”')}</div>
      <div><span>Ãšltima actualizaciÃ³n</span>${safe(formatDateTime(draft.updatedAt || draft.reviewAt) || 'â€”')}</div>
      ${extraRows}
    </div>
    <div class="receipt"><strong>Comprobante de pago</strong><p>${receiptSummary}</p>${mediaLink}</div>
    ${decision ? `<div class="receipt"><strong>Ãšltima decisiÃ³n</strong><p>${safe(ACTION_LABELS[decision.action]?.title || decision.action)} Â· ${safe(formatDateTime(decision.createdAt) || '')} Â· ${safe(decision.byEmail || '')}${decision.note ? ` Â· ${safe(decision.note)}` : ''}</p></div>` : ''}`;
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
    actions.innerHTML = '<button type="button" class="reject-btn" id="requestInfoBtn">Pedir informaciÃ³n</button><button type="button" class="reject-btn" id="rejectBtn">Rechazar</button><button type="button" class="primary-btn" id="approveBtn">âœ“ Aprobar comprobante</button>';
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
  if (action === 'approved') return { title: 'Aprobar comprobante', copy: 'La pre-reserva quedarÃ¡ confirmada y se reflejarÃ¡ en las mÃ©tricas del dÃ­a.', accept: 'SÃ­, aprobar', code: 'AprobaciÃ³n' };
  if (action === 'rejected') return { title: 'Rechazar comprobante', copy: 'El comprobante quedarÃ¡ rechazado y la reserva marcada como rechazada en el histÃ³rico.', accept: 'SÃ­, rechazar', code: 'Rechazo' };
  return { title: 'Pedir informaciÃ³n', copy: 'La reserva quedarÃ¡ marcada como pendiente de informaciÃ³n adicional del cliente.', accept: 'SÃ­, solicitar', code: 'Solicitud' };
};

export const alertMessage = message => { const node = $('#toastMessage'); if (node) node.textContent = message; const toast = $('#toast'); if (toast) { toast.show(); setTimeout(() => toast.close(), 4200); } };

/* ---------- DiÃ¡logo de confirmaciÃ³n ---------- */

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

export const setLoading = (loading, label = 'Cargandoâ€¦') => {
  const status = $('#syncStatus');
  if (!status) return;
  if (loading) { status.textContent = label; status.classList.remove('connected'); }
};

export const rowActionId = event => {
  const button = event.target.closest('.row-action');
  return button ? Number(button.dataset.id) : null;
};
