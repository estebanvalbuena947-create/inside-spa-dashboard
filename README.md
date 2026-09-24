# Inside Spa · Dashboard de reservas

Panel interno para revisar **pre-reservas**, validar **comprobantes de pago** y **tomar decisiones**
(aprobar, rechazar o pedir información) con datos reales de Supabase.

- **Producción:** https://inside-spa-dashboard.vercel.app
- **Repositorio:** https://github.com/estebanvalbuena947-create/inside-spa-dashboard
- **Base de datos:** Supabase proyecto `SPA` (`ncutewymydclypuqlbfk`)

---

## 1. Cómo se sincroniza con GitHub

| Paso | Qué ocurre |
| --- | --- |
| 1 | Editas los archivos en esta carpeta (o el asistente los edita). |
| 2 | `git add . && git commit -m "..." && git push origin main`. |
| 3 | Vercel detecta el push en `main` (integración Git) y publica automáticamente. |
| 4 | En ~1 minuto los cambios están en `https://inside-spa-dashboard.vercel.app`. |

No hay paso de compilación: el proyecto son archivos estáticos (HTML + CSS + módulos ES).
Si un cambio no aparece, refresca con **Ctrl + F5**; los módulos llevan versión (`?v=2.0.0`)
justo para evitar copias viejas en caché.

### Cómo verificar el despliegue
```powershell
git push origin main
# y luego, cuando Vercel termine:
curl.exe -s https://inside-spa-dashboard.vercel.app/js/main.js?v=2.0.0 | Select-Object -First 3
```
Si ese comando devuelve el contenido del archivo (y no un 404), el despliegue está correcto.

---

## 2. Estructura

```
index.html                 Interfaz (secciones: Resumen, Pre-reservas, Comprobantes, Clientes, Histórico, Diagnóstico)
styles.css                 Diseño base
dashboard.css              Estilos propios del dashboard (badges, comprobantes, diagnóstico)
supabase-config.js         URL, clave pública y correos autorizados
js/core.js                 Formato de dinero/fechas, escapado HTML, CSV, zona horaria
js/domain.js               Reglas de negocio: estados, decisiones, filtros, KPIs, clientes
js/data.js                 Consultas a Supabase, tolerancia a esquema, errores legibles, diagnóstico
js/view.js                 Render del HTML (tablas, tarjetas, modales, toast)
js/main.js                 Sesión, carga de datos, decisiones, refresco automático, exportación
tools/verify.mjs           Pruebas automáticas sin navegador (67 comprobaciones)
tools/smoke.mjs            Arranca la app completa con un DOM simulado (33 pasos)
tools/e2e.mjs              Integración de punta a punta con backend y librería de prueba
tools/mock-backend.mjs     Backend local que imita la base real (RLS, GRANT y RPC)
tools/vendor-sdk.mjs       Descarga la librería oficial de Supabase del CDN
tools/live-check.mjs       Ejecuta el dashboard real contra la base real
tools/live-sdk.mjs         Igual, con la librería oficial de Supabase
tools/dom-mock.mjs         DOM mínimo compartido por las pruebas
tools/rest-client.mjs      Cliente REST fiel a PostgREST para las pruebas en vivo
tools/audit-db.mjs         Auditoría de la base real (esquema, filas, estados, KPIs)
tools/apply-migration.mjs  Aplica la migración SQL (Management API o psql) y verifica
tools/verify-grants.mjs    Verifica en el catálogo: GRANT, RLS, políticas y RPC
tools/db-query.mjs         Ejecuta SQL de consulta con un token sbp_ (catálogo y datos)
tools/check-authenticated.mjs  Valida RLS y permisos con una sesión authenticated
docs/AUDITORIA.md          Informe de la auditoría (qué estaba roto y qué se corrigió)
supabase/APLICAR_EN_SUPABASE.sql   Migración + auditoría de la base (LEER SECCIÓN 3)
app.js                     Obsoleto: solo redirige al código nuevo (se puede borrar)
```

---

## 3. Configuración de la base (una sola vez)

