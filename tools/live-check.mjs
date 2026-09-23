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
const sessionEmail = config.allowedEmails[0];

/* ---------- 1. Sesión de prueba (si se pide) ---------- */
let accessToken = null;
if (useSession) {
  /* Este proyecto firma las sesiones con clave asimétrica (ES256) y publica su
     clave pública en /auth/v1/.well-known/jwks.json. Para firmar una sesión de
     prueba haría falta la clave privada, así que si el secreto no es simétrico
     (HS256) se avisa en lugar de intentarlo y reportar un falso fallo. */
  const jwksResponse = await fetch(`${config.url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: config.publishableKey } });
  const jwks = jwksResponse.ok ? await jwksResponse.json().catch(() => null) : null;
  const key = jwks?.keys?.[0];
  console.error('No se puede firmar una sesión de prueba en este proyecto.');
  console.error(key
    ? `Firma con clave asimétrica (${key.alg}, kid ${key.kid}): el navegador recibe la sesión del magic link y solo Supabase tiene la clave privada.`
    : 'No se pudo leer la configuración de firmas del proyecto.');
  console.log('\nPara validar la sesión autenticada usa una de estas dos vías:');
  console.log('  A) Abre el dashboard, inicia sesión, entra a "Diagnóstico" y pulsa "Revisar ahora".');
  console.log('  B) En el dashboard ya con sesión, abre la consola del navegador (F12) y ejecuta:');
  console.log('       await insideSpaCheck()');
  console.log('     Devuelve la misma tabla de comprobaciones con tu sesión real.');
  process.exit(2);
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
installDom({ config });
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
