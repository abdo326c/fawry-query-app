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

    if (link && link.custom_input_value) { studentId = link.custom_input_value; sources.studentId = 'link'; }
    if (fix && fix.correct_id) { studentId = fix.correct_id; sources.studentId = 'fix'; }

    // Remove stray spaces from ID-like values ("2310 00123" → "231000123"); names are left untouched
    if (studentId !== null && studentId !== undefined) {
        const compact = String(studentId).replace(/[\s\u00A0]+/g, '');
        if (/^(DIP)?\d+$/i.test(compact)) studentId = compact.toUpperCase();
    }

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
 * Builds a mapping lookup function from item_mappings rows.
 */
export function buildMappingLookup(mappings) {
    const map = new Map();
    (mappings || []).forEach(m => map.set(String(m.item_name || '').trim(), m));
    return (name) => map.get(String(name || '').trim());
}

/**
 * Fetch every row of a table (paginated past the 1,000-row limit).
 * @param {string} table
 * @param {string} selectCols
 * @param {(q:any)=>any} [queryFn] adds filters to the query
 * @param {string} [orderByCol] a unique, stable column to page by
 */
export async function fetchAll(table, selectCols = '*', queryFn = null, orderByCol = 'id') {
    let allData = [];
    let from = 0;
    while (true) {
        let query = supabase.from(table).select(selectCols);
        if (queryFn) query = queryFn(query);
        query = query.order(orderByCol).range(from, from + PAGE_SIZE - 1);
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return allData;
}

/**
 * Fetch every row whose `column` is in `values`, chunking the IN list and paginating each chunk.
 */
export async function fetchByIn(table, selectCols, column, values, orderByCol = 'id', chunkSize = 200) {
    const unique = [...new Set((values || []).filter(v => v !== null && v !== undefined && v !== '').map(String))];
    let all = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
        const chunk = unique.slice(i, i + chunkSize);
        const rows = await fetchAll(table, selectCols, q => q.in(column, chunk), orderByCol);
        all = all.concat(rows);
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
export async function recomputeTransactions(txs, { mappings, includeLocked = false } = {}) {
    if (!txs || txs.length === 0) return [];
    const refs = txs.map(t => String(t.reference_number));

    const [fixes, links, allMappings] = await Promise.all([
        fetchByIn('manual_fixes', '*', 'reference_number', refs, 'reference_number'),
        fetchByIn('links', 'payment_reference_number, custom_input_value', 'payment_reference_number', refs, 'payment_reference_number'),
        mappings ? Promise.resolve(mappings) : fetchAll('item_mappings', '*', null, 'item_name')
    ]);

    const fixesMap = new Map(fixes.map(f => [String(f.reference_number), f]));
    const linksMap = new Map(links.map(l => [String(l.payment_reference_number), l]));
    const lookupMapping = buildMappingLookup(allMappings);

    const changed = [];
    for (const tx of txs) {
        const ref = String(tx.reference_number);
        const diff = diffTransaction(tx, { link: linksMap.get(ref), fix: fixesMap.get(ref), lookupMapping });
        if (!diff.changed) continue;
        if (diff.locked && !includeLocked) continue;
        changed.push({ id: tx.id, fields: diff.fields, tx, diff });
    }
    return changed;
}

/**
 * Writes ONLY the rule columns (RULE_FIELDS) of the given rows, by id.
 * Rows with identical new values are grouped into one UPDATE ... WHERE id IN (...), so a
 * mapping change touching thousands of rows is a handful of requests. Settlement, ERP and
 * every other column are never sent, so a concurrent settlement/ERP run can't be overwritten.
 *
 * @param {{id:any, fields:object}[]} updates
 * @returns {Promise<number>} rows updated
 * @throws on the first error
 */
export async function updateRuleFields(updates, { idChunkSize = 200, concurrency = 4 } = {}) {
    const groups = new Map();
    for (const u of updates || []) {
        if (u.id === null || u.id === undefined) throw new Error('Cannot update a transaction without an id');
        const values = {};
        RULE_FIELDS.forEach(f => { values[f] = u.fields[f] ?? null; });
        const key = JSON.stringify(RULE_FIELDS.map(f => values[f]));
        if (!groups.has(key)) groups.set(key, { values, ids: [] });
        groups.get(key).ids.push(u.id);
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
export async function upsertTransactions(rows, chunkSize = 500) {
    let saved = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await supabase.from('transactions').upsert(chunk, {
            onConflict: 'reference_number,item_price,check_column',
            ignoreDuplicates: false
        });
        if (error) throw error;
        saved += chunk.length;
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
