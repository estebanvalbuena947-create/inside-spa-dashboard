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
tools/verify.mjs           Pruebas automáticas sin navegador (49 comprobaciones)
tools/smoke.mjs            Arranca la app completa con un DOM simulado (25 pasos)
supabase/APLICAR_EN_SUPABASE.sql   Migración + auditoría de la base (LEER SECCIÓN 3)
app.js                     Obsoleto: solo redirige al código nuevo (se puede borrar)
```

---

## 3. Configuración de la base (una sola vez)

El dashboard necesita permisos explícitos. Sin ellos, Supabase responde
`permission denied for table spa_comprobantes_pago` y el panel aparece vacío.

1. Abre https://supabase.com/dashboard/project/ncutewymydclypuqlbfk/sql/new
2. Pega **todo** el contenido de `supabase/APLICAR_EN_SUPABASE.sql`.
3. Pulsa **RUN**.
4. Devuelve dos tablas: `RESUMEN DE AUDITORIA` y `COLUMNAS EXACTAS`.
   Todo debe salir en `ok`; cualquier `FALTA` explica qué falta.

El script:
- otorga `SELECT`/`INSERT`/`UPDATE` a los administradores del dashboard,
- crea las políticas RLS para los correos de `supabase-config.js`,
- define el RPC `process_dashboard_reservation_decision(bigint, text, text)`,
- no borra ni modifica datos de reservas.

> Los correos autorizados están en dos sitios que deben coincidir:
> `supabase-config.js` → `allowedEmails` y el SQL → `inside_spa_dashboard_emails()`.

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
| Pre-reservas por gestionar | Pre-reservas en estado pendiente, por revisar, información solicitada o en confirmación |
| Confirmadas hoy | Reservas de `reservas` con `pabau_confirmado_at` de hoy + pre-reservas aprobadas hoy |
| Ingresos confirmados hoy | Suma de montos de quienes se confirmaron hoy (acepta montos en texto: `"$1,200.50"`) |
| Clientes por atender | Reservas confirmadas con servicio en las próximas 24 horas |
| Ocupación de hoy | Confirmadas + pre-reservas con fecha de hoy sobre 18 cupos (`CAPACITY` en `js/main.js`) |
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
node tools/verify.mjs   # 49 comprobaciones de lógica y estructura
node tools/smoke.mjs    # 25 pasos: arranca la app completa con un DOM simulado
```

- **`verify.mjs`**: sintaxis, que cada `#id` usado por JS exista en el HTML, que cada enlace del
  menú tenga su sección, que no queden métricas inventadas, y la lógica de dinero, fechas,
  estados, filtros, KPIs, clientes y CSV.
- **`smoke.mjs`**: monta un DOM con los `#id` reales, sustituye la librería de Supabase por un
  doble y ejecuta `js/main.js`: arranque, carga de las 4 tablas, render de todas las vistas,
  filtros, diagnóstico, modal de detalle y refresco. Falla si algo lanza una excepción.

---

## 9. Ajustes rápidos

| Quiero cambiar | Dónde |
| --- | --- |
| Correos con acceso | `supabase-config.js` **y** `inside_spa_dashboard_emails()` en el SQL |
| Capacidad diaria (18 cupos) | `CAPACITY` en `js/main.js` |
| Frecuencia de refresco (60 s) | `REFRESH_MS` en `js/main.js` |
| Estados reconocidos | `CONFIRMED_STATES`, `REVIEW_STATES`, `PROCESSING_STATES`, `REJECTED_STATES` en `js/domain.js` |
| Color/estilo de un badge | `dashboard.css` |

---

## 10. Límites conocidos

- Se leen hasta 500 filas por tabla (por rendimiento). Si la operación supera ese volumen
  conviene paginar o filtrar por fecha desde el servidor.
- El diagnóstico inserta un registro de prueba en `dashboard_reservation_decisions` y lo borra;
  si el borrado no está permitido, solo deja el aviso (la decisión no se ve afectada).
- El correo del usuario queda guardado en el histórico de decisiones (`decided_by_email`).
