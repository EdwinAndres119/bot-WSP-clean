function cleanNumber(idWithSuffix) {
    if (!idWithSuffix) return null;
    return idWithSuffix.split('@')[0];
}

// msg.id.participant is sometimes a string and sometimes a Wid object.
function serializeIdPart(part) {
    if (!part) return null;
    if (typeof part === 'string') return part;
    return part._serialized || part.toString();
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildMessageId(msgId) {
    if (msgId._serialized) return msgId._serialized;

    const participant = serializeIdPart(msgId.participant);
    return `${msgId.fromMe}_${msgId.remote}_${msgId.id}${participant ? '_' + participant : ''}`;
}

// WhatsApp system/protocol events (group creation, encryption notices, call
// logs, etc.) come through with these types instead of real chat messages.
const SYSTEM_MESSAGE_TYPES = [
    'gp2',
    'group_notification',
    'notification',
    'notification_template',
    'e2e_notification',
    'broadcast_notification',
    'call_log',
    'protocol',
];

function isSystemMessage(type) {
    return SYSTEM_MESSAGE_TYPES.includes(type);
}

module.exports = {
    cleanNumber,
    serializeIdPart,
    sanitizeFilename,
    buildMessageId,
    SYSTEM_MESSAGE_TYPES,
    isSystemMessage,
};
