// @vitest-environment jsdom
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../supabase.js', () => ({
  supabase: {}
}));

import { buildImportIssuesCsv } from '../rules.js';
import {
  loadSavedFilterPresets,
  saveFilterPresetList,
  upsertFilterPreset,
  deleteFilterPreset
} from '../app-utils.js';

describe('Saved Filter Presets & Import Issue CSV Helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('loadSavedFilterPresets / saveFilterPresetList / upsertFilterPreset / deleteFilterPreset manage presets cleanly', () => {
    const key = 'test-presets-v1';
    expect(loadSavedFilterPresets(key)).toEqual([]);

    localStorage.setItem(key, 'not-json');
    expect(loadSavedFilterPresets(key)).toEqual([]);

    let presets = [];
    presets = upsertFilterPreset(presets, { name: 'Unsettled 7d', state: { quickFilter: 'unsettled', dateFrom: '2026-11-01' } });
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('Unsettled 7d');

    // Case-insensitive update preserves ID and updates state + moves to front
    const origId = presets[0].id;
    presets = upsertFilterPreset(presets, { name: 'Missing IDs', state: { quickFilter: 'missing_id' } });
    presets = upsertFilterPreset(presets, { name: 'unsettled 7d', state: { quickFilter: 'unsettled', dateFrom: '2026-11-10' } });
    expect(presets).toHaveLength(2);
    expect(presets[0].id).toBe(origId);
    expect(presets[0].state.dateFrom).toBe('2026-11-10');

    // Caps at 20 presets
    for (let i = 0; i < 25; i++) {
      presets = upsertFilterPreset(presets, { name: `Preset ${i}`, state: { idx: i } });
    }
    expect(presets).toHaveLength(20);

    expect(saveFilterPresetList(key, presets)).toBe(true);
    const loaded = loadSavedFilterPresets(key);
    expect(loaded).toHaveLength(20);

    const removedId = loaded[0].id;
    const afterDelete = deleteFilterPreset(loaded, removedId);
    expect(afterDelete).toHaveLength(19);
    expect(afterDelete.some(p => p.id === removedId)).toBe(false);
  });

  test('buildImportIssuesCsv escapes quotes/commas and neutralizes Excel formula injection', () => {
    expect(buildImportIssuesCsv([])).toBe('');
    expect(buildImportIssuesCsv(null)).toBe('');

    const csv = buildImportIssuesCsv([
      {
        category: 'Blocked (Closed Period)',
        file_name: 'fawry_sept.csv',
        reference_number: '9706847770',
        payment_date: '2026-09-15',
        student_id: '=cmd|calc',
        item_name: 'Tuition, Fall "2026"',
        item_price: 15000,
        bank: 'NUADIB64',
        status: 'Closed 2026-09',
        reason: 'Accounting period 2026-09 is closed'
      }
    ]);

    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Category,File Name,Reference Number,Payment Date,Student ID,Item Name,Item Price,Bank,Status,Reason');
    expect(lines[1]).toContain("'=cmd|calc");
    expect(lines[1]).toContain('"Tuition, Fall ""2026"""');
    expect(lines[1]).toContain('Blocked (Closed Period)');
  });
});
