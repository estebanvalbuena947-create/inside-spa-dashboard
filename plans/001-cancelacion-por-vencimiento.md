# Plan aprobado: cancelación por vencimiento

El usuario aprobó el diseño el 20 de octubre de 2026: reconocer el estado de cancelación automática,
mostrar una etiqueta explícita y excluirlo del conteo operativo sin modificar la base.

1. Agregar regresiones de estados, cantidades, importes y alertas; comprobar que fallan antes del arreglo.
2. Corregir únicamente la traducción del estado en `js/domain.js`, conservando las prioridades.
3. Verificar el texto y conteo renderizados con una reserva sintética en cancelación.
4. Actualizar las referencias de caché, especificación, decisión y README.
5. Ejecutar verificación, prueba de humo, integración local, sintaxis y revisión del diff.

El código de lectura, los workflows, los comandos de decisión y los permisos no cambian.
Riesgo: confundir cancelación iniciada con completada. La etiqueta indica el proceso y conserva
el estado crudo para el detalle; no se escribe ningún estado externo.

Este repositorio es un sitio JavaScript estático, sin `package.json`, configuración de lint,
formato o TypeScript. Los comandos pnpm del repositorio del chat no son controles ejecutables aquí.
Se usan los controles existentes descritos en README y `node --check` para la sintaxis.
No se modifica el repositorio del chat. El despliegue está autorizado por el usuario.
