const express = require('express');
const cors = require('cors');

const supabase = require('./src/db/SupabaseClient');
const MessageRepository = require('./src/db/MessageRepository');
const ExtractionRunRepository = require('./src/db/ExtractionRunRepository');
const SessionManager = require('./src/wa/SessionManager');
const { toCsv } = require('./src/utils/csv');

// whatsapp-web.js dispara internamente un logout tras ciertos crashes de
// pagina (Client.js, listener de 'framenavigated') que en Windows puede
// chocar con un archivo bloqueado (EBUSY) del perfil de Chrome. Esa promesa
// rechazada no la lanza nuestro codigo y no hay forma de envolverla en un
// try/catch propio - sin este guard, tumba TODO el proceso de server.js
// (no solo la extraccion en curso), aunque ya haya mensajes guardados.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] El proceso siguio vivo:', err.message);
});
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection] El proceso siguio vivo:', err instanceof Error ? err.message : err);
});

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
    // El BOM le confirma a Excel que el archivo es UTF-8 - sin esto, Excel
    // adivina mal la codificacion y rompe tildes/emojis al abrirlo directo,
    // sin dar ninguna ventana para corregirlo (mas notorio todavia en Excel
    // Online/web, que ni siquiera ofrece el asistente de importacion).
    res.send('﻿' + csv);
});

// Los chats vacios/fallidos no son mensajes, asi que nunca salen en
// /api/export (esa solo exporta la tabla mensajes) - el equipo de negocio
// los necesita igual para saber cuales chats revisar a mano, asi que se
// exportan aparte, leyendo directo la columna empty_chats/failed_chats que
// ya quedo persistida en extraction_runs al terminar la corrida.
app.get('/api/export/empty', async (req, res) => {
    const { runId } = req.query;
    if (!runId) {
        return res.status(400).json({ error: 'Falta runId' });
    }

    const run = await extractionRunRepository.getById(Number(runId));
    if (!run) {
        return res.status(404).json({ error: 'Corrida no encontrada' });
    }

    const csv = toCsv(run.empty_chats || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chats_vacios_${run.line_label}_run${runId}.csv"`);
    res.send('﻿' + csv);
});

app.listen(PORT, () => {
    console.log(`API corriendo en http://localhost:${PORT}`);
});
