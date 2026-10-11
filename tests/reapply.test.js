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

const {
    originalStudentId,
    baseFromTransaction,
    applyBusinessRules,
    diffTransaction,
    updateRuleFields,
    buildMappingLookup,
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

test('updateRuleFields refuses rows without an id', async () => {
    await expect(updateRuleFields([{ fields: { student_id: 'A' } }])).rejects.toThrow('without an id');
});
