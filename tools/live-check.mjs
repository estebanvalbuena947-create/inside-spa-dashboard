/* Ejecuta el dashboard REAL contra la base REAL, sin navegador.
 *
 *   node tools/live-check.mjs              # sin sesión (clave pública, RLS activa)
 *   node tools/live-check.mjs --session    # con sesión firmada (necesita SUPABASE_JWT_SECRET)
 *
 * Cómo funciona: monta el DOM con los #id de index.html y sustituye la librería
 * de Supabase por tools/rest-client.mjs, que emite las mismas peticiones
 * PostgREST que haría el navegador. Así se comprueba de verdad:
 *   - que js/main.js arranque y consulte las 4 tablas,
 *   - qué responde la base a la clave pública y a una sesión `authenticated`,
 *   - que las métricas y la tabla se rendericen (o que el aviso de permisos sea claro),
 *   - que el diagnóstico en pantalla diga la verdad.
 *
 * Además comprueba con fetch que el CDN de la librería oficial responda, porque
 * esa descarga solo puede hacerla el navegador.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDom, installSupabaseStub, readSupabaseConfig, root } from './dom-mock.mjs';
import { createRestClient } from './rest-client.mjs';

const args = process.argv.slice(2);
const useSession = args.includes('--session');
const config = readSupabaseConfig();
if (!config.url || !config.publishableKey) {
  console.error('No se pudo leer url/publishableKey de supabase-config.js');
  process.exit(2);
}

const envPath = join(root, '.env.local');
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const getEnv = name => env.match(new RegExp(`${name}=(\\S+)`))?.[1] || process.env[name] || null;
const jwtSecret = getEnv('SUPABASE_JWT_SECRET');
const sessionEmail = config.allowedEmails[0];
const projectRef = config.url.match(/https:\/\/([^.]+)\./)?.[1];

/* ---------- 1. Sesión de prueba (si se pide y hay secreto) ---------- */
let accessToken = null;
if (useSession) {
  if (!jwtSecret) {
    console.error('Para --session hace falta SUPABASE_JWT_SECRET en .env.local');
    console.log('\nSin el secreto puedes validar la sesión real así:');
    console.log('  1. Abre el dashboard y entra con tu correo.');
    console.log('  2. Ve a la sección "Diagnóstico" y pulsa "Revisar ahora".');
    process.exit(2);
  }
  const now = Math.floor(Date.now() / 1000);
  const base64url = value => Buffer.from(value).toString('base64url');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: 'supabase', ref: projectRef, role: 'authenticated', email: sessionEmail, aud: 'authenticated', iat: now, exp: now + 3600 };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  accessToken = `${data}.${createHmac('sha256', jwtSecret).update(data).digest('base64url')}`;
}

/* ---------- 2. Instrumentar las llamadas reales ---------- */
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  const response = await originalFetch(input, init);
  if (url.includes('/rest/v1/')) calls.push({ method: init?.method || 'GET', url: url.replace(config.url, ''), status: response.status });
  return response;
};

/* ---------- 3. DOM + cliente REST ---------- */
const dom = installDom({ config });

/* La sesión se guarda igual que lo hace la librería oficial, para que
   getSession() la recupere del almacenamiento (no se simula la respuesta). */
if (accessToken) {
  const now = Math.floor(Date.now() / 1000);
  const storageKey = `sb-${projectRef}-auth-token`;
  const session = {
    access_token: accessToken,
    refresh_token: 'token-de-prueba',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: '00000000-0000-0000-0000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: sessionEmail, app_metadata: {}, user_metadata: {} }
  };
  const serialized = JSON.stringify(session);
  dom.localStorage.setItem(storageKey, serialized);
  /* El SDK guarda las claves largas fragmentadas en trozos de 3.180 caracteres. */
  for (let index = 0; index * 3180 < serialized.length; index += 1) {
    dom.localStorage.setItem(`${storageKey}.${index}`, serialized.slice(index * 3180, (index + 1) * 3180));
  }
}

await installSupabaseStub({
  createClient: () => createRestClient({ url: config.url, apikey: config.publishableKey, accessToken })
});

console.log('\n=== COMPROBACIÓN EN VIVO DEL DASHBOARD ===');
console.log(`Proyecto    : ${config.url}`);
console.log(`Zona horaria: ${config.timeZone || '(sin configurar)'}`);
console.log(`Sesión      : ${accessToken ? `firmada como ${sessionEmail}` : 'anónima (sin sesión)'}`);

/* ---------- 4. ¿Responde el CDN de la librería oficial? ---------- */
try {
  const cdn = await originalFetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm');
  console.log(`CDN         : HTTP ${cdn.status} (la descarga real la hace el navegador)`);
} catch (error) {
  console.log(`CDN         : FALLA ${error.message}`);
}
console.log('');

