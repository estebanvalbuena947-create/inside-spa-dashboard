/* Ejecuta el dashboard TAL COMO ESTÁ PUBLICADO en Vercel.
 *
 *   node tools/e2e-deployed.mjs
 *
 * Descarga los archivos reales de https://inside-spa-dashboard.vercel.app
 * (HTML, módulos y CSS), reescribe las rutas para poder cargarlos desde disco,
 * apunta el `supabase-config.js` a un backend de prueba local y ejecuta el
 * dashboard publicado. Comprueba que la versión que ve el equipo funciona:
 * arranca, consulta las 4 tablas, pinta las vistas y guarda decisiones.
 *
 * Así se detecta cualquier diferencia entre lo que hay en el repositorio y lo
 * que realmente está sirviendo producción.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDom, installSupabaseStub, readSupabaseConfig, root } from './dom-mock.mjs';
import { startMockBackend, mockUrl, mockDb, signToken, TEST_EMAIL } from './mock-backend.mjs';

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'https://inside-spa-dashboard.vercel.app';
const workDir = join(root, '.vendor', 'deployed');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const failures = [];
const passes = [];
const check = (name, condition, detail = '') => {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
};
const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

console.log('\n=== PRUEBA DEL DASHBOARD PUBLICADO ===');
console.log(`Origen: ${BASE}`);

/* ---------- 1. Descargar los artefactos publicados ---------- */
const html = await (await fetch(`${BASE}/`)).text();
const modulePaths = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map(match => match[1]))]
  .filter(path => !path.startsWith('http'));
const files = new Map();

async function download(path) {
  const clean = path.split('?')[0];
  if (files.has(clean)) return clean;
  const response = await fetch(`${BASE}/${clean.replace(/^\//, '')}`);
  if (!response.ok) throw new Error(`${clean} -> HTTP ${response.status}`);
  files.set(clean, await response.text());
  return clean;
}

for (const path of modulePaths) await download(path);

/* Los módulos se importan entre sí con rutas relativas: se descargan también. */
for (const [path, content] of [...files.entries()]) {
  for (const match of content.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const resolved = join(path, '..', match[1]).replace(/\\/g, '/');
    await download(resolved).catch(error => console.log(`  aviso: ${error.message}`));
  }
}

console.log(`\n--- ARCHIVOS PUBLICADOS DESCARGADOS (${files.size}) ---`);
[...files.keys()].sort().forEach(path => console.log(`  ${path.padEnd(28)} ${String(files.get(path).length).padStart(7)} bytes`));

/* ---------- 2. Preparar copia local cargable ---------- */
const localName = path => path.replace(/^\//, '').replace(/[?].*$/, '');
for (const [path, content] of files) {
  const target = join(workDir, localName(path));
  mkdirSync(join(target, '..'), { recursive: true });
  /* Las rutas absolutas del HTML (/js/x.js) se vuelven relativas. */
  const rewritten = content.replace(/(from\s+['"])\/(js\/)/g, '$1./').replace(/(src=")\/(js\/)/g, '$1./');
  writeFileSync(target, rewritten, 'utf8');
}
/* La configuración publicada apunta a Supabase: para la prueba se usa el backend local. */
writeFileSync(join(workDir, 'supabase-config.js'), `window.INSIDE_SPA_SUPABASE = ${JSON.stringify({
  url: mockUrl,
  publishableKey: 'sb_publishable_prueba',
  allowedEmails: [TEST_EMAIL],
  timeZone: 'America/Mexico_City'
}, null, 2)};\n`, 'utf8');

/* ---------- 3. Ejecutar el código publicado ---------- */
await startMockBackend();
const config = readSupabaseConfig();
installDom({ config: { ...config, url: mockUrl } });
const sdk = await import(pathToFileURL(join(root, '.vendor', 'entry.mjs')).href);
await installSupabaseStub({ createClient: sdk.createClient });

const entryPath = join(workDir, 'js', 'main.js');
await import(`${pathToFileURL(entryPath).href}?run=${Date.now()}`);
const app = globalThis.window.__INSIDE_SPA__;
await wait(700);
const doc = globalThis.document;

console.log('\n--- RESULTADO DEL DASHBOARD PUBLICADO ---');
check('El bundle publicado arranca', Boolean(app?.state));
check('Expone el estado de la app', Boolean(app?.state?.kpis));
check('Sin sesión no ve filas (RLS)', app.state.drafts.length === 0, String(app.state.drafts.length));

/* Con sesión: se inyecta como lo hace la librería oficial. */
const projectRef = mockUrl.match(/https?:\/\/([^.]+)\.?/)?.[1] || 'local';
const token = signToken();
const session = {
  access_token: token, refresh_token: 'prueba', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: '00000000-0000-0000-0000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: TEST_EMAIL, app_metadata: {}, user_metadata: {} }
};
globalThis.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(session));
globalThis.window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(session));

await app.refresh({ reason: 'publicado' });
await wait(400);
const rows = id => (doc.getElementById(id)?.innerHTML.match(/<tr>/g) || []).length;
check('Con sesión lee las pre-reservas', app.state.drafts.length === 5, String(app.state.drafts.length));
check('Calcula las métricas', doc.getElementById('pendingMetric')?.textContent === '3', doc.getElementById('pendingMetric')?.textContent);
check('Pinta la tabla de pre-reservas', rows('reservationBody') === 5, String(rows('reservationBody')));
check('Pinta los comprobantes', /receipt-card/.test(doc.getElementById('receiptList')?.innerHTML || ''));
check('Pinta los clientes', rows('clientBody') === 7, String(rows('clientBody')));
check('Pinta el histórico', /decision-item/.test(doc.getElementById('decisionList')?.innerHTML || ''));

/* Decisión real contra el backend de prueba, desde el código publicado. */
const { decide } = await import(pathToFileURL(join(workDir, 'js', 'data.js')).href);
const result = await decide(app.state.supabase, { draftId: 150, action: 'approved', note: 'prueba desde produccion', previousStatus: 'Pendiente de pago', userEmail: TEST_EMAIL });
check('La decisión se guarda', ['rpc', 'fallback', 'decision_only', 'status_only'].includes(result?.via), String(result?.via));
check('El backend quedó con la reserva confirmada', mockDb.reservas_draft.find(row => row.id === 150)?.estado_reserva === 'confirmado',
  mockDb.reservas_draft.find(row => row.id === 150)?.estado_reserva);
check('Queda registro en el histórico', mockDb.dashboard_reservation_decisions.some(row => row.reservation_draft_id === 150 && row.action === 'approved'));

console.log(`\n✓ ${passes.length} comprobaciones correctas`);
if (failures.length) {
  console.log(`✗ ${failures.length} fallos:`);
  failures.forEach(failure => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log('La versión publicada en Vercel funciona: lectura, métricas, vistas y decisiones.');
}
process.exit(process.exitCode || 0);
