const qrcode = require('qrcode');
const createWhatsAppClient = require('./client');
const HistoryExtractor = require('./HistoryExtractor');
const ContactResolver = require('./ContactResolver');
const MediaStorage = require('./MediaStorage');
const MessagePipeline = require('./MessagePipeline');
const config = require('../config');

// El primer chat que se procesa tras 'ready' suele ser el mas reciente/pesado
// de la cuenta (historial completo + sendPeerDataOperationRequest) - con solo
// 5s de margen, la pagina viene crasheando de forma reproducible justo en ese
// primer chat ("Protocol error ... Target closed", sin llegar siquiera a
// downloadMedia). Subido a 15s para darle mas tiempo a WhatsApp Web de
// terminar de asentar sus propias conexiones internas antes de la carga
// inicial mas pesada.
const READY_DELAY_MS = 15000;

function sanitizeClientId(lineLabel) {
    return lineLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Drives a single WhatsApp extraction run at a time (one phone line), for
// testing how many months of history WhatsApp actually lets us pull back.
// Wraps the same client/HistoryExtractor/MessagePipeline the CLI (app.js)
// uses, but exposes QR/progress over getStatus() instead of console.log so a
// separate frontend project can poll it.
class SessionManager {
    constructor({ messageRepository, extractionRunRepository }) {
        this.messageRepository = messageRepository;
        this.extractionRunRepository = extractionRunRepository;
        this._reset();
    }

    _reset() {
        this.state = 'idle';
        this.client = null;
        this.qrDataUrl = null;
        this.lineLabel = null;
        this.monthsLimit = null;
        this.runId = null;
        this.progress = { chatsFound: 0, processed: 0, failed: 0, saved: 0, failedChats: [], emptyChats: [] };
        this.errorMessage = null;
    }

    getStatus() {
        return {
            state: this.state,
            lineLabel: this.lineLabel,
            monthsLimit: this.monthsLimit,
            runId: this.runId,
            qrDataUrl: this.state === 'qr' ? this.qrDataUrl : null,
            progress: this.progress,
            errorMessage: this.errorMessage,
        };
    }

    async start({ lineLabel, monthsLimit }) {
        if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'error') {
            throw new Error('Ya hay una extraccion en curso. Esperá a que termine para iniciar otra.');
        }

        this._reset();
        this.lineLabel = lineLabel;
        this.monthsLimit = monthsLimit || null;
        this.state = 'starting';

        const clientId = sanitizeClientId(lineLabel);

        // Not awaited - start() itself isn't awaited by the API route, so the
        // endpoint returns right away for the frontend to poll getStatus().
        this._buildAndInitClient({ clientId }).catch((err) => {
            this.state = 'error';
            this.errorMessage = err.message;
        });
    }

    async _buildAndInitClient({ clientId }) {
        this.client = createWhatsAppClient({ clientId });
        const contactResolver = new ContactResolver(this.client);
        const mediaStorage = new MediaStorage(config.MEDIA_DIR);
        const messagePipeline = new MessagePipeline({
            contactResolver,
            mediaStorage,
            messageRepository: this.messageRepository,
        });
        const historyExtractor = new HistoryExtractor(this.client, config.HISTORY_LIMIT, this.monthsLimit);

        let historyInProgress = true;
        let historyStarted = false;
        const pendingLiveMessages = [];

        this.client.on('qr', async (qr) => {
            this.state = 'qr';
            this.qrDataUrl = await qrcode.toDataURL(qr);
        });

        this.client.on('auth_failure', (msg) => {
            this.state = 'error';
            this.errorMessage = `Fallo de autenticacion: ${msg}`;
        });

        this.client.on('disconnected', (reason) => {
            if (this.state !== 'completed') {
                this.state = 'error';
                this.errorMessage = `Cliente desconectado: ${reason}`;
            }
        });

        this.client.on('message', (msg) => {
            if (historyInProgress) {
                pendingLiveMessages.push(msg);
                return;
            }
            messagePipeline.process(msg).catch((err) => {
                console.error('Error al procesar mensaje en vivo:', err.message);
            });
        });

        this.client.on('ready', async () => {
            // whatsapp-web.js can fire 'ready' more than once (e.g. on a
            // reconnect). Without this guard a second firing would start a
            // second historyExtractor.run() on top of the first, doubling
            // traffic against WhatsApp and risking a real account logout
            // (this happened once before, see docs/arquitectura.md).
            if (historyStarted) return;
            historyStarted = true;

            this.state = 'extracting';
            await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));

            const chatsFound = await historyExtractor.listChats().then((c) => c.length).catch(() => 0);
            this.runId = await this.extractionRunRepository.create({
                lineLabel: this.lineLabel,
                monthsLimit: this.monthsLimit,
                chatsFound,
            });

            try {
                const result = await historyExtractor.run(
                    (msg, chatInfo) => messagePipeline.process(msg, chatInfo),
                    (progress) => {
                        this.progress = progress;
                    },
                );

                // A dead Puppeteer page (see HistoryExtractor's
                // isPageDeadError) can't be recovered reliably from inside
                // this same process - reconnecting the client in-process was
                // tried and never once completed in real testing. Ending the
                // run here is the known-working path: restarting `npm run
                // web` and starting this same lineLabel again picks up
                // fine, reusing the LocalAuth session on disk (no new QR).
                if (result.crashed) {
                    throw new Error(
                        `La pagina de Chrome se cayo durante la extraccion (${result.remainingChats.length} chats sin procesar). `
                        + 'Reinicia el servidor (npm run web) y volve a arrancar la extraccion con la misma linea para continuar sin pedir QR.'
                    );
                }

                historyInProgress = false;
                for (const msg of pendingLiveMessages) {
                    await messagePipeline.process(msg);
                }

                this.state = 'completed';
                await this.extractionRunRepository.finish(this.runId, {
                    status: 'completed',
                    chatsProcessed: result.chatsProcessed,
                    chatsFailed: result.chatsFailed,
                    messagesSaved: result.messagesSaved,
                    failedChats: result.failedChats,
                    emptyChats: result.emptyChats,
                });
            } catch (err) {
                this.state = 'error';
                this.errorMessage = err.message;

                // Without this, a crashed browser stays alive holding the
                // LocalAuth SingletonLock - the next /api/start for this same
                // lineLabel fails with "browser already running" until
                // someone kills the orphan process by hand.
                const crashedProcess = this.client?.pupBrowser?.process();
                await this.client?.destroy().catch(() => {});
                if (crashedProcess && !crashedProcess.killed) {
                    crashedProcess.kill('SIGKILL');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }

                await this.extractionRunRepository.finish(this.runId, {
                    status: 'error',
                    chatsProcessed: this.progress.processed,
                    chatsFailed: this.progress.failed,
                    messagesSaved: this.progress.saved,
                    failedChats: this.progress.failedChats,
                    emptyChats: this.progress.emptyChats,
                    errorMessage: err.message,
                });
            }
        });

        // initialize() only resolves once the client is ready (which can mean
        // waiting for the user to scan the QR) - fine to await here since this
        // whole method is itself not awaited by start(), so the API endpoint
        // still returns right away for the frontend to poll getStatus().
        try {
            await this.client.initialize();
        } catch (err) {
            // Puppeteer's browser stays alive even when initialize() rejects
            // (e.g. the injection script racing a page reload) - without this
            // it's orphaned, exactly like the stale-process issue seen before.
            await this.client.destroy().catch(() => {});
            throw err;
        }
    }

    async stop() {
        if (this.client) {
            await this.client.destroy().catch(() => {});
        }
        this._reset();
    }
}

module.exports = SessionManager;
