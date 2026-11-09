// Shared business rules and data helpers.
// Used by the importer (csv-processor.js) and by the UI (app.js) so that
// importing, saving/deleting a fix or mapping and "Re-apply Rules" always give the same result.
// Re-applying always starts from the ORIGINAL imported values (original_student_id and the
// item name kept in check_column), so removing a link, fix or rule is undone correctly.
import { supabase } from './supabase.js';

export const PAGE_SIZE = 1000; // Supabase/PostgREST default max rows per request

/**
 * Validates a student ID and returns a status string.
 */
export function validateID(id) {
    if (!id) return "Missing ID";
    const idText = String(id).trim().replace(/\u00A0/g, '');
    if (!idText) return "Missing ID";
    const idLength = idText.length;
    const onlyTextLeft = idText.replace(/[0-9]/g, '');

    if (idLength === 17 && idText.toUpperCase().startsWith("DIP")) {
        const remainder = idText.substring(3).replace(/[0-9]/g, '');
        if (remainder === "") return "Valid";
    }

    if (onlyTextLeft !== "") return "Error: Text/Name detected";
    if (idLength < 4) return `Error: ID Too Short (${idLength} digits)`;
    if (idLength > 9) return `Error: ID Too Long (${idLength} digits)`;
    if (idText.startsWith("2") && idLength !== 9) return `Error: Invalid 2-Series Length (${idLength} digits)`;
    return "Valid";
}

/**
 * Returns the item name as it was originally imported (before any fix or mapping),
 * recovered from check_column which is stored as `${reference_number}-${itemName}`.
 */
export function originalItemName(tx) {
    const ref = String(tx.reference_number ?? '');
    const check = tx.check_column == null ? '' : String(tx.check_column);
    if (check && check.startsWith(ref + '-')) return check.substring(ref.length + 1);
    return tx.item_name;
}

/**
 * Returns the student ID as it was originally imported (before any link or fix).
 * Rows imported before original_student_id existed fall back to the current student_id.
 */
export function originalStudentId(tx) {
    if (tx.original_student_id !== null && tx.original_student_id !== undefined && tx.original_student_id !== '') {
        return tx.original_student_id;
    }
    return tx.student_id;
}

/**
 * Builds the base values for applyBusinessRules from a stored transaction row:
 * always the ORIGINAL imported ID and item name, so removed links/fixes/rules are undone.
 */
export function baseFromTransaction(tx) {
    return { studentId: originalStudentId(tx), itemName: originalItemName(tx) };
}

/**
 * Single source of truth for applying links, manual fixes and item mappings.
 *
 * Order of precedence (most specific wins):
 *   1. Student ID: base value → payment link (custom input value) → manual fix correct_id
 *   2. Item name:  original name → manual fix item_name
 *   3. Mapping rule is looked up on the resulting item name. Its adjusted_item_name is
 *      used only when the manual fix did not set an item name.
 *   4. Manual fix mapping / 2nd mapping override the mapping rule.
 *
 * @param {{studentId:any, itemName:string}} base
 * @param {{link?:object, fix?:object, lookupMapping:(name:string)=>object|undefined}} ctx
 */
