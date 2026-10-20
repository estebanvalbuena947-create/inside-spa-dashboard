# Filtro por creación real de prereservas

- Fecha: 2026-10-20.
- Diseño funcional aprobado por el usuario con «hazlo».
- Propietario: `js/domain.js`; lectura en `js/data.js`; presentación en `js/main.js` y `js/view.js`.

## Regla

La creación procede exclusivamente de `created_at`, `creado_at` o `fecha_creacion`.
No se sustituye por revisión, actualización, cita ni vencimiento. Las comparaciones usan
`America/Mexico_City`, incluso con navegador en otra zona. Al elegir fecha, el conteo operativo
y su monto pendiente usan el mismo día de creación que la tabla. Búsqueda, servicio y estado
siguen siendo filtros adicionales de la tabla. Las confirmaciones e ingresos de hoy conservan
su propia fecha de confirmación y sus etiquetas actuales.

Sin fecha seleccionada se muestran todas las prereservas; sin creación conocida se muestra
«Sin fecha de creación». Estas filas se excluyen de días concretos y un aviso indica su cantidad.
Una exportación vacía sigue vacía y exporta solo los resultados visibles.

## Hallazgo y migración necesaria

La consulta de `information_schema.columns` en SPA confirmó que `reservas_draft` no tiene columna
de creación. Se prepara una migración aditiva: añadir `created_at timestamptz` nullable sin default,
y después configurar `now()` para inserciones futuras. Así no se asigna la fecha de la migración
a las filas históricas. No se recupera historia sin una fuente fiable. El usuario aprobó el diseño de datos y la publicación. La migración fue aplicada en SPA el
20 de octubre: las 14 filas preexistentes conservaron NULL y el default de nuevas filas es now().

La lectura solicita la columna nueva de forma compatible mediante el fallback existente a `*`.
El aviso por fecha ausente permanece visible. La falta de columna no bloquea la operación antigua.

## Riesgos, compatibilidad y rollback

Las filas históricas se verán solo sin filtro de día hasta una recuperación documentada.
Los escritores que omiten la columna reciben el default; enviar NULL explícitamente conserva
NULL y se señala como fecha desconocida. Una actualización no cambia el default de creación.
No cambian permisos, decisiones ni workflows. El límite de lectura de 500 filas continúa vigente.
Rollback de UI: restaurar sus archivos, conservando la columna y las fechas ya capturadas.
Si hubiera que detener la captura, retirar el default sin borrar datos históricos.

## Aceptación

- Creación y revisión en días distintos: filtro y celda usan creación.
- Medianoche mexicana, navegador en otra zona, fecha ausente o inválida y día sin resultados.
- Contador y monto operativo se actualizan al cambiar o limpiar la fecha y al refrescar.
- La corrección de cancelaciones se conserva con o sin fecha seleccionada.
- Sintaxis, dominio, render e integración local verificados; migración remota verificada y publicación autorizada.
