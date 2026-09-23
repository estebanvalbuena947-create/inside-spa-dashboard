/* Descarga la librería oficial de Supabase (y sus dependencias) desde el CDN a
 * un directorio local, reescribiendo los imports para que Node pueda cargarla
 * desde disco. Sirve para validar el dashboard con la librería REAL, ya que Node
 * no permite importar módulos por HTTP.
 *
 *   node tools/vendor-sdk.mjs            # descarga (por defecto en .vendor/)
 *   node tools/vendor-sdk.mjs --clean    # borra la copia local
 *
 * La carpeta .vendor/ está ignorada por git: es material de pruebas.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.vendor');
const VERSION = '2.116.0';
const ORIGIN = 'https://cdn.jsdelivr.net';
const ENTRY = `/npm/@supabase/supabase-js@${VERSION}/+esm`;

if (process.argv.includes('--clean')) {
  rmSync(outDir, { recursive: true, force: true });
  console.log('Copia local de la librería eliminada.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const downloaded = new Map();

/* Convierte una ruta del CDN en un nombre de archivo local estable. */
const localName = path => path.replace(/^\/npm\//, '').replace(/[\/@+]/g, '_').replace(/\.mjs$/, '') + '.mjs';

async function grab(path, depth = 0) {
  if (downloaded.has(path)) return downloaded.get(path);
  const url = ORIGIN + path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar ${url} (HTTP ${response.status})`);
  let source = await response.text();

  /* Reescribe los imports a rutas locales, descargando cada dependencia. */
  const specs = [...new Set([...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]))];
  for (const spec of specs) {
    if (spec.startsWith('/npm/')) {
      const childPath = await grab(spec, depth + 1);
      const relative = `./${childPath.split(/[\\/]/).pop()}`;
      source = source.split(`"${spec}"`).join(`"${relative}"`).split(`'${spec}'`).join(`'${relative}'`);
    } else if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      /* Dependencia sin bundle (por ejemplo @supabase/supabase-js/tracing):
         se descarga desde el CDN como ESM. */
      const cdnPath = `/npm/${spec}/+esm`;
      if (!downloaded.has(cdnPath)) {
        try {
          const childPath = await grab(cdnPath, depth + 1);
          const relative = `./${childPath.split(/[\\/]/).pop()}`;
          source = source.split(`"${spec}"`).join(`"${relative}"`).split(`'${spec}'`).join(`'${relative}'`);
        } catch (error) {
          /* Si no existe como ESM se deja tal cual: la librería lo importa de forma opcional. */
          if (depth === 0) console.log(`  aviso: ${spec} no está disponible como ESM (${error.message.slice(0, 60)})`);
        }
      }
    }
  }

  source = source.replace(/\/\/# sourceMappingURL=.*$/m, '');
  const name = localName(path);
  writeFileSync(join(outDir, name), source, 'utf8');
  console.log(`  ${name.padEnd(52)} ${String(source.length).padStart(7)} bytes  (${url.replace(ORIGIN, '')})`);
  downloaded.set(path, name);
  return name;
}

console.log(`Descargando la librería oficial @supabase/supabase-js@${VERSION} y sus dependencias...`);
const entryFile = await grab(ENTRY);
writeFileSync(join(outDir, 'entry.mjs'), `export * from './${entryFile}';\nexport { createClient } from './${entryFile}';\n`, 'utf8');
console.log(`\nListo: ${downloaded.size + 1} archivo(s) en .vendor/`);
console.log(`Entrada local: ${join('.vendor', 'entry.mjs')}`);

/* Verificación inmediata: que Node pueda importar la librería desde disco. */
try {
  const module = await import(`${new URL(`file://${join(outDir, 'entry.mjs').replace(/\\/g, '/')}`).href}`);
  console.log(`Verificación: createClient ${typeof module.createClient === 'function' ? 'disponible ✓' : 'NO disponible ✗'}`);
} catch (error) {
  console.log(`Verificación fallida: ${error.message}`);
  process.exitCode = 1;
}
void existsSync;
void readFileSync;
