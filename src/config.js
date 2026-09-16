const path = require('path');
require('dotenv').config();

const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '0', 10);
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '420000', 10);
const MEDIA_DIR = path.join(PROJECT_ROOT, 'media');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

module.exports = {
    PROJECT_ROOT,
    HISTORY_LIMIT,
    CHAT_TIMEOUT_MS,
    MEDIA_DIR,
    SUPABASE_URL,
    SUPABASE_KEY,
};
