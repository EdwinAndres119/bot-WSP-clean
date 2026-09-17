# Crash de `downloadMedia()` — causa raíz y planes de mitigación

> Escrito el 2026-09-16 para la sesión que trabaja en el PC de la empresa (`bot-WSP-clean`).
> **Aviso de honestidad:** el análisis de causa raíz está verificado leyendo el código real de la
> librería y los issues upstream. Los parches propuestos **no se probaron contra una sesión real de
> WhatsApp** (se escribieron desde otra máquina, sin acceso a la línea de pruebas). Probar antes de
> confiar en ellos.

## El síntoma

Durante la extracción, `msg.downloadMedia()` sobre un mensaje puntual mata **toda la página de
Puppeteer**:

```
Protocol error (Runtime.callFunctionOn): Target closed
```

A partir de ahí, todos los chats siguientes fallan en cascada con `Attempted to use detached Frame`.
No es determinista por chat: se vio en "Perro" (3 veces), "Red de Consejeros UM", "Mi Cachetona💕",
"Ventas cipres", "Arango" (2 veces).

## Causa raíz — confirmada leyendo el código de la librería

En `node_modules/whatsapp-web.js/src/structures/Message.js`, dentro del `pupPage.evaluate()` de
`downloadMedia()` (~línea 569):

```js
const decryptedMedia = await window
    .require('WAWebDownloadManager')
    .downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        // ...
        signal: new AbortController().signal,   // <-- SE CREA Y NUNCA SE LLAMA .abort()
        downloadQpl: mockQpl,
    });
```

Se construye un `AbortController` nuevo y **nunca se aborta**. La descarga dentro de la página es
literalmente imposible de cancelar. Si el CDN de WhatsApp no responde (media expirada del lado del
servidor, `directPath` muerto, hipo de red), esa promesa queda colgada **para siempre** dentro del
navegador.

Y unas líneas antes (~535-540) está el camino que más riesgo tiene:

```js
if (msg.mediaData.mediaStage != 'RESOLVED') {
    // try to resolve media
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
}
```

Si la media no está ya resuelta en la caché local, primero dispara un **re-fetch "caro"** contra los
servidores de WhatsApp. Para mensajes viejos cuya media ya expiró, ahí es donde se cuelga.

### Secuencia completa del crash

1. Mensaje con media no resuelta o expirada → re-fetch "expensive" contra WhatsApp.
2. La descarga se cuelga dentro de la página, sin forma de cancelarse.
3. Node queda esperando en `Runtime.callFunctionOn`.
4. Salta el `protocolTimeout` de Puppeteer (hoy 6 min, antes 3).
5. La sesión CDP queda con una promesa pendiente eterna → toda llamada posterior:
   `Target closed` / `detached Frame`.

### Confirmación upstream

