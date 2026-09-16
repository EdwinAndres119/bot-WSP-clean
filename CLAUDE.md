# BOT_WSP — extractor de WhatsApp a Supabase

Bot en Node.js que usa `whatsapp-web.js` + Puppeteer para extraer mensajes de WhatsApp (historial completo + mensajes en vivo, con multimedia) hacia una tabla `mensajes` en Supabase.

Repo: https://github.com/EdwinAndres119/prueba-botWSP.git — rama de trabajo: `edwinbranch`.

Este proyecto es **solo el backend**. El frontend vive aparte, en `Frontend_WSP` (carpeta hermana), con su propia sesión de Claude Code. Se comunican únicamente por la API REST (`http://localhost:3001`) — el frontend nunca toca Supabase directo.

## Cómo correrlo

- `npm run start` → `node app.js`: modo CLI original, extrae por consola, sin API.
- `npm run web` → `node server.js`: levanta la API Express en `:3001` (esto es lo que usa el frontend). Usar este para probar con el panel o Postman.
- Variables de entorno en `.env` (gitignored): `SUPABASE_URL`, `SUPABASE_KEY`, `HISTORY_LIMIT`, `CHAT_TIMEOUT_MS`.

## Estructura

- `src/db/` — `SupabaseClient.js`, `MessageRepository.js`, `ExtractionRunRepository.js` (historial de corridas), `UserRepository.js` (login).
- `src/wa/` — `client.js` (factory de cliente whatsapp-web.js/Puppeteer), `ContactResolver.js`, `MediaStorage.js`, `HistoryExtractor.js` (paginación + sync de historial), `MessagePipeline.js` (procesa y guarda un mensaje), `SessionManager.js` (orquesta una corrida completa para la API web), `identifiers.js` (tipos de mensaje de sistema a filtrar).
- `server.js` — API Express (raíz del proyecto).
- `db/schema/*.sql` — correr manualmente en el SQL Editor de Supabase, en orden. `002_extraction_runs.sql` y `003_users.sql` ya deberían estar corridas.

## API (lo que el frontend consume)

Auth por Bearer token (in-memory, se pierde si se reinicia el server — no es una sesión persistente real todavía).

- `POST /api/register` `{name, phone, email, password}` → `{token}` (409 si el correo ya existe, 400 si falta un campo o el email es inválido)
- `POST /api/login` `{email, password}` → `{token}` (401 si las credenciales no coinciden)
- `GET /api/me` (header `Authorization: Bearer <token>`) → `{id, name, phone, email}`
- `POST /api/start` `{lineLabel, monthsLimit?}` → `{ok:true}`. Arranca una extracción (crea un cliente whatsapp-web.js nuevo, `LocalAuth` con `clientId` = `lineLabel` saneado). No espera al QR/ready — responde de inmediato para que el frontend haga polling.
- `GET /api/status` → `{state, lineLabel, monthsLimit, runId, qrDataUrl, progress, errorMessage}`. Estados: `idle → starting → qr → extracting → completed`/`error`.
- `POST /api/stop` → detiene la extracción en curso (`client.destroy()`).
- `GET /api/runs` → últimas 50 corridas (tabla `extraction_runs`), para el panel Admin.

## Cosas ya resueltas — NO las vuelvas a "arreglar"

