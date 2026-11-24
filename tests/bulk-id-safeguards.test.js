// @vitest-environment jsdom
import { describe, expect, test, vi, afterEach } from 'vitest';

vi.mock('../supabase.js', () => ({ supabase: {} }));

import { analyzeBulkIdAssignment } from '../rules.js';
import { App } from '../app.js';

// rows like the screenshot that prompted this: different students, different mobiles
const tx = (ref, student_id, customer_mobile, extra = {}) => ({
    id: ref, reference_number: ref, student_id, customer_mobile, payment_date: '2026-11-23',
    item_name: 'Tuition', item_price: 1000, ...extra
});
const mixedSelection = [
    tx('9706879662', '231000477', '01011111111'),
    tx('9708573215', '241001031', '01022222222'),
    tx('9708622191', '241002483', '01033333333')
];

describe('analyzeBulkIdAssignment', () => {
    test('blocks overwriting several valid students paid from different mobiles', () => {
        const r = analyzeBulkIdAssignment(mixedSelection, '018270041');
        expect(r.blocked).toBe(true);
        expect(r.requiresTypedConfirm).toBe(false);
        expect(r.overwrittenValidIds).toHaveLength(3);
        expect(r.reasons[0]).toMatch(/3 different students/);
    });

    test('same payer (one mobile) fixing wrong IDs is allowed but needs typed confirmation', () => {
        const rows = [tx('1', '231000477', '01011111111'), tx('2', '241001031', '+201011111111')];
        const r = analyzeBulkIdAssignment(rows, '018270041');
        expect(r.blocked).toBe(false);
        expect(r.mobiles).toHaveLength(1);
        expect(r.requiresTypedConfirm).toBe(true);
    });

    test('rows with missing/invalid IDs from one mobile need only the review', () => {
        const rows = [tx('1', '', '01011111111'), tx('2', 'abc', '01011111111')];
        const r = analyzeBulkIdAssignment(rows, '018270041');
        expect(r.blocked).toBe(false);
        expect(r.requiresTypedConfirm).toBe(false);
        expect(r.changing).toHaveLength(2);
    });

    test('rows that already have the target ID are not counted as changes', () => {
        const rows = [tx('1', '018270041', '01011111111'), tx('2', '', '01011111111')];
        const r = analyzeBulkIdAssignment(rows, '018270041');
        expect(r.changing.map(t => t.reference_number)).toEqual(['2']);
        expect(r.unchanged).toBe(1);
    });

    test('more than 10 changing rows needs typed confirmation even from one mobile', () => {
        const rows = Array.from({ length: 11 }, (_, i) => tx(String(i), '', '01011111111'));
        expect(analyzeBulkIdAssignment(rows, '018270041').requiresTypedConfirm).toBe(true);
    });
});

describe('reviewBulkIdAssignment dialog', () => {
    const ctx = { studentMasterByIdMap: new Map() };
    const open = (rows, newId) => App.prototype.reviewBulkIdAssignment.call(ctx, analyzeBulkIdAssignment(rows, newId), { newId, idStatus: 'Valid' });
    afterEach(() => document.getElementById('modal-bulk-id-review')?.remove());

    test('blocked selection lists every row and has no Apply button', async () => {
        const p = open(mixedSelection, '018270041');
        const modal = document.getElementById('modal-bulk-id-review');
        expect(modal.querySelectorAll('tbody tr')).toHaveLength(3);
        expect(modal.textContent).toContain('231000477');
        expect(modal.querySelector('[data-bulk-review-ok]')).toBeNull();
        modal.querySelector('[data-bulk-review-cancel]').click();
        await expect(p).resolves.toBe(false);
        expect(document.getElementById('modal-bulk-id-review')).toBeNull();
    });

    test('risky selection enables Apply only after the new ID is typed', async () => {
        const rows = [tx('1', '231000477', '01011111111'), tx('2', '241001031', '01011111111')];
        const p = open(rows, '018270041');
        const modal = document.getElementById('modal-bulk-id-review');
        const ok = modal.querySelector('[data-bulk-review-ok]');
        const input = modal.querySelector('[data-bulk-review-confirm]');
        expect(ok.disabled).toBe(true);
        input.value = '018270040';
        input.dispatchEvent(new Event('input'));
        expect(ok.disabled).toBe(true);
        input.value = '018270041';
        input.dispatchEvent(new Event('input'));
        expect(ok.disabled).toBe(false);
        ok.click();
        await expect(p).resolves.toBe(true);
    });

    test('Escape cancels', async () => {
        const p = open([tx('1', '', '01011111111')], '018270041');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await expect(p).resolves.toBe(false);
    });
});
