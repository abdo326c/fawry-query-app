import { describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../supabase.js', () => ({
  supabase: {}
}));

import {
  toPeriodMonth,
  isDateInClosedPeriods,
  findClosedPeriodsInRows,
  formatPeriodMonthLabel
} from '../rules.js';

const rootDir = path.resolve(__dirname, '..');

describe('Accounting Period Lock (Month-End Close) Rules & Schema', () => {
  test('toPeriodMonth normalizes Date objects, ISO strings, Excel serials, and YYYY-MM inputs', () => {
    expect(toPeriodMonth('2026-09-18')).toBe('2026-09');
    expect(toPeriodMonth('2026-09-18T23:59:59Z')).toBe('2026-09');
    expect(toPeriodMonth('2026-09')).toBe('2026-09');
    expect(toPeriodMonth(new Date(2026, 8, 5))).toBe('2026-09');
    expect(toPeriodMonth(45672)).toBe('2025-01');
    expect(toPeriodMonth('')).toBe('');
    expect(toPeriodMonth(null)).toBe('');
    expect(toPeriodMonth(undefined)).toBe('');
    expect(toPeriodMonth('2026-13')).toBe('');
    expect(toPeriodMonth('not-a-date')).toBe('');
  });

  test('isDateInClosedPeriods checks both Sets and Arrays safely', () => {
    const closedSet = new Set(['2026-08', '2026-09']);
    expect(isDateInClosedPeriods('2026-09-15', closedSet)).toBe(true);
    expect(isDateInClosedPeriods('2026-10-01', closedSet)).toBe(false);
    expect(isDateInClosedPeriods('2026-08-31T10:00:00Z', ['2026-08'])).toBe(true);
    expect(isDateInClosedPeriods('2026-08-31', new Set())).toBe(false);
    expect(isDateInClosedPeriods('', closedSet)).toBe(false);
    expect(isDateInClosedPeriods('2026-08-01', null)).toBe(false);
  });

  test('findClosedPeriodsInRows filters blocked rows and returns sorted closed months', () => {
    const rows = [
      { id: 1, payment_date: '2026-10-03', reference_number: 'R1' },
      { id: 2, payment_date: '2026-09-29', reference_number: 'R2' },
      { id: 3, payment_date: '2026-08-12', reference_number: 'R3' },
      { id: 4, payment_date: '2026-09-01', reference_number: 'R4' },
      { id: 5, payment_date: null, reference_number: 'R5' }
    ];
    const closedSet = new Set(['2026-08', '2026-09']);
    const res = findClosedPeriodsInRows(rows, closedSet, 'payment_date');
    expect(res.blockedRows.map(r => r.id)).toEqual([2, 3, 4]);
    expect(res.closedMonths).toEqual(['2026-08', '2026-09']);

    const fxRows = [
      { reference_number: 'FX1', value_date: null, transaction_date: '2026-08-22' },
      { reference_number: 'FX2', value_date: '2026-10-02', transaction_date: '2026-10-01' }
    ];
    const fxRes = findClosedPeriodsInRows(fxRows, closedSet, r => r.value_date || r.transaction_date);
    expect(fxRes.blockedRows.map(r => r.reference_number)).toEqual(['FX1']);
    expect(fxRes.closedMonths).toEqual(['2026-08']);
  });

  test('formatPeriodMonthLabel formats YYYY-MM without timezone shift', () => {
    expect(formatPeriodMonthLabel('2026-01')).toBe('Jan 2026');
    expect(formatPeriodMonthLabel('2026-09')).toBe('Sep 2026');
    expect(formatPeriodMonthLabel('2026-12')).toBe('Dec 2026');
    expect(formatPeriodMonthLabel('bad-month')).toBe('bad-month');
  });

  test('migration 2.11.4 and schema.sql define closed_periods, RPCs, triggers, and compatibility guards', () => {
    const migSql = fs.readFileSync(path.join(rootDir, 'migrations/2.11.4_accounting_period_lock.sql'), 'utf8');
    const schemaSql = fs.readFileSync(path.join(rootDir, 'schema.sql'), 'utf8');

    const requiredTokens = [
      'CREATE TABLE IF NOT EXISTS public.closed_periods',
      'CREATE OR REPLACE FUNCTION public.is_period_closed(p_date DATE)',
      'CREATE OR REPLACE FUNCTION public.set_accounting_period_lock(',
      'CREATE OR REPLACE FUNCTION public.trg_enforce_transactions_period_lock()',
      'CREATE OR REPLACE FUNCTION public.trg_enforce_foreign_tx_period_lock()',
      'CREATE TRIGGER trg_transactions_period_lock',
      'EXECUTE FUNCTION public.trg_enforce_transactions_period_lock()',
      'CREATE TRIGGER trg_foreign_transactions_period_lock',
      'EXECUTE FUNCTION public.trg_enforce_foreign_tx_period_lock()',
      'DROP FUNCTION IF EXISTS public.trg_enforce_tx_period_lock();',
      'CREATE OR REPLACE FUNCTION public.trg_enforce_manual_fix_period_lock()',
      'CREATE TRIGGER trg_manual_fixes_period_lock',
      "PERFORM set_config('app.bypass_period_lock', 'on', true);",
      'AND NOT public.is_period_closed(t.payment_date)',
      "'Accounting Period Unlocked'"
    ];

    for (const sql of [migSql, schemaSql]) {
      for (const token of requiredTokens) {
        expect(sql, `Missing SQL token: ${token}`).toContain(token);
      }
      expect(sql).not.toContain('WHEN TG_TABLE_NAME');
    }
  });
});
