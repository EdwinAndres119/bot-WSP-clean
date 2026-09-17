const { Message } = require('whatsapp-web.js');
const config = require('../config');


const { SYSTEM_MESSAGE_TYPES, cleanNumber } = require('./identifiers');

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

// How long to wait for WhatsApp Web to come back after it reloads itself
// mid-run (see isContextDestroyedError).
const PAGE_READY_POLLS = 6;
const PAGE_READY_POLL_MS = 10000;

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Real calendar months, not months * 30 days: "6 meses" in the panel is read
// by the business side as calendar months, and the 30-day approximation cut
// the window ~4 days short at 6 months (and grows worse the larger the range),
// silently dropping chats whose last activity fell in that gap.
function monthsAgoTimestamp(months) {
    const cutoff = new Date();
    const dayOfMonth = cutoff.getDate();
    cutoff.setMonth(cutoff.getMonth() - months);
    // Going back from e.g. the 31st lands on a month that has no such day and
    // rolls forward into the next one, which would narrow the window instead
    // of widening it. setDate(0) snaps back to the intended month's last day.
    if (cutoff.getDate() !== dayOfMonth) {
        cutoff.setDate(0);
    }
    // Medianoche y no la hora actual: si no, del dia del corte solo entrarian
    // los mensajes posteriores a la hora en que se arranco la corrida, y se
    // perderia casi todo ese dia sin que nadie lo note (visto en un caso real:
    // un corte a las 17:52 dejaba afuera 18 horas del 17 de marzo).
    cutoff.setHours(0, 0, 0, 0);
    return Math.floor(cutoff.getTime() / 1000);
}

function randomDelay() {
    return new Promise((resolve) => {
        setTimeout(resolve, MIN_DELAY_MS + Math.random() * DELAY_JITTER_MS);
    });
}

// The tab itself is gone. Nothing to wait for - every remaining chat would
// fail identically, so the caller should stop and let the client be rebuilt
// (see MediaStorage.js's matching check).
function isPageGoneError(err) {
    return /Target closed|detached Frame|Session closed/.test(err.message);
}

// WhatsApp Web reloads itself periodically (updates, reconnects, session
// sync), which destroys the execution context of whatever evaluate() was in
// flight. The page survives that - whatsapp-web.js re-injects window.WWebJS
// on 'framenavigated' - so this is worth waiting out instead of throwing away
// the rest of the run. Checked only after isPageGoneError, since a dead tab
// reports as "Protocol error (...): Target closed" and matches both.
function isContextDestroyedError(err) {
    return /Execution context was destroyed|Protocol error/.test(err.message);
}

// A chat with 0 messages is NOT a failure (fetchMessages succeeded fine) -
// it's a distinct outcome from an error, so it needs its own reason instead
// of being lumped into failedChats.
function describeEmptyReason(diagnostics) {
    if (diagnostics.stoppedByMonthsLimit) return 'Sin mensajes dentro del rango de meses';
    if (diagnostics.ranOutOfLocalCache && diagnostics.endOfHistoryTransferType !== 0) {
        return `Bloqueado por WhatsApp, sin historial disponible (endOfHistoryTransferType=${diagnostics.endOfHistoryTransferType})`;
    }
    if (diagnostics.ranOutOfLocalCache && diagnostics.endOfHistoryTransferType === 0) {
        return 'WhatsApp no devolvio historial al pedirselo al telefono';
    }
    return 'Chat sin mensajes';
}

class HistoryExtractor {
    // monthsLimit: stop paginating a chat's history once its oldest loaded
    // message crosses this many months back (null = no cutoff, same as
    // before). Used to test how far back WhatsApp actually lets us go.
    constructor(client, historyLimit, monthsLimit = null) {
        this.client = client;
        this.historyLimit = historyLimit;
        this.monthsLimit = monthsLimit;
        // Computed once per run, not per chat: a long run would otherwise
        // drift its own cutoff by however many hours it takes to finish.
        this.cutoffTimestamp = monthsLimit ? monthsAgoTimestamp(monthsLimit) : null;
    }

