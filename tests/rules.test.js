import { expect, test, vi } from 'vitest';
import { validateID, originalItemName, applyBusinessRules } from '../rules.js';

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
});

