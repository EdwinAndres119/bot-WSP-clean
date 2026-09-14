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

// reuseProfilePath clients MUST launch the same real Chrome that created the
// copied profile, not Puppeteer's own bundled "Chrome for Testing" build -
// confirmed by testing (2026-09-14): with the bundled build the client
// connects and injects fine but WhatsApp still doesn't recognize the session
// as authenticated and asks for a fresh QR, exactly the version-mismatch risk
// flagged in the original investigation doc. Set CHROME_EXECUTABLE_PATH in
// .env to the real chrome.exe (e.g. "C:\Program Files\Google\Chrome\
// Application\chrome.exe") for this to work.
function resolveRealChromePath() {
    return process.env.CHROME_EXECUTABLE_PATH || undefined;
}

// Known-good older WhatsApp Web build. Only used for reuseProfilePath
// clients (lines without a phone to re-scan a QR) - mitigates a whatsapp-web.js
// bug where newer builds rename `_serialized` to `$1` internally, breaking
// HistoryExtractor.listChats()/fetchMessages() (both read `.id._serialized`
// directly). NOT applied to normal QR/LocalAuth clients yet - those work
// fine today and this pin hasn't been validated against a full
// historyExtractor.run() pass, only an isolated getChats() call. Widen this
// to both modes only after that validation (see plan, 2026-09-14).
const PINNED_WEB_VERSION_CACHE = {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023151854-alpha.html',
};

// clientId keeps each phone line's session under its own folder
// (.wwebjs_auth/session-<clientId>) so testing multiple lines one at a time
// doesn't overwrite a previous line's saved login.
//
// reuseProfilePath: for lines with no phone/SIM left to scan a fresh QR.
// Points Puppeteer's userDataDir directly at a COPY of an already-logged-in
// desktop Chrome profile instead of letting LocalAuth manage its own session
// folder - the client reaches 'ready' with no 'qr' event, reusing whatever
// WhatsApp Web session was already stored in that profile's IndexedDB.
// CONFIRMED NOT WORKING RELIABLY as of 2026-09-14 testing (WhatsApp still
// asks for a fresh QR even with valid session data present in the copy, plus
// a flaky Windows-only Puppeteer "browser already running" false positive
// against real Chrome profiles) - kept for reference/future investigation,
// prefer remoteDebugPort below.
//
// remoteDebugPort: also for lines with no phone/SIM, but the reliable path
// (see plan, 2026-09-14 cont. 3) - connects to a Chrome the person already
// has open and logged into WhatsApp Web (started with
// --remote-debugging-port=<port>) instead of launching/copying anything.
// whatsapp-web.js opens a new tab in that same browser, which shares the
// same session, so it comes up ready with no QR.
function createWhatsAppClient(options) {
    const { clientId, reuseProfilePath, remoteDebugPort } =
        typeof options === 'string' || !options ? { clientId: options } : options;

    const puppeteerOptions = {
        headless: true,
        executablePath: resolveChromePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        // Long enough to cover the sync-polling wait (max 30s) plus
        // local-cache pagination, but kept below CHAT_TIMEOUT_MS (5 min)
        // so a genuine hang doesn't block the shared page far longer
        // than our own per-chat timeout already allows for.
        protocolTimeout: 180000,
    };

    if (remoteDebugPort) {
        return new Client({
            userAgent: USER_AGENT,
            puppeteer: {
                browserURL: `http://localhost:${remoteDebugPort}`,
                protocolTimeout: puppeteerOptions.protocolTimeout,
            },
        });
    }

    if (reuseProfilePath) {
        return new Client({
            userAgent: USER_AGENT,
            webVersionCache: PINNED_WEB_VERSION_CACHE,
            puppeteer: {
                ...puppeteerOptions,
                executablePath: resolveRealChromePath(),
                userDataDir: reuseProfilePath,
                // Copied profiles are always marked exit_type "Crashed" (Chrome
                // has no way to know the copy was closed cleanly) - without
                // these, Chrome shows a "restore pages?" prompt/infobar on
                // launch that races with whatsapp-web.js's injection and can
                // also interfere with it detecting the session as valid.
                // Confirmed missing during testing on 2026-09-14 (the original
                // investigation doc already had these, this project's code
                // didn't carry them over).
                args: [...puppeteerOptions.args, '--restore-last-session=false', '--hide-crash-restore-bubble'],
            },
        });
    }

    return new Client({
        authStrategy: new LocalAuth(clientId ? { clientId } : {}),
        userAgent: USER_AGENT,
        puppeteer: puppeteerOptions,
    });
}

module.exports = createWhatsAppClient;
