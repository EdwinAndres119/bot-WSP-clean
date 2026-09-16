# BOT_WSP — extractor de WhatsApp a Supabase

Bot en Node.js que usa `whatsapp-web.js` + Puppeteer para extraer mensajes de WhatsApp (historial completo + mensajes en vivo, con multimedia) hacia una tabla `mensajes` en Supabase.

Repo: https://github.com/EdwinAndres119/prueba-botWSP.git — ramas: `main` (estado consolidado) y `edwinbranch` (rama de trabajo activa).

Este proyecto es **solo el backend**. El frontend vive aparte, en `Frontend_WSP` (carpeta hermana), con su propia sesión de Claude Code y su propio repositorio. Se comunican únicamente por la API REST (`http://localhost:3001`) — el frontend nunca toca Supabase directo.

## Cómo correrlo

- `npm install` primero (una vez, o cada vez que cambien las dependencias).
- `npm run start` → `node app.js`: modo CLI original, extrae por consola, sin API.
- `npm run web` → `node server.js`: levanta la API Express en `:3001` (esto es lo que usa el frontend). Usar este para probar con el panel o Postman.
- `npm run build` → empaqueta el bot como `.exe` standalone con `pkg` (incluye Chrome embebido) en `dist/`. No hace falta para desarrollo normal.
- En Windows, `server.js` normalmente se corre bajo pm2 (`npx pm2 start server.js --name bot-wsp-api`) para que quede en segundo plano; `npx pm2 logs bot-wsp-api` para ver la consola.

## Variables de entorno (`.env`, gitignored — hay que crearlo a mano en cada máquina)

| Variable | Usada por | Qué poner |
|---|---|---|
| `SUPABASE_URL` | `src/db/SupabaseClient.js` | URL del proyecto Supabase (`https://<ref>.supabase.co`), Project Settings → API |
| `SUPABASE_KEY` | `src/db/SupabaseClient.js` | La clave **`service_role`** (secreta) de Supabase, Project Settings → API → Project API keys. **No uses la clave `anon`/pública** — con esa, RLS bloquearía al propio backend (ver sección de seguridad más abajo). |
| `HISTORY_LIMIT` | `src/config.js` | `0` = sin límite de mensajes por chat (lo normal). Cualquier número > 0 limita cuántos mensajes trae por chat, sin importar `monthsLimit`. |
| `CHAT_TIMEOUT_MS` | `src/config.js` | Opcional — si no está, usa `420000` (7 min) por defecto. No lo bajes de eso sin ver la nota en "Cosas ya resueltas" #2. |

**Variables viejas que YA NO SE USAN** (pueden aparecer en un `.env` copiado de una versión vieja, no hacen nada — se pueden omitir tranquilamente en una instalación nueva):
- `ADMIN_PASSWORD` — era del login por clave única, se sacó por completo el 2026-09-14.
- `CHROME_EXECUTABLE_PATH` — era del modo "Cambio B" (perfil de Chrome copiado / `remoteDebugPort`), revertido el 2026-09-15.

## Estructura

```
app.js                      # modo CLI (npm run start)
server.js                   # API Express (npm run web)
src/
  config.js                  # lee .env, expone constantes
  db/
    SupabaseClient.js         # cliente de supabase-js, valida env al cargar
    MessageRepository.js       # guarda mensajes (upsert por id) + listForExport() para CSV
    ExtractionRunRepository.js  # historial de corridas (tabla extraction_runs)
  wa/
    client.js                  # factory del cliente whatsapp-web.js/Puppeteer (LocalAuth + QR)
    ContactResolver.js          # resuelve nombre/número del remitente (incluye @lid)
    MediaStorage.js              # descarga y guarda multimedia en disco
    HistoryExtractor.js           # paginación de historial + sync con el teléfono + monthsLimit
    MessagePipeline.js             # procesa y guarda UN mensaje (historial o en vivo)
    SessionManager.js               # orquesta una corrida completa para la API web
    commands.js                      # comandos de chat del modo CLI (app.js)
    identifiers.js                    # tipos de mensaje de sistema a filtrar, helpers de id
  utils/
    csv.js                              # serializa filas a CSV para /api/export
db/schema/*.sql              # correr manualmente en el SQL Editor de Supabase, EN ORDEN
docs/arquitectura.md         # detalle técnico de los bugs de whatsapp-web.js ya resueltos
```