El dashboard necesita permisos explícitos. Sin ellos, Supabase responde
`permission denied for table spa_comprobantes_pago` y el comprobante no se puede leer.

**Opción A · un comando (aplica y verifica solo):**

```powershell
node tools/apply-migration.mjs --token sbp_...      # con un token personal de Supabase
node tools/apply-migration.mjs --password "..."     # o con la contraseña de la base
node tools/verify-grants.mjs --token sbp_...        # comprueba el resultado en el catálogo
```

El token personal se crea en *Supabase → Account → Access Tokens*; la contraseña está en
*Project Settings → Database*. Ninguno se guarda en disco. Con `--check` (sin credenciales)
solo informa del estado actual.

**Opción B · manual:**

1. Abre https://supabase.com/dashboard/project/ncutewymydclypuqlbfk/sql/new
2. Pega **todo** el contenido de `supabase/APLICAR_EN_SUPABASE.sql`.
3. Pulsa **RUN**.
4. Devuelve dos tablas: `RESUMEN DE AUDITORIA` y `COLUMNAS EXACTAS`.
   Todo debe salir en `ok`; cualquier `FALTA` explica qué falta.

El script:
- otorga `SELECT`/`INSERT`/`UPDATE` a los administradores del dashboard,
- crea las políticas RLS para los correos de `supabase-config.js`,
- define (o reemplaza) el RPC `process_dashboard_reservation_decision(bigint, text, text)`,
- no borra ni modifica datos de reservas.

> Los correos autorizados están en dos sitios que deben coincidir:
> `supabase-config.js` → `allowedEmails` y el SQL → `inside_spa_dashboard_emails()`.

**La forma más rápida de saber si falta algo:** inicia sesión en el dashboard y entra a la
sección **Diagnóstico**. Con tu propia sesión revisa permisos, políticas, RPC y escritura, y
dice exactamente qué ejecutar. Desde la consola del navegador también sirve `await insideSpaCheck()`.

---

## 4. Acceso (login)

1. Botón **Iniciar sesión** → escribe un correo autorizado.
2. Llega un **enlace mágico** por correo (Supabase Auth).
3. Al abrirlo, la sesión queda activa y el dashboard carga los datos.

En Supabase → *Authentication → URL Configuration* debe estar permitido:
`https://inside-spa-dashboard.vercel.app` (y `http://localhost:3000` si pruebas en local).

Si el correo no llega, revisa *Authentication → Rate Limits / SMTP*: el proveedor por defecto
de Supabase limita a pocos correos por hora.

---

## 5. Qué muestra el dashboard (todo calculado con datos reales)

| Elemento | Cálculo |
| --- | --- |
| Pre-reservas por gestionar | Pre-reservas en estado pendiente, por revisar, información solicitada, en confirmación o creando retención |
| Confirmadas hoy | Reservas de `reservas` con `pabau_confirmado_at` de hoy + pre-reservas aprobadas hoy (día según la zona horaria del spa) |
| Ingresos confirmados hoy | Suma de montos de quienes se confirmaron hoy (acepta montos en texto: `"$1,200.50"`) |
| Clientes por atender | Reservas confirmadas con servicio en las próximas 24 horas |
| Reservas de hoy (tarjeta derecha) | Reservas que **ocurrieron hoy**: las confirmadas hoy más las que tienen el servicio agendado hoy, sin contar dos veces; el anillo dibuja la proporción sobre 18 cupos (`CAPACITY_POR_DIA` en `js/view.js`) |
| Comprobantes | Un comprobante por pre-reserva (se conserva el más reciente) con enlace al archivo y datos de pago |
| Clientes | Consolidado por correo/teléfono de pre-reservas y confirmadas |
| Histórico | Decisiones registradas (con usuario y nota) + reservas confirmadas |
| Diagnóstico | Estado real de cada tabla, permisos, sesión y RPC |

Estados reconocidos (se normalizan automáticamente):