export function applyBusinessRules(base, { link, fix, lookupMapping }) {
    let studentId = base.studentId;
    let itemName = base.itemName;
    let mapping = null;
    let secondMapping = null;
    // Where each final value came from: 'original' | 'link' | 'fix' | 'rule'
    const sources = { studentId: 'original', itemName: 'original', mapping: 'original', secondMapping: 'original' };

    const compactId = (val) => {
        if (val === null || val === undefined) return val;
        const compact = String(val).replace(/[\s\u00A0]+/g, '');
        return /^(DIP)?\d+$/i.test(compact) ? compact.toUpperCase() : val;
    };

    const baseIsValid = validateID(compactId(studentId)) === 'Valid';

    if (link && link.custom_input_value) {
        const linkCompacted = compactId(link.custom_input_value);
        // Do not overwrite an already-Valid original student ID with an invalid link value (e.g. National ID or text note)
        if (!baseIsValid || validateID(linkCompacted) === 'Valid') {
            studentId = link.custom_input_value;
            sources.studentId = 'link';
        }
    }
    if (fix && fix.correct_id) { studentId = fix.correct_id; sources.studentId = 'fix'; }

    // Remove stray spaces from ID-like values ("2310 00123" → "231000123"); names are left untouched
    studentId = compactId(studentId);

    const fixedName = fix && fix.item_name ? fix.item_name : null;
    if (fixedName) { itemName = fixedName; sources.itemName = 'fix'; }

    let mapDef = lookupMapping ? lookupMapping(String(itemName || '').trim()) : undefined;
    // A fix that renames the item to a name without its own rule keeps the original item's mapping
    if (!mapDef && fixedName && lookupMapping) mapDef = lookupMapping(String(base.itemName || '').trim());
    if (mapDef) {
        if (mapDef.adjusted_item_name && !fixedName) { itemName = mapDef.adjusted_item_name; sources.itemName = 'rule'; }
        mapping = mapDef.mapping || null;
        secondMapping = mapDef.second_mapping || null;
        if (mapping) sources.mapping = 'rule';
        if (secondMapping) sources.secondMapping = 'rule';
    }

    if (fix && fix.mapping) { mapping = fix.mapping; sources.mapping = 'fix'; }
    if (fix && fix.second_mapping) { secondMapping = fix.second_mapping; sources.secondMapping = 'fix'; }

    return {
        studentId,
        itemName,
        mapping,
        secondMapping,
        idStatus: validateID(studentId),
        sources
    };
}

/**
 * Normalizes an item name by collapsing multiple/non-breaking spaces and trimming.
 */
export function normalizeItemName(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[\s\u00A0]+/g, ' ').trim();
}

/**
 * Builds a mapping lookup function from item_mappings rows.
 * Matches by:
 *   1. Exact trimmed item_name
 *   2. Whitespace-normalized & case-insensitive item_name
 *   3. Whitespace-normalized & case-insensitive adjusted_item_name (in case a row already carries the adjusted name)
 */
export function buildMappingLookup(mappings) {
    const exactMap = new Map();
    const normMap = new Map();
    const adjustedMap = new Map();
    (mappings || []).forEach(m => {
        if (!m || !m.item_name) return;
        const trimmed = String(m.item_name).trim();
        const norm = normalizeItemName(m.item_name).toLowerCase();
        exactMap.set(trimmed, m);
        if (norm && !normMap.has(norm)) normMap.set(norm, m);
        if (m.adjusted_item_name) {
            const adjNorm = normalizeItemName(m.adjusted_item_name).toLowerCase();
            if (adjNorm && !adjustedMap.has(adjNorm)) adjustedMap.set(adjNorm, m);
        }
    });
    return (name) => {
        if (name === null || name === undefined) return undefined;
        const trimmed = String(name).trim();
        if (!trimmed) return undefined;
        if (exactMap.has(trimmed)) return exactMap.get(trimmed);
        const norm = normalizeItemName(trimmed).toLowerCase();
        return normMap.get(norm) || adjustedMap.get(norm);
    };
}

/**
 * Fetch every row of a table (paginated past the 1,000-row limit).
 * @param {string} table
 * @param {string} selectCols
 * @param {(q:any)=>any} [queryFn] adds filters to the query
 * @param {string} [orderByCol] a unique, stable column to page by
 */