### `db/schema/*.sql` — cuáles correr y en qué orden

1. `002_extraction_runs.sql` — tabla `extraction_runs` (historial de corridas). **Ya debería estar corrida.**
2. `004_enable_rls.sql` — activa RLS en `mensajes`/`extraction_runs`/`users`. **Solo correr DESPUÉS de confirmar que `SUPABASE_KEY` es la clave `service_role`** (ver sección de seguridad). Nota: si la tabla `users` ya no existe en tu Supabase (se dejó de usar, ver más abajo), esa línea específica del script va a fallar — se puede correr solo las primeras dos líneas (`mensajes`/`extraction_runs`) si pasa eso.
3. `005_failed_chats.sql` — agrega `failed_chats` (jsonb) a `extraction_runs`, para los chats que fallaron con error técnico real.
4. `006_empty_chats.sql` — agrega `empty_chats` (jsonb) a `extraction_runs`, para los chats revisados bien pero sin mensajes (con motivo).

No existe `003_users.sql` a propósito — existía cuando el proyecto tenía login por cuentas, se borró el 2026-09-15 al sacar esa funcionalidad por completo (ver `.gitignore`/historial de commits). Si tu Supabase tiene una tabla `users` de esa época, ya no la usa nada del código actual — se puede dejar así o borrarla a mano, es indistinto.

## API (lo que el frontend consume)

**Sin ninguna autenticación** — decisión explícita de negocio (2026-09-14): la app es solo para observar la extracción, pensada para red interna, no para exponer a internet. No mandar/esperar header `Authorization`.

- `POST /api/start` `{lineLabel, monthsLimit?}` → `{ok:true}`. Arranca una extracción (detiene cualquier corrida anterior, crea un cliente whatsapp-web.js nuevo, `LocalAuth` con `clientId` = `lineLabel` saneado). No espera al QR/ready — responde de inmediato para que el frontend haga polling. `monthsLimit: null`/omitido = sin límite de meses.
- `GET /api/status` → `{state, lineLabel, monthsLimit, runId, qrDataUrl, progress, errorMessage}`. Estados: `idle → starting → qr → extracting → completed`/`error`. `progress` trae `{chatsFound, processed, failed, saved, failedChats, emptyChats, done?}` — `failedChats` es `{chatId, chatName, error}[]` (fallo técnico real), `emptyChats` es `{chatId, chatName, reason}[]` (se revisó bien, no había mensajes que guardar). Estas dos listas **nunca se muestran juntas/mezcladas** en el frontend — son conceptos distintos.
- `POST /api/stop` → detiene la extracción en curso (`client.destroy()`).
- `GET /api/runs` → últimas 50 corridas (tabla `extraction_runs`, más reciente primero) para el panel Admin — cada fila trae `failed_chats`/`empty_chats` (mismo shape que arriba, en snake_case por venir directo de la tabla).
- `GET /api/export?runId=N` → descarga un CSV (`Content-Disposition: attachment`) con los mensajes guardados durante esa corrida (filtra `mensajes` por `fetched_at` entre `started_at`/`finished_at` de esa corrida). Sin `runId`, exporta toda la tabla `mensajes`.

## Cosas ya resueltas — NO las vuelvas a "arreglar"