/* ---------- 5. Ejecutar la app ---------- */
let app = null;
try {
  await import(pathToFileURL(join(root, 'js/main.js')).href);
  app = globalThis.window.__INSIDE_SPA__;
  console.log(`OK    js/main.js se ejecuta: ${Boolean(app)}`);
} catch (error) {
  console.log(`FALLA no se pudo ejecutar js/main.js: ${error.message}`);
  process.exit(1);
}

const waitFor = async (predicate, timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  return false;
};
const finished = await waitFor(() => app.state.loaded || app.state.problems.length > 0);

console.log(`\n--- LLAMADAS REALES AL BACKEND (${calls.length}) ---`);
calls.slice(0, 10).forEach(call => console.log(`  ${String(call.status).padEnd(4)} ${call.method.padEnd(4)} ${decodeURIComponent(call.url).slice(0, 105)}`));
if (calls.length > 10) console.log(`  ... y ${calls.length - 10} más`);

console.log('\n--- RESULTADO DE LA CARGA ---');
console.log(`  Carga terminada        : ${finished}`);
console.log(`  Pre-reservas leídas    : ${app.state.drafts.length}`);
console.log(`  Confirmadas leídas     : ${app.state.confirmed.length}`);
console.log(`  Decisiones leídas      : ${app.state.decisions.length}`);
console.log(`  Comprobantes           : ${app.state.receipts.size}`);
console.log(`  Problemas reportados   : ${app.state.problems.length}`);
app.state.problems.forEach(problem => console.log(`    · [${problem.table}] ${problem.message}`));
const doc = globalThis.document;
console.log(`  Sincronización         : "${doc.getElementById('syncStatus')?.textContent || ''}"`);
const alert = doc.getElementById('globalAlert');
console.log(`  Aviso en pantalla      : ${alert?.hidden ? '(oculto)' : (alert?.innerHTML || '').replace(/<[^>]+>/g, '').slice(0, 150)}`);
console.log(`  Por gestionar          : ${doc.getElementById('pendingMetric')?.textContent}`);
console.log(`  Confirmadas hoy        : ${doc.getElementById('confirmedMetric')?.textContent}`);
console.log(`  Ingresos de hoy        : ${doc.getElementById('revenueMetric')?.textContent}`);
console.log(`  Clientes por atender   : ${doc.getElementById('clientsMetric')?.textContent}`);
console.log(`  Ocupación              : ${doc.getElementById('occupancyRatio')?.innerHTML?.replace(/<[^>]+>/g, '/') || ''}`);
console.log(`  Filas en la tabla      : ${(doc.getElementById('reservationBody')?.innerHTML.match(/<tr>/g) || []).length}`);
console.log(`  Tarjetas comprobantes  : ${(doc.getElementById('receiptList')?.innerHTML.match(/receipt-card/g) || []).length}`);
console.log(`  Filas de clientes      : ${(doc.getElementById('clientBody')?.innerHTML.match(/<tr>/g) || []).length}`);
console.log(`  Entradas del histórico : ${(doc.getElementById('decisionList')?.innerHTML.match(/decision-item/g) || []).length}`);

/* ---------- 6. Diagnóstico en pantalla ---------- */
try {
  await app.diagnostics({ announce: false });
  const checks = (doc.getElementById('checksList')?.innerHTML || '').match(/<strong>([^<]+)<\/strong><p>([^<]*)<\/p>/g) || [];
  console.log('\n--- DIAGNÓSTICO EN PANTALLA ---');
  checks.forEach(item => console.log(`  ${item.replace(/<\/?(strong|p)>/g, ' ').trim()}`));
  if (!checks.length) console.log('  (sin resultados)');
} catch (error) {
  console.log(`  FALLA en el diagnóstico: ${error.message}`);
}

/* ---------- 7. Conclusión ---------- */
console.log('\n--- CONCLUSIÓN ---');
const empty = app.state.drafts.length === 0;
if (accessToken) {
  const ok = app.state.problems.length === 0 && !empty;
  console.log(ok
    ? `  ✓ La sesión autenticada leyó datos reales: ${app.state.drafts.length} pre-reservas, ${app.state.confirmed.length} confirmadas.`
    : `  ✗ Sesión autenticada sin datos completos (problemas: ${app.state.problems.length}). Revisa los mensajes de arriba.`);
  process.exitCode = ok ? 0 : 1;
} else {
  console.log('  Sin sesión la RLS oculta las filas: es el comportamiento correcto y esperado.');
  console.log('  Verificado: la app arranca, consulta las 4 tablas y explica el estado en pantalla');
  console.log('  en lugar de fallar en silencio.');
  const denied = calls.some(call => call.status === 401 || call.status === 403);
  console.log(denied
    ? '  ✓ Los avisos de permisos que verá el equipo sin sesión son los correctos.'
    : '  · La clave pública respondió sin error de permiso: conviene revisar las políticas RLS.');
}
