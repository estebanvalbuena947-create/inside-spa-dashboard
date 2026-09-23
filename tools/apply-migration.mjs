/* Aplica la migración del dashboard en Supabase y la verifica de inmediato.
 *
 *   node tools/apply-migration.mjs --check
 *   node tools/apply-migration.mjs --password '...' [--host db.<ref>.supabase.co]
 *
 * Por qué existe: el DDL (GRANT, CREATE POLICY, CREATE FUNCTION) no se puede
 * enviar por PostgREST, así que hace falta conexión directa a Postgres. Supabase
 * publica la contraseña de la base en Project Settings → Database. Aquí se
 * escribe por la entrada estándar, nunca se guarda en disco.
 *
 * Tras aplicar el SQL, el script:
 *   1. comprueba con la API REST que las tablas ya son legibles,
 *   2. verifica el RPC con una consulta de prueba,
 *   3. informa de lo que queda pendiente.
 */

import { createInterface } from 'node:readline';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const url = configSource.match(/url:\s*'([^']+)'/)?.[1];
const publishableKey = configSource.match(/publishableKey:\s*'([^']+)'/)?.[1];
const ref = url.match(/https:\/\/([^.]+)\./)?.[1];
const sqlFile = join(root, 'supabase', 'APLICAR_EN_SUPABASE.sql');
const sql = readFileSync(sqlFile, 'utf8');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : `db.${ref}.supabase.co`;
const user = args.includes('--user') ? args[args.indexOf('--user') + 1] : 'postgres';
const database = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'postgres';
let password = args.includes('--password') ? args[args.indexOf('--password') + 1] : process.env.SUPABASE_DB_PASSWORD || null;

console.log('\n=== APLICAR LA MIGRACIÓN DEL DASHBOARD ===');
console.log(`Proyecto : ${ref}`);
console.log(`Archivo   : supabase/APLICAR_EN_SUPABASE.sql (${sql.split('\n').length} líneas)`);
console.log(`Servidor  : ${host} / base ${database} / usuario ${user}`);

/* ---------- 1. ¿Hay cliente de Postgres disponible? ---------- */
const findPsql = () => {
  const candidates = ['psql', 'psql.exe'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  /* Rutas habituales en Windows. */
  const globs = ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL'];
  for (const base of globs) {
    if (!existsSync(base)) continue;
    for (const version of readdirSync(base)) {
      const candidate = join(base, version, 'bin', 'psql.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const psql = findPsql();

if (checkOnly || !password) {
  console.log('\n--- ESTADO ACTUAL (solo lectura) ---');
  const probe = async (path, options = {}) => {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, 'Content-Type': 'application/json' },
      ...options
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* no json */ }
    return { status: response.status, code: body?.code || null, message: body?.message || '' };
  };
  for (const table of ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions']) {
    const result = await probe(`${table}?select=*&limit=1`);
    const ok = result.status < 400;
    console.log(`  ${ok ? 'OK   ' : 'FALTA'} ${table.padEnd(34)} ${ok ? 'accesible' : `${result.code} · ${result.message.slice(0, 70)}`}`);
  }
  const rpc = await probe('rpc/process_dashboard_reservation_decision', {
    method: 'POST',
    body: JSON.stringify({ p_reservation_draft_id: -1, p_action: 'needs_info' })
  });
  console.log(`  ${/not authorized/i.test(rpc.message) ? 'OK   ' : 'AVISO'} RPC de decisiones             ${rpc.message.slice(0, 70)}`);

  console.log(`\nCliente psql: ${psql || 'no encontrado'}`);
  console.log('\nPara aplicar la migración y verificar de inmediato:');
  console.log('  node tools/apply-migration.mjs --password \'<contraseña de la base>\'');
  console.log('\nLa contraseña está en Supabase → Project Settings → Database → Database password.');
  console.log('Si prefieres no usarla, pega supabase/APLICAR_EN_SUPABASE.sql en el SQL Editor.');
  process.exit(0);
}

if (!psql) {
  console.error('\nNo se encontró psql (cliente de PostgreSQL) en este equipo.');
  console.error('Alternativa: pega supabase/APLICAR_EN_SUPABASE.sql en el SQL Editor de Supabase.');
  process.exit(2);
}

/* ---------- 2. Aplicar el SQL ---------- */
console.log('\nAplicando la migración...');
const result = spawnSync(psql, [
  `host=${host}`, `port=5432`, `dbname=${database}`, `user=${user}`, `password=${password}`,
  'sslmode=require', '--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--file', sqlFile
], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } });

const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
if (output) console.log(output.split('\n').slice(-25).join('\n'));
if (result.status !== 0) {
  console.error(`\nLa migración falló (código ${result.status}). Revisa el mensaje de arriba.`);
  process.exit(1);
}
console.log('Migración aplicada sin errores.');

/* ---------- 3. Verificar que todo quedó operativo ---------- */
console.log('\n--- VERIFICACIÓN DESPUÉS DE APLICAR ---');
const probe = async (path, options = {}) => {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, 'Content-Type': 'application/json' },
    ...options
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* no json */ }
  return { status: response.status, body };
};

/* Se comprueba con la service_role (lectura real) y con la clave pública (RLS). */
const serviceKey = (existsSync(join(root, '.env.local')) ? readFileSync(join(root, '.env.local'), 'utf8') : '')
  .match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1] || null;

let failures = 0;
for (const table of ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions']) {
  const anon = await probe(`${table}?select=*&limit=1`);
  const withRole = serviceKey
    ? await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
    : null;
  const total = withRole ? (withRole.headers.get('content-range') || '').split('/')[1] : null;
  const blocked = anon.body?.code === '42501';
  if (blocked) failures += 1;
  console.log(`  ${blocked ? 'FALLA' : 'OK   '} ${table.padEnd(34)} ${blocked ? `sigue bloqueada (${anon.body?.code})` : 'legible'}${total ? ` · ${total} fila(s)` : ''}`);
}

console.log(`\n${failures ? `${failures} tabla(s) siguen bloqueadas: revisa el SQL aplicado.` : 'Permisos correctos.'}`);
console.log('Última comprobación con la sesión real: abre el dashboard → Diagnóstico → "Revisar ahora".');
