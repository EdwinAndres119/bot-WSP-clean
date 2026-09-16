// Serializa un array de objetos planos a CSV (RFC4180 basico). Las columnas
// se toman de las claves de la primera fila, para no asumir el esquema
// exacto de la tabla (mensajes se creo a mano en Supabase, sin .sql propio).
function escapeCsvValue(value) {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function toCsv(rows) {
    if (!rows || rows.length === 0) return '';

    const columns = Object.keys(rows[0]);
    const header = columns.map(escapeCsvValue).join(',');
    const lines = rows.map((row) => columns.map((col) => escapeCsvValue(row[col])).join(','));

    return [header, ...lines].join('\r\n');
}

module.exports = { toCsv };