- Issue [#3829 — "downloadMedia() blocking issue: add timeout to prevent indefinite hang"](https://github.com/pedroslopez/whatsapp-web.js/issues/3829):
  describe exactamente esto (cuelgue indefinido + crash "Target closed"). **Está abierto, sin fix
  mergeado.** Afecta 1.34.x — este proyecto usa 1.34.7.
- PRs de comunidad ([#179](https://github.com/Adi1231234/whatsapp-web.js/pull/179),
  [#183](https://github.com/Adi1231234/whatsapp-web.js/pull/183)) añaden un dato importante: **ni
  siquiera abortar garantiza que se resuelva** — observaron una descarga estancada "todavía colgada,
  sin abortar, después de 5.6 minutos". Hay que correr una carrera contra un deadline, no confiar
  solo en el abort.

### Por qué una sesión recién vinculada crashea más

El reporte previo lo atribuyó a que el set de mensajes es distinto. Eso es cierto, pero hay una razón
más directa: **una sesión nueva casi no tiene media en `mediaStage: RESOLVED`**, así que
prácticamente toda descarga toma el camino "expensive"/riesgoso. Una sesión con días de uso ya tiene
mucha media resuelta localmente y ni siquiera lo intenta.

---

## Los 4 planes

Son **capas acumulables**, no alternativas excluyentes.

### Plan B — red de seguridad (aplicar esta sí o sí, es la de mejor relación impacto/riesgo)

Envolver la descarga en un timeout propio del lado de Node. Aunque la promesa dentro de la página
nunca se resuelva, Node sigue adelante: guarda el mensaje **sin** su media y continúa con el
siguiente chat, en vez de quemar 6 minutos y matar la página.

En `src/wa/MediaStorage.js`:

```js
const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_TIMEOUT_MS || '60000', 10);

// Promise.race con limpieza del timer: sin el clearTimeout, cada descarga deja
// un timer vivo que puede mantener el proceso de Node despierto de más.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout de ${label} tras ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

y en `save()`:

```js
const media = await withTimeout(msg.downloadMedia(), MEDIA_TIMEOUT_MS, 'descarga de multimedia');
```

**Importante:** el `catch` existente ya hace lo correcto con esto — el mensaje de error del timeout
no matchea `/Target closed|detached Frame|Session closed/`, así que **no** re-lanza ni corta la
corrida; cae en el `return { ...EMPTY_RESULT, hasMedia: true }` y sigue. No hay que tocar esa lógica.

**Limitación honesta:** esto no cancela la promesa colgada dentro de la página; queda un "zombie"
pendiente. En la práctica una o dos por corrida son tolerables, pero si se acumulan muchas, la página
puede degradarse igual. Por eso conviene combinarlo con el Plan C.

### Plan C — evitar el camino riesgoso (barato, alto impacto)

No disparar el re-fetch "expensive": si la media no está ya resuelta localmente, saltarla. Se pierde
justo la media que probablemente ya expiró, a cambio de esquivar la causa del cuelgue.

```js
async _isMediaResolved(msg) {
    try {
        return await msg.client.pupPage.evaluate((msgId) => {
            const m = window.require('WAWebCollections').Msg.get(msgId);
            return m?.mediaData?.mediaStage === 'RESOLVED';
        }, msg.id._serialized);
    } catch {
        return false;   // ante la duda, saltar: mejor perder una media que matar la página
    }
}
```

y al principio de `save()`:

```js
if (process.env.SKIP_UNRESOLVED_MEDIA !== 'false' && !(await this._isMediaResolved(msg))) {
    return { ...EMPTY_RESULT, hasMedia: true };
}
```

### Plan A — fix de causa raíz (el correcto, pero dejarlo para después de la entrega)

Reemplazar `msg.downloadMedia()` por una implementación propia que replique el mismo `evaluate` pero
con un **abort signal real**. Esto es consistente con la arquitectura ya establecida del proyecto: ya
se bypassean métodos rotos de la librería con evaluates propios (ver `docs/arquitectura.md`,
`listChats()`/`fetchMessages()`).

```js
async _downloadMediaConAbort(msg, timeoutMs) {
    return msg.client.pupPage.evaluate(async (msgId, timeoutMs) => {
        const m = window.require('WAWebCollections').Msg.get(msgId);
        if (!m || !m.mediaData || m.mediaData.mediaStage === 'REUPLOADING') return null;
        // Nunca disparamos el re-fetch "expensive": si no está resuelta, se salta.
        if (m.mediaData.mediaStage !== 'RESOLVED') return null;

        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const decrypted = await window
            .require('WAWebDownloadManager')
            .downloadManager.downloadAndMaybeDecrypt({
                directPath: m.directPath,
                encFilehash: m.encFilehash,
                filehash: m.filehash,
                mediaKey: m.mediaKey,
                mediaKeyTimestamp: m.mediaKeyTimestamp,
                type: m.type,
                signal: AbortSignal.timeout(timeoutMs),   // <-- LA DIFERENCIA CLAVE
                downloadQpl: mockQpl,
            });

        return {
            data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
            mimetype: m.mimetype,
            filename: m.filename,
            filesize: m.size,
        };
    }, msg.id._serialized, timeoutMs);
}
```

Devuelve un objeto plano en vez de un `MessageMedia`, pero `MediaStorage` solo usa `.data`,
`.mimetype` y `.filename`, así que sirve igual.

`AbortSignal.timeout()` existe desde Chrome 103 — la versión en uso (146) lo soporta sin problema.

**Seguir envolviéndolo en el Plan B igual**: según los PRs de comunidad, hay casos donde ni el abort
alcanza.

### Plan D — interruptor de emergencia para el viernes

Si el viernes algo sale mal y hay que entregar sí o sí, apagar la descarga de media por completo.
Extracción 100% de texto y metadata, sin ninguna posibilidad de este crash:

```js
// al principio de save()
if (process.env.DOWNLOAD_MEDIA === 'false') {
    return { ...EMPTY_RESULT, hasMedia: true };
}
```

Los mensajes se guardan igual con `has_media: true`, así que después se puede hacer una segunda
pasada solo para la media, sin perder trazabilidad de cuáles faltan.

---

## Diagnóstico que falta (pregunta abierta del reporte anterior)

Para identificar con certeza qué mensaje dispara el crash la próxima vez, loguear **antes** de la
descarga (así la línea ya está en el log aunque la página muera justo después):

```js
console.log(
    `[media] intentando descargar ${messageId}: type=${msg.type}, `
    + `isViewOnce=${msg.isViewOnce}, timestamp=${new Date(msg.timestamp * 1000).toISOString()}`
);
```

## Recomendación para la entrega del viernes

1. Aplicar **Plan B + Plan C** (bajo riesgo, ~30 min, ataca el 90% del problema).
2. Dejar **Plan D** documentado como interruptor de emergencia (una variable de entorno, sin tocar
   código el día de la entrega).
3. Dejar **Plan A** para después de entregar: es el fix de fondo, pero merece pruebas con calma.
4. La mitigación que ya existe (detección de página muerta + corte limpio + SIGKILL del Chrome
   zombie) **es correcta y hay que conservarla** — sigue siendo la última línea de defensa.

### Cómo probarlo

El crash es más fácil de reproducir con una **línea recién vinculada por QR** (casi nada de media
resuelta localmente → casi todo toma el camino riesgoso). Usar una línea de prueba nueva, no una
sesión con días de uso, y correr con `monthsLimit` alto sobre un chat con bastante multimedia.

Criterio de éxito: la corrida **termina completa** (`completed`, no `error`), aunque algunos chats
queden registrados con media faltante.

## Nota aparte (no es la causa del crash)

`MessageRepository.save()` hace `upsert(row, { onConflict: 'id' })` sin incluir `fetched_at` en el
payload, así que un mensaje que ya existía de una corrida anterior **conserva su `fetched_at`
original**. Efecto: `/api/export?runId=N` puede devolver vacío para una corrida que sí procesó
mensajes, si esos mensajes ya estaban guardados de antes. Es una limitación conocida para auditar,
no un bug del crash.
