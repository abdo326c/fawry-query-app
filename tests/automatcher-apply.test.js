// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';

vi.mock('../supabase.js', () => ({ supabase: {} }));

import { planAutoMatchApply } from '../auto-matcher.js';

const prop = (tx_id, ref, sid, extra = {}) => ({
    tx_id, original_ref: ref, proposedStudent: sid ? { student_id: sid } : null, locked: false, ...extra
});

describe('planAutoMatchApply', () => {
    test('a selected line pulls in its unmatched sibling lines of the same reference', () => {
        const all = [prop(1, 'R1', '241000001'), prop(2, 'R1', null), prop(3, 'R2', '241000002')];
        const { sidByTxId, conflictingRefs } = planAutoMatchApply(all, [all[0]]);
        expect([...sidByTxId.entries()]).toEqual([['1', '241000001'], ['2', '241000001']]);
        expect(conflictingRefs).toEqual([]);
    });

    test('settled / ERP-posted rows that are selected are applied (adjustments are allowed)', () => {
        const all = [prop(1, 'R1', '241000001', { locked: true })];
        expect(planAutoMatchApply(all, all).sidByTxId.get('1')).toBe('241000001');
    });

    test('locked sibling lines are not pulled in unless selected themselves', () => {
        const all = [prop(1, 'R1', '241000001'), prop(2, 'R1', null, { locked: true })];
        expect([...planAutoMatchApply(all, [all[0]]).sidByTxId.keys()]).toEqual(['1']);
    });

    test('a reference matched to two different students is skipped, not written in random order', () => {
        const all = [prop(1, 'R1', '241000001'), prop(2, 'R1', '241000002'), prop(3, 'R2', '241000003')];
        const { sidByTxId, conflictingRefs } = planAutoMatchApply(all, all);
        expect(conflictingRefs).toEqual(['R1']);
        expect([...sidByTxId.keys()]).toEqual(['3']);
    });

    test('leading zeros are normalised in the written ID', () => {
        const all = [prop(1, 'R1', '0241000001')];
        expect(planAutoMatchApply(all, all).sidByTxId.get('1')).toBe('241000001');
    });
});
