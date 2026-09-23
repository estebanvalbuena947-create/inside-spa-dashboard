/* Utilidades base: formato, seguridad y conversión de valores.
   Sin dependencias: se puede probar en Node (tools/verify.mjs). */

export const APP_VERSION = '2.0.0';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };

/** Escapa texto para insertarlo en HTML. */
export const safe = value => String(value ?? '').replace(/[&<>'"]/g, char => HTML_ESCAPES[char]);

const moneyFormat = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const moneyExactFormat = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

/**
 * Convierte montos que llegan como número, texto ("$1,200.00"), texto con
 * separadores locales o valores vacíos. Devuelve 0 cuando no es numérico,
 * para que las sumas nunca produzcan NaN.
 */
export function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  let text = String(value).trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  text = text.replace(/[^\d.,]/g, '');
  if (!text) return 0;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // El último separador es el decimal; el otro es de miles.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,200" => miles · "1200,50" => decimal
    text = /,\d{2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

export const money = value => moneyFormat.format(toAmount(value));
export const moneyExact = value => moneyExactFormat.format(toAmount(value));
export const sumAmounts = (items, pick) => items.reduce((total, item) => total + toAmount(pick(item)), 0);

/**
 * Normaliza fechas de Supabase/Postgres/n8n:
 * ISO con zona, "2026-09-21 14:30:00", "2026-09-21T14:30:00" o epoch.
 */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const fromEpoch = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const text = String(value).trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;
  const normalized = text.replace(' ', 'T').replace(/(\.\d+)?([+-]\d{2})$/, '$1$2:00');
  const retry = new Date(normalized);
  return Number.isNaN(retry.getTime()) ? null : retry;
}

export const formatDate = (value, options = { dateStyle: 'medium' }) => {
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat('es-MX', options).format(date) : null;
};

export const formatDateTime = value => formatDate(value, { dateStyle: 'medium', timeStyle: 'short' });

export const formatTime = value => formatDate(value, { hour: 'numeric', minute: '2-digit' });

/** "hace 5 min", "hace 2 h", "ayer", fecha corta. */
export function timeAgo(value) {
  const date = parseDate(value);
  if (!date) return 'sin fecha';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return `en ${relativeText(-diffMs)}`;
  return `hace ${relativeText(diffMs)}`;
}

function relativeText(diffMs) {
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return '1 día';
  if (days < 30) return `${days} días`;
  const months = Math.round(days / 30);
  return months <= 1 ? '1 mes' : `${months} meses`;
}

export function formatDayLabel(value) {
  const date = parseDate(value);
  if (!date) return 'Fecha por confirmar';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' }).format(date);
}

export function formatWeekday(value) {
  const date = parseDate(value) || new Date();
  const text = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const initials = name => String(name || 'IS')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map(word => word[0])
  .join('')
  .toUpperCase() || 'IS';

export function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Une valores y devuelve el primero con contenido. */
export const firstValue = (...values) => values.find(value => value !== null && value !== undefined && String(value).trim() !== '') ?? null;

/** Lee la primera propiedad existente de un objeto. */
export const pick = (row, ...keys) => {
  if (!row) return null;
  for (const key of keys) {
    if (row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== '') return row[key];
  }
  return null;
};

export function isHttpsUrl(value) {
  return /^https:\/\/[^\s]+$/i.test(String(value || '').trim());
}

export function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""').replace(/\r?\n/g, ' ')}"`;
}

/** CSV con BOM para que Excel respete tildes y ñ. */
export function buildCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(row => lines.push(row.map(csvCell).join(',')));
  return `\uFEFF${lines.join('\r\n')}`;
}

export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Clave local YYYY-MM-DD (evita el desfase de zona horaria de toISOString).
 *  Acepta "YYYY-MM-DD" tal cual y convierte fechas con hora a la zona local. */
export function dayKey(value) {
  if (typeof value === 'string') {
    const plain = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
    const withTime = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
    if (withTime) {
      const date = parseDate(value);
      if (!date) return `${withTime[1]}-${withTime[2]}-${withTime[3]}`;
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
  }
  const date = parseDate(value);
  if (!date) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export const isToday = value => {
  const key = dayKey(value);
  return key !== null && key === dayKey(new Date());
};

export const isWithinHours = (value, hours) => {
  const date = parseDate(value);
  if (!date) return false;
  const diff = date.getTime() - Date.now();
  return diff >= 0 && diff <= hours * 3600 * 1000;
};

export const truncate = (value, max = 48) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
