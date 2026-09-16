const express = require('express');
const cors = require('cors');

const supabase = require('./src/db/SupabaseClient');
const MessageRepository = require('./src/db/MessageRepository');
const ExtractionRunRepository = require('./src/db/ExtractionRunRepository');
const SessionManager = require('./src/wa/SessionManager');
const { toCsv } = require('./src/utils/csv');

const PORT = process.env.PORT || 3001;

// Sin login ni clave - instruccion directa del usuario (2026-09-14): la app
// es solo para observar la extraccion, sin ningun tipo de registro/acceso
// restringido. Pensada para correr en red interna, no expuesta a internet.
const app = express();
app.use(cors());
app.use(express.json());

const messageRepository = new MessageRepository(supabase);
const extractionRunRepository = new ExtractionRunRepository(supabase);

// Only one extraction runs at a time (one phone line being tested), so a
// single module-level SessionManager is enough. /api/start replaces it with
// a fresh instance each time so a new client isn't mixed with a dead one.
let sessionManager = new SessionManager({ messageRepository, extractionRunRepository });

app.post('/api/start', async (req, res) => {
    const { lineLabel, monthsLimit } = req.body;
    if (!lineLabel) {
        return res.status(400).json({ error: 'Falta lineLabel' });
    }

    try {
        await sessionManager.stop();
        sessionManager = new SessionManager({ messageRepository, extractionRunRepository });
        await sessionManager.start({
            lineLabel,
            monthsLimit: monthsLimit ? Number(monthsLimit) : null,
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(409).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json(sessionManager.getStatus());
});

app.post('/api/stop', async (req, res) => {
    await sessionManager.stop();
    res.json({ ok: true });
});

app.get('/api/runs', async (req, res) => {
    const runs = await extractionRunRepository.listRecent();
    res.json(runs);
});

// Exporta los mensajes guardados a CSV para que el equipo de negocio los
// pueda abrir en Excel. Sin runId exporta toda la tabla; con runId, solo los
// mensajes guardados durante esa corrida especifica (por fetched_at).
app.get('/api/export', async (req, res) => {
    const { runId } = req.query;
    let from;
    let to;
    let lineLabel;

    if (runId) {
        const run = await extractionRunRepository.getById(Number(runId));
        if (!run) {
            return res.status(404).json({ error: 'Corrida no encontrada' });
        }
        from = run.started_at;
        to = run.finished_at || new Date().toISOString();
        lineLabel = run.line_label;
    }

    const rows = await messageRepository.listForExport({ from, to });
    const csv = toCsv(rows);
    const filenameParts = ['mensajes', lineLabel, runId ? `run${runId}` : null].filter(Boolean);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameParts.join('_')}.csv"`);
    res.send(csv);
});

app.listen(PORT, () => {
    console.log(`API corriendo en http://localhost:${PORT}`);
});
