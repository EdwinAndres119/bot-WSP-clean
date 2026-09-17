const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '0', 10);
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '420000', 10);
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// downloadMedia() de whatsapp-web.js pasa un AbortController que nunca se
// aborta (ver docs/crash-downloadmedia.md) - si la descarga se cuelga del
// lado de WhatsApp, la pagina de Puppeteer queda muerta para siempre. Estos
// tres flags son la mitigacion: cortar la espera con nuestro propio timeout,
// evitar el camino de descarga "expensive" para media no resuelta local, y
// un apagado total de emergencia si hiciera falta.
const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_TIMEOUT_MS || '60000', 10);
const SKIP_UNRESOLVED_MEDIA = process.env.SKIP_UNRESOLVED_MEDIA !== 'false';
const DOWNLOAD_MEDIA = process.env.DOWNLOAD_MEDIA !== 'false';

module.exports = {
    PROJECT_ROOT,
    HISTORY_LIMIT,
    CHAT_TIMEOUT_MS,
    MEDIA_DIR,
    SUPABASE_URL,
    SUPABASE_KEY,
    MEDIA_TIMEOUT_MS,
    SKIP_UNRESOLVED_MEDIA,
    DOWNLOAD_MEDIA,
};
