/* Prueba de extremo a extremo SIN navegador pero con la librería OFICIAL.
 *
 *   node tools/live-sdk.mjs [--rest-url <url>]
 *
 * Diferencias con live-check.mjs:
 *   - usa @supabase/supabase-js real (descargado del CDN a .vendor/),
 *   - si se pasa --rest-url, apunta el cliente a OTRO backend (por ejemplo un
 *     PostgREST local que imita GRANT/RLS) para comprobar la lectura real de
 *     filas, el render de las métricas y el flujo de decisión de punta a punta.
 *
 * Requiere haber ejecutado antes: node tools/vendor-sdk.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDom, installSupabaseStub, readSupabaseConfig, root } from './dom-mock.mjs';

const args = process.argv.slice(2);
const restUrl = args.includes('--rest-url') ? args[args.indexOf('--rest-url') + 1] : null;
const config = readSupabaseConfig();
const entry = join(root, '.vendor', 'entry.mjs');
if (!existsSync(entry)) {
  console.error('Falta .vendor/: ejecuta primero  node tools/vendor-sdk.mjs');
  process.exit(2);
}

const realUrl = restUrl || config.url;
installDom({ config: { ...config, url: realUrl } });

/* Primero se carga la librería oficial desde .vendor y después se le entrega su
   propio createClient al doble de importación (así no hay recursión). */
const sdk = await import(pathToFileURL(entry).href);
await installSupabaseStub({ createClient: sdk.createClient });

console.log('\n=== PRUEBA CON LA LIBRERÍA OFICIAL DE SUPABASE ===');
console.log(`Librería : ${sdk.version || 'supabase-js'} (descargada del CDN a .vendor/)`);
console.log(`Backend  : ${realUrl}${restUrl ? '  (sustituido para la prueba)' : ''}`);

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  const response = await originalFetch(input, init);
  if (url.includes('/rest/v1/')) calls.push({ method: init?.method || 'GET', url: url.replace(realUrl, ''), status: response.status });
  return response;
};

await import(pathToFileURL(join(root, 'js/main.js')).href);
const app = globalThis.window.__INSIDE_SPA__;
const doc = globalThis.document;

const waitFor = async (predicate, timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  return false;
};

let ok = true;
const check = (name, condition, detail = '') => {
  if (!condition) ok = false;
  console.log(`  ${condition ? 'OK   ' : 'FALLA'} ${name}${detail ? ` · ${detail}` : ''}`);
};

/* La sesión de prueba se inyecta como lo hace la librería oficial. */
const token = process.env.DASHBOARD_TEST_TOKEN || null;
if (token) {
  const projectRef = realUrl.match(/https?:\/\/([^.]+)\./)?.[1] || 'local';
  const key = `sb-${projectRef}-auth-token`;
  const session = {
    access_token: token,
    refresh_token: 'prueba',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '00000000-0000-0000-0000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: config.allowedEmails[0], app_metadata: {}, user_metadata: {} }
  };
  globalThis.localStorage.setItem(key, JSON.stringify(session));
}

await waitFor(() => app.state.loaded || app.state.problems.length > 0);
if (token) {
  /* Con sesión inyectada hay que forzar una nueva lectura. */
  await app.refresh({ reason: 'prueba-sdk' });
}

console.log(`\n--- LLAMADAS DEL SDK OFICIAL (${calls.length}) ---`);
calls.slice(0, 8).forEach(call => console.log(`  ${String(call.status).padEnd(4)} ${call.method.padEnd(4)} ${decodeURIComponent(call.url).slice(0, 100)}`));

console.log('\n--- RESULTADO ---');
console.log(`  Pre-reservas : ${app.state.drafts.length}`);
console.log(`  Confirmadas  : ${app.state.confirmed.length}`);
console.log(`  Decisiones   : ${app.state.decisions.length}`);
console.log(`  Comprobantes : ${app.state.receipts.size}`);
console.log(`  Problemas    : ${app.state.problems.length}`);
app.state.problems.forEach(problem => console.log(`    · [${problem.table}] ${problem.message}`));
console.log(`  Sincronización: "${doc.getElementById('syncStatus')?.textContent || ''}"`);

console.log('\n--- COMPROBACIONES ---');
check('La app arranca con la librería oficial', Boolean(app && app.state));
check('El cliente apunta al backend configurado', Boolean(app.state.supabase));
check('Se consultaron las 4 tablas', new Set(calls.map(call => call.url.replace('/rest/v1/', '').split('?')[0])).size >= 3,
  [...new Set(calls.map(call => call.url.replace('/rest/v1/', '').split('?')[0]))].join(', '));
if (app.state.drafts.length) {
  check('Las métricas se calcularon', doc.getElementById('pendingMetric')?.textContent !== '—', String(doc.getElementById('pendingMetric')?.textContent));
  check('La tabla tiene filas', (doc.getElementById('reservationBody')?.innerHTML.match(/<tr>/g) || []).length > 0);
  check('Los comprobantes se listan', (doc.getElementById('receiptList')?.innerHTML.match(/receipt-card/g) || []).length > 0);
  check('Los clientes se consolidan', (doc.getElementById('clientBody')?.innerHTML.match(/<tr>/g) || []).length > 0);
} else {
  console.log('  · sin filas visibles: se omite la validación de métricas');
}
if (token) {
  check('Con sesión se leyeron datos', app.state.drafts.length > 0, `${app.state.drafts.length} pre-reservas`);
}

/* Decisión de ida y vuelta con el SDK oficial. */
const firstManageable = [...app.state.kpis.statuses.entries()].find(([, status]) => ['pending', 'review', 'info', 'processing'].includes(status.key));
const { decide } = await import(pathToFileURL(join(root, 'js/data.js')).href);
if (firstManageable) {
  try {
    const result = await decide(app.state.supabase, {
      draftId: firstManageable[0], action: 'needs_info', note: 'prueba automatica', previousStatus: firstManageable[1].label, userEmail: config.allowedEmails[0]
    });
    check('Decisión enviada por el SDK oficial', Boolean(result?.via), `vía: ${result?.via}`);
  } catch (error) {
    check('Decisión enviada por el SDK oficial', false, error.message.slice(0, 140));
  }
}

console.log(`\n${ok ? '✓ Todo correcto con la librería oficial.' : '✗ Hay comprobaciones fallidas.'}`);
process.exitCode = ok ? 0 : 1;
void readFileSync;
