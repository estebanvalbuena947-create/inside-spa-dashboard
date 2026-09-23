/* DOM mínimo para ejecutar el dashboard en Node (pruebas sin navegador).
   Reutilizado por tools/smoke.mjs (con datos simulados) y tools/live-check.mjs
   (contra la base real). Los #id se toman siempre de index.html para que las
   pruebas detecten cualquier referencia rota. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const html = readFileSync(join(root, 'index.html'), 'utf8');
export const rootIds = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);

export function makeNode(tagName = 'DIV', id = '') {
  const listeners = new Map();
  const attributes = new Map();
  if (id) attributes.set('id', id);
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    open: false,
    returnValue: '',
    scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: key => (attributes.has(key) ? attributes.get(key) : null),
    setAttribute: (key, value) => attributes.set(key, String(value)),
    removeAttribute: key => attributes.delete(key),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter(item => item !== handler));
    },
    dispatch: (type, extra = {}) => {
      const event = { type, target: node, preventDefault() {}, stopPropagation() {}, closest: () => null, ...extra };
      (listeners.get(type) || []).forEach(handler => handler(event));
      if (type === 'click') (listeners.get('click') || []).forEach(handler => handler(event));
    },
    appendChild(child) { node.children.push(child); return child; },
    remove() {},
    showModal() { node.open = true; },
    show() { node.open = true; },
    close() {
      node.open = false;
      (listeners.get('close') || []).forEach(handler => handler({ type: 'close', target: node }));
    },
    reset() {}
  };
  return node;
}

/**
 * Instala window/document/localStorage en globalThis.
 * @param {{ config?: object, origin?: string, hash?: string }} [options]
 */
export function installDom({ config, origin = 'https://inside-spa-dashboard.vercel.app', hash = '' } = {}) {
  const byId = new Map();
  const byClass = new Map();
  const store = new Map();

  const localStorageMock = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
    key: index => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };

  const ensureId = id => {
    if (!byId.has(id)) {
      const tag = id === 'searchInput' || id === 'dayFilter' ? 'INPUT' : id.endsWith('Dialog') || id === 'toast' ? 'DIALOG' : 'DIV';
      byId.set(id, makeNode(tag, id));
    }
    return byId.get(id);
  };
  rootIds.forEach(ensureId);
  ['.sidebar', '.menu-toggle', '.nav-link', '.occupancy-card', '.circle-progress'].forEach(selector => byClass.set(selector, makeNode('DIV')));

  globalThis.document = {
    hidden: false,
    body: makeNode('BODY'),
    querySelector: selector => {
      if (typeof selector !== 'string') return null;
      if (selector.startsWith('#')) return ensureId(selector.slice(1));
      if (byClass.has(selector)) return byClass.get(selector);
      const idPart = selector.split('#')[1];
      if (idPart) return makeNode('DIV', idPart.split(/[\s.:]/)[0]);
      return makeNode('DIV');
    },
    querySelectorAll: selector => (selector === '.nav-link' ? rootIds.filter(id => id.startsWith('nav')).map(() => makeNode('A')) : selector === '.sidebar' ? [byClass.get('.sidebar')] : []),
    getElementById: id => (rootIds.includes(id) ? ensureId(id) : null),
    createElement: tag => makeNode(tag),
    addEventListener() {},
    removeEventListener() {}
  };

  globalThis.window = {
    location: { origin, pathname: '/', hash, search: '', protocol: 'https:', href: `${origin}/${hash}` },
    history: { replaceState() {} },
    localStorage: localStorageMock,
    addEventListener() {},
    removeEventListener() {},
    INSIDE_SPA_SUPABASE: config || {}
  };
  globalThis.localStorage = localStorageMock;
  globalThis.URL.createObjectURL = () => 'blob:prueba';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.customElements = { define() {}, get: () => undefined };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.Blob = class Blob {
    constructor(parts) { this.parts = parts; }
  };

  return {
    byId,
    byClass,
    node: id => ensureId(id),
    text: id => byId.get(id)?.textContent ?? '',
    markup: id => byId.get(id)?.innerHTML ?? '',
    localStorage: localStorageMock
  };
}

/** Lee supabase-config.js (url, clave pública, correos y zona horaria). */
export function readSupabaseConfig() {
  const source = readFileSync(join(root, 'supabase-config.js'), 'utf8');
  return {
    url: source.match(/url:\s*'([^']+)'/)?.[1],
    publishableKey: source.match(/publishableKey:\s*'([^']+)'/)?.[1],
    allowedEmails: [...source.matchAll(/'([^']+@[^']+)'/g)].map(match => match[1]),
    timeZone: source.match(/timeZone:\s*'([^']+)'/)?.[1] || null
  };
}

/** Redirige la importación de la librería de Supabase hacia un doble de prueba. */
export async function installSupabaseStub(stub, { onlyFor = /supabase-js|esm\.sh/ } = {}) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { register } = await import('node:module');
  globalThis.__supabaseStub = stub;
  const source = 'export const createClient = globalThis.__supabaseStub.createClient;';
  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  const dir = mkdtempSync(join(tmpdir(), 'inside-spa-dom-'));
  const hookPath = join(dir, 'hook.mjs');
  writeFileSync(hookPath, `
export async function resolve(specifier, context, nextResolve) {
  if (${onlyFor}.test(specifier)) return { url: ${JSON.stringify(dataUrl)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
  if (typeof register !== 'function') throw new Error('Este Node no soporta module.register; usa Node 20.6 o superior.');
  register(`file://${hookPath.replace(/\\/g, '/')}`);
}
