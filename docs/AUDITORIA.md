# Informe de auditoría · Dashboard de reservas Inside Spa

Fecha: 23 de septiembre de 2026
Proyecto Supabase auditado: `ncutewymydclypuqlbfk` (SPA)
Producción: https://inside-spa-dashboard.vercel.app

## 1. Cómo está conectado GitHub

| Pieza | Estado |
| --- | --- |
| Repositorio | `estebanvalbuena947-create/inside-spa-dashboard` (rama `main`) |
| Publicación | Vercel conectado al repositorio: cada `push` a `main` publica solo |
| Build | Ninguno: son archivos estáticos (HTML + CSS + módulos ES) |
| Proyecto Supabase | `ncutewymydclypuqlbfk` (`https://ncutewymydclypuqlbfk.supabase.co`) |
| Clave del navegador | `sb_publishable_...` (pública por diseño) + RLS |
| Acceso | Magic link de Supabase Auth, correos permitidos en `supabase-config.js` |

Verificación hecha: `https://inside-spa-dashboard.vercel.app` responde 200 y sirve el dashboard,
y el commit local `988851f` está en GitHub, así que la cadena GitHub → Vercel funciona.

## 2. Qué estaba roto (encontrado con auditoría real)

| # | Problema | Evidencia | Impacto |
| --- | --- | --- | --- |
| 1 | `spa_comprobantes_pago` sin `GRANT SELECT` | `42501 permission denied for table spa_comprobantes_pago` | El dashboard no podía leer ningún comprobante |
| 2 | `monto_pagado` de `reservas_draft` es `null` en las 18 filas | consulta con `service_role` | El valor siempre salía vacío aunque el comprobante tuviera monto |
| 3 | El monto real vive en `comprobante_revision_datos` (JSONB) | `monto_documento: 1000` en 8 de 9 pre-reservas con evidencia | El dashboard no veía el ingreso real |
| 4 | Ocupación y variaciones inventadas en el HTML | `72%`, `13/18`, `↑ 12% vs. ayer`, fecha fija | Datos falsos mostrados al equipo |
| 5 | Estados reales no reconocidos: `creando_retencion`, `expirado_sin_pago` | conteo por `estado_reserva` | Reservas mal clasificadas |
| 6 | Filtro por día con desfase de zona horaria | `toISOString()` sobre fecha local | "Hoy" se calculaba con el día equivocado |
| 7 | Estados del menú `Comprobantes` y `Clientes` sin sección | `index.html` | Enlaces que no llevaban a ninguna parte |
| 8 | Sin diagnóstico ni manejo claro de errores | — | Errores silenciosos: el panel se veía en ceros |

## 3. Datos reales hoy (23 sep 2026)
| Tabla | Filas |
| --- | --- |
| `reservas_draft` (pre-reservas) | 18 |
| `reservas` (confirmadas) | 10 |
| `spa_comprobantes_pago` | 14 |
| `dashboard_reservation_decisions` | 0 (aún sin decisiones) |

Estados reales de las pre-reservas:

| Estado | Reservas | Se muestra como |
| --- | --- | --- |
| `requiere_revision_pago` | 8 | Por revisar |
| `pendiente_pago` | 6 | Pendiente de pago |
| `creando_retencion` | 1 | En confirmación |
| `confirmado` | 1 | Confirmada |
| `requiere_revision` | 1 | Por revisar |
| `expirado_sin_pago` | 1 | Rechazada o expirada |

KPIs calculados con esos datos reales (misma lógica del dashboard):

| KPI | Valor |
| --- | --- |
| Por gestionar | 16 (6 pendientes + 9 por revisar/info + 1 en confirmación) |
| Rechazadas o expiradas | 1 |
| Monto por confirmar | $8,000 |
| Ingresos confirmados hoy | $0 (la última confirmación fue el 22 sep 21:12, hora de Ciudad de México) |
| Comprobantes visibles | 13 (8 recuperados de la evidencia de la propia pre-reserva) |
| Clientes consolidados | 27 |
| Confirmadas con servicio en 24 h | 0 |

