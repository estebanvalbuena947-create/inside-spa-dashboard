/* Explora qué vías de escritura están disponibles en el proyecto Supabase.
 *
 *   node tools/probe-admin.mjs
 *
 * Prueba, sin modificar nada:
 *   1. Si la service_role key sirve en la Management API (endpoint de consultas).
 *   2. Si existe una contraseña de base de datos en el entorno para conectar por
 *      TCP al pooler (5432/6543).
 *   3. Qué endpoints de la Management API aceptan esa credencial.
 * Solo informa: no ejecuta DDL.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1] || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const configSource = readFileSync(join(root, 'supabase-config.js'), 'utf8');
const url = configSource.match(/url:\s*'([^']+)'/)?.[1];
const ref = url?.match(/https:\/\/([^.]+)\./)?.[1];

console.log('\n=== VÍAS DISPONIBLES PARA ESCRIBIR EN LA BASE ===');
console.log(`Proyecto: ${ref}`);
console.log(`service_role key: ${serviceKey ? 'presente' : 'AUSENTE'}\n`);

/* 1. Management API con la service_role key. */
const endpoints = [
  [`https://api.supabase.com/v1/projects/${ref}/database/query`, 'POST', { query: 'select 1 as ok' }],
  [`https://api.supabase.com/v1/projects/${ref}`, 'GET', null],
  [`https://api.supabase.com/v1/projects`, 'GET', null]
];
for (const [endpoint, method, body] of endpoints) {
  try {
    const response = await fetch(endpoint, {
      method,
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = (await response.text()).slice(0, 120);
    console.log(`${String(response.status).padEnd(4)} ${method} ${endpoint.replace('https://api.supabase.com', '')} → ${text}`);
  } catch (error) {
    console.log(`ERR  ${method} ${endpoint} → ${error.message}`);
  }
}

/* 2. ¿Hay contraseña de base de datos en el entorno o en los archivos de credenciales? */
const passwordVars = ['SUPABASE_DB_PASSWORD', 'DATABASE_URL', 'POSTGRES_PASSWORD', 'SUPABASE_DB_URL'];
const found = passwordVars.filter(name => env.includes(name) || process.env[name]);
console.log(`\nContraseñas de base en .env.local: ${found.length ? found.join(', ') : 'ninguna'}`);

/* 3. ¿Responde el pooler por TCP? (solo para saber si sería alcanzable) */
const hosts = [
  { host: `aws-0-us-east-1.pooler.supabase.com`, port: 6543 },
  { host: `aws-0-us-west-1.pooler.supabase.com`, port: 6543 },
  { host: `db.${ref}.supabase.co`, port: 5432 }
];
const tcpCheck = (host, port) => new Promise(resolvePromise => {
  const socket = createConnection({ host, port });
  const done = reachable => { socket.destroy(); resolvePromise(reachable); };
  socket.setTimeout(6000);
  socket.on('connect', () => done(true));
  socket.on('timeout', () => done(false));
  socket.on('error', () => done(false));
});
console.log('\nAlcanzabilidad TCP (para conectar con la contraseña de la base):');
for (const { host, port } of hosts) {
  console.log(`  ${(await tcpCheck(host, port)) ? 'alcanzable' : 'sin respuesta'}  ${host}:${port}`);
}

console.log('\nResumen:');
console.log('  · Con la service_role key se puede LEER y escribir vía PostgREST (RLS saltada).');
console.log('  · El DDL (GRANT, CREATE POLICY, CREATE FUNCTION) NO se puede enviar por PostgREST.');
console.log('  · Para aplicarlo hace falta: token personal sbp_ (Management API), la contraseña');
console.log('    de la base, o ejecutar el SQL en el editor de Supabase.');
