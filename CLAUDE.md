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
| `MEDIA_TIMEOUT_MS` | `src/config.js` | Opcional, default `60000` (1 min). Corte propio para `downloadMedia()`, que no se puede cancelar solo (ver "Cosas ya resueltas" #8). |
| `SKIP_UNRESOLVED_MEDIA` | `src/config.js` | Opcional, default activado. Poner `false` para intentar descargar también la media que no está `RESOLVED` localmente — **sube mucho el riesgo de crash**, es justo el camino que cuelga la página. |
| `DOWNLOAD_MEDIA` | `src/config.js` | Opcional, default activado. `false` apaga TODA descarga de multimedia (los mensajes igual se guardan, con `has_media: true` y sin archivo). Interruptor de emergencia si el crash aparece en producción, sin tocar código. |

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
- `GET /api/status` → `{state, lineLabel, monthsLimit, runId, qrDataUrl, progress, errorMessage}`. Estados: `idle → starting → qr → extracting → completed`/`error`. `progress` trae `{chatsFound, processed, failed, saved, failedChats, emptyChats, done?}` — `failedChats` es `{chatId, chatNumber, isGroup, chatName, error}[]` (fallo técnico real), `emptyChats` es `{chatId, chatNumber, isGroup, chatName, reason}[]` (se revisó bien, no había mensajes que guardar). `chatNumber` es el número real resuelto desde el `@lid` interno de WhatsApp (`HistoryExtractor._resolveChatNumber()`) — puede venir `null` para grupos (no tienen un número "dueño") o cuando WhatsApp no dejó resolverlo; en ese caso el consumidor debe mostrar `chatId` como respaldo, no dejar la celda vacía (ver nota de `Frontend_WSP` más abajo, quedó un paso atrás de este campo el 2026-09-17). Estas dos listas **nunca se muestran juntas/mezcladas** en el frontend — son conceptos distintos.
- `POST /api/stop` → detiene la extracción en curso (`client.destroy()`).
- `GET /api/runs` → últimas 50 corridas (tabla `extraction_runs`, más reciente primero) para el panel Admin — cada fila trae `failed_chats`/`empty_chats` (mismo shape que arriba, en snake_case por venir directo de la tabla).
- `GET /api/export?runId=N` → descarga un CSV (`Content-Disposition: attachment`) con los mensajes guardados durante esa corrida (filtra `mensajes` por `fetched_at` entre `started_at`/`finished_at` de esa corrida). Sin `runId`, exporta toda la tabla `mensajes`. **No incluye chats vacíos/fallidos** — esos no son mensajes, no tienen fila que exportar en esta tabla.
- `GET /api/export/empty?runId=N` (agregado 2026-09-17) → descarga un CSV con los chats vacíos de esa corrida (`empty_chats` de `extraction_runs`, leído directo por `runId` — no hace falta filtrar por fecha). `runId` es obligatorio acá (a diferencia de `/api/export`), porque `empty_chats` solo existe por corrida, no hay una tabla global equivalente a `mensajes`. Pensado para que el equipo de negocio sepa qué números revisar a mano sin tener que abrir el panel aparte. Todavía no existe un equivalente para `failed_chats` — se dejó afuera a pedido explícito del usuario ("por ahora los importantes son los vacíos"), agregarlo es trivial si lo piden (mismo patrón, ver `MessagePipeline.js`/`server.js`).

## Cosas ya resueltas — NO las vuelvas a "arreglar"

1. **Sync de historial viejo (`chat.endOfHistoryTransferType`)**: WhatsApp permite pedirle al teléfono más historial de un chat solo si `endOfHistoryTransferType === 0` (mismo mecanismo que el botón "Click here to get older messages" de la UI real). Si es `1`/`2`, WhatsApp mismo bloquea ese chat — **no es un bug, es un límite real de la plataforma**, confirmado comparando contra capturas de WhatsApp Web real. El request correcto (verificado contra el propio `Client.js` de la librería) es `sendPeerDataOperationRequest(3, { chatId: chat.id })`, **UNA sola vez por chat**, seguido de polling paciente (`loadEarlierMsgs`) sin volver a mandar el request — reenviarlo cancela el pedido pendiente antes de que el teléfono alcance a responder. Ya implementado así en `HistoryExtractor.js`. También se confirmó (2026-09-15/16) que una sesión **recién vinculada por QR** es bloqueada mucho más agresivamente por WhatsApp que una sesión con más horas activa — repetir la misma corrida horas después, sin re-escanear QR, puede traer varias veces más mensajes.
2. **`protocolTimeout` de Puppeteer** (`src/wa/client.js`) y **`CHAT_TIMEOUT_MS`** (`src/config.js`) van SIEMPRE juntos — `protocolTimeout` tiene que quedar un poco por debajo de `CHAT_TIMEOUT_MS`, si no, subir uno solo no cambia nada (el que sea menor corta primero). Están en `360000`/`420000` (6/7 min) desde el 2026-09-16, porque con `monthsLimit` alto (ej. 6 meses) un chat grande y activo real puede tardar más de 3 min en una sola pasada de paginado (confirmado con CPU de `chrome.exe` subiendo, no colgado). Ya se había probado antes `600000` (10 min) y los cuelgues reales (ej. un `downloadMedia()` trabado) tardaban hasta 10 min en salir como error, bloqueando todo ese tiempo — por eso no subir más de lo necesario. No los subas de nuevo sin una razón concreta.
3. **Guard contra `ready` disparado dos veces**: tanto `app.js` como `SessionManager.js` tienen una bandera (`historyStarted`) para ignorar un segundo `client.on('ready', ...)`. Sin esto, un reconnect dispara una segunda pasada de `historyExtractor.run()` sobre los mismos chats en paralelo, corrompe los diagnósticos y en un incidente real causó un LOGOUT de la cuenta. Si agregás un cliente nuevo en otro lado, replicá este guard.
4. **Mensajes en vivo vs. extracción de historial compiten por la misma página de Puppeteer**: si no se coordinan, saturan el mismo canal CDP y cuelgan/crashean la página. Fix ya aplicado: mientras `historyInProgress` es `true`, los mensajes en vivo se encolan (`pendingLiveMessages`) y se procesan recién cuando `historyExtractor.run()` termina.
5. **Filtro de mensajes de sistema y Estados**: `SYSTEM_MESSAGE_TYPES` en `identifiers.js` (notificaciones tipo "se creó el grupo", etc.) y `status@broadcast` se filtran explícitamente — no son mensajes de chat reales.
6. **Extracción sin QR (perfil de Chrome copiado / `remoteDebugPort`), alias "Cambio B"**: se intentó (2026-09-14) y **falló de forma reproducible** en las tres variantes probadas (perfil copiado, perfil original, conectar a un Chrome ya abierto). Parece un bloqueo deliberado de WhatsApp a herramientas de automatización sobre un perfil no iniciado por el propio flujo de QR. Revertido por completo el 2026-09-15 — **no lo vuelvas a intentar** sin que el usuario lo pida explícitamente sabiendo que ya se descartó.
7. **Login (clave única o cuentas por correo/contraseña)**: se implementó, se revirtió, y se volvió a implementar una clave única, y finalmente se sacó TODA autenticación por instrucción directa de los jefes del usuario (2026-09-14). `UserRepository.js` y `003_users.sql` se borraron el 2026-09-15 por quedar huérfanos. No reintroduzcas ningún tipo de login sin que te lo pidan de nuevo explícitamente.
8. **Crash de página de Puppeteer (`downloadMedia` / `fetchMessages`)** — causa raíz confirmada el 2026-09-17, ver `docs/crash-downloadmedia.md`: `downloadMedia()` de whatsapp-web.js pasa un `AbortController` que nunca aborta, así que una descarga colgada no se puede cancelar y termina matando la sesión CDP entera. Es un bug **abierto y sin fix** upstream ([#3829](https://github.com/pedroslopez/whatsapp-web.js/issues/3829), afecta 1.34.x). **No se puede eliminar del todo desde este código.** Lo que sí está aplicado, y NO hay que revertir:
   - `MEDIA_TIMEOUT_MS` / `SKIP_UNRESOLVED_MEDIA` / `DOWNLOAD_MEDIA` (`config.js`): timeout propio + saltar media que no esté ya `RESOLVED` localmente (evita el re-fetch "expensive" que es el que cuelga). `DOWNLOAD_MEDIA=false` es el interruptor de emergencia, sin tocar código.
   - `isPageGoneError()` vs `isContextDestroyedError()` (`HistoryExtractor.js`): **son dos cosas distintas y no hay que volver a mezclarlas**. `Target closed`/`Session closed`/`detached Frame` = el tab murió, hay que cortar la corrida. `Execution context was destroyed` = WhatsApp Web **se recargó sola** (hace eso periódicamente) y la página vuelve: `_waitForPageReady()` espera hasta ~60s a que `window.WWebJS` se re-inyecte y la corrida **continúa**. Antes se trataba todo como muerte y se perdían cientos de chats por una recarga de 20s.
   - Orden de chats invertido en `listChats()` (más antiguo primero): `getModelsArray()` los devuelve más-reciente-primero, y si el primero resulta ser un chat que crashea la página se pierde todo. Con el orden invertido, un chat problemático cae al final y lo demás ya está guardado. Medido: se pasó de 1 chat procesado antes del crash a 396/418 y de ~0 a 1253 mensajes guardados.
   - `process.on('uncaughtException'/'unhandledRejection')` en `server.js`: la librería dispara un `logout()` interno en su listener de `framenavigated` que en Windows choca con `EBUSY` sobre el perfil de Chrome. Sin este guard, esa promesa rechazada **mataba el proceso entero de `server.js`**, no solo la extracción.
9. **`monthsLimit` cuenta meses de calendario reales, no `meses * 30 días`** (`monthsAgoTimestamp()` en `HistoryExtractor.js`, 2026-09-17). La aproximación vieja de 30 días recortaba la ventana ~4 días de más a 6 meses (y peor cuanto mayor el rango), dejando afuera chats cuya última actividad caía en ese hueco — confirmado con un caso real (chat con último mensaje el 20/3 que quedaba fuera de un corte del 21/3). El corte se calcula **una sola vez por corrida** (antes se recalculaba por chat, así que en una corrida larga se iba corriendo solo). Al arrancar, el log imprime la fecha de corte exacta: `[monthsLimit] 6 meses -> se guardan mensajes desde YYYY-MM-DD en adelante.`
10. **El CSV de `/api/export` se manda con BOM UTF-8** (`'﻿' + csv` en `server.js`). Sin el BOM, Excel adivina mal la codificación y rompe tildes/emojis al abrir el archivo — y Excel Online ni siquiera ofrece el asistente de importación para corregirlo. No lo saques.
11. **`fetched_at` se manda en CADA upsert, no solo en el insert** (`MessagePipeline.js`, 2026-09-17). Antes se dejaba que la columna se seteara sola por `default now()` y el payload del upsert no la incluía a propósito, para "preservar la primera vez que se vio el mensaje" — pero eso rompía el propósito real para el que existe esa columna: `GET /api/export?runId=N` la usa para saber qué mensajes entraron en una corrida puntual. Si una línea se prueba varias veces seguidas (algo que pasa todo el tiempo en desarrollo, y probablemente también en producción con re-extracciones), la mayoría de los mensajes de una corrida nueva **ya existían** de una corrida anterior — su `fetched_at` se quedaba con la fecha vieja, y el export de la corrida nueva salía **vacío** aunque `messages_saved` mostrara un número real. Confirmado en vivo contra Supabase: `runId=29` (100 guardados) exportaba 0 filas. Con el fix, `fetched_at` = "última vez que una corrida confirmó este mensaje", y el export por `runId` funciona siempre para corridas hechas después del fix. **No revertir a "solo en el insert"** — ese comportamiento parecía más prolijo pero rompe el export, que es justo para lo que se agregó la columna. Nada más en el código depende del valor original de "primera vez visto" (verificado con grep, `fetched_at` solo se usa en `MessageRepository.js` y `server.js`).
12. **`GET /api/export/empty?runId=N` no puede "reparar" corridas viejas** (anteriores al fix de arriba): un mensaje que ya tenía `fetched_at` viejo antes del 2026-09-17 se queda así para siempre, no hay forma de saber retroactivamente qué corrida lo trajo. Esto es esperado, no hay que "arreglarlo" — solo avisarle al usuario que las corridas de prueba de hoy (`runId` 21 al 31 aprox.) van a exportar vacío o incompleto si las vuelven a pedir; las corridas de mañana en adelante van a andar bien.

## Primera corrida completa de punta a punta (2026-09-17, runId 29)

Linea "3014051196-final", 6 meses, con todos los arreglos del dia aplicados. **Termino en `completed`**, la
primera del dia que llega al final sin morirse ni necesitar intervencion:

| | Resultado |
|---|---|
| Chats procesados | **512 de 512 (100%)** |
| Mensajes guardados | 100 |
| Chats fallidos | 5 (todos timeouts de Cuenta de empresa, ver seccion siguiente) |
| Crashes de pagina | 0 |

Desglose de los 407 chats sin mensajes — **ninguno es un error**, y conviene tenerlo a mano porque es la
pregunta que hace el area de negocio al ver el Excel:
- **277** "Sin mensajes dentro del rango de meses" → el chat existe pero su ultima actividad es anterior al
  corte. Verificado a mano contra WhatsApp Web en varios casos: correcto.
- **115 + 12** "Bloqueado por WhatsApp" (`endOfHistoryTransferType` 2 / undefined) → limite de la plataforma,
  ver "Cosas ya resueltas" #1. Baja bastante si se repite la corrida con la sesion ya madura.
- **3** "WhatsApp no devolvio historial al pedirselo al telefono".

Contexto util para leer estos numeros: con `monthsLimit` los chats se procesan del mas antiguo al mas
reciente, asi que `saved` se queda en 0 durante buena parte de la corrida y recien despega al cruzar la fecha
de corte. En esta corrida el primer mensaje entro recien en el chat ~380 de 512. **Eso es normal, no es un
bug** — antes de investigar un `saved: 0`, mirar el desglose de `emptyChats`.

## Pendiente de mayor impacto: los chats de "Cuenta de empresa" cuelgan la extraccion

Hallazgo del 2026-09-17, confirmado 3 de 3 contra WhatsApp Web real: **cada vez que una corrida se frena
~6 minutos y termina en `Runtime.callFunctionOn timed out`, el chat culpable es una "Cuenta de empresa"**
(las que muestran *"Actualmente, esta empresa está usando un servicio seguro de Meta para administrar este
chat"*). Casos verificados uno por uno: `573217431017`, `573053482199`, `573023538175`, y despues
"Alpha Y Omega". El historial de esos chats no vive donde el de un chat normal, asi que la consulta dentro
de la pagina nunca resuelve y se come el `protocolTimeout` entero (6 min) para no traer nada.

**Por que importa**: las lineas que se van a extraer en produccion son comerciales, o sea que hablan con
muchisimas cuentas de empresa (operadores, bancos, proveedores). Con 20 chats asi, una corrida pierde 2 horas
en esperas inutiles. Es, de lejos, la mejora con mas impacto real pendiente.

**Fix propuesto (no implementado todavia)**: envolver `loadEarlierMsgs()` en un timeout **dentro** del
`pupPage.evaluate()` de `fetchMessages()` (un `Promise.race` con un `setTimeout` en contexto de navegador que
resuelva `null`). Asi el evaluate siempre retorna con lo que tenga en vez de colgarse, sin importar el tipo de
chat — y no hace falta detectar la cuenta de empresa ni cambiar la semantica del sync (sigue siendo UN solo
`sendPeerDataOperationRequest` + polling paciente, ver "Cosas ya resueltas" #1). Un timeout de ~30s ahi
convertiria 6 minutos perdidos en 30 segundos.

## Riesgo de seguridad — estado a confirmar

Hasta el 2026-09-14, `SUPABASE_KEY` en `.env` era la clave **pública** (`sb_publishable_...`), por lo que RLS estaba desactivado en `mensajes`/`extraction_runs`/`users` (si se activara con esa clave y sin políticas, el propio backend se quedaría sin poder escribir). El 2026-09-16 se observó que la clave actual en `.env` **parece ser un JWT que decodifica a `"role":"service_role"`** — es decir, ya podría ser la clave secreta correcta. **No confirmado de punta a punta** (no se verificó activando RLS y probando una corrida real después). Antes de dar esto por resuelto: confirmar en el dashboard de Supabase (Project Settings → API) cuál es la clave `service_role` real y compararla con la del `.env`; si coincide, correr `004_enable_rls.sql` y probar una extracción completa para confirmar que el backend sigue pudiendo escribir.

## Gotchas operativos

- Cada `lineLabel` usado en `/api/start` se convierte en un `clientId` propio para `LocalAuth` (carpeta `.wwebjs_auth/session-<clientId>`), así que cada línea de prueba mantiene su sesión de WhatsApp aparte sin pisar otras. Esa carpeta está en `.gitignore` — no viaja entre máquinas por git (ver sección de migración más abajo).
- `/api/start` **sí detiene la corrida anterior antes de crear una nueva** `SessionManager` (`sessionManager.stop()`) — pero si el proceso se mató a la fuerza (cierre de terminal, corte de luz, etc.) en medio de una corrida, puede quedar un navegador Chromium huérfano corriendo en segundo plano. Si ves errores tipo `Attempted to use detached Frame` o `Target closed`, revisá procesos con `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` filtrando por `CommandLine` con el `session-<clientId>` correspondiente antes de asumir que es un bug de código.
- Los logs del backend son silenciosos a propósito durante una corrida normal — solo imprime en consola eventos especiales (`"chat": N mensajes encontrados.`, `[sync] ...`, `[monthsLimit] ...`, errores). El progreso real (`chatsProcessed`, `messagesSaved`) se sigue por `/api/status` o la tabla `extraction_runs`, no por la terminal. Los contadores de esa tabla solo se actualizan cada 10 chats procesados (`PROGRESS_INTERVAL` en `HistoryExtractor.js`) — un panel quieto en "0 de N" con chats grandes en curso NO significa que esté trabado.
- Si arrancás el server dos veces (ej. una vez en pm2 y otra vez manual en una terminal), la segunda instancia falla al intentar tomar el puerto 3001 — bajo pm2 esto puede verse como reinicios en loop muy rápidos (`pm2 status`, columna `↺`). Si ves eso, confirmá primero cuál de los dos procesos es el que realmente está respondiendo (`curl http://localhost:3001/api/status`) antes de matar ninguno.
- **Para que un cambio de código tome efecto hay que MATAR el proceso viejo primero.** Lanzar `npm run web` de nuevo sin parar el anterior no falla de forma visible: el nuevo no puede tomar el puerto y muere calladito, y `/api/status` te sigue respondiendo el **estado viejo** (con el código viejo), dando la falsa impresión de que el fix no sirvió. Esto pasó varias veces el 2026-09-17. Antes de reiniciar: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server.js*" }` y `Stop-Process -Id <pid> -Force`.
- **Tras un crash NO hace falta reiniciar el server** (el mensaje de error del panel todavía dice que sí — es texto del frontend, proyecto aparte). Con los guards actuales el proceso sobrevive, el Chrome zombie se limpia solo, y alcanza con darle "Iniciar" de nuevo a la misma línea: reusa la sesión de `LocalAuth`, **no pide QR**, y no duplica nada (el guardado es upsert por `id`). Eso sí: **arranca desde el chat 1 de nuevo**, no retoma donde quedó — `/api/start` no tiene "resume", solo re-procesa todo (lo ya guardado no se duplica, solo tarda más).
- Un contador quieto **no** es un cuelgue: el progreso se publica cada 10 chats (`PROGRESS_INTERVAL`) y un solo chat puede tardar hasta 6-7 min si pega `protocolTimeout`. Para saber si está vivo de verdad, mirá si el log del server **sigue creciendo**, no el contador.
- `saved: 0` con muchos chats procesados suele ser correcto, no un bug: con el orden invertido se procesan primero los chats más viejos, que normalmente caen fuera del `monthsLimit` (`"corto por limite de meses, 0 mensajes dentro del rango"`). Los datos reales aparecen en el tramo final. Antes de investigar, mirá el desglose de motivos en `emptyChats`.
- Los chats vacíos/fallidos **sí quedan persistidos** en `extraction_runs` (`empty_chats` / `failed_chats`, jsonb) y se consultan por `/api/runs`, directo en Supabase, o por `GET /api/export/empty?runId=N` (solo vacíos, ver arriba) — pero **no salen en el CSV** de `/api/export`, que solo exporta la tabla `mensajes`. Si alguien de negocio pregunta "¿por qué este número no trajo nada?", esa respuesta está en el panel o en el CSV de vacíos, no en el Excel de mensajes.
- El CSV se abre bien en **LibreOffice Calc** (muestra el asistente de importación solo): dejar `Unicode (UTF-8)` y **solo "Coma"** tildada como separador. Importante destildar "Punto y coma": el escapado del CSV solo entrecomilla campos con `,`/`"`/salto de línea, así que un `;` dentro de un mensaje partiría la fila en columnas de más. En Excel de escritorio hay que usar **Datos → Desde texto/CSV** (no doble clic).

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
