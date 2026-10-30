import { expect, test, vi } from 'vitest';
import { validateID, originalItemName, applyBusinessRules, toDateOnly, dateToExcelSerial, normalizeItemName, buildMappingLookup } from '../rules.js';

vi.mock('../supabase.js', () => ({
    supabase: {}
}));

test('validateID tests', () => {
    expect(validateID(null)).toBe('Missing ID');
    expect(validateID('')).toBe('Missing ID');
    expect(validateID('DIP12345678901234')).toBe('Valid');
    expect(validateID('123abc456')).toBe('Error: Text/Name detected');
    expect(validateID('123')).toBe('Error: ID Too Short (3 digits)');
    expect(validateID('1234567890')).toBe('Error: ID Too Long (10 digits)');
    expect(validateID('2023123')).toBe('Error: Invalid 2-Series Length (7 digits)');
    expect(validateID('202312345')).toBe('Valid');
});

test('originalItemName tests', () => {
    expect(originalItemName({ reference_number: 'REF1', check_column: 'REF1-OrigItem' })).toBe('OrigItem');
    expect(originalItemName({ reference_number: 'REF2', check_column: null, item_name: 'Fallback' })).toBe('Fallback');
});

test('applyBusinessRules precedence logic', () => {
    const base = { studentId: '12345', itemName: 'Tuition' };
    
    // No links, no fixes, no mappings
    const res1 = applyBusinessRules(base, { lookupMapping: () => undefined });
    expect(res1.studentId).toBe('12345');
    expect(res1.itemName).toBe('Tuition');
    
    // With link override
    const link = { custom_input_value: '54321' };
    const res2 = applyBusinessRules(base, { link, lookupMapping: () => undefined });
    expect(res2.studentId).toBe('54321');
    
    // With fix override
    const fix = { correct_id: '99999', item_name: 'FixedTuition', mapping: 'Finance', second_mapping: 'DeptA' };
    const res3 = applyBusinessRules(base, { fix, lookupMapping: () => undefined });
    expect(res3.studentId).toBe('99999');
    expect(res3.itemName).toBe('FixedTuition');
    expect(res3.mapping).toBe('Finance');
    expect(res3.secondMapping).toBe('DeptA');
    
    // With mapping rule lookup
    const lookupMapping = (name) => {
        if (name === 'Tuition') return { adjusted_item_name: 'AdjTuition', mapping: 'Fin', second_mapping: 'Sec' };
        return undefined;
    };
    const res4 = applyBusinessRules(base, { lookupMapping });
    expect(res4.itemName).toBe('AdjTuition');
    expect(res4.mapping).toBe('Fin');
    expect(res4.secondMapping).toBe('Sec');

    // Invalid link.custom_input_value (e.g. 14-digit National ID or text note) must NOT overwrite an already-Valid base studentId
    const res5 = applyBusinessRules(
        { studentId: '202312345', itemName: 'Tuition' },
        { link: { custom_input_value: '29901011234567' }, lookupMapping: () => undefined }
    );
    expect(res5.studentId).toBe('202312345');
    expect(res5.idStatus).toBe('Valid');

    // Invalid link.custom_input_value is still used when base studentId is missing or invalid
    const res6 = applyBusinessRules(
        { studentId: null, itemName: 'Tuition' },
        { link: { custom_input_value: '29901011234567' }, lookupMapping: () => undefined }
    );
    expect(res6.studentId).toBe('29901011234567');
    expect(res6.idStatus).toBe('Error: ID Too Long (14 digits)');
});

test('toDateOnly strips time without shifting calendar date', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly('2025-08-01')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01T00:00:00.000Z')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01T03:00:00+03:00')).toBe('2025-08-01');
    expect(toDateOnly('2025-08-01 23:59:59')).toBe('2025-08-01');
    expect(toDateOnly('01/08/2025 3:00:00 AM')).toBe('2025-08-01');
    expect(toDateOnly('8/15/2025 3:00:00 AM')).toBe('2025-08-15');
    // Excel serial 45870 = 2025-08-01, 45870.125 = 2025-08-01 3:00:00 AM, 45870.99 = 2025-08-01 late night
    expect(toDateOnly(45870)).toBe('2025-08-01');
    expect(toDateOnly(45870.125)).toBe('2025-08-01');
    expect(toDateOnly(45870.99)).toBe('2025-08-01');
});

test('dateToExcelSerial returns exact integer serial with zero fractional time', () => {
    expect(dateToExcelSerial('2025-08-01')).toBe(45870);
    expect(dateToExcelSerial('2025-08-01T03:00:00.000Z')).toBe(45870);
    expect(dateToExcelSerial('01/08/2025 3:00:00 AM')).toBe(45870);
    expect(Number.isInteger(dateToExcelSerial('2025-08-01'))).toBe(true);
    expect(dateToExcelSerial('')).toBeNull();
});

test('normalizeItemName and buildMappingLookup handle whitespace, casing, and adjusted item names', () => {
    expect(normalizeItemName('  Tuition\u00A0  Fees - Fall  ')).toBe('Tuition Fees - Fall');
    const lookup = buildMappingLookup([
        { item_name: 'Tuition Fees - Fall', adjusted_item_name: 'Fall Tuition 2025', mapping: 'Tuition', second_mapping: 'Undergrad' }
    ]);
    // Exact match
    expect(lookup('Tuition Fees - Fall')?.mapping).toBe('Tuition');
    // Case + extra space match
    expect(lookup('  tuition   fees - fall ')?.mapping).toBe('Tuition');
    // Reverse lookup via adjusted_item_name
    expect(lookup('Fall Tuition 2025')?.item_name).toBe('Tuition Fees - Fall');
    expect(lookup('  fall  tuition 2025 ')?.mapping).toBe('Tuition');
    expect(lookup('Nonexistent')).toBeUndefined();
});



