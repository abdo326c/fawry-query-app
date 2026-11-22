/**
 * Fawry automated database backup (Turso / libSQL) -> Google Drive
 * Runs locally or from GitHub Actions (.github/workflows/weekly_backup.yml).
 *
 * Hierarchy on Google Drive:
 *   Fawry Payments Backup
 *     └── Year (e.g. 2026)
 *          └── Month (e.g. 10 - October)
 *               └── Week (e.g. Week 44 (Oct 26 - Nov 01))
 *                    ├── fawry_backup_YYYYMMDD_HHmmss.zip            (every table, see BACKUP_TABLES)
 *                    └── fawry_backup_YYYYMMDD_HHmmss_manifest.json  (row counts, checksums, archive SHA-256)
 *
 * The zip holds one file per table (JSON array, or JSON Lines for the big tables), the raw
 * database values (restorable 1:1 by scripts/restore_from_backup.mjs) and manifest.json with the
 * row count and SHA-256 of every file. It contains app_users (password hashes) and student
 * personal data: the Drive folder must be shared with nobody but the finance admins.
 *
 * Retention: after a successful upload, only the newest BACKUP_RETENTION (default 12) backup
 * zips made by this script are kept; older ones (and their manifests) are moved to the Drive
 * trash. BACKUP_RETENTION=0 turns retention off.
 *
 * Usage:
 *   npm run backup                                             (export + upload to Drive)
 *   node scripts/backup_to_drive.js --local-only [--out <dir>] (export to a local zip only; default dir: backups/)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { once } from 'events';
import { createClient } from '@libsql/client';
import { withDbRetry, withDbWriteRetry } from '../api/_lib/db.js';

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_ROOT_FOLDER = 'Fawry Payments Backup';
export const BACKUP_ZIP_NAME_RE = /^fawry_backup_(\d{8}_\d{6})\.zip$/;
export const BACKUP_MANIFEST_NAME_RE = /^fawry_backup_(\d{8}_\d{6})_manifest\.json$/;
export const RESUMABLE_UPLOAD_THRESHOLD = 5 * 1024 * 1024;
const RESUMABLE_CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB

/**
 * Every table of turso/schema.sql, in restore order (parents before children, closed_periods
 * before the period-locked tables, transactions before transactions_archive).
 * `key` is the primary key used for keyset paging. `optional` tables are skipped (and recorded
 * in the manifest) when they don't exist in the source database.
 */
export const BACKUP_TABLES = [
    { table: 'app_users', file: 'app_users.json', key: ['id'] },
    { table: 'user_roles', file: 'user_roles.json', key: ['email'] },
    { table: 'import_batches', file: 'import_batches.json', key: ['id'], optional: true },
    { table: 'item_mappings', file: 'item_mappings.json', key: ['id'] },
    { table: 'student_master', file: 'student_master.jsonl', key: ['student_id'] },
    { table: 'links', file: 'links.json', key: ['id'], optional: true },
    { table: 'payment_links', file: 'payment_links.json', key: ['id'], optional: true },
    { table: 'exchange_rates', file: 'exchange_rates.json', key: ['rate_date', 'currency_pair'], optional: true },
    { table: 'settlement_batches', file: 'settlement_batches.json', key: ['id'], optional: true },
    { table: 'closed_periods', file: 'closed_periods.json', key: ['period_month'], optional: true },
    { table: 'transactions', file: 'transactions.jsonl', key: ['id'] },
    { table: 'transactions_archive', file: 'transactions_archive.jsonl', key: ['id'], optional: true },
    { table: 'foreign_transactions', file: 'foreign_transactions.json', key: ['id'], optional: true },
    { table: 'manual_fixes', file: 'manual_fixes.json', key: ['id'] },
    { table: 'audit_logs', file: 'audit_logs_full.jsonl', key: ['id'] }
];

/** Tables of turso/schema.sql deliberately NOT backed up. */
export const EXCLUDED_TABLES = {
    period_lock_bypass: 'transient one-row switch, set and cleared inside a single write batch; always empty between requests',
    login_attempts: 'transient login rate-limit counters (15-minute windows); nothing to restore',
    login_attempts: 'transient sign-in throttling counters (not part of turso/schema.sql today); restoring them would only re-lock accounts'
};

/**
 * Computes the SHA-256 hex digest of a file on disk for backup integrity verification.
 */
export function computeFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

export function sha256Buffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function getTursoClient() {
    const url = process.env.TURSO_DATABASE_URL || '';
    if (!url) {
        throw new Error('TURSO_DATABASE_URL is not set. Add it as a repository secret (Settings -> Secrets -> Actions).');
    }
    return createClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN || undefined
    });
}