export async function fetchAll(table, selectCols = '*', queryFn = null, orderByCol = 'id') {
    const fetchPage = async (from) => {
        let query = supabase.from(table).select(selectCols);
        if (queryFn) query = queryFn(query);
        query = query.order(orderByCol).range(from, from + PAGE_SIZE - 1);
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    };

    // Fast path: fetch the first page alone so small tables (< 1,000 rows) only make 1 request
    const firstPage = await fetchPage(0);
    if (firstPage.length < PAGE_SIZE) return firstPage;

    const allData = firstPage.slice();
    let from = PAGE_SIZE;
    const BATCH_PAGES = 5;

    while (true) {
        const batchPromises = [];
        for (let p = 0; p < BATCH_PAGES; p++) {
            batchPromises.push(fetchPage(from + p * PAGE_SIZE));
        }
        const pages = await Promise.all(batchPromises);
        let done = false;
        for (const page of pages) {
            if (page.length === 0) {
                done = true;
                break;
            }
            for (let i = 0; i < page.length; i++) allData.push(page[i]);
            if (page.length < PAGE_SIZE) {
                done = true;
                break;
            }
        }
        if (done) break;
        from += BATCH_PAGES * PAGE_SIZE;
    }
    return allData;
}

/**
 * Fetch every row whose `column` is in `values`, chunking the IN list and paginating each chunk in parallel.
 */
export async function fetchByIn(table, selectCols, column, values, orderByCol = 'id', chunkSize = 250, concurrency = 6) {
    const unique = [...new Set((values || []).filter(v => v !== null && v !== undefined && v !== '').map(String))];
    if (unique.length === 0) return [];

    const chunks = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
        chunks.push(unique.slice(i, i + chunkSize));
    }

    const all = [];
    for (let i = 0; i < chunks.length; i += concurrency) {
        const slice = chunks.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            slice.map(chunk => fetchAll(table, selectCols, q => q.in(column, chunk), orderByCol))
        );
        for (const rows of batchResults) {
            for (let j = 0; j < rows.length; j++) all.push(rows[j]);
        }
    }
    return all;
}

// The only columns the rule engine is allowed to write. Everything else on a transaction
// (settlement, ERP, amounts, batch) is never touched by a rule re-apply.
export const RULE_FIELDS = ['student_id', 'item_name', 'mapping', 'second_mapping', 'id_status'];

// Compares stored and computed values, treating null/undefined/'' as equal and numbers as text
// (so a numeric student_id column doesn't make every row look changed).
function sameValue(a, b) {
    const norm = v => (v === null || v === undefined || v === '') ? null : String(v);
    return norm(a) === norm(b);
}

const SOURCE_LABELS = { link: 'Student Link', fix: 'Manual Fix', rule: 'Mapping Rule', original: 'Original restored' };

/**
 * Re-derives one stored transaction from its ORIGINAL imported values and the given rules.
 * Pure function (no database access) shared by every re-apply path.
 *
 * @returns {{changed:boolean, fields:object, changes:Array<{field:string,label:string,from:any,to:any}>, reasons:string[], locked:boolean}}
 *   fields  – the new values for RULE_FIELDS only
 *   changes – one entry per field that differs from what is stored
 *   reasons – human-readable sources of the changes (e.g. "Manual Fix", "Original restored")
 *   locked  – the row is settled or already recorded in ERP
 */
export function diffTransaction(tx, { link, fix, lookupMapping }) {
    const r = applyBusinessRules(baseFromTransaction(tx), { link, fix, lookupMapping });
    const fields = {
        student_id: r.studentId,
        item_name: r.itemName,
        mapping: r.mapping,
        second_mapping: r.secondMapping,
        id_status: r.idStatus
    };

    const checks = [
        ['student_id', 'ID', 'studentId'],
        ['item_name', 'Item Name', 'itemName'],
        ['mapping', 'Mapping', 'mapping'],
        ['second_mapping', '2nd Mapping', 'secondMapping'],
        ['id_status', 'Status', null]
    ];
    const changes = [];
    const reasons = new Set();
    for (const [field, label, sourceKey] of checks) {
        if (sameValue(tx[field], fields[field])) continue;
        changes.push({ field, label, from: tx[field] ?? null, to: fields[field] ?? null });
        if (sourceKey) reasons.add(SOURCE_LABELS[r.sources[sourceKey]]);
    }
    // A status change on its own (ID unchanged) comes from re-validating the ID
    if (changes.length > 0 && reasons.size === 0) reasons.add('Status Re-validation');

    return {
        changed: changes.length > 0,
        fields,
        changes,
        reasons: [...reasons],
        locked: isLockedTransaction(tx)
    };
}

