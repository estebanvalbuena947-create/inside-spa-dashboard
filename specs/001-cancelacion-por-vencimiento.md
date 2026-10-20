# Cancelación por vencimiento en el conteo operativo

- Fecha: 2026-10-20.
- Estado: diseño aprobado por el usuario; implementado localmente.
- Propietario: `js/domain.js`.

## Regla y evidencia

`cancelando_expirada` indica que el workflow inició una cancelación automática sin pago.
No representa una espera de pago ni una revisión pendiente del equipo. Debe mostrarse como
«Cancelación por vencimiento» dentro del grupo existente `rejected`, fuera de `MANAGE_STATUSES`.
No se declara que la cancelación externa haya terminado.

La consulta agregada de SPA del 20 de octubre encontró 14 borradores: 6 en revisión de pago,
2 pendientes de pago, 2 creando retención, 3 cancelando por vencimiento y 1 confirmado.
La versión publicada desconocía el estado de cancelación y calculaba 13 por gestionar, en vez de 10.
Los números describen esa lectura; no son valores fijos del producto.

Se conserva la prioridad existente: confirmación > última decisión > estado de la tabla.
No se infiere una cancelación por la fecha de vencimiento: una revisión con retención vencida
sigue siendo revisión. Se mantiene la normalización de mayúsculas y espacios.

## Aceptación

- Cancelaciones no suman en pendientes, por gestionar, monto pendiente ni alertas de retención.
- Su etiqueta es visible y pueden consultarse con el filtro existente de rechazadas.
- Estados operativos, confirmaciones y decisiones conservan su comportamiento.
- Pruebas de dominio y render reproducen la diferencia sin información de clientes.

## Compatibilidad y límites

No hay migraciones, cambios de permisos, dependencias ni escrituras de reservas. Los módulos
modificados se publicarán con versión `2.0.2` para renovar las referencias de caché; el módulo
compartido de fechas conserva su versión para evitar instancias diferentes de la zona horaria.
Los estados desconocidos y el límite de lectura de 500 filas permanecen fuera de este alcance.
Rollback: restaurar los archivos del cambio y sus referencias de versión. Publicación autorizada.
