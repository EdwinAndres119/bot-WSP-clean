const { Message } = require('whatsapp-web.js');
const config = require('../config');


const { SYSTEM_MESSAGE_TYPES } = require('./identifiers');

const MIN_DELAY_MS = 1500;
const DELAY_JITTER_MS = 1500;
const PAGE_DELAY_MS = 600;
const PROGRESS_INTERVAL = 10;

// How long to patiently wait for the phone to respond to a single history
// sync request once the locally cached messages run out (this is a live
// request to the phone, not to WhatsApp's servers - the "Click here to get
// older messages from your phone" button in the real UI triggers the exact
// same request). Polled in SYNC_POLL_MS steps instead of re-sent, since
// re-sending the request before the phone answers the first one appears to
// cancel/override it.
const SYNC_POLLS = 10;
const SYNC_POLL_MS = 3000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

function randomDelay() {
    return new Promise((resolve) => {
        setTimeout(resolve, MIN_DELAY_MS + Math.random() * DELAY_JITTER_MS);
    });
}

class HistoryExtractor {
    // monthsLimit: stop paginating a chat's history once its oldest loaded
    // message crosses this many months back (null = no cutoff, same as
    // before). Used to test how far back WhatsApp actually lets us go.
    constructor(client, historyLimit, monthsLimit = null) {
        this.client = client;
        this.historyLimit = historyLimit;
        this.monthsLimit = monthsLimit;
    }

    // Chat.getModelsArray() is used directly instead of client.getChats(),
    // which fails to serialize most chats under the current WhatsApp Web
    // build (see docs/arquitectura.md).
    async listChats() {
        return this.client.pupPage.evaluate(() => {
            const chats = window.require('WAWebCollections').Chat.getModelsArray();
            return chats.map((c) => ({
                id: c.id._serialized,
                name: c.formattedTitle || c.name || null,
            }));
        });
    }

    // Mirrors Chat.fetchMessages() internally, but fetches the chat with
    // getAsModel: false to avoid the same serialization failure as listChats().
    // limit <= 0 means no cap: keep paging into history until WhatsApp
    // reports there are no earlier messages left to load, asking the phone
    // for more (same as the "get older messages from your phone" button)
    // once the locally cached messages run out.
    async fetchMessages(chatId) {
        const limit = this.historyLimit;
        const cutoffTimestamp = this.monthsLimit
            ? Math.floor(Date.now() / 1000) - this.monthsLimit * 30 * 24 * 3600
            : null;
        const { messages: rawMessages, diagnostics } = await this.client.pupPage.evaluate(async (
            chatId, limit, pageDelayMs, systemTypes, syncPolls, syncPollMs, cutoffTimestamp
        ) => {
            const isRealMessage = (m) => !m.isNotification && !systemTypes.includes(m.type);
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            // msgs is kept oldest-first (each page is prepended), so msgs[0]
            // is always the oldest message loaded so far.
            const pastCutoff = (list) => cutoffTimestamp !== null && list.length > 0 && list[0].t < cutoffTimestamp;

            const diagnostics = {
                ranOutOfLocalCache: false,
                endOfHistoryTransferType: null,
                syncAttempts: 0,
                syncGotMore: false,
                stoppedByMonthsLimit: false,
            };

            const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
            let msgs = chat.msgs.getModelsArray().filter(isRealMessage);

            while (limit <= 0 || msgs.length < limit) {
                if (pastCutoff(msgs)) {
                    diagnostics.stoppedByMonthsLimit = true;
                    break;
                }

                const loaded = await window
                    .require('WAWebChatLoadMessages')
                    .loadEarlierMsgs({ chat });

                if (loaded && loaded.length) {
                    msgs = [...loaded.filter(isRealMessage), ...msgs];
                    await sleep(pageDelayMs);
                    continue;
                }

                // Nothing left locally cached. endOfHistoryTransferType === 0
                // means the phone still has more to give for this chat -
                // request it live, same as clicking "get older messages
                // from your phone" in the real WhatsApp Web UI.
                diagnostics.ranOutOfLocalCache = true;
                diagnostics.endOfHistoryTransferType = chat.endOfHistoryTransferType;
                if (chat.endOfHistoryTransferType !== 0) break;

                // Send the request once - re-sending it before the phone has
                // answered appears to cancel/override the pending one, so we
                // poll patiently instead of re-firing it each attempt.
                await window
                    .require('WAWebSendNonMessageDataRequest')
                    .sendPeerDataOperationRequest(3, { chatId: chat.id });

                let gotMore = false;
                for (let attempt = 0; attempt < syncPolls; attempt++) {
                    diagnostics.syncAttempts++;
                    await sleep(syncPollMs);

                    const afterSync = await window
                        .require('WAWebChatLoadMessages')
                        .loadEarlierMsgs({ chat });
                    if (afterSync && afterSync.length) {
                        msgs = [...afterSync.filter(isRealMessage), ...msgs];
                        gotMore = true;
                        diagnostics.syncGotMore = true;
                        await sleep(pageDelayMs);
                        break;
                    }
                    if (chat.endOfHistoryTransferType !== 0) break;
                }
                if (!gotMore) break;
                if (pastCutoff(msgs)) {
                    diagnostics.stoppedByMonthsLimit = true;
                    break;
                }
            }

            if (cutoffTimestamp !== null) {
                msgs = msgs.filter((m) => m.t >= cutoffTimestamp);
            }

            if (limit > 0 && msgs.length > limit) {
                msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
                msgs = msgs.splice(msgs.length - limit);
            }

            return {
                messages: msgs.map((m) => window.WWebJS.getMessageModel(m)),
                diagnostics,
            };
        }, chatId, limit, PAGE_DELAY_MS, SYSTEM_MESSAGE_TYPES, SYNC_POLLS, SYNC_POLL_MS, cutoffTimestamp);

        return {
            messages: rawMessages.map((m) => new Message(this.client, m)),
            diagnostics,
        };
    }

