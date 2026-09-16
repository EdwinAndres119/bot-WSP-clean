const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Real desktop Chrome user-agent so WhatsApp does not see an inconsistent
// browser fingerprint (Puppeteer's default is a common automation signal).
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function resolveChromePath() {
    if (!process.pkg) return undefined;

    const bundledPath = path.join(path.dirname(process.execPath), 'chrome-win64', 'chrome.exe');
    return fs.existsSync(bundledPath) ? bundledPath : undefined;
}

// clientId keeps each phone line's session under its own folder
// (.wwebjs_auth/session-<clientId>) so testing multiple lines one at a time
// doesn't overwrite a previous line's saved login.
function createWhatsAppClient(options) {
    const { clientId } = typeof options === 'string' || !options ? { clientId: options } : options;

    return new Client({
        authStrategy: new LocalAuth(clientId ? { clientId } : {}),
        userAgent: USER_AGENT,
        puppeteer: {
            headless: true,
            executablePath: resolveChromePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            // Long enough to cover the sync-polling wait (max 30s) plus
            // local-cache pagination for a large chat over a wide monthsLimit
            // window (confirmed real work, not a hang, via chrome.exe CPU
            // climbing during a 6-month run on a 2000+ message chat) - kept
            // below CHAT_TIMEOUT_MS (7 min) so a genuine hang still surfaces
            // as this specific Puppeteer error instead of the generic one.
            protocolTimeout: 360000,
        },
    });
}

module.exports = createWhatsAppClient;
