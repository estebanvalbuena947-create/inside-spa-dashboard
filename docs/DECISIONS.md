# Decisiones

## ADR-001 — Cancelaciones por vencimiento fuera de la gestión pendiente

- Fecha: 2026-10-20.
- Diseño aprobado por el usuario.

El workflow marca `cancelando_expirada` al iniciar la liberación automática sin pago.
El fallback a pendiente de pago inflaba el trabajo visible. La traducción pertenece al dominio,
no a los componentes ni a la lectura de datos.

Se representa con el grupo existente `rejected` y la etiqueta «Cancelación por vencimiento».
Así se excluye de los cálculos operativos existentes sin crear otro vocabulario público ni
afirmar que la cancelación externa finalizó. Se conserva la prioridad de confirmaciones y decisiones.
El filtro de rechazadas incluye estas filas; el detalle conserva el estado original.
No se deduce el estado a partir de la retención vencida. No hay escrituras remotas ni migración.

Validación local: 90 comprobaciones de `tools/verify.mjs`, 34 pasos de `tools/smoke.mjs`
y 43 comprobaciones de `tools/e2e.mjs`, contra un backend local simulado con el SDK oficial.
Las regresiones nuevas fallaron antes del cambio y pasan con la corrección. No se realizó una
verificación visual en navegador; la prueba de humo comprueba la etiqueta y el contador renderizados.
La publicación está autorizada por el usuario.

## ADR-002 — Creación real, ausencias explícitas y contador por día

- Fecha: 2026-10-20.
- Corrección funcional autorizada; migración de datos aprobada y aplicada en SPA.

La base SPA no contiene creación en `reservas_draft`, comprobado con `information_schema.columns`.
La revisión del comprobante cambia durante la operación, por lo que no se usa como creación.
El dominio conserva solo timestamps de creación explícitos y aplica el día de Ciudad de México.
`buildKpis` conserva el mapa completo de estados para el detalle, pero filtra su conjunto operativo
por creación para conteos, monto pendiente y alertas. El calendario provoca recálculo y render
inmediatos; el refresco de red conserva esa selección. Los filtros de búsqueda, servicio y estado
se aplican adicionalmente a la tabla; las confirmaciones de hoy mantienen su criterio previo.

La lectura pide `created_at` como campo aditivo y conserva el fallback a `*` con aviso de esquema
en bases sin migrar. Las celdas y exportación muestran solo creación; el listado informa cuántas
filas no tienen fecha y las excluye de días específicos. Exportar cero resultados no exporta toda
la base por accidente. El texto y hora de creación usan la misma zona del filtro.

La migración agrega columna nullable primero y después default `now()`, sin backfill. En una
tabla temporal transaccional se verificó que una fila preexistente queda NULL, una nueva toma el
default y una actualización conserva su timestamp; se hizo rollback sin cambios operativos.
No demuestra compatibilidad completa con todos los escritores externos. Un escritor que envía
NULL explícitamente no recibe el default; queda visible como ausencia. No hay trigger que modifique
datos históricos ni recuperación de historia inferida.

Controles: 9 pruebas específicas (repetidas con `TZ=Asia/Tokyo`), 90 comprobaciones de dominio y
estructura, 41 pasos de render con DOM simulado y 43 de integración local con SDK oficial.
No hubo revisión visual en navegador; se comprobaron el texto de ausencia, la selección y el contador
renderizados. El límite de 500 filas sigue vigente. No existe tooling de tipos/lint/formato en este
sitio estático. Migración aplicada y publicación autorizada; rollback de UI conserva la columna y sus datos.
