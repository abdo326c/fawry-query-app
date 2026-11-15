import { expect, test, vi, beforeEach } from 'vitest';

// Records every update() call so updateRuleFields can be checked
const updateCalls = [];
vi.mock('../supabase.js', () => ({
    supabase: {
        from: vi.fn(() => ({
            update: vi.fn((values) => ({
                in: vi.fn(async (col, ids) => {
                    updateCalls.push({ values, col, ids });
                    return { error: null };
                })
            }))
        }))
    }
}));

const { supabase } = await import('../supabase.js');

const {
    originalStudentId,
    baseFromTransaction,
    applyBusinessRules,
    diffTransaction,
    updateRuleFields,
    fetchAll,
    buildMappingLookup,
    pruneEmptyWorksheetCells,
    buildNativeZip,
    RULE_FIELDS
} = await import('../rules.js');

beforeEach(() => { updateCalls.length = 0; });

const noRules = { lookupMapping: () => undefined };

// A transaction as stored after import + rules
const stored = (over = {}) => ({
    id: 1,
    reference_number: 'R1',
    original_student_id: '231000123',
    student_id: '231000123',
    item_name: 'Fees',
    check_column: 'R1-Fees',
    mapping: null,
    second_mapping: null,
    id_status: 'Valid',
    is_settled: false,
    erp_batch_number: null,
    ...over
});

test('originalStudentId prefers original_student_id and falls back for old rows', () => {
    expect(originalStudentId({ original_student_id: 'A1', student_id: 'B2' })).toBe('A1');
    expect(originalStudentId({ original_student_id: null, student_id: 'B2' })).toBe('B2');
    expect(originalStudentId({ student_id: 'B2' })).toBe('B2');
    expect(baseFromTransaction(stored({ item_name: 'Renamed' }))).toEqual({ studentId: '231000123', itemName: 'Fees' });
});

test('deleting a manual fix restores the original student ID', () => {
    // A fix had changed the ID; the fix is now gone
    const tx = stored({ student_id: '231000999', id_status: 'Valid' });
    const d = diffTransaction(tx, noRules);
    expect(d.changed).toBe(true);
    expect(d.fields.student_id).toBe('231000123');
    expect(d.changes.map(c => c.field)).toEqual(['student_id']);
    expect(d.reasons).toEqual(['Original restored']);
});

test('removing a link restores the original student ID', () => {
    const tx = stored({ original_student_id: 'Ahmed', student_id: '231000555', id_status: 'Valid' });
    const d = diffTransaction(tx, noRules);
    expect(d.fields.student_id).toBe('Ahmed');
    expect(d.fields.id_status).toBe('Error: Text/Name detected');
    expect(d.changes.map(c => c.label)).toEqual(['ID', 'Status']);
});

test('clearing a fix Correct ID falls back to the link value, not the stale ID', () => {
    const tx = stored({ student_id: '231000999' });
    const d = diffTransaction(tx, { link: { custom_input_value: '231000777' }, fix: { correct_id: null }, lookupMapping: () => undefined });
    expect(d.fields.student_id).toBe('231000777');
    expect(d.reasons).toEqual(['Student Link']);
});

test('re-apply is idempotent: an up-to-date row is unchanged', () => {
    const tx = stored({ student_id: '231000999' });
    expect(diffTransaction(tx, { fix: { correct_id: '231000999' }, lookupMapping: () => undefined }).changed).toBe(false);
});

test('deleting a mapping rule restores item name and clears mappings', () => {
    const tx = stored({ item_name: 'Tuition Fees', mapping: 'Tuition', second_mapping: 'UG' });
    const d = diffTransaction(tx, noRules);
    expect(d.fields).toMatchObject({ item_name: 'Fees', mapping: null, second_mapping: null });
    expect(d.reasons).toEqual(['Original restored']);
});

