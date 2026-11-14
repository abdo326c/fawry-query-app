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
 * Returns true if a single mapping label belongs to an ID-exempt category
 * (Dip, Diploma, Workshop, Workshops, Dip & Workshop, etc.).
 */
function isExemptMappingLabel(value) {
    const s = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!s) return false;
    if (
        s === 'dip' ||
        s === 'diploma' ||
        s === 'workshop' ||
        s === 'workshops' ||
        s === 'dip & workshop' ||
        s === 'dip and workshop'
    ) return true;
    return /\b(dip|diploma|workshops?)\b/i.test(s);
}

/**
 * Returns true if the given transaction or mapping values belong to a category
 * (Dip / Workshop) that does not follow standard tuition Student ID rules.
 */
export function isIdValidationExempt(txOrMapping, secondMapping = null) {
    let m1 = txOrMapping;
    let m2 = secondMapping;
    if (txOrMapping && typeof txOrMapping === 'object') {
        m1 = txOrMapping.mapping;
        m2 = txOrMapping.second_mapping ?? txOrMapping.secondMapping;
    }
    return isExemptMappingLabel(m1) || isExemptMappingLabel(m2);
}

/**
 * Returns the effective ID status for a transaction ('Valid', 'Exempt' for
 * Dip & Workshop non-Valid rows, or the standard validation message).
 */
export function getEffectiveIdStatus(tx) {
    if (!tx) return 'Missing ID';
    const rawStatus = tx.id_status ? String(tx.id_status).trim() : validateID(tx.student_id);
    if (rawStatus === 'Valid') return 'Valid';
    if (rawStatus === 'Exempt' || isIdValidationExempt(tx)) return 'Exempt';
    return rawStatus || 'Missing ID';
}

/**
 * Returns true when a transaction is Valid or Exempt (i.e. not an invalid/missing ID issue).
 */
