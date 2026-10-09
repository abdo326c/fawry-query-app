// Shared business rules and data helpers.
// Used by the importer (csv-processor.js) and by the UI (app.js) so that
// importing, saving a fix/mapping and "Re-apply Rules" always give the same result.
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

    if (link && link.custom_input_value) studentId = link.custom_input_value;
    if (fix && fix.correct_id) studentId = fix.correct_id;

    // Remove stray spaces from ID-like values ("2310 00123" → "231000123"); names are left untouched
    if (studentId !== null && studentId !== undefined) {
        const compact = String(studentId).replace(/[\s\u00A0]+/g, '');
        if (/^(DIP)?\d+$/i.test(compact)) studentId = compact.toUpperCase();
    }

    const fixedName = fix && fix.item_name ? fix.item_name : null;
    if (fixedName) itemName = fixedName;

    let mapDef = lookupMapping ? lookupMapping(String(itemName || '').trim()) : undefined;
    // A fix that renames the item to a name without its own rule keeps the original item's mapping
    if (!mapDef && fixedName && lookupMapping) mapDef = lookupMapping(String(base.itemName || '').trim());
    if (mapDef) {
        if (mapDef.adjusted_item_name && !fixedName) itemName = mapDef.adjusted_item_name;
        mapping = mapDef.mapping || null;
        secondMapping = mapDef.second_mapping || null;
    }

    if (fix && fix.mapping) mapping = fix.mapping;
    if (fix && fix.second_mapping) secondMapping = fix.second_mapping;

    return {
        studentId,
        itemName,
        mapping,
        secondMapping,
        idStatus: validateID(studentId)
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

/**
 * Re-computes student ID / item name / mappings / ID status for existing transaction rows
 * using the current links, manual fixes and item mappings in the database.
 * Returns only the rows that changed (full rows, ready to upsert).
 */
export async function recomputeTransactions(txs, { mappings } = {}) {
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
        const r = applyBusinessRules(
            { studentId: tx.student_id, itemName: originalItemName(tx) },
            { link: linksMap.get(ref), fix: fixesMap.get(ref), lookupMapping }
        );
        if (
            tx.student_id !== r.studentId ||
            tx.item_name !== r.itemName ||
            (tx.mapping || null) !== r.mapping ||
            (tx.second_mapping || null) !== r.secondMapping ||
            tx.id_status !== r.idStatus
        ) {
            changed.push({
                ...tx,
                student_id: r.studentId,
                item_name: r.itemName,
                mapping: r.mapping,
                second_mapping: r.secondMapping,
                id_status: r.idStatus
            });
        }
    }
    return changed;
}

/**
 * Upserts full transaction rows in chunks and throws on the first error.
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