test('reasons describe the actual change, not just what exists', () => {
    // Link exists but the only change comes from the mapping rule
    const lookupMapping = buildMappingLookup([{ item_name: 'Fees', mapping: 'Tuition' }]);
    const d = diffTransaction(stored(), { link: { custom_input_value: '231000123' }, lookupMapping });
    expect(d.reasons).toEqual(['Mapping Rule']);
});

test('reason covers the fallback to the original item rule when a fix renames the item', () => {
    const lookupMapping = buildMappingLookup([{ item_name: 'Fees', mapping: 'Tuition' }]);
    const d = diffTransaction(stored(), { fix: { item_name: 'Other' }, lookupMapping });
    expect(d.fields).toMatchObject({ item_name: 'Other', mapping: 'Tuition' });
    expect(d.reasons.sort()).toEqual(['Manual Fix', 'Mapping Rule']);
});

test('status-only change is labelled Status Re-validation', () => {
    const d = diffTransaction(stored({ id_status: 'Old status' }), noRules);
    expect(d.changes.map(c => c.field)).toEqual(['id_status']);
    expect(d.reasons).toEqual(['Status Re-validation']);
});

test('numeric student_id column does not look like a change', () => {
    const tx = stored({ original_student_id: 231000123, student_id: 231000123 });
    expect(diffTransaction(tx, noRules).changed).toBe(false);
});

test('settled and ERP-recorded rows are flagged as locked', () => {
    expect(diffTransaction(stored({ student_id: 'X', is_settled: true }), noRules).locked).toBe(true);
    expect(diffTransaction(stored({ student_id: 'X', erp_batch_number: 'B1' }), noRules).locked).toBe(true);
    expect(diffTransaction(stored({ student_id: 'X' }), noRules).locked).toBe(false);
});

test('import and re-apply give the same result', () => {
    const lookupMapping = buildMappingLookup([{ item_name: 'Fees', adjusted_item_name: 'Tuition Fees', mapping: 'Tuition' }]);
    const ctx = { link: { custom_input_value: '2310 00456' }, fix: { mapping: 'Override' }, lookupMapping };
    const atImport = applyBusinessRules({ studentId: 'Ahmed', itemName: 'Fees' }, ctx);
    const tx = stored({
        original_student_id: 'Ahmed',
        student_id: atImport.studentId,
        item_name: atImport.itemName,
        mapping: atImport.mapping,
        second_mapping: atImport.secondMapping,
        id_status: atImport.idStatus
    });
    expect(diffTransaction(tx, ctx).changed).toBe(false);
});

test('updateRuleFields sends only rule columns, grouped by identical values', async () => {
    const saved = await updateRuleFields([
        { id: 1, fields: { student_id: 'A', item_name: 'X', mapping: 'M', second_mapping: null, id_status: 'Valid', is_settled: true } },
        { id: 2, fields: { student_id: 'A', item_name: 'X', mapping: 'M', second_mapping: null, id_status: 'Valid' } },
        { id: 3, fields: { student_id: 'B', item_name: 'X', mapping: 'M', second_mapping: null, id_status: 'Valid' } }
    ]);
    expect(saved).toBe(3);
    expect(updateCalls).toHaveLength(2);
    for (const call of updateCalls) {
        expect(Object.keys(call.values).sort()).toEqual([...RULE_FIELDS].sort());
        expect(call.col).toBe('id');
    }
    expect(updateCalls.find(c => c.values.student_id === 'A').ids).toEqual([1, 2]);
});

