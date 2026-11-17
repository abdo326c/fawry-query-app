// @vitest-environment jsdom
// Regression tests for the critical / high fixes from the 2026-11 code review.
import { expect, test, vi, beforeEach } from 'vitest';

// Programmable supabase mock: a keyset-capable table of N rows with an optional one-off failure.
const sb = vi.hoisted(() => ({ rows: [], failGteOnce: null }));
vi.mock('../supabase.js', () => {
    class Q {
        constructor() { this.f = []; this.lo = 0; this.hi = 0; this._gte = null; }
        select() { return this; }
        order() { return this; }
        in() { return this; }
        gt(c, v) { this.f.push(r => r.id > v); return this; }
        gte(c, v) { this.f.push(r => r.id >= v); this._gte = v; return this; }
        lte(c, v) { this.f.push(r => r.id <= v); return this; }
        range(a, b) { this.lo = a; this.hi = b; return this; }
        then(res, rej) {
            if (sb.failGteOnce !== null && this._gte === sb.failGteOnce) {
                sb.failGteOnce = null;
                return Promise.resolve({ data: null, error: { message: 'network fail' } }).then(res, rej);
            }
            const d = sb.rows.filter(r => this.f.every(fn => fn(r))).slice(this.lo, this.hi + 1);
            return Promise.resolve({ data: d, error: null }).then(res, rej);
        }
    }
    return {
        supabase: {
            from: () => new Q(),
            rpc: (name, { p_chunk_size, p_after }) => {
                const out = [];
                const rest = sb.rows.filter(r => r.id > Number(p_after));
                for (let i = 0; i < rest.length; i += p_chunk_size) {
                    const s = rest.slice(i, i + p_chunk_size);
                    out.push({ min_val: String(s[0].id), max_val: String(s[s.length - 1].id) });
                }
                return Promise.resolve({ data: out, error: null });
            }
        }
    };
});

import { fetchAll } from '../rules.js';
import { parseStatementDate, matchForeignDepositsToStudents } from '../foreign-transactions.js';
import { fetchUsdToEgpRateForDate, syncMissingFxRates, createEmptyFxStore } from '../fx-rates.js';
import '../settlement.js';
const SettlementProcessor = window.SettlementProcessor;

beforeEach(() => {
    sb.rows = [];
    sb.failGteOnce = null;
});

// ---- rules.js fetchAll -------------------------------------------------------
test('fetchAll never returns duplicate rows when a parallel bucket fails', async () => {
    sb.rows = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 }));
    sb.failGteOnce = 2801; // a bucket in the second parallel slice fails once
    const res = await fetchAll('transactions', 'id', null, 'id', { pageSize: 200 });
    const ids = res.map(r => r.id);
    expect(ids.length).toBe(5000);
    expect(new Set(ids).size).toBe(5000);
});

test('fetchAll parallel path still returns every row exactly once', async () => {
    sb.rows = Array.from({ length: 3333 }, (_, i) => ({ id: i + 1 }));
    const res = await fetchAll('transactions', 'id', null, 'id', { pageSize: 200 });
    expect(res.length).toBe(3333);
    expect(new Set(res.map(r => r.id)).size).toBe(3333);
});

// ---- settlement.js -----------------------------------------------------------
test('settlement dates: DD/MM, MM/DD fallback, and impossible dates rejected', () => {
    expect(SettlementProcessor.toDateOnly('25/01/2026')).toBe('2026-01-25');
    expect(SettlementProcessor.toDateOnly('05/01/2026')).toBe('2026-01-05'); // ambiguous -> Fawry DD/MM
    expect(SettlementProcessor.toDateOnly('1/25/2026 10:15:00 AM')).toBe('2026-01-25');
    expect(SettlementProcessor.toDateOnly('30/02/2026')).toBeNull();
    expect(SettlementProcessor.toDateOnly('2026-13-01')).toBeNull();
    expect(SettlementProcessor.toDateOnly('2026-02-28 13:00')).toBe('2026-02-28');
});