## 4. Cambios aplicados al dashboard

- Código reescrito en módulos: `js/core.js`, `js/domain.js`, `js/data.js`, `js/view.js`, `js/main.js`.
- Montos reales con origen explícito: reserva, comprobante o monto esperado (se indica en pantalla y en el CSV).
- Evidencias del comprobante en el detalle: banco, beneficiario, cuenta, referencia, tipo de pago,
  confianza del clasificador y los **motivos de revisión que ya calcula n8n** traducidos a texto claro.
- Estados reales de la operación reconocidos (incluye `creando_retencion` y `expirado_sin_pago`).
- "Hoy" se calcula con la zona horaria del negocio (`America/Mexico_City`), no con la del navegador.
- Se eliminaron la ocupación fija, las variaciones inventadas, la fecha del encabezado y el usuario fijo.
- Secciones nuevas y funcionales: **Comprobantes**, **Clientes** y **Diagnóstico**.
- Decisiones con confirmación previa, nota opcional, bloqueo de doble clic, vía alternativa si el RPC
  no existe, y registro en el histórico con el correo del usuario.
- Refresco automático cada 60 s, refresco manual, exportación CSV con BOM y avisos legibles por error.
- Migración SQL en `supabase/APLICAR_EN_SUPABASE.sql` (permisos, RLS y RPC de decisiones).

## 5. Estado de la base verificado en vivo

Comprobado ejecutando el dashboard real contra la base real (`node tools/live-check.mjs`):

| Elemento | Estado |
| --- | --- |
| Esquema de las 4 tablas | confirmado con el listado real de columnas (71 en `reservas_draft`, 41 en `reservas`, 7 en `spa_comprobantes_pago`, 9 en `dashboard_reservation_decisions`) |
| Columnas que usa el dashboard | todas existen: cada tabla se consulta **una sola vez**, sin reintentos con `select(*)` |
| `reservas` sin `updated_at` | detectado y corregido (la consulta caía al comodín) |
| RPC `process_dashboard_reservation_decision(bigint, text, text)` | **existe y valida la autorización** ("Not authorized" sin sesión) |
| `spa_comprobantes_pago` para el rol `authenticated` | **FALTA**: `42501 permission denied` → requiere el GRANT |
| `dashboard_reservation_decisions` (escritura) | **FALTA**: sin permiso de INSERT → requiere el GRANT |
| `reservas_draft`, `reservas`, decisiones (lectura) | accesibles (la RLS oculta las filas sin sesión, que es lo correcto) |
| Magic link (`/auth/v1/otp`) | HTTP 200 para un correo autorizado: el envío funciona |
| CDN de la librería de Supabase | responde HTTP 200 |
| Firma de sesiones | clave asimétrica **ES256** (`/auth/v1/.well-known/jwks.json`) |

Notas de esquema que el dashboard respeta:

- `reservas_draft` no tiene `updated_at`; su marca de tiempo es `comprobante_revision_at`.
- `reservas_draft.monto_pagado` es `numeric` pero está vacío: el monto real está en
  `comprobante_revision_datos.monto_documento`.
- `dashboard_reservation_decisions.decided_by` es `NOT NULL` con default `auth.uid()`:
  el insert que hace el navegador queda cubierto por ese default.
- `reservas_draft.estado_reserva` tiene default `'esperando_pago'`, estado que el
  dashboard reconoce como "Pendiente de pago".
- Columnas de operación ahora visibles en el detalle: vencimiento de la retención,
  tiempo en proceso e intentos de pago. Además hay un aviso de urgencia cuando una
  retención vence en menos de una hora.

## 6. Estado de la publicación (importante)

