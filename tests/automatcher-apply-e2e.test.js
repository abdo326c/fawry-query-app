// @vitest-environment jsdom
// Auto-Match "Apply" end to end: real supabase.js client -> API handlers -> in-memory SQLite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler from '../api/rpc.js';
import { supabase } from '../supabase.js';
import { recomputeTransactions } from '../rules.js';
import { App } from '../app.js';

async function callApi(handler, body, token) {
    let out = '';
    const res = { statusCode: 200, setHeader() {}, end(c) { out = c || ''; } };
    await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
    return { status: res.statusCode, body: JSON.parse(out || '{}') };
}

describe('Auto-Matcher apply', () => {
    let db;
    const origFetch = globalThis.fetch;

    beforeAll(async () => {
        db = createClient({ url: ':memory:' });
        setDbClient(db);
        await db.executeMultiple(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8'));
        await db.execute({ sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)', args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('Owner12345!')] });
        globalThis.fetch = async (url, init) => {
            const body = JSON.parse(init?.body || '{}');
            const auth = init?.headers?.Authorization || '';
            const handler = String(url).endsWith('/api/auth') ? authHandler : String(url).endsWith('/api/rpc') ? rpcHandler : queryHandler;
            const out = await callApi(handler, body, auth.replace(/^Bearer\s+/i, '') || null);
            return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
        };
        const signIn = await supabase.auth.signInWithPassword({ email: 'ammahmoud@nu.edu.eg', password: 'Owner12345!' });
        expect(signIn.error).toBeNull();
    });
    afterAll(async () => {
        await supabase.auth.signOut();
        globalThis.fetch = origFetch;
    });

    test('applies via the rules engine, skips closed-period and changed rows, keeps settled rows, and can be undone', async () => {
        const base = { item_name: 'Tuition', item_price: 1000, bank: 'NUADIB64', id_status: 'Error: Invalid' };
        const rows = [
            { ...base, reference_number: 'AM-1', payment_date: '2026-11-20', student_id: 'abc', original_student_id: 'abc', check_column: 'AM-1-T' },
            { ...base, reference_number: 'AM-1', payment_date: '2026-11-20', student_id: 'abc', original_student_id: 'abc', check_column: 'AM-1-B', item_name: 'Bus', item_price: 50 },
            { ...base, reference_number: 'AM-2', payment_date: '2026-10-05', student_id: 'def', original_student_id: 'def', check_column: 'AM-2-T' },
            { ...base, reference_number: 'AM-3', payment_date: '2026-11-21', student_id: 'ghi', original_student_id: 'ghi', check_column: 'AM-3-T' },
            { ...base, reference_number: 'AM-4', payment_date: '2026-11-22', student_id: 'jkl', original_student_id: 'jkl', check_column: 'AM-4-T', is_settled: true }
        ];
        const ins = await supabase.from('transactions').insert(rows).select('id, reference_number, check_column');
        expect(ins.error).toBeNull();
        const idOf = (cc) => ins.data.find(r => r.check_column === cc).id;
        // someone fixes AM-3 by hand after the matcher ran
        await db.execute({ sql: "UPDATE transactions SET student_id = '241000555', id_status = 'Valid' WHERE id = ?", args: [idOf('AM-3-T')] });

        const p = (cc, ref, sid, orig, extra = {}) => ({ tx_id: idOf(cc), original_ref: ref, original_student_id: orig, proposedStudent: sid ? { student_id: sid } : null, locked: false, selected: Boolean(sid), ...extra });
        const audits = [];
        const ctx = {
            automatchProposals: [
                p('AM-1-T', 'AM-1', '241000001', 'abc'),
                p('AM-1-B', 'AM-1', null, 'abc'),
                p('AM-2-T', 'AM-2', '241000002', 'def'),
                p('AM-3-T', 'AM-3', '241000003', 'ghi'),
                p('AM-4-T', 'AM-4', '241000004', 'jkl', { locked: true })
            ],
            closedPeriodSet: new Set(['2026-10']),
            allMappingsData: [],
            targetedMatchRefs: [],
            logAudit: async (action, refs, details) => {
                audits.push({ action, refs, details });
                const r = await supabase.from('audit_logs').insert({ action, affected_references: refs, details }).select('id');
                if (r.error) throw r.error;
                audits[audits.length - 1].id = r.data[0].id;
            },
            invalidateDistinctCache() {}, runAutoMatcher() {}, loadDashboard() {}, loadTransactions() {}, updateSidebarBadges() {}
        };
        await App.prototype.applyAutoMatches.call(ctx);

        const sid = async (cc) => (await db.execute({ sql: 'SELECT student_id, id_status FROM transactions WHERE id = ?', args: [idOf(cc)] })).rows[0];
        expect((await sid('AM-1-T')).student_id).toBe('241000001');
        expect((await sid('AM-1-T')).id_status).toBe('Valid');
        expect((await sid('AM-1-B')).student_id).toBe('241000001'); // sibling line of the same order
        expect((await sid('AM-2-T')).student_id).toBe('def');       // closed period: skipped
        expect((await sid('AM-3-T')).student_id).toBe('241000555'); // changed since run: left alone
        expect((await sid('AM-4-T')).student_id).toBe('241000004'); // settled rows can be adjusted

        const fixes = (await db.execute('SELECT reference_number, correct_id FROM manual_fixes ORDER BY reference_number')).rows.map(r => [r.reference_number, r.correct_id]);
        expect(fixes).toEqual([['AM-1', '241000001'], ['AM-4', '241000004']]);

        expect(audits).toHaveLength(1);
        expect(audits[0].details).toMatchObject({ count: 2, skipped_closed_period: 1, skipped_changed_since_run: 1, locked_included: 1 });
        expect(audits[0].details.revert_data.inserted_keys.sort()).toEqual(['AM-1', 'AM-4']);

        // Undo: the fixes go away and re-deriving the rows restores the original IDs
        const rev = await supabase.rpc('revert_audit_log_entry', { p_audit_id: audits[0].id });
        expect(rev.error).toBeNull();
        expect((await db.execute('SELECT COUNT(*) AS n FROM manual_fixes')).rows[0].n).toBe(0);
        const back = (await supabase.from('transactions').select('*').in('reference_number', ['AM-1'])).data;
        const changes = await recomputeTransactions(back, { includeLocked: true, mappings: [] });
        expect(changes.map(c => c.fields.student_id)).toEqual(['abc', 'abc']);
    });
});
