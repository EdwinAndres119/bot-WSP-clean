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
            chat_id: cleanNumber(msg.from),
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
        });
    }

    async _resolveChat(msg, chatInfo) {
        if (chatInfo) return chatInfo;

        try {
            return await msg.getChat();
        } catch (err) {
            return {};
        }
    }
}

module.exports = MessagePipeline;