1. **Sync de historial viejo (`chat.endOfHistoryTransferType`)**: WhatsApp permite pedirle al teléfono más historial de un chat solo si `endOfHistoryTransferType === 0` (mismo mecanismo que el botón "Click here to get older messages" de la UI real). Si es `1`/`2`, WhatsApp mismo bloquea ese chat — **no es un bug, es un límite real de la plataforma**, confirmado comparando contra capturas de WhatsApp Web real. El request correcto (verificado contra el propio `Client.js` de la librería) es `sendPeerDataOperationRequest(3, { chatId: chat.id })`, **UNA sola vez por chat**, seguido de polling paciente (`loadEarlierMsgs`) sin volver a mandar el request — reenviarlo cancela el pedido pendiente antes de que el teléfono alcance a responder. Ya implementado así en `HistoryExtractor.js`. También se confirmó (2026-09-15/16) que una sesión **recién vinculada por QR** es bloqueada mucho más agresivamente por WhatsApp que una sesión con más horas activa — repetir la misma corrida horas después, sin re-escanear QR, puede traer varias veces más mensajes.
2. **`protocolTimeout` de Puppeteer** (`src/wa/client.js`) y **`CHAT_TIMEOUT_MS`** (`src/config.js`) van SIEMPRE juntos — `protocolTimeout` tiene que quedar un poco por debajo de `CHAT_TIMEOUT_MS`, si no, subir uno solo no cambia nada (el que sea menor corta primero). Están en `360000`/`420000` (6/7 min) desde el 2026-09-16, porque con `monthsLimit` alto (ej. 6 meses) un chat grande y activo real puede tardar más de 3 min en una sola pasada de paginado (confirmado con CPU de `chrome.exe` subiendo, no colgado). Ya se había probado antes `600000` (10 min) y los cuelgues reales (ej. un `downloadMedia()` trabado) tardaban hasta 10 min en salir como error, bloqueando todo ese tiempo — por eso no subir más de lo necesario. No los subas de nuevo sin una razón concreta.
3. **Guard contra `ready` disparado dos veces**: tanto `app.js` como `SessionManager.js` tienen una bandera (`historyStarted`) para ignorar un segundo `client.on('ready', ...)`. Sin esto, un reconnect dispara una segunda pasada de `historyExtractor.run()` sobre los mismos chats en paralelo, corrompe los diagnósticos y en un incidente real causó un LOGOUT de la cuenta. Si agregás un cliente nuevo en otro lado, replicá este guard.
4. **Mensajes en vivo vs. extracción de historial compiten por la misma página de Puppeteer**: si no se coordinan, saturan el mismo canal CDP y cuelgan/crashean la página. Fix ya aplicado: mientras `historyInProgress` es `true`, los mensajes en vivo se encolan (`pendingLiveMessages`) y se procesan recién cuando `historyExtractor.run()` termina.
5. **Filtro de mensajes de sistema y Estados**: `SYSTEM_MESSAGE_TYPES` en `identifiers.js` (notificaciones tipo "se creó el grupo", etc.) y `status@broadcast` se filtran explícitamente — no son mensajes de chat reales.
6. **Extracción sin QR (perfil de Chrome copiado / `remoteDebugPort`), alias "Cambio B"**: se intentó (2026-09-14) y **falló de forma reproducible** en las tres variantes probadas (perfil copiado, perfil original, conectar a un Chrome ya abierto). Parece un bloqueo deliberado de WhatsApp a herramientas de automatización sobre un perfil no iniciado por el propio flujo de QR. Revertido por completo el 2026-09-15 — **no lo vuelvas a intentar** sin que el usuario lo pida explícitamente sabiendo que ya se descartó.
7. **Login (clave única o cuentas por correo/contraseña)**: se implementó, se revirtió, y se volvió a implementar una clave única, y finalmente se sacó TODA autenticación por instrucción directa de los jefes del usuario (2026-09-14). `UserRepository.js` y `003_users.sql` se borraron el 2026-09-15 por quedar huérfanos. No reintroduzcas ningún tipo de login sin que te lo pidan de nuevo explícitamente.

## Riesgo de seguridad — estado a confirmar

Hasta el 2026-09-14, `SUPABASE_KEY` en `.env` era la clave **pública** (`sb_publishable_...`), por lo que RLS estaba desactivado en `mensajes`/`extraction_runs`/`users` (si se activara con esa clave y sin políticas, el propio backend se quedaría sin poder escribir). El 2026-09-16 se observó que la clave actual en `.env` **parece ser un JWT que decodifica a `"role":"service_role"`** — es decir, ya podría ser la clave secreta correcta. **No confirmado de punta a punta** (no se verificó activando RLS y probando una corrida real después). Antes de dar esto por resuelto: confirmar en el dashboard de Supabase (Project Settings → API) cuál es la clave `service_role` real y compararla con la del `.env`; si coincide, correr `004_enable_rls.sql` y probar una extracción completa para confirmar que el backend sigue pudiendo escribir.