test('saved settlement runs map DB column names back to the fields the UI reads', () => {
    const run = SettlementProcessor.normalizeSavedRun({
        id: 7, batch_label: 'Settlement #1', user_email: 'acc@nu.edu.eg',
        total_stl_amount: 100, total_sys_amount: 90, missing_sys_count: 2, missing_stl_count: 3,
        summary_data: { total_references: 42, settlement_date_from: '2026-01-01', settlement_date_to: '2026-01-05', settlement_numbers: ['1'], discrepancies: [{ reference: 'R' }] }
    });
    expect(run.created_by).toBe('acc@nu.edu.eg');
    expect(run.total_settlement_amount).toBe(100);
    expect(run.total_system_amount).toBe(90);
    expect(run.missing_in_system_count).toBe(2);
    expect(run.missing_in_settlement_count).toBe(3);
    expect(run.total_references).toBe(42);
    expect(run.settlement_date_from).toBe('2026-01-01');
    expect(run.discrepancies.length).toBe(1);
});

// ---- foreign-transactions.js -------------------------------------------------
test('statement dates: Excel serial numbers and impossible dates', () => {
    expect(parseStatementDate(45672.5)).toEqual({ dateOnly: '2025-01-15', dateTime: '2025-01-15 12:00:00' }); // 45658 = 2025-01-01
    expect(parseStatementDate(45672)).toEqual({ dateOnly: '2025-01-15', dateTime: '2025-01-15' });
    expect(parseStatementDate('31-02-2026 10:00:00').dateOnly).toBeNull();
    expect(parseStatementDate('2026-01-15 09:30:00').dateOnly).toBe('2026-01-15');
});

test('identical student names never auto-match a deposit', () => {
    const students = [
        { student_id: '231000111', arabic_name: 'محمد احمد محمود' },
        { student_id: '241000222', arabic_name: 'محمد احمد محمود' }
    ];
    const [res] = matchForeignDepositsToStudents(
        [{ reference_number: 'D1', extracted_name: 'محمد أحمد محمود', student_id: '' }], students);
    expect(res.student_id).toBe('');
    expect(res.match_source).not.toBe('name_match');
});

test('a unique exact name still matches', () => {
    const students = [
        { student_id: '231000111', arabic_name: 'محمد احمد محمود' },
        { student_id: '241000222', arabic_name: 'سارة علي حسن' }
    ];
    const [res] = matchForeignDepositsToStudents(
        [{ reference_number: 'D1', extracted_name: 'محمد أحمد محمود', student_id: '' }], students);
    expect(res.student_id).toBe('231000111');
    expect(res.match_source).toBe('name_match');
    expect(res.match_confidence).toBeLessThanOrEqual(100);
});

// ---- fx-rates.js -------------------------------------------------------------
const latestOnlyFetch = async (url) => {
    // Historical snapshots are unavailable; only the "latest" feeds answer.
    if (url.includes('@latest') || url.includes('open.er-api.com') || url.startsWith('https://latest.')) {
        return { ok: true, json: async () => ({ date: '2026-11-17', usd: { egp: 47.9 } }) };
    }
    return { ok: false, json: async () => ({}) };
};

test('a past date that cannot be fetched is NOT stored with today\'s rate', async () => {
    const res = await fetchUsdToEgpRateForDate('2023-06-15', latestOnlyFetch, '2026-11-17');
    expect(res).toBeNull();

    const store = createEmptyFxStore();
    store.latest = { date: '2026-11-17', rate: 47.9, source: 'manual' };
    await syncMissingFxRates(['2023-06-15'], store, { fetchImpl: latestOnlyFetch, todayStr: '2026-11-17' });
    expect(store.ratesByDate['2023-06-15']).toBeUndefined();
});

test('future value dates are not fetched or stored', async () => {
    const store = createEmptyFxStore();
    store.latest = { date: '2026-11-17', rate: 47.9, source: 'manual' };
    await syncMissingFxRates(['2026-11-20'], store, { fetchImpl: latestOnlyFetch, todayStr: '2026-11-17' });
    expect(store.ratesByDate['2026-11-20']).toBeUndefined();
});
