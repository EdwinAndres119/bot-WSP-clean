class MessageRepository {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async save(row) {
        const { error } = await this.supabase
            .from('mensajes')
            .upsert(row, { onConflict: 'id' });

        if (error) {
            console.error('Error al guardar mensaje en Supabase:', error.message);
        }
    }

    // Trae todos los mensajes de una corrida (o de toda la tabla si no se
    // pasa rango) para exportar a CSV. Pagina con .range() porque una sola
    // query de Supabase no devuelve mas de 1000 filas por defecto, y una
    // corrida real puede superar los 9000 mensajes.
    async listForExport({ from, to } = {}) {
        const pageSize = 1000;
        const rows = [];
        let offset = 0;

        while (true) {
            let query = this.supabase
                .from('mensajes')
                .select('*')
                .order('timestamp', { ascending: true })
                .range(offset, offset + pageSize - 1);

            if (from) query = query.gte('fetched_at', from);
            if (to) query = query.lte('fetched_at', to);

            const { data, error } = await query;

            if (error) {
                console.error('Error al exportar mensajes:', error.message);
                break;
            }
            if (!data || data.length === 0) break;

            rows.push(...data);
            if (data.length < pageSize) break;
            offset += pageSize;
        }

        return rows;
    }
}

module.exports = MessageRepository;
