/* Vista previa de la tarjeta "Pre-reservas con fecha de hoy" con datos reales.
 *
 *   node tools/preview-today-card.mjs
 *
 * Lee la base real, ejecuta el render del dashboard y escribe un HTML con los
 * estilos del proyecto para poder revisar la tarjeta en el navegador.
 * Salida: .vendor/tarjeta-hoy.html
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { installDom, readSupabaseConfig } from './dom-mock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, '.vendor');
if (!existsSync(vendor)) mkdirSync(vendor, { recursive: true });

const config = readSupabaseConfig();
const serviceKey = readFileSync(join(root, '.env.local'), 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(\S+)/)?.[1];
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const fetchTable = async table => (await fetch(`${config.url}/rest/v1/${table}?select=*&limit=500`, { headers })).json();

const domain = await import(pathToFileURL(join(root, 'js/domain.js')).href);
const [rawDrafts, rawConfirmed] = await Promise.all([fetchTable('reservas_draft'), fetchTable('reservas')]);
const drafts = rawDrafts.map(domain.normalizeDraft);
const confirmed = rawConfirmed.map(domain.normalizeConfirmed);

const dom = installDom({ config });
const view = await import(pathToFileURL(join(root, 'js/view.js')).href);
view.renderOccupancy({ drafts, confirmed });

/* El CSS del proyecto + el bloque nuevo de la tarjeta. */
const styles = readFileSync(join(root, 'styles.css'), 'utf8');
const dashboard = readFileSync(join(root, 'dashboard.css'), 'utf8');
const cardMarkup = `<article class="occupancy-card" id="occupancyCard">
  <div><h3>Pre-reservas con fecha de hoy</h3></div>
  <div class="circle-progress"><span id="occupancyRatio">${dom.markup('occupancyRatio')}</span></div>
</article>`;

const html = `<!doctype html>
<html lang="es"><head><meta charset="UTF-8"><title>Tarjeta · Pre-reservas de hoy</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
<style>${styles}</style><style>${dashboard}</style>
<style>body{background:#f8f7f5;padding:24px}.right-column{max-width:320px}</style>
</head><body><div class="right-column">${cardMarkup}</div></body></html>`;

writeFileSync(join(vendor, 'tarjeta-hoy.html'), html, 'utf8');
console.log('Vista previa escrita en .vendor/tarjeta-hoy.html');
console.log('Contenido de la tarjeta:', cardMarkup.replace(/\n\s*/g, ' '));
