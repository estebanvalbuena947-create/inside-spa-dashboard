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

## 6. Pendiente de confirmar

1. Permisos + RLS de la **sesión autenticada**. El proyecto firma las sesiones con
   clave **asimétrica (ES256)**, así que no se puede firmar una sesión de prueba desde
   Node (solo Supabase tiene la clave privada). Hay dos formas de comprobarlo con la
   sesión real:
   - dashboard → sección *Diagnóstico* → **Revisar ahora**;
   - consola del navegador (F12) con sesión iniciada: `await insideSpaCheck()`.
2. Ejecutar `supabase/APLICAR_EN_SUPABASE.sql` (ya confirmado que faltan 2 permisos).
3. Subir los commits a GitHub para que Vercel publique (`git push origin main`).

## 7. Herramientas de verificación

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