test('updateRuleFields groups mapping-only changes across distinct student_ids into a single batch update', async () => {
    const lookupMapping = buildMappingLookup([{ item_name: 'Fees', adjusted_item_name: 'Tuition Fees', mapping: 'Tuition', second_mapping: 'UG' }]);
    const rows = [
        stored({ id: 10, student_id: '231000001', original_student_id: '231000001' }),
        stored({ id: 11, student_id: '231000002', original_student_id: '231000002' }),
        stored({ id: 12, student_id: '231000003', original_student_id: '231000003' })
    ];
    const updates = rows.map(tx => {
        const diff = diffTransaction(tx, { lookupMapping });
        return { id: tx.id, fields: diff.fields, diff };
    });

    const saved = await updateRuleFields(updates);
    expect(saved).toBe(3);
    // Despite 3 distinct student_ids, only item_name, mapping, and second_mapping changed, so all 3 rows collapse into 1 update call!
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].ids).toEqual([10, 11, 12]);
    expect(updateCalls[0].values).toEqual({
        item_name: 'Tuition Fees',
        mapping: 'Tuition',
        second_mapping: 'UG'
    });
});

test('updateRuleFields refuses rows without an id', async () => {
    await expect(updateRuleFields([{ fields: { student_id: 'A' } }])).rejects.toThrow('without an id');
});

test('fetchAll uses O(N) keyset pagination and shrinks pageSize on Postgres statement timeout', async () => {
    const origFrom = supabase.from;
    const totalRows = Array.from({ length: 1250 }, (_, idx) => ({ id: (idx + 1) * 3 }));
    const queryLog = [];
    let simulateTimeout = true;

    try {
        supabase.from = vi.fn(() => {
            let gtVal = null;
            const chain = {
                select: vi.fn(() => chain),
                gt: vi.fn((col, val) => {
                    if (col === 'id') gtVal = val;
                    return chain;
                }),
                order: vi.fn(() => chain),
                range: vi.fn(async (from, to) => {
                    const limit = to - from + 1;
                    queryLog.push({ gtVal, from, to, limit });
                    if (simulateTimeout && gtVal !== null && limit >= 1000) {
                        simulateTimeout = false;
                        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
                    }
                    const filtered = gtVal === null ? totalRows : totalRows.filter(r => r.id > gtVal);
                    return { data: filtered.slice(from, to + 1), error: null };
                })
            };
            return chain;
        });

        const progressUpdates = [];
        const rows = await fetchAll('transactions', 'id', null, 'id', {
            pageSize: 1000,
            onProgress: (n) => progressUpdates.push(n)
        });

        expect(rows.map(r => r.id)).toEqual(totalRows.map(r => r.id));
        expect(queryLog.every(q => q.from === 0)).toBe(true); // Never used non-zero OFFSET
        expect(queryLog.some(q => q.gtVal === 3000 && q.limit === 1000)).toBe(true); // First keyset attempt at 1000
        expect(queryLog.some(q => q.gtVal === 3000 && q.limit === 500)).toBe(true);  // Halved to 500 after timeout
        expect(progressUpdates[progressUpdates.length - 1]).toBe(1250);
    } finally {
        supabase.from = origFrom;
    }
});