| Estado en la base | Se muestra como |
| --- | --- |
| `confirmado`, `confirmada`, `aprobado`, `reserva_confirmada = true` | Confirmada |
| `requiere_revision`, `requiere_revision_pago`, `revision_pago`, `en_revision` | Por revisar |
| `procesando_pabau`, `pendiente_pabau`, `en_proceso` | En confirmación |
| `rechazado`, `cancelado`, `expirado`, `abandonado` | Rechazada |
| cualquier otro valor | Pendiente de pago (se muestra el valor crudo en el detalle) |

Si aparece un estado nuevo, el dashboard **no lo inventa**: lo agrupa en "Pendiente de pago"
y sigue permitiendo aprobar/rechazar.

---

## 6. Toma de decisiones

Desde la fila de una pre-reserva (o desde la tarjeta del comprobante):

1. Se abre el detalle con el comprobante y el historial.
2. Botones: **Aprobar comprobante**, **Rechazar**, **Pedir información**.
3. Aparece un diálogo de confirmación (evita clics accidentales).
4. Se puede dejar una **nota** que queda en el histórico.
5. El dashboard llama al RPC `process_dashboard_reservation_decision`, que actualiza el estado
   y registra la decisión con el correo del usuario.

**Ver el comprobante sin salir del panel:** cada fila con evidencia muestra el enlace
**"Ver comprobante ↗"** junto al botón de gestión, y el modal de detalle repite el enlace
**"Ver comprobante en otra pestaña ↗"** para revisarlo mientras se decide. Los enlaces se abren
con `target="_blank" rel="noopener noreferrer"` y, si la evidencia no tiene archivo adjunto,
el panel lo indica en vez de mostrar un enlace roto.

Si el RPC no existe todavía, el panel lo dice y guarda la decisión por la vía alternativa
(inserta en `dashboard_reservation_decisions` y actualiza `reservas_draft`). Nunca muestra
un éxito falso: si no pudo guardar, lo informa y no cambia la pantalla.

---

## 7. Diagnóstico y problemas frecuentes

Entra a la sección **Diagnóstico** y pulsa *Revisar ahora*. Revisa, con tu propia sesión:

- clave pública y URL configuradas,
- sesión activa, correo autorizado y vigencia del token,
- lectura de cada tabla (`ok` / `FALTA` con el código de error de Postgres),
- el RPC de decisiones,
- escritura en la tabla de decisiones (inserta y borra un registro de prueba).

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `permission denied for table ...` | Falta `GRANT` | Ejecutar `APLICAR_EN_SUPABASE.sql` |
| Todo en 0 con sesión iniciada | RLS sin política para tu correo | Ejecutar `APLICAR_EN_SUPABASE.sql` |
| "No se pudo guardar la decisión" | RPC ausente o sin permiso de `UPDATE` | Ejecutar `APLICAR_EN_SUPABASE.sql` |
| El enlace del correo no abre sesión | URL de redirección no permitida | Supabase → Authentication → URL Configuration |
| No llega el correo | SMTP / límite de envíos | Revisar Authentication → SMTP |

---

## 8. Verificación local (sin navegador)

```powershell
node tools/vendor-sdk.mjs         # descarga la librería oficial del CDN a .vendor/ (una vez)
node tools/verify.mjs             # 67 comprobaciones de lógica, estructura y columnas
node tools/smoke.mjs              # 33 pasos: arranca la app completa con un DOM simulado
node tools/e2e.mjs                # 30 comprobaciones de punta a punta (backend de prueba + librería oficial)
node tools/live-check.mjs         # ejecuta la app contra la base real
node tools/live-sdk.mjs           # ejecuta la app con la librería oficial contra la base real
node tools/audit-db.mjs           # audita la base real (esquema, filas, estados y KPIs)
node tools/check-authenticated.mjs # valida RLS/permisos con una sesión autenticada
```

- **`verify.mjs`**: sintaxis, que cada `#id` usado por JS exista en el HTML, que cada enlace del
  menú tenga su sección, que no queden métricas inventadas, que la lógica de dinero, fechas,
  estados, filtros, KPIs, clientes y CSV sea correcta, y que **todas las columnas y los órdenes
  que pide `js/data.js` existan en `supabase/openapi-schema.json`**.
