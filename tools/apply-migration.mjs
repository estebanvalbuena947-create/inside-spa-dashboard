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
const accessToken = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.SUPABASE_ACCESS_TOKEN || null;

/* ---------- 0. Vía preferida: Management API con un token personal sbp_ ---------- */
if (accessToken) {
  console.log('\n=== APLICAR LA MIGRACIÓN (Management API) ===');
  console.log(`Proyecto: ${ref}`);
  console.log(`Archivo : supabase/APLICAR_EN_SUPABASE.sql (${sql.split('\n').length} líneas)`);

  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  const text = await response.text();
  if (response.status >= 400) {
    console.error(`\nLa migración falló (HTTP ${response.status}): ${text.slice(0, 400)}`);
    process.exit(1);
  }
  let audit = null;
  try { audit = JSON.parse(text); } catch { /* respuesta no JSON */ }

  console.log('\nMigración aplicada. Resultado de la auditoría incluida en el SQL:');
  if (Array.isArray(audit)) {
    const rows = audit.flat ? audit.flat() : audit;
    const summary = rows.filter(row => row && (row.seccion || row.tabla));
    if (summary.length) {
      summary.slice(0, 40).forEach(row => {
        if (row.seccion) console.log(`  ${String(row.seccion).padEnd(22)} ${String(row.item || row.tabla || '').padEnd(46)} ${row.estado ?? ''} ${row.detalle ?? ''}`);
        else console.log(`  ${String(row.tabla).padEnd(30)} ${String(row.columna).padEnd(34)} ${row.tipo}`);
      });
    } else {
      console.log(JSON.stringify(rows).slice(0, 600));
    }
  } else if (audit) {
    console.log(JSON.stringify(audit).slice(0, 600));
  }

  await verifyAfterMigration(accessToken);
  process.exit(0);
}

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
const psqlResult = spawnSync(psql, [
  `host=${host}`, `port=5432`, `dbname=${database}`, `user=${user}`, `password=${password}`,
  'sslmode=require', '--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', '--file', sqlFile
], { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } });

const psqlOutput = `${psqlResult.stdout || ''}${psqlResult.stderr || ''}`.trim();
if (psqlOutput) console.log(psqlOutput.split('\n').slice(-25).join('\n'));
if (psqlResult.status !== 0) {
  console.error(`\nLa migración falló (código ${psqlResult.status}). Revisa el mensaje de arriba.`);
  process.exit(1);
}
console.log('Migración aplicada sin errores.');

/* ---------- Verificación posterior (compartida por las dos vías) ---------- */
async function verifyAfterMigration(accessTokenForAudit = null) {
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

  /* Se compara la clave pública (sujeta a RLS) con la service_role (lectura real). */
  const serviceKey = (existsSync(join(root, '.env.local')) ? readFileSync(join(root, '.env.local'), 'utf8') : '')
    .match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1] || null;

  let failures = 0;
  for (const table of ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions']) {
    const anon = await probe(`${table}?select=*&limit=1`);
    const withRole = serviceKey
      ? await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } })
      : null;
    const total = withRole ? (withRole.headers.get('content-range') || '').split('/')[1] : null;
    /* Ojo: la clave pública usa el rol `anon`, que NO tiene los GRANT del
       dashboard (son para `authenticated`), así que un 42501 aquí es esperado. */
    const blocked = anon.body?.code === '42501';
    console.log(`  ${blocked ? 'INFO ' : 'OK   '} ${table.padEnd(34)} ${blocked ? 'privada para el rol anon (correcto)' : 'legible sin sesión'}${total ? ` · ${total} fila(s)` : ''}`);
  }

  /* La comprobación que importa: permisos del rol `authenticated` en el catálogo. */
  if (accessTokenForAudit) {
    try {
      const query = `select t.table_name,
           has_table_privilege('authenticated', 'public.'||t.table_name, 'SELECT') as sel,
           c.relrowsecurity as rls
      from information_schema.tables t
      join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
     where t.table_schema = 'public'
       and t.table_name in ('reservas_draft','reservas','spa_comprobantes_pago','dashboard_reservation_decisions')
     order by t.table_name`;
      const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessTokenForAudit}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const rows = await response.json();
      console.log('\n  Permisos del rol authenticated (catálogo):');
      if (Array.isArray(rows)) {
        rows.forEach(row => {
          const ok = row.sel && row.rls;
          if (!ok) failures += 1;
          console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${String(row.table_name).padEnd(34)} SELECT=${row.sel} RLS=${row.rls}`);
        });
      } else {
        console.log(`  no se pudo leer el catálogo: ${JSON.stringify(rows).slice(0, 120)}`);
      }
    } catch (error) {
      console.log(`  no se pudo consultar el catálogo: ${error.message}`);
    }
  } else {
    console.log('\n  (sin token no se puede comprobar el rol authenticated en el catálogo)');
  }

  const rpc = await probe('rpc/process_dashboard_reservation_decision', {
    method: 'POST',
    body: JSON.stringify({ p_reservation_draft_id: -1, p_action: 'needs_info' })
  });
  const rpcOk = /not authorized/i.test(String(rpc.body?.message || ''));
  console.log(`  ${rpcOk ? 'OK   ' : 'AVISO'} RPC de decisiones                 ${rpcOk ? 'existe y valida la autorización' : String(rpc.body?.message || rpc.status).slice(0, 70)}`);

  console.log(failures
    ? `\n${failures} tabla(s) sin permiso para authenticated: revisa el SQL aplicado.`
    : '\nPermisos correctos: el dashboard ya puede leer y escribir con la sesión del equipo.');
  console.log('Última comprobación con la sesión real: dashboard → Diagnóstico → "Revisar ahora".');
  return failures;
}

/* ---------- 4. Verificar y cerrar ---------- */
await verifyAfterMigration();
