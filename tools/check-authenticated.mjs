/* Comprueba qué ve el dashboard con una sesión autenticada real.
 *
 *   node tools/check-authenticated.mjs
 *
 * Firma un JWT de prueba con el secreto del proyecto (rol `authenticated` y uno
 * de los correos autorizados) y consulta las 4 tablas tal como lo hará el
 * navegador del equipo. Así se valida de verdad la cadena GRANT + RLS, que la
 * service_role key no puede comprobar porque salta las políticas.
 *
 * El secreto JWT se lee de .env.local (SUPABASE_JWT_SECRET) o se deriva de la
 * service_role key (el campo `iss` no es el secreto, así que se pide explícito).
 * Si no hay secreto, solo se informa de lo que falta.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const getEnv = name => env.match(new RegExp(`${name}=(\\S+)`))?.[1] || process.env[name] || null;

const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const url = configSource.match(/url:\s*'([^']+)'/)?.[1];
const publishableKey = configSource.match(/publishableKey:\s*'([^']+)'/)?.[1];
const allowedEmails = [...configSource.matchAll(/'([^']+@[^']+)'/g)].map(match => match[1]);
const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
const jwtSecret = getEnv('SUPABASE_JWT_SECRET');

const TABLES = ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions'];
const base64url = value => Buffer.from(value).toString('base64url');

if (!jwtSecret) {
  console.log('\n=== COMPROBACIÓN CON SESIÓN AUTENTICADA ===');
  console.log('Falta el secreto JWT del proyecto para poder firmar una sesión de prueba.');
  console.log('\nDónde encontrarlo: Supabase → Project Settings → API → JWT Settings → "JWT Secret".');
  console.log('Añádelo a .env.local (ignorado por git):');
  console.log('   SUPABASE_JWT_SECRET=<secreto>');
  console.log('\nAlternativa sin secreto: abre el dashboard, inicia sesión y entra en la');
  console.log('sección "Diagnóstico" → ahí se valida lo mismo con tu sesión real.');
  process.exit(0);
}

async function signedToken({ email, role = 'authenticated' }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: 'supabase', ref: url.match(/https:\/\/([^.]+)\./)?.[1], role, email, aud: 'authenticated', iat: now, exp: now + 3600 };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', jwtSecret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

const email = allowedEmails[0];
console.log('\n=== COMPROBACIÓN CON SESIÓN AUTENTICADA ===');
console.log(`Proyecto : ${url}`);
console.log(`Correo   : ${email}`);
console.log(`Rol      : authenticated\n`);

const token = await signedToken({ email });
const headers = { apikey: publishableKey, Authorization: `Bearer ${token}` };
let failures = 0;

for (const table of TABLES) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no json */ }
  const ok = response.status === 200;
  if (!ok) failures += 1;
  const detail = ok ? `${Array.isArray(body) ? `${body.length} fila(s) visibles` : 'ok'}` : `${body?.code || ''} ${body?.message || text.slice(0, 120)}`;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${table.padEnd(34)} ${detail}`);
}

/* Prueba de escritura: el RPC de decisiones debe aceptar la sesión y rechazar
   una reserva inexistente (así se comprueba autorización + permisos sin tocar datos). */
const rpc = await fetch(`${url}/rest/v1/rpc/process_dashboard_reservation_decision`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_reservation_draft_id: -1, p_action: 'needs_info', p_note: 'comprobacion-tecnica' })
});
const rpcText = await rpc.text();
if (rpc.status >= 400 && /does not exist|no existe/i.test(rpcText)) {
  console.log(`OK   ${'RPC de decisiones'.padEnd(34)} existe y autoriza la sesión`);
} else if (rpc.status >= 400 && /not authorized/i.test(rpcText)) {
  failures += 1;
  console.log(`FALLA ${'RPC de decisiones'.padEnd(34)} la sesión no está autorizada: ${rpcText.slice(0, 120)}`);
} else if (rpc.status >= 400 && /could not find the function/i.test(rpcText)) {
  console.log(`AVISO ${'RPC de decisiones'.padEnd(34)} la función no existe todavía: hay que ejecutar el SQL`);
} else {
  console.log(`${rpc.status >= 400 ? 'AVISO' : 'OK  '} ${'RPC de decisiones'.padEnd(34)} HTTP ${rpc.status}: ${rpcText.slice(0, 140)}`);
}

console.log(`\n${failures ? `${failures} tabla(s) sin acceso para la sesión autenticada.` : 'La sesión autenticada puede leer las 4 tablas.'}`);
if (failures) console.log('Solución: ejecuta supabase/APLICAR_EN_SUPABASE.sql en el SQL Editor.');