const quoteIdent = (name) => `"${String(name).replace(/[^a-zA-Z0-9_]/g, '')}"`;

function rowToObject(res, row) {
    const out = {};
    res.columns.forEach((col, i) => {
        const v = row[i];
        out[col] = typeof v === 'bigint' ? Number(v) : v;
    });
    return out;
}

function isNoSuchTableError(err) {
    return /no such table/i.test(String(err?.message || err?.cause?.message || ''));
}

/**
 * Reads every row of a table with keyset paging on its primary key (WHERE key > last ORDER BY
 * key LIMIT n). Unlike LIMIT/OFFSET, rows inserted or deleted while the backup runs can't shift
 * the pages, so no row is skipped or read twice.
 */
export async function* iterateTableRows(db, table, key, pageSize = 2000) {
    const keyCols = key.map(quoteIdent);
    const orderSql = keyCols.map(c => `${c} ASC`).join(', ');
    let last = null;
    for (;;) {
        let sql;
        let args;
        if (last === null) {
            sql = `SELECT * FROM ${quoteIdent(table)} ORDER BY ${orderSql} LIMIT ?`;
            args = [pageSize];
        } else if (keyCols.length === 1) {
            sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${keyCols[0]} > ? ORDER BY ${orderSql} LIMIT ?`;
            args = [last[0], pageSize];
        } else {
            sql = `SELECT * FROM ${quoteIdent(table)} WHERE (${keyCols.join(', ')}) > (${keyCols.map(() => '?').join(', ')}) ORDER BY ${orderSql} LIMIT ?`;
            args = [...last, pageSize];
        }
        const res = await withDbRetry(() => db.execute({ sql, args }));
        let lastRow = null;
        for (const raw of res.rows) {
            lastRow = rowToObject(res, raw);
            yield lastRow;
        }
        if (res.rows.length < pageSize || !lastRow) break;
        last = key.map(k => lastRow[k]);
    }
}

/** Backwards-compatible helper: all rows of a table in primary-key order. */
export async function fetchTableAll(table, key = ['id'], pageSize = 2000, db = getTursoClient()) {
    const rows = [];
    for await (const row of iterateTableRows(db, table, Array.isArray(key) ? key : [String(key).split('.')[0]], pageSize)) {
        rows.push(row);
    }
    return rows;
}

async function writeChunk(stream, chunk) {
    if (!stream.write(chunk)) await once(stream, 'drain');
}

async function closeStream(stream) {
    await new Promise((resolve, reject) => {
        stream.once('error', reject);
        stream.end(resolve);
    });
}

/** Writes rows to `filePath` as a JSON array (.json) or JSON Lines (.jsonl). */
async function exportRowsToFile(rowsIterable, filePath, onRow) {
    const jsonl = filePath.endsWith('.jsonl');
    const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
    let count = 0;
    try {
        if (!jsonl) await writeChunk(stream, '[\n');
        for await (const row of rowsIterable) {
            if (onRow && onRow(row) === false) continue;
            const line = JSON.stringify(row);
            await writeChunk(stream, jsonl ? line + '\n' : (count > 0 ? ',\n' : '') + line);
            count++;
        }
        if (!jsonl) await writeChunk(stream, '\n]\n');
    } finally {
        await closeStream(stream);
    }
    return count;
}

/** Reads a table file written by exportRowsToFile (or an older backup) from a string. */
export function parseTableFile(fileName, text) {
    if (fileName.endsWith('.jsonl')) {
        return text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line));
    }
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${fileName} is not a JSON array.`);
    return parsed;
}

async function* iterateJsonlFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const row of parseTableFile(filePath, text)) yield row;
}

// ---------------------------------------------------------------------------------------------
// Minimal ZIP writer / reader (deflate, no external tools, identical on Windows and Linux)
// ---------------------------------------------------------------------------------------------

let crcTable = null;
function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

/**
 * Writes a zip file. `entries` = [{ name, data: Buffer }]. Throws for archives that would need
 * ZIP64 (> 4 GB), which this format does not support.
 */