1. **Sync de historial viejo (`chat.endOfHistoryTransferType`)**: WhatsApp permite pedirle al teléfono más historial de un chat solo si `endOfHistoryTransferType === 0` (mismo mecanismo que el botón "Click here to get older messages" de la UI real). Si es `1`/`2`, WhatsApp mismo bloquea ese chat — **no es un bug, es un límite real de la plataforma**, confirmado comparando contra capturas de WhatsApp Web real. El request correcto (verificado contra el propio `Client.js` de la librería) es `sendPeerDataOperationRequest(3, { chatId: chat.id })`, **UNA sola vez por chat**, seguido de polling paciente (`loadEarlierMsgs`) sin volver a mandar el request — reenviarlo cancela el pedido pendiente antes de que el teléfono alcance a responder. Ya implementado así en `HistoryExtractor.js`.
2. **`protocolTimeout` de Puppeteer** (`src/wa/client.js`) y **`CHAT_TIMEOUT_MS`** (`src/config.js`) van SIEMPRE juntos — `protocolTimeout` tiene que quedar un poco por debajo de `CHAT_TIMEOUT_MS`, si no, subir uno solo no cambia nada (el que sea menor corta primero). Estaban en `180000`/`300000` (3/5 min); se subieron a `360000`/`420000` (6/7 min) el 2026-09-16 porque con `monthsLimit=6` un chat grande y activo real (confirmado con CPU de `chrome.exe` subiendo, no colgado) puede tardar mas de 3 min en una sola pasada de paginado. Ya se habia probado antes `600000` (10 min) y los cuelgues reales (ej. un `downloadMedia()` trabado) tardaban hasta 10 min en salir como error, bloqueando todo ese tiempo — por eso no subir mas de lo necesario. No los subas de nuevo sin una razón concreta.
3. **Guard contra `ready` disparado dos veces**: tanto `app.js` como `SessionManager.js` tienen una bandera (`historyStarted`) para ignorar un segundo `client.on('ready', ...)`. Sin esto, un reconnect dispara una segunda pasada de `historyExtractor.run()` sobre los mismos chats en paralelo, corrompe los diagnósticos y en un incidente real causó un LOGOUT de la cuenta. Si agregás un cliente nuevo en otro lado, replicá este guard.
4. **Mensajes en vivo vs. extracción de historial compiten por la misma página de Puppeteer**: si no se coordinan, saturan el mismo canal CDP y cuelgan/crashean la página. Fix ya aplicado: mientras `historyInProgress` es `true`, los mensajes en vivo se encolan (`pendingLiveMessages`) y se procesan recién cuando `historyExtractor.run()` termina.
5. **Filtro de mensajes de sistema y Estados**: `SYSTEM_MESSAGE_TYPES` en `identifiers.js` (notificaciones tipo "se creó el grupo", etc.) y `status@broadcast` se filtran explícitamente — no son mensajes de chat reales.

## Riesgo de seguridad real, sin resolver (avisado, no bloqueante para pruebas)

`SUPABASE_KEY` en `.env` es del formato nuevo `sb_publishable_...` — es la clave **pública** (equivalente a anon), no la secreta/service-role. Por eso **RLS está desactivado** en `mensajes`, `extraction_runs` y `users` (si se activara con esta clave y sin políticas, el propio backend no podría escribir). Esto significa que cualquiera con esa clave pública podría leer/escribir las tres tablas, incluyendo `password_hash` de `users`. Antes de que esto salga de fase de pruebas hay que migrar a la clave secreta real de Supabase y activar RLS con políticas. No lo arregles sin avisar primero — es una decisión de infraestructura, no un bug de código.

## Gotchas operativos

- Cada `lineLabel` usado en `/api/start` se convierte en un `clientId` propio para `LocalAuth` (carpeta `.wwebjs_auth/session-<clientId>`), así que cada línea de prueba mantiene su sesión de WhatsApp aparte sin pisar otras.
- `/api/start` **no detiene la corrida anterior antes de crear una nueva** `SessionManager` — si arrancás una corrida nueva mientras otra sigue viva (estado no es `idle`/`completed`/`error`), el guard en `SessionManager.start()` debería rechazarla, pero si el server se reinició a la fuerza en el medio, puede quedar un navegador Chromium huérfano corriendo en segundo plano. Si ves errores tipo `Attempted to use detached Frame`, revisá procesos con `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` filtrando por `CommandLine` con el `session-<clientId>` correspondiente antes de asumir que es un bug de código.
- Los logs del backend son silenciosos a propósito durante una corrida normal — solo imprime en consola eventos especiales (`[sync] ...`, `[monthsLimit] ...`, errores). El progreso real (`chatsProcessed`, `messagesSaved`) se sigue por `/api/status` o la tabla `extraction_runs`, no por la terminal. Los contadores de esa tabla solo se actualizan cada 10 chats procesados.