export function isNonInvalidTransaction(tx) {
    const st = getEffectiveIdStatus(tx);
    return st === 'Valid' || st === 'Exempt';
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

    const rawIdStatus = validateID(studentId);
    const idStatus = (rawIdStatus !== 'Valid' && isIdValidationExempt(mapping, secondMapping))
        ? 'Exempt'
        : rawIdStatus;

    return {
        studentId,
        itemName,
        mapping,
        secondMapping,
        idStatus,
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
    const normalized = /[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(val) ? val.normalize('NFKC') : val;
    const trimmed = normalized.trimStart();
    if (!trimmed) return normalized;
    const first = trimmed[0];
    if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
        return `'${normalized}`;
    }
    if (first === '-' && !/^-\d+(\.\d+)?$/.test(trimmed) && trimmed !== '-') {
        return `'${normalized}`;
    }
    return normalized;
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

/**
 * Returns true if a transaction belongs to a bank / channel whose ERP journal date
 * is the exact transaction/value date (no next-day or weekend settlement delay),
 * such as Foreign Bank Statement deposits (NuMisrUsd5).
 */
export function isSameDaySettlementBank(row) {
    if (!row) return false;
    const bank = String(row.bank || '').trim().toLowerCase();
    return row._erpSource === 'foreign' || bank === 'numisrusd5';
}

/**
 * Resolves the Dynamics 365 ERP journal Date string ('YYYY-MM-DD') for a row:
 * - 'custom' with customDate -> customDate
 * - 'payment' -> exact payment/value date
 * - 'settlement' (default) -> same value date for same-day banks (NuMisrUsd5),
 *   or calculateSettlementDate(payment_date) for Fawry banks.
 */
export function resolveErpJournalDate(row, dateMode = 'settlement', customDate = null) {
    const baseDate = toDateOnly(row?.value_date || row?.payment_date || row?.transaction_date);
    if (dateMode === 'custom' && customDate) {
        return toDateOnly(customDate) || baseDate;
    }
    if (dateMode === 'payment' || isSameDaySettlementBank(row)) {
        return baseDate;
    }
    return calculateSettlementDate(baseDate) || baseDate;
}

// ==========================================
// High-Precision Auto-Matcher Engine
// ==========================================

const PHONETIC_TOKEN_MAP = {
    mohammed: 'mohamed',
    muhammad: 'mohamed',
    mohamad: 'mohamed',
    muhamed: 'mohamed',
    mohmed: 'mohamed',
    mahmod: 'mahmoud',
    mahmud: 'mahmoud',
    ahmad: 'ahmed',
    yousef: 'youssef',
    yusef: 'youssef',
    mustafa: 'mostafa',
    moustafa: 'mostafa',
    hussien: 'hussein',
    husain: 'hussein',
    hasan: 'hassan',
    aly: 'ali',
    ayah: 'aya',
    sarah: 'sara',
    fatema: 'fatma',
    fatima: 'fatma',
    zeyad: 'ziad',
    zyad: 'ziad',
    khalid: 'khaled',
    tarik: 'tarek',
    kareem: 'karim',
    ussama: 'osama',
    osamah: 'osama',
    eslam: 'islam',
    iman: 'eman',
    marawan: 'marwan'
};

const NAME_STOPWORDS = new Set([
    'student', 'students', 'name', 'id', 'sid', 'nu', 'dr', 'eng', 'mr', 'mrs', 'ms', 'miss', 'prof',
    'طالب', 'طالبه', 'الطالب', 'الطالبه', 'اسم', 'باسم', 'الاسم', 'دكتور', 'مهندس'
]);

const COLLEGE_KEYWORDS = [
    { code: 'engr', patterns: ['engr', 'engineering', 'هندس'] },
    { code: 'itcs', patterns: ['itcs', 'csce', 'computer', 'informatics', 'حاسبات'] },
    { code: 'eas', patterns: ['eas', 'business', 'management', 'اداره', 'اعمال'] },
    { code: 'biot', patterns: ['biot', 'biotech', 'تكنولوجيا حيويه'] },
    { code: 'arch', patterns: ['arch', 'architecture', 'عماره'] },
    { code: 'pharm', patterns: ['pharm', 'pharmacy', 'صيدل'] },
    { code: 'med', patterns: ['med', 'medicine', 'طب'] },
    { code: 'dent', patterns: ['dent', 'dental', 'اسنان'] }
];

/**
 * Normalizes a Student ID by trimming whitespace, stripping leading zeros on 4+ digit numeric IDs,
 * and standardizing DIP prefixes.
 */
export function normalizeStudentIdValue(val) {
    if (val === null || val === undefined) return '';
    const s = String(val).trim();
    if (!s) return '';
    const dipMatch = s.match(/^dip[\s\-]*(\d{10,16})$/i);
    if (dipMatch) return 'DIP' + dipMatch[1];
    if (/^0+\d{4,}$/.test(s)) {
        return s.replace(/^0+/, '');
    }
    return s;
}

/**
 * Classifies a student record or program string into 'UG' (Undergraduate) or 'PG' (Postgraduate / non-Undergraduate).
 * Rule: All Undergraduate programs are labeled 'UG'; otherwise 'PG'.
 * Returns '' when no student or program is provided.
 */
export function getStudentProgramLevel(studentOrProgram) {
    if (studentOrProgram === null || studentOrProgram === undefined) return '';
    let prog = '';
    if (typeof studentOrProgram === 'object') {
        const hasIdentity = Boolean(
            studentOrProgram.student_id ||
            studentOrProgram.full_name ||
            studentOrProgram.arabic_name ||
            studentOrProgram.program !== undefined
        );
        if (!hasIdentity) return '';
        if (studentOrProgram.level === 'UG' || studentOrProgram.level === '(UG)') return 'UG';
        if (studentOrProgram.level === 'PG' || studentOrProgram.level === '(PG)') return 'PG';
        prog = String(studentOrProgram.program || '').trim();
    } else {
        prog = String(studentOrProgram).trim();
        if (!prog) return '';
        if (prog === 'UG' || prog === '(UG)') return 'UG';
        if (prog === 'PG' || prog === '(PG)') return 'PG';
    }
    if (/^\(UG\)\b/i.test(prog)) return 'UG';
    if (/^\(PG\)\b/i.test(prog)) return 'PG';
    const cleanProg = prog.replace(/^\((?:UG|PG)\)\s*/i, '');
    const primarySegment = cleanProg.split('/')[0].trim();
    if (/^(graduate|postgraduate|diploma|phd|master|msc|mba|pg)\b/i.test(primarySegment)) {
        return 'PG';
    }
    if (/^(undergraduate|undergrad|bachelor|ug)\b/i.test(primarySegment)) {
        return 'UG';
    }
    return /\b(undergraduate|undergrad|bachelor|ug)\b/i.test(cleanProg) ? 'UG' : 'PG';
}

/**
 * Returns the parenthesized student level label: '(UG)' or '(PG)' (or '' if unknown).
 */
export function formatStudentLevelTag(studentOrProgram) {
    const level = (studentOrProgram === 'UG' || studentOrProgram === 'PG')
        ? studentOrProgram
        : getStudentProgramLevel(studentOrProgram);
    return level ? `(${level})` : '';
}

/**
 * Ensures a student program string starts with its '(UG)' or '(PG)' label without double-prefixing.
 */
export function ensureProgramHasLevelPrefix(programStr) {
    const raw = String(programStr || '').trim();
    const clean = raw.replace(/^\((?:UG|PG)\)\s*/i, '').trim();
    const level = getStudentProgramLevel({ program: clean });
    const tag = `(${level || 'PG'})`;
    return clean ? `${tag} ${clean}` : tag;
}

/**
 * Normalizes a phone number into a canonical 10-digit lookup key.
 * Rejects dummy/placeholder numbers (0000000000, 1111111111, 1234567890, etc.).
 * When strictMobile=true (used for free-text student_id / custom_input fields), requires
 * a valid Egyptian mobile prefix (010/011/012/015) so mistyped 10-digit Student IDs are never treated as phones.
 */
export function normalizePhoneKey(raw, { strictMobile = false } = {}) {
    if (raw === null || raw === undefined) return '';
    const digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length < 10 || digits.length > 15) return '';

    const egMatch = digits.match(/^(?:0020|20|0)?(1[0125]\d{8})$/);
    if (strictMobile) {
        if (!egMatch) return '';
    }
    const key = egMatch ? egMatch[1] : digits.slice(-10);

    // Reject dummy/repeating/sequential placeholders
    const uniqueDigits = new Set(key.split('')).size;
    if (uniqueDigits < 3) return '';
    if (key === '1234567890' || key === '0123456789' || key === '9876543210') return '';
    return key;
}

/**
 * Normalizes a National ID or Passport string for exact lookup, rejecting placeholders.
 */
export function normalizeNationalIdKey(raw) {
    if (raw === null || raw === undefined) return '';
    const clean = String(raw).trim().replace(/[\s\-]+/g, '').toUpperCase();
    if (clean.length < 7 || clean.length > 20) return '';
    const digitCount = (clean.match(/\d/g) || []).length;
    if (digitCount < 5) return '';
    if (new Set(clean.split('')).size < 3) return '';
    return clean;
}

/**
 * Normalizes Arabic & English person names for high-accuracy matching:
 * - Normalizes Arabic presentation forms, Alef/Yaa/Taa-Marbuta, and diacritics
 * - Removes titles/labels and punctuation
 * - Merges compound Egyptian name prefixes/suffixes (Abdel Rahman -> abdelrahman, عبد الرحمن -> عبدالرحمن, etc.)
 * - Normalizes common English transliteration variants (Mohammed -> mohamed, Ahmad -> ahmed, etc.)
 */
export function normalizeAutoMatchName(str) {
    if (!str) return '';
    let s = String(str);
    if (/[\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s)) {
        s = s.normalize('NFKC');
    }
    s = s
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .toLowerCase()
        .replace(/[^\u0600-\u06FFa-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!s) return '';

    // Merge common compound Arabic & English name parts so token positions align consistently
    s = s
        .replace(/\b(abd)\s+(el|al)\s+([a-z]{3,})\b/g, 'abdel$3')
        .replace(/\b(abdel|abdul)\s+([a-z]{3,})\b/g, 'abdel$2')
        .replace(/\b(el|al)\s+([a-z]{3,})\b/g, 'el$2')
        .replace(/\b([a-z]{3,})\s+(el|al)\s*(din|deen)\b/g, '$1eldin')
        .replace(/\b(abu|abo)\s+([a-z]{3,})\b/g, 'abu$2')
        .replace(/(?:^|\s)عبد\s+ال(\S+)/g, ' عبدال$1')
        .replace(/(?:^|\s)ابو\s+(\S+)/g, ' ابو$1')
        .replace(/(\S+)\s+الدين(?=\s|$)/g, '$1الدين')
        .replace(/\s+/g, ' ')
        .trim();

    const tokens = s
        .split(' ')
        .filter(t => t.length >= 2 && !NAME_STOPWORDS.has(t))
        .map(t => PHONETIC_TOKEN_MAP[t] || t);

    return tokens.join(' ');
}

/**
 * Extracts ordered candidate Student IDs from a potentially dirty input string
 * (e.g. "221001005 - Ahmed", "00221001005", "ID: 241001700 / Fall 2025", "DIP 12345678901234").
 */
export function extractCandidateStudentIds(raw) {
    if (raw === null || raw === undefined) return [];
    const text = String(raw).trim();
    if (!text) return [];

    const out = [];
    const add = (v) => {
        if (!v) return;
        const clean = String(v).trim();
        if (clean && !out.includes(clean)) out.push(clean);
        const norm = normalizeStudentIdValue(clean);
        if (norm && !out.includes(norm)) out.push(norm);
    };

    // 1. Direct value & normalized value
    add(text);

    // 2. Standalone DIP IDs (even with spaces/hyphens after DIP)
    const dipRegex = /(?:^|[^A-Za-z0-9])(DIP[\s\-]*\d{10,16})(?:$|[^A-Za-z0-9])/gi;
    let m;
    while ((m = dipRegex.exec(text)) !== null) {
        add(m[1].replace(/[\s\-]+/g, '').toUpperCase());
    }

    // 3. Standalone 9-digit NU Student IDs (2xxxxxxxx) or 0-padded IDs (00221001005)
    const nu9Regex = /(?:^|\D)(0*2\d{8})(?:\D|$)/g;
    while ((m = nu9Regex.exec(text)) !== null) {
        add(m[1]);
    }

    // 4. Pure numeric with spaces/hyphens (e.g. "221-001-005" or "00 12345")
    const hasLetters = /[A-Za-z\u0600-\u06FF@]/.test(text);
    const allDigits = text.replace(/[^0-9]/g, '');
    if (!hasLetters && allDigits.length >= 4 && allDigits.length <= 11 && /^0*\d{4,9}$/.test(allDigits)) {
        add(allDigits);
    }

    // 5. Embedded 4–9 digit tokens inside mixed text (excluding 4-digit calendar years 1990-2035 when text has words)
    const numTokenRegex = /(?:^|\D)(0*\d{4,9})(?:\D|$)/g;
    while ((m = numTokenRegex.exec(text)) !== null) {
        const token = m[1];
        const norm = normalizeStudentIdValue(token);
        if (hasLetters && norm.length === 4) {
            const yr = parseInt(norm, 10);
            if (yr >= 1990 && yr <= 2035) continue; // Skip cohort/calendar years like "Fall 2025"
        }
        add(token);
    }

    return out;
}

function tokenEditDistanceLeq1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1 || Math.min(la, lb) < 5) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) {
            i++;
            j++;
        } else {
            edits++;
            if (edits > 1) return false;
            if (la > lb) i++;
            else if (lb > la) j++;
            else { i++; j++; }
        }
    }
    if (i < la || j < lb) edits++;
    return edits <= 1;
}

function tokenSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (tokenEditDistanceLeq1(a, b)) return 0.88;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 2 || Math.min(la, lb) < 4) return 0;
    const dp = Array.from({ length: la + 1 }, (_, r) => {
        const row = new Array(lb + 1);
        row[0] = r;
        return row;
    });
    for (let c = 0; c <= lb; c++) dp[0][c] = c;
    for (let r = 1; r <= la; r++) {
        for (let c = 1; c <= lb; c++) {
            const cost = a[r - 1] === b[c - 1] ? 0 : 1;
            dp[r][c] = Math.min(dp[r - 1][c] + 1, dp[r][c - 1] + 1, dp[r - 1][c - 1] + cost);
        }
    }
    const dist = dp[la][lb];
    return Math.max(0, 1 - dist / Math.max(la, lb));
}

function detectCollegeCode(str) {
    if (!str) return null;
    const s = String(str).toLowerCase();
    for (const c of COLLEGE_KEYWORDS) {
        if (c.patterns.some(p => s.includes(p))) return c.code;
    }
    return null;
}

/**
 * Builds a collision-aware lookup index over student_master records.
 */
export function buildStudentLookupIndex(students = []) {
    const idMap = new Map();
    const emailMap = new Map();
    const nationalIdMap = new Map();
    const directMobileMap = new Map();
    const guardianMobileMap = new Map();
    const exactNameMap = new Map();
    const exactGuardianNameMap = new Map();
    const firstTokenIndex = new Map();
    const preparedStudents = [];

    const pushUnique = (map, key, student) => {
        if (!key) return;
        let arr = map.get(key);
        if (!arr) {
            arr = [];
            map.set(key, arr);
        }
        const normSid = normalizeStudentIdValue(student.student_id);
        if (!arr.some(x => normalizeStudentIdValue(x.student_id) === normSid)) {
            arr.push(student);
        }
    };

    for (const s of (students || [])) {
        if (!s || !s.student_id) continue;
        const rawSid = String(s.student_id).trim();
        const normSid = normalizeStudentIdValue(rawSid);
        idMap.set(rawSid, s);
        idMap.set(rawSid.toUpperCase(), s);
        if (normSid) {
            idMap.set(normSid, s);
            idMap.set(normSid.toUpperCase(), s);
        }

        if (s.email) {
            const em = String(s.email).toLowerCase().trim();
            if (em.includes('@') && em.length >= 6) {
                pushUnique(emailMap, em, s);
            }
        }

        if (s.national_id) {
            const nid = normalizeNationalIdKey(s.national_id);
            if (nid) pushUnique(nationalIdMap, nid, s);
        }

        const directPhone = normalizePhoneKey(s.mobile);
        if (directPhone) pushUnique(directMobileMap, directPhone, s);

        const guardianPhone = normalizePhoneKey(s.guardian_mobile);
        if (guardianPhone) pushUnique(guardianMobileMap, guardianPhone, s);

        const normEn = normalizeAutoMatchName(s.full_name || '');
        const normAr = normalizeAutoMatchName(s.arabic_name || '');
        const normGuardian = normalizeAutoMatchName(s.guardian_name || '');
        const enTokens = normEn ? normEn.split(' ') : [];
        const arTokens = normAr ? normAr.split(' ') : [];
        const guardianTokens = normGuardian ? normGuardian.split(' ') : [];

        if (normEn && enTokens.length >= 2) pushUnique(exactNameMap, normEn, s);
        if (normAr && arTokens.length >= 2) pushUnique(exactNameMap, normAr, s);
        if (normGuardian && guardianTokens.length >= 3) pushUnique(exactGuardianNameMap, normGuardian, s);

        const prep = {
            student: s,
            sid: normSid || rawSid,
            normEn,
            normAr,
            normGuardian,
            enTokens,
            arTokens,
            guardianTokens,
            directPhone,
            guardianPhone,
            collegeCode: detectCollegeCode(`${s.college || ''} ${s.program || ''}`)
        };
        preparedStudents.push(prep);

        if (enTokens[0]) {
            let list = firstTokenIndex.get(enTokens[0]);
            if (!list) { list = []; firstTokenIndex.set(enTokens[0], list); }
            list.push(prep);
        }
        if (arTokens[0]) {
            let list = firstTokenIndex.get(arTokens[0]);
            if (!list) { list = []; firstTokenIndex.set(arTokens[0], list); }
            list.push(prep);
        }
    }

    return {
        idMap,
        emailMap,
        nationalIdMap,
        directMobileMap,
        guardianMobileMap,
        exactNameMap,
        exactGuardianNameMap,
        firstTokenIndex,
        preparedStudents
    };
}