    // After WhatsApp Web reloads itself, the page answers again long before
    // whatsapp-web.js finishes re-injecting - so a plain "does the page
    // respond" probe would return too early and the next chat would fail on a
    // missing window.WWebJS. Waiting for that global specifically is the real
    // readiness signal.
    async _waitForPageReady() {
        for (let attempt = 0; attempt < PAGE_READY_POLLS; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, PAGE_READY_POLL_MS));
            try {
                const ready = await this.client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined');
                if (ready) return true;
            } catch (err) {
                if (isPageGoneError(err)) return false;
            }
        }
        return false;
    }

    // failedChats/emptyChats need a real phone number, not the opaque @lid
    // WhatsApp uses internally - groups (@g.us) don't have one to resolve,
    // there's no single "owner" number for a group chat.
    async _resolveChatNumber(chatId) {
        if (chatId.endsWith('@g.us')) return null;
        if (!chatId.endsWith('@lid')) return cleanNumber(chatId);

        try {
            const [result] = await this.client.getContactLidAndPhone([chatId]);
            if (result && result.pn) return cleanNumber(result.pn);
        } catch (err) {
            // Keep null if WhatsApp won't resolve it (matches ContactResolver's fallback).
        }
        return null;
    }

    // Chat.getModelsArray() is used directly instead of client.getChats(),
    // which fails to serialize most chats under the current WhatsApp Web
    // build (see docs/arquitectura.md).
    //
    // getModelsArray() returns chats most-recently-active first. Reversed
    // here: in repeated real testing, whichever chat lands first gets hit
    // the instant the page is freshest/least warmed-up, and if THAT chat's
    // content happens to crash the page (seen 4 times in a row with the same
    // chat, unaffected by adding more warm-up delay - looks like a
    // content-specific crash, same pattern as the "video notes" chat
    // documented in docs/arquitectura.md), every other chat is lost too.
    // Processing oldest-active-first means a single problematic chat crashes
    // near the END of the run instead of at the very start, so everything
    // else still gets saved first either way.
    async listChats() {
        const chats = await this.client.pupPage.evaluate(() => {
            const chats = window.require('WAWebCollections').Chat.getModelsArray();
            return chats.map((c) => ({
                id: c.id._serialized,
                name: c.formattedTitle || c.name || null,
            }));
        });
        return chats.reverse();
    }

    // Mirrors Chat.fetchMessages() internally, but fetches the chat with
    // getAsModel: false to avoid the same serialization failure as listChats().
    // limit <= 0 means no cap: keep paging into history until WhatsApp
    // reports there are no earlier messages left to load, asking the phone
    // for more (same as the "get older messages from your phone" button)
    // once the locally cached messages run out.
    async fetchMessages(chatId) {
        const limit = this.historyLimit;
        const cutoffTimestamp = this.cutoffTimestamp;
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
        const totalChats = chats.length;
        console.log(`${totalChats} chats encontrados.`);
        if (this.cutoffTimestamp) {
            console.log(
                `[monthsLimit] ${this.monthsLimit} meses -> se guardan mensajes desde `
                + `${new Date(this.cutoffTimestamp * 1000).toISOString().slice(0, 10)} en adelante.`
            );
        }

        let processed = 0;
        let failed = 0;
        let saved = 0;
        const failedChats = [];
        const emptyChats = [];
        if (onProgress) onProgress({ chatsFound: totalChats, processed, failed, saved, failedChats, emptyChats });

        for (let i = 0; i < chats.length; i++) {
            const chat = chats[i];

            if (!this.client.pupPage || this.client.pupPage.isClosed()) {
                console.log('Sesion desconectada, se detiene la extraccion historica.');
                break;
            }

            try {
                const chatInfo = { name: chat.name, isGroup: chat.id.endsWith('@g.us') };
                const { messages, diagnostics } = await withTimeout(this.fetchMessages(chat.id), config.CHAT_TIMEOUT_MS);

                console.log(`"${chat.name || chat.id}": ${messages.length} mensajes encontrados.`);

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

                if (messages.length === 0) {
                    emptyChats.push({
                        chatId: chat.id,
                        chatNumber: await this._resolveChatNumber(chat.id),
                        isGroup: chatInfo.isGroup,
                        chatName: chat.name || chat.id,
                        reason: describeEmptyReason(diagnostics),
                    });
                }

                for (const msg of messages) {
                    await onMessage(msg, chatInfo);
                    saved++;
                }
            } catch (err) {
                failed++;
                let pageDead = isPageGoneError(err);
                // Resolving the number needs a live client - skip it on a
                // page-dead crash, that call would just fail too and delay
                // reporting the crash for nothing.
                failedChats.push({
                    chatId: chat.id,
                    chatNumber: pageDead ? null : await this._resolveChatNumber(chat.id),
                    isGroup: chat.id.endsWith('@g.us'),
                    chatName: chat.name || chat.id,
                    error: err.message,
                });
                console.error(`Error al extraer "${chat.name || chat.id}":`, err.message);

                // A reload only costs this one chat, as long as we wait for
                // WhatsApp Web to finish coming back before moving on.
                if (!pageDead && isContextDestroyedError(err)) {
                    console.error('La pagina de WhatsApp se recargo, esperando a que vuelva...');
                    const recovered = await this._waitForPageReady();
                    console.error(recovered
                        ? 'Pagina de WhatsApp lista de nuevo, se retoma la extraccion.'
                        : 'La pagina de WhatsApp no volvio a tiempo.');
                    pageDead = !recovered;
                }

                if (pageDead) {
                    const remainingChats = chats.slice(i + 1);
                    console.error(`Pagina de Chrome caida, se corta la extraccion (${remainingChats.length} chats sin procesar).`);
                    if (onProgress) onProgress({ chatsFound: totalChats, processed, failed, saved, failedChats, emptyChats });
                    return { crashed: true, remainingChats };
                }
            }

            await randomDelay();

            processed++;
            if (processed % PROGRESS_INTERVAL === 0) {
                console.log(`Progreso: ${processed}/${totalChats} chats, ${saved} mensajes guardados.`);
                if (onProgress) onProgress({ chatsFound: totalChats, processed, failed, saved, failedChats, emptyChats });
            }
        }

        console.log(`Extraccion historica completa: ${saved} mensajes (${failed} chats con error, ${emptyChats.length} chats sin mensajes).`);
        if (onProgress) onProgress({ chatsFound: totalChats, processed, failed, saved, failedChats, emptyChats, done: true });

        return {
            chatsFound: totalChats,
            chatsProcessed: processed,
            chatsFailed: failed,
            messagesSaved: saved,
            failedChats,
            emptyChats,
        };
    }
}

module.exports = HistoryExtractor;