test('fetchAll uses get_keyset_bounds RPC for parallel O(N) chunked fetches when available', async () => {
    const origFrom = supabase.from;
    const origRpc = supabase.rpc;
    const totalRows = Array.from({ length: 3200 }, (_, idx) => ({ id: idx + 1 }));
    const rangeCalls = [];

    try {
        supabase.rpc = vi.fn(async (fn, args) => {
            if (fn === 'get_keyset_bounds') {
                expect(args).toMatchObject({ p_table: 'transactions', p_col: 'id', p_chunk_size: 1000, p_after: '1000' });
                return {
                    data: [
                        { chunk_idx: 0, min_val: '1001', max_val: '2000' },
                        { chunk_idx: 1, min_val: '2001', max_val: '3000' },
                        { chunk_idx: 2, min_val: '3001', max_val: '3200' }
                    ],
                    error: null
                };
            }
            return { data: null, error: { message: 'unexpected rpc' } };
        });

        supabase.from = vi.fn(() => {
            let gteVal = null;
            let lteVal = null;
            let gtVal = null;
            const chain = {
                select: vi.fn(() => chain),
                gte: vi.fn((_c, v) => { gteVal = v; return chain; }),
                lte: vi.fn((_c, v) => { lteVal = v; return chain; }),
                gt: vi.fn((_c, v) => { gtVal = v; return chain; }),
                order: vi.fn(() => chain),
                range: vi.fn(async (from, to) => {
                    rangeCalls.push({ gteVal, lteVal, gtVal, from, to });
                    const filtered = totalRows.filter(r =>
                        (gteVal == null || r.id >= gteVal) &&
                        (lteVal == null || r.id <= lteVal) &&
                        (gtVal == null || r.id > gtVal)
                    );
                    return { data: filtered.slice(from, to + 1), error: null };
                })
            };
            return chain;
        });

        const rows = await fetchAll('transactions', 'id', null, 'id', { pageSize: 1000 });
        expect(rows.length).toBe(3200);
        expect(rows.map(r => r.id)).toEqual(totalRows.map(r => r.id));
        expect(rangeCalls.every(c => c.from === 0)).toBe(true); // Zero OFFSET scans
        expect(rangeCalls.some(c => c.gteVal === 1001 && c.lteVal === 2000)).toBe(true);
        expect(rangeCalls.some(c => c.gteVal === 2001 && c.lteVal === 3000)).toBe(true);
        expect(rangeCalls.some(c => c.gteVal === 3001 && c.lteVal === 3200)).toBe(true);
        expect(rangeCalls.filter(c => c.gtVal !== null)).toHaveLength(0); // No redundant 2nd query when bucket ends at max_val
        expect(rangeCalls).toHaveLength(4); // 1 firstPage + 3 single-shot buckets
    } finally {
        supabase.from = origFrom;
        supabase.rpc = origRpc;
    }
});

test('pruneEmptyWorksheetCells deletes empty unstyled data cells while preserving headers, values, and styles', () => {
    const wb = {
        SheetNames: ['Fawry Query'],
        Sheets: {
            'Fawry Query': {
                '!ref': 'A1:C3',
                A1: { t: 's', v: 'Ref' },
                B1: { t: 's', v: '' }, // Row 1 header slot preserved
                A2: { t: 's', v: '1001' },
                B2: { t: 's', v: '' }, // Empty data cell pruned
                C2: { t: 's', v: '', s: { font: { bold: true } } }, // Styled empty cell preserved
                A3: { t: 'n', v: 0 }, // Numeric 0 preserved
                B3: { t: 's', v: '', f: 'A2' } // Formula cell preserved
            }
        }
    };
    pruneEmptyWorksheetCells(wb);
    const ws = wb.Sheets['Fawry Query'];
    expect(ws.A1).toBeDefined();
    expect(ws.B1).toBeDefined();
    expect(ws.A2).toBeDefined();
    expect(ws.B2).toBeUndefined();
    expect(ws.C2).toBeDefined();
    expect(ws.A3).toEqual({ t: 'n', v: 0 });
    expect(ws.B3).toBeDefined();
});

test('buildNativeZip produces a valid DEFLATE PKZIP archive that shrinks repetitive XML data', async () => {
    const sampleXml = '<sheetData>' + '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>2</v></c></row>'.repeat(200) + '</sheetData>';
    const rawBytes = new TextEncoder().encode(sampleXml);
    const zip = await buildNativeZip([{ name: 'xl/worksheets/sheet1.xml', data: rawBytes }]);

    // Valid PKZIP Local File Header & End of Central Directory signatures
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
    expect(zip.length).toBeLessThan(rawBytes.length / 5);

    // Inflate first entry payload directly to verify lossless roundtrip
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const method = dv.getUint16(8, true);
    const compSize = dv.getUint32(18, true);
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    expect(method).toBe(8);
    const compressedSlice = zip.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + compSize);
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    w.write(compressedSlice);
    w.close();
    const restored = new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
    expect(restored).toBe(sampleXml);
});