/**
 * A transaction that is settled or already posted to ERP. Re-apply never changes these
 * silently; the preview shows them unticked so the user decides.
 */
export function isLockedTransaction(tx) {
    return !!(tx.is_settled || tx.erp_batch_number);
}

/**
 * Re-computes student ID / item name / mappings / ID status for existing transaction rows
 * using the current links, manual fixes and item mappings in the database.
 * Returns one entry per changed row: { id, fields, tx, diff }.
 *
 * @param {object[]} txs
 * @param {{mappings?:object[], includeLocked?:boolean}} [opts]
 *   includeLocked – also return settled / ERP-recorded rows (default false)
 */
export async function recomputeTransactions(txs, { mappings, fixes, links, includeLocked = false } = {}) {
    if (!txs || txs.length === 0) return [];
    const refs = [...new Set(txs.map(t => String(t.reference_number || '').trim()).filter(Boolean))];

    const [fetchedFixes, fetchedLinks, allMappings] = await Promise.all([
        fixes
            ? Promise.resolve(fixes)
            : (refs.length > 500
                ? fetchAll('manual_fixes', '*', null, 'reference_number')
                : fetchByIn('manual_fixes', '*', 'reference_number', refs, 'reference_number')),
        links
            ? Promise.resolve(links)
            : fetchByIn('links', 'payment_reference_number, custom_input_value', 'payment_reference_number', refs, 'payment_reference_number', 350),
        mappings ? Promise.resolve(mappings) : fetchAll('item_mappings', '*', null, 'item_name')
    ]);

    const fixesMap = fetchedFixes instanceof Map
        ? fetchedFixes
        : new Map(fetchedFixes.flatMap(f => {
            const raw = String(f.reference_number ?? '');
            const trimmed = raw.trim();
            return trimmed && trimmed !== raw ? [[raw, f], [trimmed, f]] : [[trimmed || raw, f]];
        }));
    const linksMap = fetchedLinks instanceof Map
        ? fetchedLinks
        : new Map(fetchedLinks.flatMap(l => {
            const raw = String(l.payment_reference_number ?? '');
            const trimmed = raw.trim();
            return trimmed && trimmed !== raw ? [[raw, l], [trimmed, l]] : [[trimmed || raw, l]];
        }));
    const lookupMapping = typeof allMappings === 'function' ? allMappings : buildMappingLookup(allMappings);

    const changed = [];
    for (const tx of txs) {
        const rawRef = String(tx.reference_number ?? '');
        const cleanRef = rawRef.trim();
        const fix = fixesMap.get(cleanRef) ?? fixesMap.get(rawRef);
        const link = linksMap.get(cleanRef) ?? linksMap.get(rawRef);
        const diff = diffTransaction(tx, { link, fix, lookupMapping });
        if (!diff.changed) continue;
        if (diff.locked && !includeLocked) continue;
        changed.push({ id: tx.id, fields: diff.fields, tx, diff });
    }
    return changed;
}

/**
 * Writes ONLY the rule columns (RULE_FIELDS) of the given rows, by id.
 * Rows with identical new values are grouped into one UPDATE ... WHERE id IN (...), so a
 * mapping change touching thousands of rows is a handful of requests. When many rows have
 * distinct student_ids (e.g. Bulk Manual Fixes or Auto-Matcher), tries the server-side
 * bulk_update_rule_fields RPC first to update up to 1,000 rows per request, falling back
 * automatically to high-concurrency grouped UPDATE queries.
 *
 * @param {{id:any, fields:object, diff?:object}[]} updates
 * @returns {Promise<number>} rows updated
 * @throws on the first error
 */
