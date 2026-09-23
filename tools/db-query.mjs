/* Consulta el catálogo del proyecto con la Management API (token sbp_).
 *
 *   node tools/db-query.mjs --token sbp_... "select ..."
 *   node tools/db-query.mjs --token sbp_... --file consulta.sql
 *
 * Es la vía para inspeccionar constraints, políticas, permisos y datos sin
 * depender de la contraseña de la base. No modifica nada por sí sola: ejecuta
 * exactamente el SQL que se le pase.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const ref = configSource.match(/https:\/\/([^.]+)\./)?.[1];
const args = process.argv.slice(2);
const token = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.SUPABASE_ACCESS_TOKEN;
const sql = args.includes('--file')
  ? readFileSync(join(root, args[args.indexOf('--file') + 1]), 'utf8')
  : args.filter((arg, index) => !arg.startsWith('--') && index !== args.indexOf('--token') + 1).join(' ');

if (!token || !sql.trim()) {
  console.error('Uso: node tools/db-query.mjs --token sbp_... "select ..."');
  process.exit(2);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql })
});
const text = await response.text();
if (response.status >= 400) {
  console.error(`ERROR ${response.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
