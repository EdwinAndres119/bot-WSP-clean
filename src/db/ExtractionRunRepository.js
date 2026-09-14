class ExtractionRunRepository {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async create({ lineLabel, monthsLimit, chatsFound }) {
        const { data, error } = await this.supabase
            .from('extraction_runs')
            .insert({ line_label: lineLabel, months_limit: monthsLimit, chats_found: chatsFound })
            .select('id')
            .single();

        if (error) {
            console.error('Error al crear extraction_run:', error.message);
            return null;
        }
        return data.id;
    }

    async update(runId, fields) {
        if (!runId) return;

        const { error } = await this.supabase
            .from('extraction_runs')
            .update(fields)
            .eq('id', runId);

        if (error) {
            console.error('Error al actualizar extraction_run:', error.message);
        }
    }

    async finish(runId, { status, chatsProcessed, chatsFailed, messagesSaved, errorMessage }) {
        await this.update(runId, {
            status,
            chats_processed: chatsProcessed,
            chats_failed: chatsFailed,
            messages_saved: messagesSaved,
            error_message: errorMessage || null,
            finished_at: new Date().toISOString(),
        });
    }

    async listRecent(limit = 50) {
        const { data, error } = await this.supabase
            .from('extraction_runs')
            .select('*')
            .order('started_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('Error al listar extraction_runs:', error.message);
            return [];
        }
        return data;
    }
}

module.exports = ExtractionRunRepository;