La versión publicada en Vercel **funciona** (probada con `node tools/e2e-deployed.mjs`:
lee las 4 tablas, calcula métricas, pinta las vistas y guarda decisiones) y **está al día**:
los commits se subieron y `node tools/compare-deploy.mjs` confirma que producción coincide
con el código local (incluido el arreglo de la consulta de `reservas`, el aviso de
retenciones y `insideSpaCheck()`).

## 7. Migración aplicada (23 sep 2026)

`supabase/APLICAR_EN_SUPABASE.sql` se aplicó con la Management API
(`node tools/apply-migration.mjs --token sbp_...`) y se verificó en el catálogo de Postgres
con `node tools/verify-grants.mjs`:

| Tabla | SELECT | INSERT | UPDATE | RLS |
| --- | --- | --- | --- | --- |
| `reservas_draft` | sí | sí | sí | activa |
| `reservas` | sí | sí | sí | activa |
| `spa_comprobantes_pago` | **sí (antes no)** | no | no | activa |
| `dashboard_reservation_decisions` | sí | sí | sí | activa |

- Políticas creadas para los correos autorizados en lectura (4 tablas) y escritura
  (`reservas_draft`, `spa_comprobantes_pago`, decisiones).
- `process_dashboard_reservation_decision(bigint, text, text)` existe, es
  `SECURITY DEFINER` y el rol `authenticated` puede ejecutarlo.
- Correos de la base y de `supabase-config.js` coinciden.
- El rol `anon` sigue sin acceso a `spa_comprobantes_pago`: correcto, es una tabla privada.

## 7.b Limpieza de duplicados y residuos (23 sep 2026)

La primera versión de la migración convivió con políticas RLS que ya existían con otro
nombre, así que quedaron **6 reglas duplicadas** (equivalentes: unas usaban la lista de
correos escrita a mano y otras la función `inside_spa_dashboard_emails()`). Se eliminaron
las antiguas y quedó **una sola política por operación**:

| Tabla | Operación | Política única que queda |
| --- | --- | --- |
| `reservas` | SELECT | `… read confirmed reservations` |
| `reservas_draft` | SELECT | `… read drafts` |
| `reservas_draft` | UPDATE | `… update drafts` |
| `spa_comprobantes_pago` | SELECT | `… read receipts` |
| `spa_comprobantes_pago` | UPDATE | `… update receipts` |
| `dashboard_reservation_decisions` | SELECT | `… read decisions` |
| `dashboard_reservation_decisions` | INSERT | `… write decisions` |

Las que se eliminaron: `… read reservation drafts`, `… update payment decisions`,
`… read payment receipts` y `… write their decisions`. La migración ahora las borra de
forma explícita, así que volver a ejecutarla no vuelve a duplicarlas.

Además se limpió **1 registro de prueba** que mi propio Diagnóstico había dejado en el
histórico (`note = diagnostico-automatico-descartable`). El histórico quedó en **0 filas**:
las decisiones reales que se tomen desde el panel se conservan.

Para que no vuelva a pasar, la comprobación de escritura del Diagnóstico ya no inserta
desde el navegador: la hace la función `dashboard_decision_write_probe()`, que inserta un
registro de prueba y **lo borra en la misma transacción**. Así el dashboard valida la
escritura sin necesitar permiso de DELETE sobre el histórico (que debe permanecer como
registro de auditoría) y sin dejar basura si se cierra la pestaña.

## 7.c Datos que NO se tocaron (son reales, no basura)

| Qué | Por qué se deja |
| --- | --- |
| 4 comprobantes sin pre-reserva asociada (ids 178, 181, 186) | quedan cuando la pre-reserva pasa a `reservas` o expira: son el rastro de la evidencia. Tres son de Moses Cortez, Diana María y uno del flujo de pruebas de n8n |
| 1 reserva confirmada con `nombre = Test` (`test@gmail.com`, id 187) | registro del flujo de pruebas del equipo en n8n; borrarlo podría romper la conciliación con Pabau |
| `reservas_draft` id 187 con un comprobante de `Test` | igual que el anterior, pertenece a la prueba de punta a punta del equipo |