## Gotchas operativos

- Cada `lineLabel` usado en `/api/start` se convierte en un `clientId` propio para `LocalAuth` (carpeta `.wwebjs_auth/session-<clientId>`), así que cada línea de prueba mantiene su sesión de WhatsApp aparte sin pisar otras. Esa carpeta está en `.gitignore` — no viaja entre máquinas por git (ver sección de migración más abajo).
- `/api/start` **sí detiene la corrida anterior antes de crear una nueva** `SessionManager` (`sessionManager.stop()`) — pero si el proceso se mató a la fuerza (cierre de terminal, corte de luz, etc.) en medio de una corrida, puede quedar un navegador Chromium huérfano corriendo en segundo plano. Si ves errores tipo `Attempted to use detached Frame` o `Target closed`, revisá procesos con `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` filtrando por `CommandLine` con el `session-<clientId>` correspondiente antes de asumir que es un bug de código.
- Los logs del backend son silenciosos a propósito durante una corrida normal — solo imprime en consola eventos especiales (`"chat": N mensajes encontrados.`, `[sync] ...`, `[monthsLimit] ...`, errores). El progreso real (`chatsProcessed`, `messagesSaved`) se sigue por `/api/status` o la tabla `extraction_runs`, no por la terminal. Los contadores de esa tabla solo se actualizan cada 10 chats procesados (`PROGRESS_INTERVAL` en `HistoryExtractor.js`) — un panel quieto en "0 de N" con chats grandes en curso NO significa que esté trabado.
- Si arrancás el server dos veces (ej. una vez en pm2 y otra vez manual en una terminal), la segunda instancia falla al intentar tomar el puerto 3001 — bajo pm2 esto puede verse como reinicios en loop muy rápidos (`pm2 status`, columna `↺`). Si ves eso, confirmá primero cuál de los dos procesos es el que realmente está respondiendo (`curl http://localhost:3001/api/status`) antes de matar ninguno.

## Migrar a otra máquina

Lo que **sí** viaja con `git clone` (todo lo demás en esta lista está en `.gitignore`, hay que resolverlo aparte):

| Ruta gitignored | Qué es | Qué hacer en la máquina nueva |
|---|---|---|
| `.env` | Credenciales (Supabase, límites) | Crearlo a mano con los valores de la tabla de arriba (copiar los valores reales por un canal seguro, nunca por chat sin cifrar) |
| `node_modules/` | Dependencias npm | `npm install` |
| `.wwebjs_auth/` | Sesión de WhatsApp por línea | Sin copiarla, cada línea va a pedir escanear QR de nuevo (no se pierde nada de lo ya extraído, eso vive en Supabase). Copiarla es técnicamente el mecanismo para el que está pensada `LocalAuth`, pero no está garantizado — no es lo mismo que "Cambio B" (que sí está descartado) |
| `.wwebjs_cache/` | Caché interna de la librería | No hace falta, se regenera sola |
| `media/` | Multimedia descargada | No hace falta, se regenera sola (`MediaStorage.js` crea el directorio si no existe) |
| `dist/` | Build de `npm run build` (.exe + Chrome embebido) | No hace falta, se regenera con `npm run build` si se necesita el ejecutable standalone |
| `perfiles-recuperados/` | Restos de "Cambio B" (descartado) | No usar, no hace falta |
| `.agents/`, `.claude`, `postman/`, `.postman/` | Herramientas locales (skills de Claude Code, scaffolding de Postman) | No hace falta, no afectan si faltan |

**Pasos completos**, ver el mensaje de la conversación donde se pidió esto — incluye clonar el repo, `npm install`, crear `.env`, y arrancar con `npm run web`.
