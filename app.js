const qrcode = require('qrcode-terminal');

const config = require('./src/config');
const supabase = require('./src/db/SupabaseClient');
const MessageRepository = require('./src/db/MessageRepository');
const ContactResolver = require('./src/wa/ContactResolver');
const MediaStorage = require('./src/wa/MediaStorage');
const MessagePipeline = require('./src/wa/MessagePipeline');
const HistoryExtractor = require('./src/wa/HistoryExtractor');
const createWhatsAppClient = require('./src/wa/client');
const { handleCommand } = require('./src/wa/commands');

const READY_DELAY_MS = 5000;
const INIT_MAX_ATTEMPTS = 3;
const INIT_RETRY_DELAY_MS = 3000;

const client = createWhatsAppClient();

const messageRepository = new MessageRepository(supabase);
const contactResolver = new ContactResolver(client);
const mediaStorage = new MediaStorage(config.MEDIA_DIR);
const messagePipeline = new MessagePipeline({ contactResolver, mediaStorage, messageRepository });
const historyExtractor = new HistoryExtractor(client, config.HISTORY_LIMIT);

client.on('qr', (qr) => {
    console.log('Escanea el codigo QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Autenticacion exitosa');
});

client.on('auth_failure', (msg) => {
    console.error('Error de autenticacion:', msg);
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado:', reason);
});

let readyFired = false;
let historyStarted = false;

// Mientras corre historyExtractor.run(), los mensajes en vivo compiten por
// la misma pagina de Puppeteer (downloadMedia, resolver contacto, etc.) con
// las llamadas largas de sync del historico, lo que satura la pagina y la
// cuelga o la crashea. Se encolan y se procesan despues, en vez de en
// paralelo, para no perder mensajes ni competir por la pagina.
let historyInProgress = true;
const pendingLiveMessages = [];

client.on('ready', async () => {
    readyFired = true;
    if (historyStarted) return;
    historyStarted = true;

    console.log('Cliente de WhatsApp conectado');

    // Da tiempo a que WhatsApp Web termine de inicializar sus modulos
    // internos antes de leer el historial de chats.
    await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));

    await historyExtractor.run((msg, chatInfo) => messagePipeline.process(msg, chatInfo));

    historyInProgress = false;
    console.log(`Procesando ${pendingLiveMessages.length} mensajes en vivo recibidos durante el historico...`);
    for (const msg of pendingLiveMessages) {
        await messagePipeline.process(msg);
        await handleCommand(msg);
    }
});

client.on('message', async (msg) => {
    console.log(`Mensaje de ${msg.from}: ${msg.body}`);

    if (historyInProgress) {
        pendingLiveMessages.push(msg);
        return;
    }

    await messagePipeline.process(msg);
    await handleCommand(msg);
});

async function initializeWithRetry() {
    for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt++) {
        try {
            await client.initialize();
            return;
        } catch (err) {
            if (readyFired) {
                console.log('El cliente ya habia quedado listo antes de este error; no se reintenta.');
                return;
            }
            const isContextRace = err.message && err.message.includes('Execution context was destroyed');
            if (!isContextRace || attempt === INIT_MAX_ATTEMPTS) throw err;
            console.log(`Fallo al inicializar (intento ${attempt}/${INIT_MAX_ATTEMPTS}), reintentando...`);
            try {
                await client.destroy();
            } catch (destroyErr) {
                console.error('No se pudo cerrar el navegador tras el fallo:', destroyErr.message);
            }
            await new Promise((resolve) => setTimeout(resolve, INIT_RETRY_DELAY_MS));
        }
    }
}

console.log('Iniciando cliente de WhatsApp...');
initializeWithRetry().catch((err) => {
    console.error('No se pudo inicializar el cliente de WhatsApp:', err.message);
    process.exit(1);
});