- **`smoke.mjs`**: monta un DOM con los `#id` reales, sustituye la librería por un doble y ejecuta
  `js/main.js`: arranque, carga de las 4 tablas, render de todas las vistas, filtros, diagnóstico,
  modal, refresco y los **tres caminos de una decisión** (vía alternativa sin RPC, camino oficial
  por RPC y falta de permisos). Falla si algo lanza una excepción o si se reporta un falso éxito.
- **`e2e.mjs`**: prueba de integración real. Levanta `tools/mock-backend.mjs` (backend local con las
  columnas reales, RLS activa, una tabla sin GRANT y el RPC de decisiones), usa la **librería
  oficial de Supabase descargada del CDN** y comprueba el ciclo completo: sin sesión no se ven
  filas; con sesión se leen las 4 tablas, se calculan las métricas correctas y se pintan las
  vistas; aprobar / pedir información / rechazar viajan por el RPC y **el estado y el histórico
  cambian en el backend**.
- **`live-check.mjs`**: arranca el dashboard de verdad contra la base de verdad, emitiendo las
  mismas peticiones PostgREST que el navegador (`tools/rest-client.mjs`), y reporta qué contesta el
  backend, qué métricas se pintan, qué dice el diagnóstico y si alguna consulta tuvo que reintentar
  con `select(*)` (señal de columna inexistente).
- **`live-sdk.mjs`**: lo mismo pero con la librería oficial (`--rest-url` para apuntar a otro backend).
- **`audit-db.mjs`**: contra la base real. Sin credenciales solo comprueba el acceso público; con
  `SUPABASE_SERVICE_ROLE_KEY` en `.env.local` lista el esquema real, cuenta filas, resume estados y
  calcula los KPIs del dashboard con datos de producción (`--json`, `--sample N`).
- **`check-authenticated.mjs`**: valida lo que verá el navegador del equipo. Como la firma es
  asimétrica, la comprobación real se hace desde el propio dashboard: sección *Diagnóstico* o
  `await insideSpaCheck()` en la consola del navegador.

---

## 9. Ajustes rápidos

| Quiero cambiar | Dónde |
| --- | --- |
| Correos con acceso | `supabase-config.js` **y** `inside_spa_dashboard_emails()` en el SQL |
| Zona horaria de la operación | `timeZone` en `supabase-config.js` (por defecto `America/Mexico_City`) |
| Capacidad diaria (18 cupos) | `CAPACITY` en `js/main.js` |
| Frecuencia de refresco (60 s) | `REFRESH_MS` en `js/main.js` |
| Estados reconocidos | `CONFIRMED_STATES`, `REVIEW_STATES`, `PROCESSING_STATES`, `REJECTED_STATES` en `js/domain.js` |
| Textos de los motivos de revisión de n8n | `PAYMENT_REASON_LABELS` en `js/domain.js` |
| Color/estilo de un badge | `dashboard.css` |
| Qué cuenta como "de hoy" | `enteredAtOf()` y `closedAtOf()` en `js/domain.js`: la tarjeta y el filtro por día usan la **fecha de creación** de la pre-reserva (`comprobante_revision_at`) |

---

## 10. Límites conocidos

- Se leen hasta 500 filas por tabla (por rendimiento). Hoy hay 18 pre-reservas y 10 confirmadas,
  así que entra todo; si la operación crece conviene paginar o filtrar por fecha en el servidor.
- En esta base `reservas_draft.monto_pagado` está vacío: el monto se lee de
  `comprobante_revision_datos` (`monto_documento`). El dashboard indica en pantalla el origen del dato.
- Algunas pre-reservas no tienen monto en ningún lado porque el cliente todavía no paga; esas
  aparecen sin valor y suman a "por gestionar", no a "por confirmar".
- El diagnóstico inserta un registro de prueba en `dashboard_reservation_decisions` y lo borra;
  si el borrado no está permitido, solo deja el aviso (la decisión no se ve afectada).
- El correo del usuario queda guardado en el histórico de decisiones (`decided_by_email`).

El detalle completo de la auditoría está en `docs/AUDITORIA.md`.
