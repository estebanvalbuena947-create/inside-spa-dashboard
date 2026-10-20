# Plan: creación real y conteo por día

1. Confirmar columnas reales en SPA mediante consulta de metadatos, sin datos personales.
2. Crear pruebas de regresión para fecha real, medianoche, ausencias y actualización del contador.
3. Normalizar creación sin fallback temporal y centralizar selección de día en dominio.
4. Solicitar la columna de creación con lectura compatible, sincronizar contador y tabla,
   mostrar ausencia de fecha y respetar los resultados vacíos al exportar.
5. Preparar migración aditiva, sin backfill inventado; verificar semántica contra tabla temporal.
6. Ejecutar controles del sitio estático, revisar diff y documentar límites.
7. Solicitar aprobación del cambio de datos preparado antes de aplicarlo a SPA.

El usuario autorizó la corrección funcional. La ausencia de fecha en origen descubre un cambio
de datos adicional que quedó preparado y revisable antes de la aprobación. El usuario aprobó después aplicar la migración y publicar. La migración se aplicó a SPA;
se verificaron tipo, default y conservación de las 14 filas históricas sin fecha.
Los controles disponibles son `node tools/verify.mjs`, `node tools/smoke.mjs`,
`node tools/e2e.mjs`, `node --check` y `git diff --check`. No existe package.json ni configuración
de lint, formato o TypeScript en este sitio; no corresponden los comandos pnpm del chat.
