import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';

const config = window.INSIDE_SPA_SUPABASE;
const supabase = createClient(config.url, config.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
let reservations = [];
let decisions = [];
let receipts = new Map();
let currentId = null;
let currentUser = null;

const money = value => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateFormat = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const safe = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const initials = name => String(name || 'IS').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'IS';
const receiptData = reservation => receipts.get(Number(reservation.id)) || null;
const latestDecision = reservation => decisions.find(item => Number(item.reservation_draft_id) === Number(reservation.id));
const statusOf = reservation => {
  const decision = latestDecision(reservation);
  if (reservation.estado_reserva === 'confirmado' || reservation.reserva_confirmada) return { key: 'confirmed', label: 'Confirmada' };
  if (decision?.action === 'rejected') return { key: 'rejected', label: 'Comprobante rechazado' };
  if (['requiere_revision', 'requiere_revision_pago'].includes(reservation.estado_reserva)) return { key: 'pending', label: 'Por revisar' };
  if (reservation.estado_reserva === 'procesando_pabau') return { key: 'pending', label: 'En confirmación' };
  return { key: 'pending', label: 'Pendiente de pago' };
};
const formatSchedule = reservation => {
  const value = reservation.masaje_inicio || reservation.jacuzzi_inicio;
  if (!value) return { date: 'Horario pendiente', time: 'Por definir' };
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return { date: new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(date), time: new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' }).format(date) };
};
const isReviewable = reservation => ['requiere_revision', 'requiere_revision_pago'].includes(reservation.estado_reserva);
const setSyncStatus = (text, connected = false) => { const status = document.querySelector('#syncStatus'); status.textContent = text; status.classList.toggle('connected', connected); };

function render() {
  const query = document.querySelector('#searchInput').value.toLowerCase();
  const service = document.querySelector('#serviceFilter').value;
  const status = document.querySelector('#statusFilter').value;
  const rows = reservations.filter(r => {
    const derived = statusOf(r);
    return (!query || `${r.nombre || ''} ${r.email || ''} ${r.id}`.toLowerCase().includes(query)) && (!service || (r.nombre_servicio || r.servicio) === service) && (!status || derived.key === status);
  });
  document.querySelector('#reservationBody').innerHTML = rows.map(r => {
    const schedule = formatSchedule(r), state = statusOf(r), serviceName = r.nombre_servicio || r.servicio || 'Servicio por confirmar';
    return `<tr><td><div class="client-cell"><div class="avatar">${safe(initials(r.nombre))}</div><div><span class="client-name">${safe(r.nombre || 'Cliente sin nombre')}</span><span class="client-email">${safe(r.email || r.phone || 'Sin contacto')}</span></div></div></td><td class="service">${safe(serviceName)}</td><td><span class="date">${safe(schedule.date)}</span><span class="time">${safe(schedule.time)}</span></td><td class="price">${money(r.monto_pagado || receiptData(r)?.datos?.monto_pago)}</td><td><span class="badge ${state.key}">${safe(state.label)}</span></td><td><button class="row-action" data-id="${Number(r.id)}" aria-label="Ver reserva">•••</button></td></tr>`;
  }).join('');
  document.querySelector('#emptyState').hidden = rows.length > 0;
  document.querySelectorAll('.row-action').forEach(button => button.addEventListener('click', () => openModal(Number(button.dataset.id))));
  const pending = reservations.filter(r => statusOf(r).key === 'pending').length;
  const confirmed = reservations.filter(r => statusOf(r).key === 'confirmed');
  const confirmedRevenue = confirmed.reduce((total, r) => total + Number(r.monto_pagado || receiptData(r)?.datos?.monto_pago || 0), 0);
  document.querySelector('#pendingMetric').textContent = pending;
  document.querySelector('#pendingBadge').textContent = pending;
  document.querySelector('#reservationCount').textContent = pending;
  document.querySelector('#pendingChange').textContent = pending ? `${pending} requieren atención` : 'Todo al día';
  document.querySelector('#confirmedMetric').textContent = confirmed.length;
  document.querySelector('#revenueMetric').textContent = money(confirmedRevenue);
  document.querySelector('#clientsMetric').textContent = reservations.filter(r => r.masaje_inicio || r.jacuzzi_inicio).length;
  const activityRows = decisions.slice(0, 4);
  document.querySelector('#activityList').innerHTML = activityRows.length ? activityRows.map(item => {
    const reservation = reservations.find(r => Number(r.id) === Number(item.reservation_draft_id));
    const action = item.action === 'approved' ? 'aprobó el comprobante de' : item.action === 'rejected' ? 'rechazó el comprobante de' : 'solicitó información a';
    return `<li style="--activity-color:${item.action === 'approved' ? '#3b8a72' : item.action === 'rejected' ? '#c26a68' : '#c28d49'}"><strong>${safe(item.decided_by_email)}</strong> ${action} <strong>${safe(reservation?.nombre || `reserva #${item.reservation_draft_id}`)}</strong>.<time>${safe(dateFormat.format(new Date(item.created_at)))}</time></li>`;
  }).join('') : '<li><strong>Sin decisiones todavía.</strong><time>Las acciones aprobadas o rechazadas aparecerán aquí.</time></li>';
  document.querySelector('#decisionList').innerHTML = decisions.length ? decisions.slice(0, 6).map(item => {
    const reservation = reservations.find(r => Number(r.id) === Number(item.reservation_draft_id));
    const label = item.action === 'approved' ? 'Comprobante aprobado' : item.action === 'rejected' ? 'Comprobante rechazado' : 'Información solicitada';
    return `<article class="decision-item"><strong>${safe(label)} · ${safe(reservation?.nombre || `#${item.reservation_draft_id}`)}</strong><p>${safe(item.previous_status)} → ${safe(item.resulting_status)}${item.note ? ` · ${safe(item.note)}` : ''}</p><time>${safe(dateFormat.format(new Date(item.created_at)))} · ${safe(item.decided_by_email)}</time></article>`;
  }).join('') : '<p class="empty-state">Aún no hay decisiones registradas.</p>';
}

function openModal(id) {
  const reservation = reservations.find(item => Number(item.id) === Number(id));
  if (!reservation) return;
  currentId = id;
  const schedule = formatSchedule(reservation), state = statusOf(reservation), receipt = receiptData(reservation), details = receipt?.datos || {};
  document.querySelector('#modalCode').textContent = `PRE-${reservation.id}`;
  document.querySelector('#modalTitle').textContent = reservation.nombre || 'Detalle de pre-reserva';
  const mediaLink = /^https:\/\//.test(String(details.media_url || '')) ? `<a href="${safe(details.media_url)}" target="_blank" rel="noopener noreferrer">Abrir comprobante ↗</a>` : '<span>Archivo no disponible</span>';
  document.querySelector('#modalContent').innerHTML = `<div class="detail-grid"><div><span>Servicio</span>${safe(reservation.nombre_servicio || reservation.servicio || '—')}</div><div><span>Valor reportado</span><strong>${money(reservation.monto_pagado || details.monto_pago)}</strong></div><div><span>Fecha y hora</span>${safe(schedule.date)} · ${safe(schedule.time)}</div><div><span>Estado actual</span><span class="badge ${state.key}">${safe(state.label)}</span></div></div><div class="receipt"><strong>Comprobante de pago</strong><p>${safe(receipt ? `${receipt.estado || 'revision'} · ${details.fecha_pago || 'Sin fecha'} · ${money(details.monto_pago)}` : 'No hay comprobante asociado.')}</p>${mediaLink}</div>`;
  document.querySelector('#modalActions').innerHTML = isReviewable(reservation) ? `<button type="button" class="reject-btn" id="requestInfoBtn">Pedir información</button><button type="button" class="reject-btn" id="rejectBtn">Rechazar</button><button type="button" class="primary-btn" id="approveBtn">✓ Aprobar comprobante</button>` : '<button value="cancel" class="primary-btn">Cerrar</button>';
  document.querySelector('#reservationDialog').showModal();
  document.querySelector('#approveBtn')?.addEventListener('click', () => decide('approved'));
  document.querySelector('#rejectBtn')?.addEventListener('click', () => decide('rejected'));
  document.querySelector('#requestInfoBtn')?.addEventListener('click', () => decide('needs_info'));
}

async function decide(action) {
  const labels = { approved: 'aprobado', rejected: 'rechazado', needs_info: 'marcado para información adicional' };
  const { error } = await supabase.rpc('process_dashboard_reservation_decision', { p_reservation_draft_id: currentId, p_action: action, p_note: null });
  if (error) { showToast(`No fue posible guardar la decisión: ${error.message}`); return; }
  document.querySelector('#reservationDialog').close();
  showToast(`Comprobante ${labels[action]} correctamente.`);
  await loadData();
}

async function loadData() {
  setSyncStatus('Sincronizando…');
  const [reservationResult, receiptResult, decisionResult] = await Promise.all([
    supabase.from('reservas_draft').select('*').order('comprobante_revision_at', { ascending: false, nullsFirst: false }).limit(100),
    supabase.from('spa_comprobantes_pago').select('reserva_draft_id,estado,datos,creado_at,actualizado_at').order('actualizado_at', { ascending: false }).limit(100),
    supabase.from('dashboard_reservation_decisions').select('*').order('created_at', { ascending: false }).limit(100)
  ]);
  const error = reservationResult.error || receiptResult.error || decisionResult.error;
  if (error) { setSyncStatus('Error de conexión'); showToast(`No se pudieron cargar los datos: ${error.message}`); return; }
  reservations = reservationResult.data || [];
  decisions = decisionResult.data || [];
  receipts = new Map();
  (receiptResult.data || []).forEach(receipt => { if (!receipts.has(Number(receipt.reserva_draft_id))) receipts.set(Number(receipt.reserva_draft_id), receipt); });
  const services = [...new Set(reservations.map(r => r.nombre_servicio || r.servicio).filter(Boolean))];
  const select = document.querySelector('#serviceFilter');
  const previous = select.value;
  select.innerHTML = '<option value="">Todos los servicios</option>' + services.map(item => `<option value="${safe(item)}">${safe(item)}</option>`).join('');
  select.value = previous;
  setSyncStatus('Datos sincronizados', true);
  render();
}

function showToast(message) { document.querySelector('#toastMessage').textContent = message; const toast = document.querySelector('#toast'); toast.show(); setTimeout(() => toast.close(), 3200); }
function exportCsv() { const csv = ['Código,Cliente,Servicio,Fecha,Valor,Estado', ...reservations.map(r => { const schedule = formatSchedule(r); return [r.id, r.nombre, r.nombre_servicio || r.servicio, `${schedule.date} ${schedule.time}`, r.monto_pagado || receiptData(r)?.datos?.monto_pago || 0, statusOf(r).label].map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','); })].join('\n'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'reservas-inside-spa.csv'; link.click(); URL.revokeObjectURL(url); }
function openAuth() { document.querySelector('#authFeedback').textContent = ''; document.querySelector('#authDialog').showModal(); }
async function sendMagicLink(event) {
  event.preventDefault();
  const email = document.querySelector('#authEmail').value.trim().toLowerCase();
  const feedback = document.querySelector('#authFeedback');
  if (!config.allowedEmails.includes(email)) { feedback.textContent = 'Este correo no tiene acceso al dashboard.'; return; }
  if (window.location.protocol === 'file:') { feedback.textContent = 'Publica el dashboard en un dominio HTTPS antes de iniciar sesión.'; return; }
  const button = document.querySelector('#sendLinkBtn'); button.disabled = true; feedback.textContent = 'Enviando enlace seguro…';
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
  button.disabled = false;
  if (error) { feedback.textContent = error.message; return; }
  feedback.style.color = '#278667'; feedback.textContent = 'Revisa tu correo y abre el enlace para completar el acceso.';
}
async function syncSession(session) {
  const user = session?.user || (await supabase.auth.getUser()).data.user;
  if (!user) { currentUser = null; setSyncStatus('Conecta tu cuenta'); document.querySelector('#authBtn').textContent = 'Iniciar sesión'; reservations = []; decisions = []; receipts = new Map(); render(); return; }
  if (!config.allowedEmails.includes(String(user.email || '').toLowerCase())) { await supabase.auth.signOut(); showToast('Tu cuenta no está autorizada para este dashboard.'); return; }
  currentUser = user; document.querySelector('#authBtn').textContent = 'Cerrar sesión'; await loadData();
}
function setup() {
  document.querySelectorAll('#searchInput,#serviceFilter,#statusFilter').forEach(element => element.addEventListener('input', render));
  document.querySelector('#exportBtn').addEventListener('click', exportCsv);
  document.querySelector('#authBtn').addEventListener('click', async () => { if (currentUser) { await supabase.auth.signOut(); return; } openAuth(); });
  document.querySelector('#authForm').addEventListener('submit', sendMagicLink);
  document.querySelector('#closeAuthBtn').addEventListener('click', () => document.querySelector('#authDialog').close());
  document.querySelector('.menu-toggle').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active')); link.classList.add('active'); document.querySelector('.sidebar').classList.remove('open'); }));
  supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => syncSession(session), 0); });
  syncSession();
}
setup();