    async run(onMessage, onProgress) {
        const chats = await this.listChats();
        console.log(`${chats.length} chats encontrados.`);
        if (onProgress) onProgress({ chatsFound: chats.length, processed: 0, failed: 0, saved: 0 });

        let processed = 0;
        let failed = 0;
        let saved = 0;

        for (const chat of chats) {
            if (!this.client.pupPage || this.client.pupPage.isClosed()) {
                console.log('Sesion desconectada, se detiene la extraccion historica.');
                break;
            }

            try {
                const chatInfo = { name: chat.name, isGroup: chat.id.endsWith('@g.us') };
                const { messages, diagnostics } = await withTimeout(this.fetchMessages(chat.id), config.CHAT_TIMEOUT_MS);

                if (diagnostics.ranOutOfLocalCache) {
                    console.log(
                        `[sync] "${chat.name || chat.id}": cache local agotada, `
                        + `endOfHistoryTransferType=${diagnostics.endOfHistoryTransferType}, `
                        + `intentos=${diagnostics.syncAttempts}, obtuvo_mas=${diagnostics.syncGotMore}`
                    );
                }
                if (diagnostics.stoppedByMonthsLimit) {
                    console.log(`[monthsLimit] "${chat.name || chat.id}": corto por limite de meses, ${messages.length} mensajes dentro del rango.`);
                }

                for (const msg of messages) {
                    await onMessage(msg, chatInfo);
                    saved++;
                }
            } catch (err) {
                failed++;
                console.error(`Error al extraer "${chat.name || chat.id}":`, err.message);
            }

            await randomDelay();

            processed++;
            if (processed % PROGRESS_INTERVAL === 0) {
                console.log(`Progreso: ${processed}/${chats.length} chats, ${saved} mensajes guardados.`);
                if (onProgress) onProgress({ chatsFound: chats.length, processed, failed, saved });
            }
        }

        console.log(`Extraccion historica completa: ${saved} mensajes (${failed} chats con error).`);
        if (onProgress) onProgress({ chatsFound: chats.length, processed, failed, saved, done: true });

        return { chatsFound: chats.length, chatsProcessed: processed, chatsFailed: failed, messagesSaved: saved };
    }
}

module.exports = HistoryExtractor;
