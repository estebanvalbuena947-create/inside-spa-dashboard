/* Inside Spa · Dashboard de reservas
   Orquesta sesión, carga de datos, decisiones y refresco. */

import { buildCsv, downloadText, formatDate, formatWeekday, initials, safe, setTimeZone, timeAgo } from './core.js?v=2.0.0';
import {
  buildClients, buildKpis, buildReceipts, filterDrafts, indexByDraftId, isConfirmed,
  serviceOptions, visibleAmount, AMOUNT_SOURCE_LABELS
} from './domain.js?v=2.0.0';
import {
  classifyError, DataError, decide as commitDecision, describeError,
  loadDashboard, runDiagnostics, signOut, TABLE, getSession
} from './data.js?v=2.0.0';
import * as view from './view.js?v=2.0.0';

const SUPABASE_VERSION = '2.116.0';
const CAPACITY = 18;
const REFRESH_MS = 60000;

async function loadSupabaseLibrary() {
  const sources = [
    `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_VERSION}/+esm`,
    `https://esm.sh/@supabase/supabase-js@${SUPABASE_VERSION}`,
    'https://esm.sh/@supabase/supabase-js@2'
  ];
  let lastError = null;
  for (const source of sources) {
    try {
      const module = await import(/* @vite-ignore */ source);
      if (module?.createClient) return { createClient: module.createClient, source };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No se pudo cargar la librería de Supabase (${lastError?.message || 'sin detalle'}).`);
}

const state = {
  supabase: null,
  session: null,
  userEmail: null,
  drafts: [],
  confirmed: [],
  decisions: [],
  receipts: new Map(),
  receiptsList: [],
  clients: [],
  statuses: new Map(),
  draftById: new Map(),
  decisionsByDraft: new Map(),
  kpis: buildKpis([], [], [], new Map()),
  problems: [],
  warnings: [],
  loaded: false,
  loadedAt: null,
  visibleDrafts: [],
  currentId: null,
  busy: false
};

const config = window.INSIDE_SPA_SUPABASE || {};
setTimeZone(config.timeZone);
const allowedEmails = (config.allowedEmails || []).map(email => String(email).toLowerCase());
const isAllowed = email => allowedEmails.includes(String(email || '').toLowerCase());

/* ---------- Arranque ---------- */

async function boot() {
  let createClient;
  try {
    ({ createClient } = await loadSupabaseLibrary());
  } catch (error) {
    view.alertMessage(error.message);
    view.renderHeader({ todayLabel: formatWeekday(), greeting: greetingFor(), sync: 'Sin conexión a la librería', connected: false });
    return;
  }
  if (!config.url || !config.publishableKey) {
    view.alertMessage('Falta configurar supabase-config.js (url y publishableKey).');
    return;
  }
  state.supabase = createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  bindEvents();
  setHeaderLabels();
  await refresh({ reason: 'inicio' });
  state.supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => handleAuthChange(event, session), 0);
  });
  const session = await getSession(state.supabase);
  await applySession(session);
  startAutoRefresh();
  void reportAuthRedirect();
}

function setHeaderLabels() {
  view.renderHeader({
    todayLabel: formatWeekday(),
    greeting: greetingFor(),
    sync: state.session ? 'Sincronizando…' : 'Conecta tu cuenta',
    connected: Boolean(state.session)
  });
}

function greetingFor() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function startAutoRefresh() {
  setInterval(() => {
    if (document.hidden) return;
    if (!state.session) return;
    refresh({ reason: 'auto', silent: true });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.session) return;
    const age = state.loadedAt ? Date.now() - state.loadedAt.getTime() : Infinity;
    if (age > 45000) refresh({ reason: 'visibilidad', silent: true });
  });
}

/* ---------- Sesión ---------- */

async function applySession(session) {
  if (!session?.user) {
    state.session = null;
    state.userEmail = null;
    clearData();
    setProfile(null);
    view.renderHeader({ todayLabel: formatWeekday(), greeting: greetingFor(), sync: 'Conecta tu cuenta', connected: false });
    renderAll();
    return;
  }
  const email = String(session.user.email || '').toLowerCase();
  if (!isAllowed(email)) {
    view.alertMessage('Tu cuenta no está autorizada para este dashboard.');
    await signOut(state.supabase);
    return;
  }
  const isNew = state.userEmail !== email;
  state.session = session;
  state.userEmail = email;
  setProfile(email);
  if (isNew || !state.loaded) await refresh({ reason: 'sesion' });
}

async function handleAuthChange(event, session) {
  if (event === 'SIGNED_OUT') {
    state.session = null;
    state.userEmail = null;
    clearData();
    setProfile(null);
    renderAll();
    view.renderHeader({ todayLabel: formatWeekday(), greeting: greetingFor(), sync: 'Sesión cerrada', connected: false });
    view.alertMessage('Sesión cerrada.');
    return;
  }
  if (['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION', 'USER_UPDATED'].includes(event)) {
    await applySession(session);
  }
}

function setProfile(email) {
  const node = document.querySelector('#profileName');
  const role = document.querySelector('#profileRole');
  const avatar = document.querySelector('#profileAvatar');
  const button = document.querySelector('#loginBtn');
  const authButton = document.querySelector('#authBtn');
  if (!email) {
    if (node) node.textContent = 'Sin sesión';
    if (role) role.textContent = 'Conecta tu cuenta';
    if (avatar) avatar.textContent = 'IS';
    if (button) button.textContent = 'Iniciar sesión';
    if (authButton) authButton.title = 'Iniciar sesión';
    return;
  }
  const short = email.split('@')[0].replace(/[._-]+/g, ' ');
  if (node) node.textContent = short.replace(/\b\w/g, letter => letter.toUpperCase());
  if (role) role.textContent = 'Administradora · Inside Spa';
  if (avatar) avatar.textContent = initials(short.replace(/[._-]+/g, ' '));
  if (button) button.textContent = 'Cerrar sesión';
  if (authButton) authButton.title = 'Cerrar sesión';
}

function clearData() {
  state.drafts = [];
  state.confirmed = [];
  state.decisions = [];
  state.receipts = new Map();
  state.receiptsList = [];
  state.clients = [];
  state.statuses = new Map();
  state.draftById = new Map();
  state.decisionsByDraft = new Map();
  state.kpis = buildKpis([], [], [], new Map());
  state.problems = [];
  state.warnings = [];
  state.visibleDrafts = [];
  state.loaded = false;
  state.loadedAt = null;
  state.currentId = null;
}

async function reportAuthRedirect() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const errorDescription = hash.get('error_description') || query.get('error_description');
  const errorCode = hash.get('error_code') || query.get('error_code');
  if (!errorDescription && !errorCode) return;
  view.alertMessage(`No se pudo completar el acceso: ${errorDescription || errorCode}`);
  if (window.history?.replaceState) window.history.replaceState(null, '', window.location.pathname);
}

/* ---------- Carga de datos ---------- */

async function refresh({ reason = 'manual', silent = false } = {}) {
  if (!state.supabase) return;
  if (state.busy) return;
  state.busy = true;
  if (!silent) view.setLoading(true, 'Sincronizando…');
  try {
    const result = await loadDashboard(state.supabase);
    state.drafts = result.drafts;
    state.confirmed = result.confirmed;
    state.decisions = result.decisions;
    state.receipts = result.receipts;
    state.problems = result.problems;
    state.warnings = result.warnings || [];
    state.loaded = true;
    state.loadedAt = result.loadedAt;
    recompute();
    renderAll();
    const syncText = syncLabel(result);
    view.renderHeader({ todayLabel: formatWeekday(), greeting: greetingFor(), sync: syncText, connected: state.problems.length === 0 });
    if (result.problems.length && !silent) view.alertMessage(result.problems[0].message);
    if (!result.problems.length && result.warnings.length) {
      view.alertMessage(`Datos cargados con avisos de esquema: ${result.warnings[0]}`);
    }
    if (silent && reason === 'manual') view.alertMessage('Datos actualizados.');
  } catch (error) {
    const kind = classifyError(error);
    const message = kind === 'network' ? 'No se pudo conectar con Supabase.' : `Error al cargar datos: ${error.message}`;
    state.problems = [{ table: 'general', message, kind: 'unknown' }];
    view.renderHeader({ todayLabel: formatWeekday(), greeting: greetingFor(), sync: 'Error de conexión', connected: false });
    if (!silent) view.alertMessage(message);
    renderAll();
  } finally {
    state.busy = false;
  }
}

function syncLabel(result) {
  if (result.problems.length) return 'Sincronización con avisos';
  if (!state.drafts.length && !state.confirmed.length) return 'Sincronizado · sin datos aún';
  return 'Datos sincronizados';
}

function recompute() {
  state.decisionsByDraft = indexByDraftId(state.decisions, 'draftId');
  state.draftById = new Map(state.drafts.map(row => [row.id, row]));
  state.kpis = buildKpis(state.drafts, state.confirmed, state.decisions, state.receipts);
  state.statuses = state.kpis.statuses;
  state.receiptsList = buildReceipts(state.drafts, state.receipts);
  state.clients = buildClients(state.drafts, state.confirmed);
  state.visibleDrafts = computeVisible();
}

function currentFilters() {
  return {
    query: document.querySelector('#searchInput')?.value || '',
    service: document.querySelector('#serviceFilter')?.value || '',
    status: document.querySelector('#statusFilter')?.value || '',
    date: document.querySelector('#dayFilter')?.value || ''
  };
}

function computeVisible() {
  return filterDrafts(state.drafts, state.statuses, currentFilters());
}

function renderAll() {
  view.renderMetrics(state);
  view.renderOccupancy(state, CAPACITY);
  view.renderReservations(state);
  view.renderActivity(state);
  view.renderHistory(state);
  view.renderReceipts(state);
  view.renderClients(state);
}

function renderTable() {
  state.visibleDrafts = computeVisible();
  view.renderReservations(state);
}

function syncServiceFilter() {
  const select = document.querySelector('#serviceFilter');
  if (!select) return;
  const previous = select.value;
  const options = serviceOptions(state.drafts);
  select.innerHTML = '<option value="">Todos los servicios</option>' + options.map(item => `<option value="${safe(item)}">${safe(item)}</option>`).join('');
  select.value = options.includes(previous) ? previous : '';
}

/* ---------- Decisiones ---------- */

async function openReservation(id) {
  const draft = state.draftById.get(Number(id));
  if (!draft) return;
  state.currentId = draft.id;
  if (!view.renderReservationModal(state, draft.id)) return;
  view.renderModalActions(state, draft.id);
  view.openDialog('#reservationDialog');
  document.querySelector('#approveBtn')?.addEventListener('click', () => askDecision('approved'));
  document.querySelector('#rejectBtn')?.addEventListener('click', () => askDecision('rejected'));
  document.querySelector('#requestInfoBtn')?.addEventListener('click', () => askDecision('needs_info'));
  document.querySelector('#closeModalBtn')?.addEventListener('click', () => view.closeDialog('#reservationDialog'));
}

async function askDecision(action) {
  const draft = state.draftById.get(state.currentId);
  if (!draft || state.busy) return;
  const copy = view.confirmCopy(action);
  view.confirmDialog(copy);
  const confirmed = await view.awaitConfirm();
  if (!confirmed) return;
  const note = view.decisionNote();
  await runDecision(draft, action, note);
}

async function runDecision(draft, action, note) {
  const status = state.statuses.get(draft.id) || { key: 'pending', label: 'Pendiente de pago' };
  state.busy = true;
  setActionButtonsDisabled(true);
  try {
    const result = await commitDecision(state.supabase, {
      draftId: draft.id,
      action,
      note,
      previousStatus: status.label,
      userEmail: state.userEmail
    });
    view.closeDialog('#reservationDialog');
    const labels = { approved: 'aprobado', rejected: 'rechazado', needs_info: 'marcado para información adicional' };
    view.alertMessage(`Comprobante ${labels[action]} correctamente.`);
    if (result.via === 'fallback' || result.via === 'decision_only' || result.via === 'status_only') {
      view.alertMessage(result.warning
        ? `Decisión guardada, pero el estado no se pudo actualizar: ${result.warning}`
        : 'Decisión guardada por la vía alternativa (el RPC del dashboard no existe todavía).');
    }
    state.loaded = false;
    await refresh({ reason: 'decision', silent: true });
  } catch (error) {
    const detail = error instanceof DataError ? error.message : describeError(error, TABLE.drafts);
    view.alertMessage(`No se pudo guardar la decisión: ${detail}`);
  } finally {
    state.busy = false;
    setActionButtonsDisabled(false);
  }
}

function setActionButtonsDisabled(disabled) {
  ['#approveBtn', '#rejectBtn', '#requestInfoBtn', '#confirmAccept'].forEach(selector => {
    const node = document.querySelector(selector);
    if (node) node.disabled = disabled;
  });
}

/* ---------- Exportación ---------- */

function exportCsv() {
  const rows = (state.visibleDrafts.length ? state.visibleDrafts : state.drafts).map(row => {
    const status = state.statuses.get(row.id) || { label: '' };
    const receipt = state.receipts.get(row.id);
    const { amount, source } = visibleAmount(row, receipt);
    return [
      row.id,
      row.nombre || '',
      row.email || '',
      row.phone || '',
      row.servicio || '',
      row.scheduleDate ? `${formatDate(row.scheduleDate)} ${new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' }).format(row.scheduleDate)}` : '',
      amount,
      AMOUNT_SOURCE_LABELS[source] || '',
      status.label,
      receipt ? (receipt.estado || 'revision') : 'sin comprobante',
      isConfirmed(row) ? 'sí' : 'no'
    ];
  });
  const csv = buildCsv(
    ['Código', 'Cliente', 'Correo', 'Teléfono', 'Servicio', 'Fecha y hora del servicio', 'Valor', 'Origen del valor', 'Estado', 'Comprobante', 'Confirmada'],
    rows
  );
  downloadText(`pre-reservas-inside-spa-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  view.alertMessage(`Exportadas ${rows.length} filas.`);
}

/* ---------- Diagnóstico ---------- */

async function diagnostics({ announce = true } = {}) {
  if (!state.supabase) return;
  view.renderDiagnosticsLoading();
  /* Se usa una pre-reserva real para la prueba de escritura: la tabla de
     decisiones tiene clave foránea a reservas_draft. */
  const probeDraftId = state.drafts[0]?.id ?? state.drafts.find(row => Number.isFinite(row.id))?.id ?? null;
  const checks = await runDiagnostics(state.supabase, {
    userEmail: state.userEmail,
    allowedEmails,
    session: state.session,
    probeDraftId
  });
  const failures = checks.filter(check => check.status === 'fail').length;
  view.renderDiagnostics(checks, failures
    ? `${failures} punto(s) con error. Corrige lo indicado y vuelve a revisar.`
    : 'Todo correcto: el dashboard puede leer y escribir en Supabase.');
  if (announce) view.alertMessage(failures ? `Diagnóstico: ${failures} problema(s) encontrado(s).` : 'Diagnóstico sin problemas.');
}

/* ---------- Eventos ---------- */

function bindEvents() {
  ['#searchInput', '#serviceFilter', '#statusFilter', '#dayFilter'].forEach(selector => {
    const node = document.querySelector(selector);
    if (!node) return;
    node.addEventListener('input', renderTable);
    node.addEventListener('change', renderTable);
  });
  document.querySelector('#exportBtn')?.addEventListener('click', exportCsv);
  document.querySelector('#refreshBtn')?.addEventListener('click', () => refresh({ reason: 'manual' }));
  document.querySelector('#reloadActivity')?.addEventListener('click', () => refresh({ reason: 'manual' }));
  document.querySelector('#runDiagnosticsBtn')?.addEventListener('click', () => diagnostics());
  document.querySelector('#helpBtn')?.addEventListener('click', () => {
    document.querySelector('#diagnostico')?.scrollIntoView({ behavior: 'smooth' });
    view.alertMessage('Revisa el Diagnóstico para ver el estado de la conexión con Supabase.');
  });
  document.querySelector('#loginBtn')?.addEventListener('click', handleAuthButton);
  document.querySelector('#authBtn')?.addEventListener('click', handleAuthButton);
  document.querySelector('#authForm')?.addEventListener('submit', sendAccessLink);
  document.querySelector('#closeAuthBtn')?.addEventListener('click', () => view.closeDialog('#authDialog'));
  document.querySelector('.menu-toggle')?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('open'));
  document.querySelector('#reservationBody')?.addEventListener('click', event => {
    const id = view.rowActionId(event);
    if (id) openReservation(id);
  });
  document.querySelector('#receiptList')?.addEventListener('click', event => {
    const id = view.rowActionId(event);
    if (id) openReservation(id);
  });
  document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
    link.classList.add('active');
    document.querySelector('.sidebar')?.classList.remove('open');
  }));
}

async function handleAuthButton() {
  if (state.session) {
    await signOut(state.supabase);
    return;
  }
  const feedback = document.querySelector('#authFeedback');
  if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }
  view.openDialog('#authDialog');
}

async function sendAccessLink(event) {
  event.preventDefault();
  const email = document.querySelector('#authEmail')?.value?.trim().toLowerCase() || '';
  const feedback = document.querySelector('#authFeedback');
  const button = document.querySelector('#sendLinkBtn');
  if (feedback) { feedback.style.color = ''; feedback.textContent = ''; }
  if (!isAllowed(email)) {
    if (feedback) { feedback.textContent = 'Este correo no tiene acceso al dashboard.'; }
    return;
  }
  if (window.location.protocol === 'file:') {
    if (feedback) feedback.textContent = 'Publica el dashboard en un dominio HTTPS antes de iniciar sesión.';
    return;
  }
  if (button) button.disabled = true;
  if (feedback) feedback.textContent = 'Enviando enlace seguro…';
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabaseSignIn(email, redirectTo);
  if (button) button.disabled = false;
  if (error) {
    if (feedback) feedback.textContent = `No se pudo enviar el enlace: ${error.message}`;
    return;
  }
  if (feedback) {
    feedback.style.color = '#278667';
    feedback.textContent = 'Revisa tu correo y abre el enlace para completar el acceso.';
  }
}

async function supabaseSignIn(email, redirectTo) {
  try {
    return await state.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: false }
    });
  } catch (error) {
    return { error };
  }
}

/* Navegación: si el hash apunta a una sección inexistente, lleva al resumen. */
function guardHashNavigation() {
  const valid = ['#dashboard', '#reservas', '#comprobantes', '#clientes', '#historico', '#diagnostico'];
  if (window.location.hash && !valid.includes(window.location.hash)) {
    window.location.hash = '#dashboard';
  }
}

guardHashNavigation();
window.addEventListener('hashchange', guardHashNavigation);
void boot();

/* Expuesto para pruebas y para comprobar la conexión desde la consola del navegador. */
window.__INSIDE_SPA__ = { state, refresh, diagnostics, exportCsv };

/**
 * Comprobación en un clic desde la consola del navegador (F12):
 *   await insideSpaCheck()
 * Revisa el acceso a las 4 tablas y al RPC con la sesión real del usuario.
 */
window.insideSpaCheck = async () => {
  if (!state.supabase) { console.warn('El dashboard todavía no está listo.'); return null; }
  if (!state.session) { console.warn('No hay sesión activa: inicia sesión primero.'); return null; }
  const checks = await runDiagnostics(state.supabase, { userEmail: state.userEmail, allowedEmails, session: state.session, probeDraftId: state.drafts[0]?.id ?? null });
  const failures = checks.filter(check => check.status === 'fail');
  console.table(checks.map(({ name, status, detail }) => ({ comprobacion: name, estado: status, detalle: detail })));
  console.log(failures.length
    ? `${failures.length} problema(s): ejecuta supabase/APLICAR_EN_SUPABASE.sql y vuelve a intentar.`
    : 'Todo correcto: el dashboard puede leer y escribir con esta sesión.');
  return checks;
};