Si prefieres eliminar los registros de prueba, se pueden borrar de forma puntual; dime y lo
hago con los ids exactos.


## 8. Verificación con la sesión real (23 sep 2026)

Con la sesión real de `estebanvalbuena947@gmail.com` el Diagnóstico del dashboard reporta:

| Comprobación | Resultado |
| --- | --- |
| Sesión y correo autorizado | correctos |
| Lectura · Pre-reservas | **18 filas visibles** |
| Lectura · Comprobantes | **14 filas visibles** (el GRANT funcionó) |
| Lectura · Reservas confirmadas | **10 filas visibles** |
| Lectura · Decisiones | accesible (aún sin registros) |
| RPC de decisiones | existe y valida la autorización |

Los dos avisos que aparecían eran **falsos positivos de la propia comprobación**, ya
corregidos:

1. El sondeo del RPC usaba un id inexistente, así que recibía "la pre-reserva -1 no
   existe" (respuesta correcta: confirma que la función está instalada y que la sesión
   pasó la autorización). Ahora ese caso se interpreta como `ok`.
2. El sondeo de escritura no enviaba `previous_status` ni `resulting_status` (NOT NULL) y
   usaba una pre-reserva inexistente, pero `reservation_draft_id` tiene **clave foránea** a
   `reservas_draft(id)`. Ahora usa una pre-reserva real, completa las columnas obligatorias
   y borra el registro de prueba.

Restricciones comprobadas en el catálogo (`node tools/db-query.mjs --token sbp_...`):
`action` tiene un `CHECK` con `approved`/`rejected`/`needs_info` (coincide con el
dashboard), `id` es la clave primaria y `reservation_draft_id` es clave foránea.

## 9. Pendiente de confirmar

1. **Repetir el Diagnóstico** en el dashboard (sección *Diagnóstico* → "Revisar ahora"):
   debe quedar todo en `ok`, incluida la escritura.
2. **Gestionar una pre-reserva real** (aprobar / rechazar / pedir información) y comprobar
   que aparece en *Histórico de decisiones* con tu correo y la nota.

## 10. Herramientas de verificación

| Comando | Qué comprueba |
| --- | --- |
| `node tools/verify.mjs` | 67 comprobaciones: lógica, estados, montos, fechas, filtros, estructura y columnas contra el esquema |
| `node tools/smoke.mjs` | Arranca la app completa con un DOM simulado (33 pasos, incluye los 3 caminos de una decisión) |
| `node tools/e2e.mjs` | Integración de punta a punta: backend de prueba + librería oficial de Supabase (30 comprobaciones) |
| `node tools/live-check.mjs` | Ejecuta la app contra la base real y reporta qué contesta el backend |
| `node tools/live-sdk.mjs` | Igual, usando la librería oficial de Supabase |
| `node tools/audit-db.mjs` | Esquema real, filas reales y KPIs reales desde Supabase |
| `node tools/check-authenticated.mjs` | Lectura de las 4 tablas y RPC con una sesión `authenticated` |

Los tres últimos se apoyan en `tools/mock-backend.mjs` (backend local con las columnas reales, RLS,
una tabla sin GRANT y el RPC de decisiones) y en `tools/vendor-sdk.mjs`, que descarga la librería
oficial del CDN para poder ejecutarla en Node. Así el ciclo completo queda probado sin navegador:

- sin sesión no se ven filas y el panel lo explica;
- con sesión se leen las 4 tablas y las métricas salen correctas;
- aprobar / pedir información / rechazar viajan por el RPC y **el estado y el histórico cambian**
  en el backend (verificado leyendo los datos después de cada decisión).

> `supabase/openapi-schema.json` guarda el esquema real del proyecto (16 tablas) como referencia.