export async function updateRuleFields(updates, { idChunkSize = 300, concurrency = 12 } = {}) {
    const groups = new Map();
    const rpcRows = [];

    for (const u of updates || []) {
        if (u.id === null || u.id === undefined) throw new Error('Cannot update a transaction without an id');
        const changedSet = (u.diff && Array.isArray(u.diff.changes) && u.diff.changes.length > 0)
            ? new Set(u.diff.changes.map(c => c.field))
            : null;
        const targetFields = changedSet
            ? RULE_FIELDS.filter(f => changedSet.has(f))
            : RULE_FIELDS;
        if (targetFields.length === 0) continue;

        const values = {};
        targetFields.forEach(f => { values[f] = u.fields[f] ?? null; });
        const key = JSON.stringify(targetFields.map(f => [f, values[f]]));
        if (!groups.has(key)) groups.set(key, { values, ids: [] });
        groups.get(key).ids.push(u.id);

        rpcRows.push({
            id: u.id,
            student_id: u.fields.student_id ?? null,
            item_name: u.fields.item_name ?? null,
            mapping: u.fields.mapping ?? null,
            second_mapping: u.fields.second_mapping ?? null,
            id_status: u.fields.id_status ?? null
        });
    }

    const tasks = [];
    for (const { values, ids } of groups.values()) {
        for (let i = 0; i < ids.length; i += idChunkSize) {
            const chunk = ids.slice(i, i + idChunkSize);
            tasks.push(async () => {
                const { error } = await supabase.from('transactions').update(values).in('id', chunk);
                if (error) throw error;
                return chunk.length;
            });
        }
    }

    // Fast path for Bulk Manual Fixes / Auto-Matcher / Re-apply where many rows have distinct student_ids:
    // Use single-statement JSONB batch RPC if available and there are many distinct groups
    if (tasks.length > 8 && typeof supabase.rpc === 'function') {
        try {
            const rpcChunkSize = 1000;
            const rpcTasks = [];
            for (let i = 0; i < rpcRows.length; i += rpcChunkSize) {
                const chunk = rpcRows.slice(i, i + rpcChunkSize);
                rpcTasks.push(async () => {
                    const { data, error } = await supabase.rpc('bulk_update_rule_fields', { p_updates: chunk });
                    if (error) throw error;
                    return typeof data === 'number' ? data : chunk.length;
                });
            }
            let rpcSaved = 0;
            for (let i = 0; i < rpcTasks.length; i += 4) {
                const res = await Promise.all(rpcTasks.slice(i, i + 4).map(fn => fn()));
                rpcSaved += res.reduce((a, b) => a + b, 0);
            }
            return rpcSaved;
        } catch (_rpcErr) {
            // RPC not yet deployed in DB; fall back seamlessly to parallel grouped UPDATE tasks below
        }
    }

    let saved = 0;
    for (let i = 0; i < tasks.length; i += concurrency) {
        const results = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
        saved += results.reduce((a, b) => a + b, 0);
    }
    return saved;
}

/**
 * Upserts full transaction rows in chunks and throws on the first error.
 * (Used by imports only – rule re-applies use updateRuleFields.)
 */
export async function upsertTransactions(rows, chunkSize = 500, concurrency = 4) {
    if (!rows || rows.length === 0) return 0;
    const tasks = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        tasks.push(async () => {
            const { error } = await supabase.from('transactions').upsert(chunk, {
                onConflict: 'reference_number,item_price,check_column',
                ignoreDuplicates: false
            });
            if (error) throw error;
            return chunk.length;
        });
    }
    let saved = 0;
    for (let i = 0; i < tasks.length; i += concurrency) {
        const results = await Promise.all(tasks.slice(i, i + concurrency).map(fn => fn()));
        saved += results.reduce((a, b) => a + b, 0);
    }
    return saved;
}