/**
 * Resolves a candidate list (1 or more students sharing a phone/email/name)
 * using secondary contextual signals from the transaction and payment link.
 */
function resolveCandidateGroup(candidates, context) {
    if (!candidates || candidates.length === 0) {
        return { student: null, disambiguatedBy: null, ambiguous: false };
    }
    if (candidates.length === 1) {
        return { student: candidates[0], disambiguatedBy: null, ambiguous: false };
    }

    const { nameTokensSet, txPhonesSet, txEmailsSet, txCollegeCode } = context;
    const scored = candidates.map(student => {
        let score = 0;
        const reasons = [];

        const sNameNorm = `${normalizeAutoMatchName(student.full_name || '')} ${normalizeAutoMatchName(student.arabic_name || '')}`.trim();
        const sTokens = sNameNorm ? sNameNorm.split(/\s+/) : [];
        if (sTokens.length > 0 && nameTokensSet.size > 0) {
            if (nameTokensSet.has(sTokens[0])) {
                score += 50;
                reasons.push('First Name');
            }
            let extra = 0;
            for (let i = 1; i < sTokens.length; i++) {
                if (nameTokensSet.has(sTokens[i])) extra++;
            }
            if (extra > 0) {
                score += extra * 25;
                reasons.push('Family Name');
            }
        }

        const em = student.email ? String(student.email).toLowerCase().trim() : '';
        if (em && txEmailsSet.has(em)) {
            score += 60;
            reasons.push('Email');
        }

        const p1 = normalizePhoneKey(student.mobile);
        const p2 = normalizePhoneKey(student.guardian_mobile);
        if ((p1 && txPhonesSet.has(p1)) || (p2 && txPhonesSet.has(p2))) {
            score += 30;
            reasons.push('Phone');
        }

        const sCol = detectCollegeCode(`${student.college || ''} ${student.program || ''}`);
        if (txCollegeCode && sCol && txCollegeCode === sCol) {
            score += 25;
            reasons.push('College/Program');
        }

        return { student, score, reason: [...new Set(reasons)].join(' + ') };
    }).sort((a, b) => b.score - a.score);

    if (scored[0].score > 0 && (scored[0].score - (scored[1]?.score || 0)) >= 20) {
        return {
            student: scored[0].student,
            disambiguatedBy: scored[0].reason,
            ambiguous: false
        };
    }

    return { student: null, disambiguatedBy: null, ambiguous: true };
}

