const fs = require('fs');
const path = require('path');
const { sanitizeFilename } = require('./identifiers');
const config = require('../config');

const EMPTY_RESULT = { hasMedia: false, mimetype: null, filename: null, mediaPath: null };

class MediaStorage {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    async save(msg, messageId) {
        if (!msg.hasMedia) {
            return EMPTY_RESULT;
        }

        try {
            const media = await msg.downloadMedia();
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

            // These mean the underlying Puppeteer page/frame is dead, not
            // that this one message's media failed - every subsequent
            // download will fail identically until the caller stops.
            // Rethrow so HistoryExtractor's per-chat catch can cut the loop
            // short instead of burning through hundreds of messages/chats.
            if (/Target closed|detached Frame|Session closed/.test(err.message)) {
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