export function writeZip(zipPath, entries, date = new Date()) {
    const { time, day } = dosDateTime(date);
    const fd = fs.openSync(zipPath, 'w');
    const central = [];
    let offset = 0;
    const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
    try {
        for (const { name, data } of entries) {
            const nameBuf = Buffer.from(name, 'utf-8');
            const compressed = zlib.deflateRawSync(data, { level: 9 });
            const crc = crc32(data);
            if (data.length >= 0xFFFFFFFF || compressed.length >= 0xFFFFFFFF || offset >= 0xFFFFFFFF) {
                throw new Error(`Backup file ${name} is too large for a non-ZIP64 archive.`);
            }
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x0800, 6); // UTF-8 names
            local.writeUInt16LE(8, 8); // deflate
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(day, 12);
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(compressed.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            local.writeUInt16LE(0, 28);
            const headerOffset = offset;
            write(local);
            write(nameBuf);
            write(compressed);

            const cen = Buffer.alloc(46);
            cen.writeUInt32LE(0x02014b50, 0);
            cen.writeUInt16LE(20, 4);
            cen.writeUInt16LE(20, 6);
            cen.writeUInt16LE(0x0800, 8);
            cen.writeUInt16LE(8, 10);
            cen.writeUInt16LE(time, 12);
            cen.writeUInt16LE(day, 14);
            cen.writeUInt32LE(crc, 16);
            cen.writeUInt32LE(compressed.length, 20);
            cen.writeUInt32LE(data.length, 24);
            cen.writeUInt16LE(nameBuf.length, 28);
            cen.writeUInt32LE(headerOffset, 42);
            central.push(Buffer.concat([cen, nameBuf]));
        }
        const cdOffset = offset;
        const cdBuf = Buffer.concat(central);
        write(cdBuf);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cdBuf.length, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        write(eocd);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Reads a zip file into a Map(name -> Buffer). Supports stored and deflated entries (our own
 * archives and ones made by Compress-Archive / zip). Verifies each entry's CRC-32.
 */
export function readZip(zipPath) {
    const buf = fs.readFileSync(zipPath);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${path.basename(zipPath)} is not a valid zip archive (no end-of-central-directory record).`);
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf-8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue; // directory entry
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt zip local header for ${name}.`);
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + csize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`Unsupported zip compression method ${method} for ${name}.`);
        if (data.length !== usize) throw new Error(`Zip entry ${name}: size mismatch.`);
        if (crc32(data) !== crc) throw new Error(`Zip entry ${name}: CRC-32 mismatch (archive is corrupt).`);
        out.set(name, data);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Export (no Google Drive involved)
// ---------------------------------------------------------------------------------------------

export function formatTimestamp(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Exports every table in BACKUP_TABLES into `dir`, then writes manifest.json there.
 * Returns the manifest.
 *
 * Consistency with the archive job (which MOVES settled rows from transactions to
 * transactions_archive in one transaction, keeping their id): transactions is read first and
 * transactions_archive after it. A row moved in between shows up in both files; it is then
 * dropped from transactions.jsonl, so every row is backed up exactly once and none is lost.
 */
export async function exportDatabaseToDir(db, dir, { now = new Date(), log = console.log, pageSize = 2000 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const tables = {};
    const skipped = {};
    const txIds = new Set();
    const movedIds = new Set();
    let txStats = { count: 0, amount: 0, settled: 0 };

    const addTxStats = (stats, row) => {
        stats.count++;
        stats.amount += parseFloat(row.item_price || 0) || 0;
        if (Number(row.is_settled) === 1 || row.is_settled === true) stats.settled++;
    };

    for (const spec of BACKUP_TABLES) {
        const filePath = path.join(dir, spec.file);
        let onRow = null;
        if (spec.table === 'transactions') {
            onRow = (row) => { txIds.add(Number(row.id)); addTxStats(txStats, row); };
        } else if (spec.table === 'transactions_archive') {
            onRow = (row) => { if (txIds.has(Number(row.id))) movedIds.add(Number(row.id)); };
        }
        let rows;
        try {
            rows = await exportRowsToFile(iterateTableRows(db, spec.table, spec.key, pageSize), filePath, onRow);
        } catch (err) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (spec.optional && isNoSuchTableError(err)) {
                skipped[spec.table] = 'table does not exist in the source database';
                log(`  - ${spec.table}: skipped (table does not exist)`);
                continue;
            }
            throw new Error(`Backup of table ${spec.table} failed: ${err.message}`, { cause: err });
        }
        tables[spec.table] = { file: spec.file, rows };
        log(`  ✓ ${spec.table}: ${rows.toLocaleString()} rows`);
    }

    if (movedIds.size > 0) {
        // Rewrite transactions.jsonl without the rows that were archived during the backup.
        const txSpec = BACKUP_TABLES.find(s => s.table === 'transactions');
        const txPath = path.join(dir, txSpec.file);
        const tmpPath = txPath.replace(/\.jsonl$/, '.rewrite.jsonl');
        txStats = { count: 0, amount: 0, settled: 0 };
        const kept = await exportRowsToFile(iterateJsonlFile(txPath), tmpPath, (row) => {
            if (movedIds.has(Number(row.id))) return false;
            addTxStats(txStats, row);
            return true;
        });
        fs.renameSync(tmpPath, txPath);
        tables.transactions.rows = kept;
        log(`  ✓ ${movedIds.size} transaction(s) were archived during the backup; kept once (in transactions_archive).`);
    }

    // AUTOINCREMENT counters, so a restored database never re-issues an id that was used before
    // (e.g. an archived transaction's id). Read last: counters only grow.
    const sqliteSequence = {};
    try {
        const seqRes = await withDbRetry(() => db.execute('SELECT name, seq FROM sqlite_sequence'));
        for (const r of seqRes.rows) sqliteSequence[String(r.name)] = Number(r.seq);
    } catch (err) {
        if (!isNoSuchTableError(err)) throw err;
    }

    const summaryRes = await withDbRetry(() => db.execute({
        sql: `SELECT substr(payment_date, 1, 7) AS month, bank, COUNT(*) AS tx_count, COALESCE(SUM(item_price), 0) AS total_amount
              FROM transactions
              GROUP BY 1, bank
              ORDER BY 1 DESC, bank ASC`
    }));
    fs.writeFileSync(
        path.join(dir, 'transactions_monthly_summary.json'),
        JSON.stringify(summaryRes.rows.map(r => rowToObject(summaryRes, r)), null, 2),
        'utf-8'
    );

    const checksums = {};
    for (const fname of fs.readdirSync(dir).sort()) {
        const fullPath = path.join(dir, fname);
        if (fname === 'manifest.json' || !fs.statSync(fullPath).isFile()) continue;
        checksums[fname] = { bytes: fs.statSync(fullPath).size, sha256: computeFileSha256(fullPath) };
    }

    const timestamp = formatTimestamp(now);
    const manifest = {
        backup_id: `fawry_backup_${timestamp}`,
        format_version: BACKUP_FORMAT_VERSION,
        created_at: now.toISOString(),
        version: '2.12-turso',
        database: 'Fawry Payments Project (Turso / libSQL)',
        raw_values: true,
        integrity_verified: true,
        tables,
        skipped_tables: skipped,
        excluded_tables: EXCLUDED_TABLES,
        sqlite_sequence: sqliteSequence,
        consistency: {
            read_order: BACKUP_TABLES.map(s => s.table),
            archived_during_backup: movedIds.size
        },
        statistics: {
            transactions_count: tables.transactions?.rows ?? 0,
            transactions_total_amount_egp: Math.round(txStats.amount * 100) / 100,
            settled_transactions_count: txStats.settled,
            students_count: tables.student_master?.rows ?? 0,
            mappings_count: tables.item_mappings?.rows ?? 0,
            manual_fixes_count: tables.manual_fixes?.rows ?? 0,
            user_roles_count: tables.user_roles?.rows ?? 0,
            app_users_count: tables.app_users?.rows ?? 0,
            audit_logs_count: tables.audit_logs?.rows ?? 0
        },
        checksums_sha256: checksums
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    return manifest;
}

/**
 * Exports the database into a zip in `workDir` (no Google Drive). Returns
 * { zipPath, manifestPath, manifest, tempDir }. The caller deletes tempDir / zipPath.
 * manifestPath is the external manifest (same content + archive_sha256 / archive size).
 */
export async function createLocalBackup({ db, workDir = os.tmpdir(), now = new Date(), log = console.log, pageSize } = {}) {
    const timestamp = formatTimestamp(now);
    const tempDir = fs.mkdtempSync(path.join(workDir, `fawry_backup_temp_${timestamp}_`));
    const manifest = await exportDatabaseToDir(db, tempDir, { now, log, pageSize });

    const zipName = `fawry_backup_${timestamp}.zip`;
    const zipPath = path.join(workDir, zipName);
    const entries = fs.readdirSync(tempDir).sort().map(name => ({ name, data: fs.readFileSync(path.join(tempDir, name)) }));
    writeZip(zipPath, entries, now);

    const zipBytes = fs.statSync(zipPath).size;
    const external = {
        ...manifest,
        archive_name: zipName,
        archive_sha256: computeFileSha256(zipPath),
        archive_size_bytes: zipBytes,
        archive_size_mb: Math.round((zipBytes / (1024 * 1024)) * 100) / 100
    };
    const manifestPath = path.join(workDir, `fawry_backup_${timestamp}_manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(external, null, 2), 'utf-8');
    return { zipPath, manifestPath, manifest: external, tempDir, timestamp };
}

// ---------------------------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------------------------

/**
 * Calculates current Year, Month, and Week hierarchy labels
 */
export function getFolderHierarchy(date = new Date()) {
    const year = String(date.getFullYear());
    const monthNames = [
        '01 - January', '02 - February', '03 - March', '04 - April',
        '05 - May', '06 - June', '07 - July', '08 - August',
        '09 - September', '10 - October', '11 - November', '12 - December'
    ];
    const month = monthNames[date.getMonth()];

    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);

    const day = date.getDay();
    const diffToMonday = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.getFullYear(), date.getMonth(), diffToMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

    const pad = (n) => String(n).padStart(2, '0');
    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const span = `${shortMonths[monday.getMonth()]} ${pad(monday.getDate())} - ${shortMonths[sunday.getMonth()]} ${pad(sunday.getDate())}`;

    const week = `Week ${pad(weekNumber)} (${span})`;
    return { year, month, week };
}

/**
 * Resolves Google Drive OAuth2 Credentials
 */
export function getGoogleCredentials() {
    if (process.env.GDRIVE_TOKEN_JSON) {
        try {
            const raw = JSON.parse(process.env.GDRIVE_TOKEN_JSON);
            return {
                clientId: raw.client_id,
                clientSecret: raw.client_secret,
                refreshToken: raw.token?.refresh_token || raw.refresh_token
            };
        } catch (e) {
            console.warn('⚠️  Could not parse GDRIVE_TOKEN_JSON:', e.message);
        }
    }

    if (process.env.GDRIVE_REFRESH_TOKEN && process.env.GDRIVE_CLIENT_ID) {
        return {
            clientId: process.env.GDRIVE_CLIENT_ID,
            clientSecret: process.env.GDRIVE_CLIENT_SECRET,
            refreshToken: process.env.GDRIVE_REFRESH_TOKEN
        };
    }

    const localCandidates = [
        path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'plugin_data', 'gdrive', 'token.json'),
        path.join(process.env.HOME || '', '.gemini', 'antigravity', 'plugin_data', 'gdrive', 'token.json')
    ];

    for (const p of localCandidates) {
        if (p && fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
            return {
                clientId: raw.client_id,
                clientSecret: raw.client_secret,
                refreshToken: raw.token?.refresh_token || raw.refresh_token
            };
        }
    }

    return null;
}

/**
 * Exchanges Google OAuth2 Refresh Token for a fresh Access Token
 */
export async function getDriveAccessToken(creds, fetchImpl = fetch) {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            refresh_token: creds.refreshToken,
            grant_type: 'refresh_token'
        })
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Google OAuth Token Refresh Failed: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    return data.access_token;
}

const escapeDriveQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Resolves or creates a Google Drive folder via pure REST API v3
 */
export async function getOrCreateDriveFolderRest(accessToken, name, parentId = null, fetchImpl = fetch) {
    const qParts = [
        `name = '${escapeDriveQ(name)}'`,
        `mimeType = 'application/vnd.google-apps.folder'`,
        `trashed = false`
    ];
    if (parentId) qParts.push(`'${escapeDriveQ(parentId)}' in parents`);
    const q = qParts.join(' and ');
    const searchRes = await fetchImpl(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!searchRes.ok) {
        throw new Error(`Drive folder lookup failed for "${name}": ${searchRes.status} ${await searchRes.text()}`);
    }
    const searchJson = await searchRes.json();
    if (searchJson.files && searchJson.files.length > 0) {
        return searchJson.files[0];
    }

    const body = {
        name,
        mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) body.parents = [parentId];

    const createRes = await fetchImpl('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!createRes.ok) {
        throw new Error(`Failed to create Drive folder "${name}": ${createRes.status} ${await createRes.text()}`);
    }

    return await createRes.json();
}

async function uploadMultipart(accessToken, filePath, metadata, mimeType, fetchImpl) {
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '-------fawrybackup' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartBody = Buffer.concat([
        Buffer.from(
            delimiter +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(metadata) +
            delimiter +
            `Content-Type: ${mimeType}\r\n\r\n`
        ),
        fileBuffer,
        Buffer.from(closeDelimiter)
    ]);

    const res = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
    });

    if (!res.ok) {
        throw new Error(`Drive file upload failed ("${metadata.name}"): ${res.status} ${await res.text()}`);
    }
    return await res.json();
}

function parseRangeEnd(rangeHeader) {
    const m = /bytes=\d+-(\d+)/.exec(rangeHeader || '');
    return m ? Number(m[1]) + 1 : 0;
}

/**
 * Drive resumable upload: one session, sent in 8 MB chunks. A failed chunk (network error or
 * 5xx) asks Drive how much it already has and continues from there, up to `maxRetries` times.
 */
async function uploadResumable(accessToken, filePath, metadata, mimeType, fetchImpl, { maxRetries = 5, retryDelayMs = 1000 } = {}) {
    const size = fs.statSync(filePath).size;
    const startRes = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType,
            'X-Upload-Content-Length': String(size)
        },
        body: JSON.stringify(metadata)
    });
    if (!startRes.ok) {
        throw new Error(`Drive resumable upload could not start ("${metadata.name}"): ${startRes.status} ${await startRes.text()}`);
    }
    const sessionUrl = startRes.headers.get('location');
    if (!sessionUrl) throw new Error('Drive resumable upload: no session URL returned.');

    const fd = fs.openSync(filePath, 'r');
    try {
        let offset = 0;
        let failures = 0;
        for (;;) {
            const end = Math.min(offset + RESUMABLE_CHUNK_SIZE, size);
            const chunk = Buffer.alloc(end - offset);
            fs.readSync(fd, chunk, 0, chunk.length, offset);
            let res;
            try {
                res = await fetchImpl(sessionUrl, {
                    method: 'PUT',
                    headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
                    body: chunk
                });
            } catch (err) {
                res = { ok: false, status: 0, networkError: err };
            }

            if (res.status === 200 || res.status === 201) return await res.json();
            if (res.status === 308) {
                offset = parseRangeEnd(res.headers.get('range'));
                failures = 0;
                continue;
            }
            if (res.status !== 0 && res.status < 500) {
                throw new Error(`Drive resumable upload failed ("${metadata.name}"): ${res.status} ${await res.text()}`);
            }
            failures++;
            if (failures > maxRetries) {
                throw new Error(`Drive resumable upload failed ("${metadata.name}") after ${maxRetries} retries: ${res.networkError?.message || res.status}`);
            }
            await new Promise(r => setTimeout(r, retryDelayMs * failures));
            // Ask Drive how many bytes it has.
            const statusRes = await fetchImpl(sessionUrl, {
                method: 'PUT',
                headers: { 'Content-Range': `bytes */${size}` }
            }).catch(() => null);
            if (statusRes && (statusRes.status === 200 || statusRes.status === 201)) return await statusRes.json();
            if (statusRes && statusRes.status === 308) offset = parseRangeEnd(statusRes.headers.get('range'));
        }
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Uploads a local file to a Google Drive folder. Files up to 5 MB go in one multipart request;
 * bigger files use a resumable upload session.
 */
export async function uploadFileToDriveRest(accessToken, filePath, fileName, mimeType, parentFolderId, { fetchImpl = fetch, appProperties, retryDelayMs } = {}) {
    const metadata = { name: fileName, parents: [parentFolderId] };
    if (appProperties) metadata.appProperties = appProperties;
    const size = fs.statSync(filePath).size;
    if (size > RESUMABLE_UPLOAD_THRESHOLD) {
        return uploadResumable(accessToken, filePath, metadata, mimeType, fetchImpl, retryDelayMs !== undefined ? { retryDelayMs } : {});
    }
    return uploadMultipart(accessToken, filePath, metadata, mimeType, fetchImpl);
}

export function parseRetention(value, fallback = 12) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`BACKUP_RETENTION must be a whole number >= 0 (got "${value}").`);
    return n;
}

/**
 * Keeps the newest `keep` backup zips made by this script under the root backup folder and moves
 * older ones (and their *_manifest.json) to the Drive trash. Only files whose name matches
 * fawry_backup_YYYYMMDD_HHmmss.zip / _manifest.json AND that sit in a Year > Month > Week folder
 * under `rootFolderId` are touched. Returns { kept, trashed }.
 */
export async function applyDriveRetention(accessToken, rootFolderId, keep, { fetchImpl = fetch, log = console.log } = {}) {
    if (!keep || keep <= 0) return { kept: [], trashed: [] };
    const auth = { 'Authorization': `Bearer ${accessToken}` };

    const files = [];
    let pageToken = null;
    do {
        const q = "name contains 'fawry_backup_' and trashed = false";
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,parents)')}&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await fetchImpl(url, { headers: auth });
        if (!res.ok) throw new Error(`Drive listing for retention failed: ${res.status} ${await res.text()}`);
        const json = await res.json();
        files.push(...(json.files || []));
        pageToken = json.nextPageToken || null;
    } while (pageToken);

    const parentCache = new Map();
    const getParent = async (id) => {
        if (parentCache.has(id)) return parentCache.get(id);
        const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=parents`, { headers: auth });
        if (!res.ok) throw new Error(`Drive parent lookup failed: ${res.status} ${await res.text()}`);
        const parent = (await res.json()).parents?.[0] || null;
        parentCache.set(id, parent);
        return parent;
    };
    // file -> week -> month -> year -> root
    const isUnderRoot = async (file) => {
        let current = file.parents?.[0] || null;
        for (let hop = 0; hop < 3 && current; hop++) current = await getParent(current);
        return current === rootFolderId;
    };

    const zips = [];
    const manifests = [];
    for (const f of files) {
        const zm = BACKUP_ZIP_NAME_RE.exec(f.name || '');
        const mm = BACKUP_MANIFEST_NAME_RE.exec(f.name || '');
        if (!zm && !mm) continue;
        if (!(await isUnderRoot(f))) continue;
        (zm ? zips : manifests).push({ ...f, stamp: (zm || mm)[1] });
    }
    zips.sort((a, b) => b.stamp.localeCompare(a.stamp));
    const kept = zips.slice(0, keep);
    const old = zips.slice(keep);
    if (old.length === 0) return { kept: kept.map(f => f.name), trashed: [] };

    const keptStamps = new Set(kept.map(f => f.stamp));
    const oldestKept = kept[kept.length - 1].stamp;
    const toTrash = [...old, ...manifests.filter(m => !keptStamps.has(m.stamp) && m.stamp < oldestKept)];

    const trashed = [];
    for (const f of toTrash) {
        const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}`, {
            method: 'PATCH',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true })
        });
        if (!res.ok) throw new Error(`Could not move old backup ${f.name} to the Drive trash: ${res.status} ${await res.text()}`);
        trashed.push(f.name);
        log(`  ✓ Retention: moved ${f.name} to the Drive trash`);
    }
    return { kept: kept.map(f => f.name), trashed };
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/**
 * Full backup. With localOnly the zip + manifest are copied to outDir and nothing is uploaded.
 */
export async function runFullDatabaseBackup({ localOnly = false, outDir = path.resolve('backups'), db = null } = {}) {
    console.log('='.repeat(75));
    console.log(localOnly ? '💾 FAWRY DATABASE BACKUP (LOCAL ONLY)' : '☁️  FAWRY AUTOMATED BACKUP TO GOOGLE DRIVE');
    console.log('='.repeat(75));

    const startTime = Date.now();
    const now = new Date();
    const hierarchy = getFolderHierarchy(now);
    const client = db || getTursoClient();

    let driveAccessToken = null;
    let retention = 0;
    if (!localOnly) {
        retention = parseRetention(process.env.BACKUP_RETENTION);
        const creds = getGoogleCredentials();
        if (!creds || !creds.refreshToken) {
            throw new Error('Google Drive credentials not found. Provide GDRIVE_TOKEN_JSON (or GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN).');
        }
        driveAccessToken = await getDriveAccessToken(creds);
        console.log('  ✓ Google Drive REST API authenticated successfully');
        console.log(`\n📅 Target: ${BACKUP_ROOT_FOLDER} > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`);
    }

    let backup = null;
    try {
        console.log('\n[1/3] Exporting every table (keyset paging)...');
        backup = await createLocalBackup({ db: client, now });
        const { manifest, zipPath, manifestPath, timestamp } = backup;
        const zipSizeMb = manifest.archive_size_mb;
        const stats = manifest.statistics;
        console.log(`\n[2/3] Archive created: ${zipSizeMb} MB | SHA-256: ${manifest.archive_sha256.slice(0, 16)}...`);

        if (localOnly) {
            fs.mkdirSync(outDir, { recursive: true });
            const zipOut = path.join(outDir, path.basename(zipPath));
            const manifestOut = path.join(outDir, path.basename(manifestPath));
            fs.copyFileSync(zipPath, zipOut);
            fs.copyFileSync(manifestPath, manifestOut);
            console.log(`\n[3/3] Saved locally:\n   ${zipOut}\n   ${manifestOut}`);
            return { success: true, manifest, zipPath: zipOut, manifestPath: manifestOut };
        }

        console.log('\n[3/3] Uploading to Google Drive...');
        const rootFolder = await getOrCreateDriveFolderRest(driveAccessToken, BACKUP_ROOT_FOLDER);
        const yearFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.year, rootFolder.id);
        const monthFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.month, yearFolder.id);
        const weekFolder = await getOrCreateDriveFolderRest(driveAccessToken, hierarchy.week, monthFolder.id);

        const uploadedArchive = await uploadFileToDriveRest(driveAccessToken, zipPath, `fawry_backup_${timestamp}.zip`, 'application/zip', weekFolder.id);
        console.log(`  ✓ Archive uploaded (File ID: ${uploadedArchive.id})`);
        const uploadedManifest = await uploadFileToDriveRest(driveAccessToken, manifestPath, `fawry_backup_${timestamp}_manifest.json`, 'application/json', weekFolder.id);
        console.log(`  ✓ Manifest uploaded (File ID: ${uploadedManifest.id})`);

        const retentionResult = await applyDriveRetention(driveAccessToken, rootFolder.id, retention);
        console.log(retention > 0
            ? `  ✓ Retention: keeping the newest ${retention} backups; ${retentionResult.trashed.length} old file(s) moved to the Drive trash`
            : '  - Retention disabled (BACKUP_RETENTION=0)');

        await withDbWriteRetry(() => client.execute({
            sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
            args: [
                'system@nu.edu.eg',
                'DRIVE_BACKUP_COMPLETED',
                `Full Database (${stats.transactions_count.toLocaleString()} txs)`,
                JSON.stringify({
                    archive_name: `fawry_backup_${timestamp}.zip`,
                    archive_sha256: manifest.archive_sha256,
                    size_mb: zipSizeMb,
                    hierarchy: `${BACKUP_ROOT_FOLDER} > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}`,
                    drive_folder_url: weekFolder.webViewLink,
                    financial_total_egp: stats.transactions_total_amount_egp,
                    table_rows: Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows])),
                    retention_trashed: retentionResult.trashed.length,
                    runner: process.env.GITHUB_ACTIONS ? 'github-actions-cloud' : 'local-runtime'
                })
            ]
        }));

        const duration = Date.now() - startTime;
        console.log('\n' + '='.repeat(75));
        console.log(`🎉 BACKUP UPLOADED TO GOOGLE DRIVE IN ${(duration / 1000).toFixed(1)}s`);
        console.log(`   Transactions:  ${stats.transactions_count.toLocaleString()} rows (EGP ${stats.transactions_total_amount_egp.toLocaleString('en-US', { minimumFractionDigits: 2 })})`);
        console.log(`   Students:      ${stats.students_count.toLocaleString()} rows`);
        console.log(`   Cloud Folder:  ${weekFolder.webViewLink}`);
        console.log('='.repeat(75));

        if (process.env.GITHUB_STEP_SUMMARY) {
            try {
                const tableRows = Object.entries(manifest.tables).map(([t, v]) => `| ${t} | ${v.rows.toLocaleString()} |`).join('\n');
                fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `
### ☁️ Fawry Payments Automated Cloud Backup Succeeded

- **Status**: Completed in ${(duration / 1000).toFixed(1)}s
- **Destination**: [${BACKUP_ROOT_FOLDER} > ${hierarchy.year} > ${hierarchy.month} > ${hierarchy.week}](${weekFolder.webViewLink})
- **Archive Size**: ${zipSizeMb} MB
- **Archive ID**: \`${uploadedArchive.id}\`
- **Retention**: ${retention > 0 ? `newest ${retention} kept, ${retentionResult.trashed.length} moved to trash` : 'disabled'}

| Table | Rows |
| :--- | ---: |
${tableRows}
`);
            } catch (_sumErr) {
                // Step summary is cosmetic
            }
        }

        return { success: true, manifest, driveFolderUrl: weekFolder.webViewLink, hierarchy };
    } finally {
        // Only our own temporary files. Never touch <repo>/backups/ (pre-delete backups of
        // scripts/delete_foreign_transactions.mjs and --local-only backups live there).
        try {
            if (backup?.tempDir && fs.existsSync(backup.tempDir)) fs.rmSync(backup.tempDir, { recursive: true, force: true });
            if (backup?.zipPath && fs.existsSync(backup.zipPath)) fs.unlinkSync(backup.zipPath);
            if (backup?.manifestPath && fs.existsSync(backup.manifestPath)) fs.unlinkSync(backup.manifestPath);
        } catch (cleanupErr) {
            console.warn('⚠️  Could not remove temporary backup files:', cleanupErr.message);
        }
    }
}

if (process.argv[1] && process.argv[1].endsWith('backup_to_drive.js')) {
    const argv = process.argv.slice(2);
    const outIdx = argv.indexOf('--out');
    runFullDatabaseBackup({
        localOnly: argv.includes('--local-only'),
        outDir: outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : path.resolve('backups')
    }).catch(err => {
        console.error('❌ Backup failed:', err);
        process.exit(1);
    });
}