/**
 * Escapes a value for safe insertion into HTML.
 */
export function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Neutralizes CSV / Excel formula injection in a cell value.
 * Strings beginning with '=', '+', '-', '@', tab, or CR (except plain negative numbers)
 * are prefixed with a single quote so spreadsheet apps treat them as text.
 */
export function sanitizeExcelValue(val) {
    if (typeof val !== 'string' || val.length === 0) return val;
    const trimmed = val.trimStart();
    if (!trimmed) return val;
    const first = trimmed[0];
    if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
        return `'${val}`;
    }
    if (first === '-' && !/^-\d+(\.\d+)?$/.test(trimmed) && trimmed !== '-') {
        return `'${val}`;
    }
    return val;
}

/**
 * Applies sanitizeExcelValue to every string property of each row object in an array.
 */
export function sanitizeExcelRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => {
        if (Array.isArray(row)) {
            return row.map(v => sanitizeExcelValue(v));
        }
        if (!row || typeof row !== 'object') return row;
        const clean = {};
        for (const [k, v] of Object.entries(row)) {
            clean[k] = sanitizeExcelValue(v);
        }
        return clean;
    });
}

/**
 * Strips any time component from a date value without timezone shifting,
 * returning a pure 'YYYY-MM-DD' string (or null).
 */
export function toDateOnly(val) {
    if (val === null || val === undefined || val === '') return null;
    if (val instanceof Date && !isNaN(val.getTime())) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    if (typeof val === 'number') {
        const intSerial = Math.floor(val);
        const d = new Date(Math.round((intSerial - 25569) * 86400 * 1000));
        return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    }
    const str = String(val).trim();
    if (!str) return null;
    const datePart = str.split(/[T ]/)[0];
    let m = datePart.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    if (m) {
        const year = m[1];
        const p1 = parseInt(m[2], 10);
        const p2 = parseInt(m[3], 10);
        let month = p1, day = p2;
        if (p1 > 12 && p2 <= 12) { day = p1; month = p2; }
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    m = datePart.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
        const first = parseInt(m[1], 10);
        const second = parseInt(m[2], 10);
        const year = m[3];
        let day = first, month = second;
        if (second > 12 && first <= 12) { day = second; month = first; }
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return datePart;
}

/**
 * Converts a date value to an integer Excel serial number (days since 1899-12-30)
 * with zero time fraction so Excel never displays a time component (e.g. 3:00:00 AM).
 */
export function dateToExcelSerial(val) {
    const clean = toDateOnly(val);
    if (!clean) return null;
    const parts = clean.split('-');
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/**
 * Calculates the Fawry bank settlement date for a given transaction payment date:
 * - Sunday (0), Monday (1), Tuesday (2), Wednesday (3) -> +1 day (next business day Mon-Thu)
 * - Thursday (4) -> +3 days (settled on Sunday)
 * - Friday (5)   -> +2 days (settled on Sunday)
 * - Saturday (6) -> +1 day  (settled on Sunday)
 *
 * Uses pure UTC calendar arithmetic so local timezones/DST never shift dates.
 * Returns a 'YYYY-MM-DD' string (or null if input is invalid).
 */
export function calculateSettlementDate(val) {
    const clean = toDateOnly(val);
    if (!clean) return null;
    const parts = clean.split('-');
    if (parts.length !== 3) return null;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;

    const utcDate = new Date(Date.UTC(y, m - 1, d));
    if (isNaN(utcDate.getTime())) return null;

    const dayOfWeek = utcDate.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
    const daysToAdd = dayOfWeek === 4 ? 3 : dayOfWeek === 5 ? 2 : 1;
    utcDate.setUTCDate(utcDate.getUTCDate() + daysToAdd);

    const sy = utcDate.getUTCFullYear();
    const sm = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const sd = String(utcDate.getUTCDate()).padStart(2, '0');
    return `${sy}-${sm}-${sd}`;
}
