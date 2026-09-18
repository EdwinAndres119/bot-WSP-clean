const { cleanNumber, buildMessageId, isSystemMessage } = require('./identifiers');

class MessagePipeline {
    constructor({ contactResolver, mediaStorage, messageRepository }) {
        this.contactResolver = contactResolver;
        this.mediaStorage = mediaStorage;
        this.messageRepository = messageRepository;
    }

    async process(msg, chatInfo) {
        if (!msg.id || !msg.id.id) {
            return; // internal WhatsApp notification without a real message id
        }

        if (isSystemMessage(msg.type)) {
            return; // group creation/protocol events, not a real chat message
        }

        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') {
            return; // WhatsApp Status/Stories, not a conversation
        }

        const messageId = buildMessageId(msg.id);

        // downloadMedia() and other library internals rely on this.id._serialized.
        if (!msg.id._serialized) {
            msg.id._serialized = messageId;
        }

        const chat = await this._resolveChat(msg, chatInfo);
        const sender = await this.contactResolver.resolve(msg);
        const media = await this.mediaStorage.save(msg, messageId);

        await this.messageRepository.save({
            id: messageId,
            chat_id: cleanNumber(msg.fromMe ? msg.to : msg.from),
            chat_name: chat.name || null,
            is_group: chat.isGroup || false,
            remitente_numero: sender.number,
            remitente_nombre: sender.name,
            esta_registrado: sender.isRegistered,
            body: msg.body,
            message_type: msg.type,
            from_me: msg.fromMe,
            has_media: media.hasMedia,
            media_mimetype: media.mimetype,
            media_filename: media.filename,
            media_path: media.mediaPath,
            timestamp: new Date(msg.timestamp * 1000).toISOString(),
            // Se manda en CADA upsert (no solo en el insert) para que refleje
            // la ultima corrida que confirmo este mensaje. GET /api/export
            // filtra por esto para saber que entro en una corrida puntual -
            // si se preservara el valor original, un mensaje ya guardado de
            // una prueba anterior desaparecia del export de la corrida nueva
            // aunque esa corrida si lo haya vuelto a traer (bug real, visto
            // en runId=29: 100 guardados, 0 en el CSV).
            fetched_at: new Date().toISOString(),
        });
    }

    async _resolveChat(msg, chatInfo) {
        if (chatInfo) return chatInfo;

        // Live messages (no chatInfo, unlike history which always passes it -
        // see HistoryExtractor.js) used to rely entirely on msg.getChat(),
        // which fails silently here often enough that every live message
        // ended up with an empty chat_name and is_group stuck at false. A
        // group/individual chat is always decidable from msg.from itself -
        // resolve that without needing a page round trip, and only use
        // getChat() as a best-effort attempt at the display name.
        const isGroup = msg.from.endsWith('@g.us');
        try {
            const chat = await msg.getChat();
            return { name: chat.name, isGroup: chat.isGroup ?? isGroup };
        } catch (err) {
            return { name: null, isGroup };
        }
    }
}

module.exports = MessagePipeline;