/**
 * Matches an ordered 3+ token query name against a student's 3+ token full name
 * (e.g. "Aya Ramadan Rashed" -> "Aya Ramadan Mohamed Rashed"), requiring:
 * - First name token (pos 0) and Father's name token (pos 1) to match in order
 * - All remaining query tokens to match in strictly increasing order.
 */
function scoreOrderedNameTokens(qTokens, tTokens) {
    if (!qTokens || !tTokens || qTokens.length < 3 || tTokens.length < 3) return 0;
    if (qTokens.length > tTokens.length) return 0;

    // Position 0 (Given name) and Position 1 (Father's name) must match
    const sim0 = tokenSimilarity(qTokens[0], tTokens[0]);
    if (sim0 < 0.85) return 0;
    const sim1 = tokenSimilarity(qTokens[1], tTokens[1]);
    if (sim1 < 0.85) return 0;

    let tIdx = 2;
    let simSum = sim0 + sim1;
    for (let qIdx = 2; qIdx < qTokens.length; qIdx++) {
        const qt = qTokens[qIdx];
        let foundSim = 0;
        while (tIdx < tTokens.length) {
            const s = tokenSimilarity(qt, tTokens[tIdx]);
            tIdx++;
            if (s >= 0.84) {
                foundSim = s;
                break;
            }
        }
        if (!foundSim) return 0;
        simSum += foundSim;
    }

    const avgSim = simSum / qTokens.length;
    const coverageBonus = (qTokens.length / Math.max(qTokens.length, tTokens.length)) * 0.08;
    // Slight bonus when the last token of query matches the last token (family surname) of target
    const lastMatches = tokenSimilarity(qTokens[qTokens.length - 1], tTokens[tTokens.length - 1]) >= 0.85 ? 0.04 : 0;
    return Math.min(0.99, avgSim * 0.88 + coverageBonus + lastMatches);
}

/**
 * High-precision single-transaction matcher used by Auto Matcher.
 */
