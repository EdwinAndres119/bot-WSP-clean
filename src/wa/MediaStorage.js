const fs = require('fs');
const path = require('path');
const { sanitizeFilename } = require('./identifiers');
const config = require('../config');

const EMPTY_RESULT = { hasMedia: false, mimetype: null, filename: null, mediaPath: null };

// Promise.race con limpieza del timer: sin el clearTimeout, cada descarga
// deja un timer vivo que puede mantener el proceso de Node despierto de mas.
// No cancela la promesa colgada dentro de la pagina (downloadMedia() no es
// cancelable, ver docs/crash-downloadmedia.md) - solo evita que Node se
// quede esperando esa promesa para siempre.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout de ${label} tras ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class MediaStorage {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    // Evita el camino "expensive" de downloadMedia(): si la media de un
    // mensaje no esta ya resuelta localmente, la libreria dispara un
    // re-fetch contra WhatsApp que, para media vieja/expirada, se cuelga
    // para siempre (causa raiz del crash, ver docs/crash-downloadmedia.md).
    // Ante cualquier duda (evaluate falla, mensaje no encontrado) se salta -
    // preferible perder una media a matar la pagina entera.
    async _isMediaResolved(msg) {
        try {
            return await msg.client.pupPage.evaluate((msgId) => {
                const m = window.require('WAWebCollections').Msg.get(msgId);
                return m?.mediaData?.mediaStage === 'RESOLVED';
            }, msg.id._serialized);
        } catch {
            return false;
        }
    }

    async save(msg, messageId) {
        if (!msg.hasMedia) {
            return EMPTY_RESULT;
        }

        if (!config.DOWNLOAD_MEDIA) {
            return { ...EMPTY_RESULT, hasMedia: true };
        }

        console.log(
            `[media] intentando descargar ${messageId}: type=${msg.type}, `
            + `isViewOnce=${msg.isViewOnce}, timestamp=${new Date(msg.timestamp * 1000).toISOString()}`
        );

        if (config.SKIP_UNRESOLVED_MEDIA && !(await this._isMediaResolved(msg))) {
            return { ...EMPTY_RESULT, hasMedia: true };
        }

        try {
            const media = await withTimeout(msg.downloadMedia(), config.MEDIA_TIMEOUT_MS, 'descarga de multimedia');
            if (!media || !media.data) {
                return { ...EMPTY_RESULT, hasMedia: true };
            }

            const targetDir = path.join(this.baseDir, this._today());
            fs.mkdirSync(targetDir, { recursive: true });

            const extension = media.mimetype ? media.mimetype.split('/')[1].split(';')[0] : 'bin';
            const filename = `${sanitizeFilename(messageId)}.${extension}`;
            const fullPath = path.join(targetDir, filename);

            fs.writeFileSync(fullPath, Buffer.from(media.data, 'base64'));

            const relativePath = path.relative(config.PROJECT_ROOT, fullPath).split(path.sep).join('/');

            return {
                hasMedia: true,
                mimetype: media.mimetype || null,
                filename: media.filename || filename,
                mediaPath: relativePath,
            };
        } catch (err) {
            console.error('No se pudo descargar el multimedia:', err.message);

            // These mean the underlying Puppeteer page/frame is dead or the
            // page reloaded under us, not that this one message's media
            // failed - every subsequent download would fail identically.
            // Rethrow so HistoryExtractor's per-chat catch can decide whether
            // to wait out a reload or cut the run short, instead of burning
            // through hundreds of messages/chats.
            if (/Target closed|detached Frame|Session closed|Execution context was destroyed|Protocol error/.test(err.message)) {
                throw err;
            }

            return { ...EMPTY_RESULT, hasMedia: true };
        }
    }

    _today() {
        return new Date().toISOString().slice(0, 10);
    }
}

module.exports = MediaStorage;
