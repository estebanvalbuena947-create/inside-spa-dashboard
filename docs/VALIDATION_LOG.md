# Validación y publicación — 20 de octubre de 2026

## Cambios publicados

- `js/domain.js`: cancelaciones por vencimiento fuera de gestión; creación real y KPIs por día.
- `js/data.js`: lectura aditiva de `created_at` con compatibilidad previa a migración.
- `js/main.js`: recálculo al filtrar, persistencia de selección al refrescar y CSV vacío correcto.
- `js/view.js`, `index.html`: fecha en Ciudad de México y aviso por creación desconocida.
- `tools/verify.mjs`, `tools/smoke.mjs`, `tools/check-creation-date.mjs`: regresiones.
- Especificaciones, planes, decisiones y README actualizados. Referencias de módulos: `2.0.2`.

## SPA

Migración `20261020205736_reservation_draft_created_at` aplicada con aprobación del usuario.
Se verificó `created_at timestamptz`, nullable, default `now()` y permiso de lectura para
`authenticated`. Las 14 filas históricas conservaron NULL; no se inventaron fechas.
La secuencia de creación se probó previamente en tabla temporal con rollback: filas existentes
sin fecha, inserción con default y actualización conservando el timestamp.
El informe de seguridad no cambió respecto al previo; no se modificaron políticas ni permisos.

La lectura real mediante `loadDashboard` devolvió 14 borradores, 14 sin creación y cero avisos
de esquema. En esa lectura había 8 por gestionar sin filtro; al filtrar hoy, cero con creación
conocida. Son valores observados, no constantes del producto.

## Controles

- `node --test tools/check-creation-date.mjs`: 9 pruebas; también pasan con `TZ=Asia/Tokyo`.
- `node tools/verify.mjs`: 90 comprobaciones.
- `node tools/smoke.mjs`: 41 pasos, incluida exportación vacía.
- `node tools/e2e.mjs`: 43 comprobaciones con SDK oficial y backend local simulado.
- `node --check` y `git diff --check`: sin fallos. Sitio estático sin controles pnpm de tipos/lint/formato.
- `node tools/e2e-deployed.mjs`: 12 comprobaciones del código publicado, con backend local simulado.

Vercel confirmó éxito para el commit `2462c57321645bcbde68eca00a61dd37f8afe891`.
Los cinco archivos de producción modificados respondieron HTTP 200 y coincidieron con la versión
publicada, normalizando únicamente finales de línea. La publicación excluyó el commit local previo
de acceso `8e53ca4`, ajeno a esta corrección; permanece intacto en la carpeta original.

Sitio: https://inside-spa-dashboard.vercel.app

## Límites y uso

Las fechas históricas siguen siendo desconocidas: consultar esas filas con el calendario vacío.
Para recuperar su creación se necesita una fuente histórica fiable. Escritores que envíen NULL
explícitamente no reciben el default y se mostrarán como fecha desconocida. El tope de lectura
de 500 filas sigue vigente. No hubo comprobación visual en navegador ni decisiones de prueba
sobre reservas reales. Rollback de UI: restaurar la versión anterior conservando la columna y datos.