export function matchTransactionToStudent(tx, {
    index,
    link = null,
    existingFix = null,
    enableNameMatch = false,
    sharedMobileSet = null
} = {}) {
    if (!tx || !index) {
        return { proposedStudent: null, matchReason: '', confidenceTier: 'unmatched' };
    }

    const rawTxSid = tx.student_id ? String(tx.student_id).trim() : '';
    const origTxSid = tx.original_student_id ? String(tx.original_student_id).trim() : '';
    const customInput = link?.custom_input_value ? String(link.custom_input_value).trim() : '';

    // Gather contextual signals for sibling/collision disambiguation
    const nameCandidateStrings = [];
    if (link?.customer_name) nameCandidateStrings.push({ text: String(link.customer_name).trim(), source: 'Link Info' });
    if (rawTxSid && /[A-Za-z\u0600-\u06FF]/.test(rawTxSid) && !rawTxSid.includes('@')) {
        nameCandidateStrings.push({ text: rawTxSid, source: 'Transaction data' });
    }
    if (origTxSid && origTxSid !== rawTxSid && /[A-Za-z\u0600-\u06FF]/.test(origTxSid) && !origTxSid.includes('@')) {
        nameCandidateStrings.push({ text: origTxSid, source: 'Original Transaction ID' });
    }
    if (customInput && /[A-Za-z\u0600-\u06FF]/.test(customInput) && !customInput.includes('@')) {
        nameCandidateStrings.push({ text: customInput, source: 'Link Info' });
    }

    const nameTokensSet = new Set();
    for (const nc of nameCandidateStrings) {
        const norm = normalizeAutoMatchName(nc.text);
        if (norm) norm.split(' ').forEach(t => nameTokensSet.add(t));
    }

    const txEmailsSet = new Set();
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    for (const src of [link?.customer_email, customInput, rawTxSid, origTxSid]) {
        if (!src) continue;
        const matches = String(src).toLowerCase().match(emailRegex);
        if (matches) matches.forEach(e => txEmailsSet.add(e.trim()));
    }

    const txPhonesSet = new Set();
    for (const p of [
        normalizePhoneKey(link?.customer_mobile),
        normalizePhoneKey(customInput, { strictMobile: true }),
        normalizePhoneKey(rawTxSid, { strictMobile: true }),
        normalizePhoneKey(origTxSid, { strictMobile: true }),
        normalizePhoneKey(tx.customer_mobile)
    ]) {
        if (p) txPhonesSet.add(p);
    }

    const txCollegeCode = detectCollegeCode(`${tx.item_name || ''} ${tx.mapping || ''} ${tx.second_mapping || ''}`);
    const context = { nameTokensSet, txPhonesSet, txEmailsSet, txCollegeCode };

    // Priority 0: Existing Manual Fix for Reference
    if (existingFix && existingFix.correct_id) {
        for (const candId of extractCandidateStudentIds(existingFix.correct_id)) {
            const st = index.idMap.get(candId) || index.idMap.get(candId.toUpperCase());
            if (st) {
                return {
                    proposedStudent: st,
                    matchReason: 'Existing Manual Fix for Reference',
                    confidenceTier: 'high'
                };
            }
        }
    }

    // Priority 1a: Student ID in Link Info (exact or embedded token)
    if (customInput) {
        for (const candId of extractCandidateStudentIds(customInput)) {
            const st = index.idMap.get(candId) || index.idMap.get(candId.toUpperCase());
            if (st) {
                return {
                    proposedStudent: st,
                    matchReason: 'Found exact ID in Link Info',
                    confidenceTier: 'high'
                };
            }
        }
    }

    // Priority 1b: Student ID in Transaction student_id or original_student_id (normalized / 0-padded / embedded)
    for (const sidField of [rawTxSid, origTxSid]) {
        if (!sidField) continue;
        for (const candId of extractCandidateStudentIds(sidField)) {
            const st = index.idMap.get(candId) || index.idMap.get(candId.toUpperCase());
            if (st) {
                return {
                    proposedStudent: st,
                    matchReason: 'Normalized Student ID in Transaction',
                    confidenceTier: 'high'
                };
            }
        }
    }

    // Priority 2a & 2b: Email in Link Info or Transaction ID field
    const tryEmailMatch = (rawStr, reasonLabel) => {
        if (!rawStr) return null;
        const foundEmails = String(rawStr).toLowerCase().match(emailRegex) || [];
        for (const em of foundEmails) {
            const cands = index.emailMap.get(em.trim());
            const resolved = resolveCandidateGroup(cands, context);
            if (resolved.student) {
                return {
                    proposedStudent: resolved.student,
                    matchReason: resolved.disambiguatedBy ? `${reasonLabel} (${resolved.disambiguatedBy})` : reasonLabel,
                    confidenceTier: 'high'
                };
            }
            // Also check if university email local-part contains a 9-digit NU student ID
            if (em.endsWith('@nu.edu.eg')) {
                const localPart = em.split('@')[0];
                for (const candId of extractCandidateStudentIds(localPart)) {
                    const st = index.idMap.get(candId);
                    if (st) {
                        return {
                            proposedStudent: st,
                            matchReason: `${reasonLabel} (ID in NU Email)`,
                            confidenceTier: 'high'
                        };
                    }
                }
            }
        }
        return null;
    };

    const emailLinkHit = tryEmailMatch(link?.customer_email, 'Email matched via Link Info') ||
        tryEmailMatch(customInput, 'Email matched via Link Info');
    if (emailLinkHit) return emailLinkHit;

    const emailTxHit = tryEmailMatch(rawTxSid, 'Email entered in Transaction ID field') ||
        tryEmailMatch(origTxSid, 'Email entered in Transaction ID field');
    if (emailTxHit) return emailTxHit;

    // Priority 3a & 3b: National ID in Link Info or Transaction ID field
    const extractNationalIdCandidates = (rawStr) => {
        if (!rawStr) return [];
        const list = [];
        const direct = normalizeNationalIdKey(rawStr);
        if (direct) list.push(direct);
        const digitsOnly = String(rawStr).replace(/[^0-9]/g, '');
        if (digitsOnly.length === 14) list.push(digitsOnly);
        const egNidRegex = /(?:^|\D)([23]\d{13})(?:\D|$)/g;
        let m;
        while ((m = egNidRegex.exec(String(rawStr))) !== null) {
            if (!list.includes(m[1])) list.push(m[1]);
        }
        return list;
    };

    const tryNationalIdMatch = (rawStr, reasonLabel) => {
        for (const nid of extractNationalIdCandidates(rawStr)) {
            const cands = index.nationalIdMap.get(nid);
            const resolved = resolveCandidateGroup(cands, context);
            if (resolved.student) {
                return {
                    proposedStudent: resolved.student,
                    matchReason: resolved.disambiguatedBy ? `${reasonLabel} (${resolved.disambiguatedBy})` : reasonLabel,
                    confidenceTier: 'high'
                };
            }
        }
        return null;
    };

    const nidLinkHit = tryNationalIdMatch(link?.customer_national_id, 'National ID matched via Link Info') ||
        tryNationalIdMatch(customInput, 'National ID matched via Link Info');
    if (nidLinkHit) return nidLinkHit;

    const nidTxHit = tryNationalIdMatch(rawTxSid, 'National ID entered in Transaction ID field') ||
        tryNationalIdMatch(origTxSid, 'National ID entered in Transaction ID field');
    if (nidTxHit) return nidTxHit;

    // Helper: evaluate name candidates (used both for Priority 5 and to guard Priority 4 against kiosk-phone conflicts)
    const findBestNameMatch = () => {
        for (const { text, source } of nameCandidateStrings) {
            const normQuery = normalizeAutoMatchName(text);
            if (!normQuery) continue;
            const qTokens = normQuery.split(' ').filter(t => t.length >= 2);
            if (qTokens.length < 2) continue;

            // 5a: Exact normalized full name (English or Arabic)
            const exactCands = index.exactNameMap.get(normQuery);
            if (exactCands && exactCands.length > 0) {
                const resolved = resolveCandidateGroup(exactCands, context);
                if (resolved.student) {
                    return {
                        student: resolved.student,
                        matchReason: `Exact Name matched via ${source}`,
                        score: 1.0,
                        isExact: true
                    };
                }
            }

            // 5b: Ordered 3+ token subsequence match (e.g. 3-part name vs 4-part official name)
            if (qTokens.length >= 3) {
                const pool = index.firstTokenIndex.get(qTokens[0]) || index.preparedStudents;
                let bestCand = null;
                let bestScore = 0;
                let secondBestScore = 0;

                for (const cand of pool) {
                    const sEn = scoreOrderedNameTokens(qTokens, cand.enTokens);
                    const sAr = scoreOrderedNameTokens(qTokens, cand.arTokens);
                    let sc = Math.max(sEn, sAr);
                    if (sc > 0 && txCollegeCode && cand.collegeCode && txCollegeCode === cand.collegeCode) {
                        sc = Math.min(0.99, sc + 0.03);
                    }
                    if (sc > bestScore) {
                        secondBestScore = bestScore;
                        bestScore = sc;
                        bestCand = cand;
                    } else if (sc > secondBestScore && cand.sid !== bestCand?.sid) {
                        secondBestScore = sc;
                    }
                }

                if (bestCand && bestScore >= 0.85 && (bestScore - secondBestScore) >= 0.06) {
                    const confidence = Math.round(bestScore * 100);
                    return {
                        student: bestCand.student,
                        matchReason: `Full Name matched via ${source} (${confidence}%): "${bestCand.student.full_name || bestCand.student.arabic_name}"`,
                        score: bestScore,
                        isExact: false
                    };
                }
            }

            // 5c: Exact 3+ token Guardian Name match
            if (qTokens.length >= 3) {
                const guardCands = index.exactGuardianNameMap.get(normQuery);
                if (guardCands && guardCands.length > 0) {
                    const resolved = resolveCandidateGroup(guardCands, context);
                    if (resolved.student) {
                        return {
                            student: resolved.student,
                            matchReason: `Guardian Name matched via ${source}`,
                            score: 0.92,
                            isExact: true
                        };
                    }
                }
            }

            // 5d: Guarded Fuzzy Match on 3+ token names (catches 1-2 character spelling typos while blocking 2-word false positives)
            if (qTokens.length >= 3 && index.preparedStudents.length > 0) {
                let bestCand = null;
                let bestSim = 0;
                let secondSim = 0;

                for (const cand of index.preparedStudents) {
                    for (const tTokens of [cand.enTokens, cand.arTokens]) {
                        if (!tTokens || tTokens.length < 3) continue;
                        const s0 = tokenSimilarity(qTokens[0], tTokens[0]);
                        if (s0 < 0.80) continue;
                        const s1 = tokenSimilarity(qTokens[1], tTokens[1]);
                        if (s1 < 0.80) continue;

                        const compareLen = Math.min(qTokens.length, tTokens.length);
                        let sum = s0 + s1;
                        let ok = true;
                        for (let i = 2; i < compareLen; i++) {
                            const si = tokenSimilarity(qTokens[i], tTokens[i]);
                            const siLast = (i === qTokens.length - 1) ? tokenSimilarity(qTokens[i], tTokens[tTokens.length - 1]) : 0;
                            const bestTokenSim = Math.max(si, siLast);
                            if (bestTokenSim < 0.78) {
                                ok = false;
                                break;
                            }
                            sum += bestTokenSim;
                        }
                        if (!ok) continue;
                        const avg = sum / compareLen;
                        if (avg > bestSim) {
                            if (cand.sid !== bestCand?.sid) secondSim = bestSim;
                            bestSim = avg;
                            bestCand = cand;
                        } else if (avg > secondSim && cand.sid !== bestCand?.sid) {
                            secondSim = avg;
                        }
                    }
                }

                if (bestCand && bestSim >= 0.86 && (bestSim - secondSim) >= 0.04) {
                    const confidence = Math.round(bestSim * 100);
                    return {
                        student: bestCand.student,
                        matchReason: `Fuzzy Name Match (Confidence: ${confidence}%): "${bestCand.student.full_name || bestCand.student.arabic_name}"`,
                        score: bestSim,
                        isExact: false
                    };
                }
            }
        }
        return null;
    };

    // Priority 4a, 4b, 4c: Phone number matching (Direct Student Mobile prioritized over Guardian Mobile)
    const phoneSources = [
        { key: normalizePhoneKey(link?.customer_mobile), label: 'Phone number matched via Link Info', isTerminalMobile: false },
        { key: normalizePhoneKey(customInput, { strictMobile: true }), label: 'Phone number matched via Link Info', isTerminalMobile: false },
        { key: normalizePhoneKey(rawTxSid, { strictMobile: true }), label: 'Phone number entered in Transaction ID field', isTerminalMobile: false },
        { key: normalizePhoneKey(origTxSid, { strictMobile: true }), label: 'Phone number entered in Transaction ID field', isTerminalMobile: false },
        { key: normalizePhoneKey(tx.customer_mobile), label: 'Phone number matched via Transaction data', isTerminalMobile: true }
    ];

    for (const src of phoneSources) {
        if (!src.key) continue;

        // Try direct student mobile first, then guardian mobile
        const directCands = index.directMobileMap.get(src.key);
        const guardianCands = index.guardianMobileMap.get(src.key);
        let resolved = resolveCandidateGroup(directCands, context);
        let isGuardian = false;
        if (!resolved.student && !resolved.ambiguous && guardianCands && guardianCands.length > 0) {
            resolved = resolveCandidateGroup(guardianCands, context);
            isGuardian = true;
        }

        if (resolved.student) {
            const matchedStudent = resolved.student;
            const sNorm = `${normalizeAutoMatchName(matchedStudent.full_name || '')} ${normalizeAutoMatchName(matchedStudent.arabic_name || '')} ${normalizeAutoMatchName(matchedStudent.guardian_name || '')}`.trim();
            const sTokenSet = new Set(sNorm ? sNorm.split(/\s+/) : []);
            const hasNameOverlap = nameTokensSet.size > 0 && [...nameTokensSet].some(t => sTokenSet.has(t));

            // Guard against Fawry Kiosk / Third-Party Terminal Mobile conflicts:
            // If the match came from tx.customer_mobile AND rawTxSid contains a 3+ word student name
            // that has ZERO overlap with the phone owner, check if that name belongs to another student!
            if (src.isTerminalMobile && !hasNameOverlap && nameTokensSet.size >= 3) {
                const nameHit = findBestNameMatch();
                if (nameHit && normalizeStudentIdValue(nameHit.student.student_id) !== normalizeStudentIdValue(matchedStudent.student_id)) {
                    if (enableNameMatch) {
                        return {
                            proposedStudent: nameHit.student,
                            matchReason: nameHit.matchReason,
                            confidenceTier: 'name'
                        };
                    }
                    // Do not assign Student B's named transaction to Student A's terminal phone
                    continue;
                }
                if (sharedMobileSet && sharedMobileSet.has(src.key)) {
                    continue;
                }
            }

            let reason = src.label;
            if (isGuardian && !reason.includes('Guardian')) {
                reason = `${reason} (Guardian Mobile)`;
            }
            if (resolved.disambiguatedBy) {
                reason = `${reason} — Disambiguated by ${resolved.disambiguatedBy}`;
            } else if (hasNameOverlap && nameTokensSet.size >= 2) {
                reason = `${reason} (Verified by Student Name)`;
            }

            return {
                proposedStudent: matchedStudent,
                matchReason: reason,
                confidenceTier: 'phone'
            };
        }
    }

    // Priority 5: Name Matching (when enabled)
    if (enableNameMatch) {
        const nameHit = findBestNameMatch();
        if (nameHit) {
            return {
                proposedStudent: nameHit.student,
                matchReason: nameHit.matchReason,
                confidenceTier: 'name'
            };
        }
    }

    return { proposedStudent: null, matchReason: '', confidenceTier: 'unmatched' };
}
