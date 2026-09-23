/* Verifica en el catálogo de Postgres que los permisos y políticas quedaron bien.
 *
 *   node tools/verify-grants.mjs --token sbp_...
 *
 * Consulta información privilegiada del proyecto (a través de la Management API)
 * para confirmar, tabla por tabla: GRANT para `authenticated`, RLS activa,
 * políticas creadas y firma del RPC. Es la comprobación que no se puede hacer
 * con la clave pública ni con la service_role.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const ref = configSource.match(/https:\/\/([^.]+)\./)?.[1];
const args = process.argv.slice(2);
const token = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('Falta el token personal: node tools/verify-grants.mjs --token sbp_...');
  process.exit(2);
}

const query = async sql => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
};

const tables = ['reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions'];
const quoted = tables.map(table => `'${table}'`).join(',');

console.log('\n=== VERIFICACIÓN DE PERMISOS Y POLÍTICAS ===\n');

const grants = await query(`
  select t.table_name,
         has_table_privilege('authenticated', 'public.'||t.table_name, 'SELECT') as sel,
         has_table_privilege('authenticated', 'public.'||t.table_name, 'INSERT') as ins,
         has_table_privilege('authenticated', 'public.'||t.table_name, 'UPDATE') as upd,
         c.relrowsecurity as rls
    from information_schema.tables t
    join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
   where t.table_schema = 'public' and t.table_name in (${quoted})
   order by t.table_name`);

console.log('--- PERMISOS DEL ROL authenticated ---');
let problems = 0;
grants.forEach(row => {
  const ok = row.sel && row.rls;
  if (!ok) problems += 1;
  console.log(`  ${ok ? 'OK   ' : 'FALLA'} ${row.table_name.padEnd(34)} SELECT=${row.sel} INSERT=${row.ins} UPDATE=${row.upd} RLS=${row.rls}`);
});
console.table(grants);

const policies = await query(`
  select tablename, policyname, cmd, array_to_string(roles, ', ') as roles
    from pg_policies
   where schemaname = 'public' and tablename in (${quoted})
   order by tablename, cmd`);
console.log('--- POLÍTICAS RLS ---');
policies.forEach(row => console.log(`  ${row.tablename.padEnd(34)} ${row.cmd.padEnd(7)} ${row.policyname}  [${row.roles}]`));
if (!policies.length) { problems += 1; console.log('  (no hay políticas: el dashboard no vería filas)'); }

const functions = await query(`
  select p.proname, pg_get_function_arguments(p.oid) as args, p.prosecdef as security_definer,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as puede_ejecutar
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('process_dashboard_reservation_decision','inside_spa_dashboard_emails')
   order by p.proname`);
console.log('\n--- FUNCIONES ---');
functions.forEach(row => console.log(`  ${row.proname.padEnd(40)} (${row.args}) · definer=${row.security_definer} · execute=${row.puede_ejecutar}`));
const rpc = functions.find(row => row.proname === 'process_dashboard_reservation_decision');
if (!rpc) { problems += 1; console.log('  FALLA: falta el RPC de decisiones'); }
else if (!rpc.puede_ejecutar) { problems += 1; console.log('  FALLA: el rol authenticated no puede ejecutar el RPC'); }

/* Los correos autorizados deben coincidir con supabase-config.js. */
const emails = await query('select public.inside_spa_dashboard_emails() as lista');
const allowed = configSource.match(/allowedEmails:\s*\[([^\]]+)\]/)?.[1].match(/'([^']+)'/g)?.map(item => item.replaceAll("'", '')) || [];
console.log('\n--- CORREOS AUTORIZADOS ---');
console.log(`  En la base:      ${(emails[0]?.lista || []).join(', ')}`);
console.log(`  En el dashboard: ${allowed.join(', ')}`);
const mismatched = allowed.filter(email => !(emails[0]?.lista || []).includes(email));
if (mismatched.length) { problems += 1; console.log(`  FALLA: no coinciden estos correos: ${mismatched.join(', ')}`); }
else console.log('  Coinciden.');

console.log(`\n${problems ? `${problems} problema(s) encontrado(s).` : 'Todo correcto: permisos, RLS, políticas, RPC y correos.'}`);
process.exitCode = problems ? 1 : 0;
