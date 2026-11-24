// @vitest-environment node
// Turso's SQLite rejects expressions deeper than 100 ("Expression tree is too large"); the local
// SQLite used in tests allows 1000, so these tests check the SQL the API builds instead.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeAll } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import authHandler from '../api/auth.js';
import queryHandler, { joinShallow } from '../api/query.js';

async function call(handler, body, token) {
    let out = '';
    const res = { statusCode: 200, setHeader() {}, end(c) { out = c || ''; } };
    await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
    return { status: res.statusCode, body: JSON.parse(out || '{}') };
}

// Longest run of AND/OR operators inside one parenthesis level (a flat chain = that many levels deep).
function longestFlatChain(sql) {
    let max = 0;
    const stack = [0];
    const tokens = sql.match(/\(|\)|\bOR\b|\bAND\b/g) || [];
    for (const t of tokens) {
        if (t === '(') stack.push(0);
        else if (t === ')') stack.pop();
        else { stack[stack.length - 1]++; max = Math.max(max, stack[stack.length - 1]); }
    }
    return max;
}

describe('SQL expression depth stays within Turso limits', () => {
    let token;
    const seen = [];

    beforeAll(async () => {
        const db = createClient({ url: ':memory:' });
        const record = (stmt) => seen.push(typeof stmt === 'string' ? stmt : stmt.sql);
        const wrapped = {
            execute: (s) => { record(s); return db.execute(s); },
            batch: (stmts, mode) => { stmts.forEach(record); return db.batch(stmts, mode); },
            executeMultiple: (s) => db.executeMultiple(s)
        };
        setDbClient(wrapped);
        await db.executeMultiple(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8'));
        await db.execute({ sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)', args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('Owner12345!')] });
        token = (await call(authHandler, { action: 'login', email: 'ammahmoud@nu.edu.eg', password: 'Owner12345!' })).body.session.access_token;
    });

    test('re-importing 500 existing transactions (upsert) succeeds with shallow SQL', async () => {
        const rows = Array.from({ length: 500 }, (_, i) => ({
            reference_number: String(9000000000 + i), payment_date: '2026-11-20', item_name: 'Tuition',
            item_price: 1000, check_column: `${9000000000 + i}-Tuition`, bank: 'NUADIB64'
        }));
        const first = await call(queryHandler, { table: 'transactions', operation: 'upsert', values: rows, onConflict: 'reference_number,item_price,check_column' }, token);
        expect(first.status).toBe(200);
        seen.length = 0;
        // second time every row already exists: this is the path that failed in production
        const again = await call(queryHandler, { table: 'transactions', operation: 'upsert', values: rows.map(r => ({ ...r, student_id: '261000001' })), onConflict: 'reference_number,item_price,check_column' }, token);
        expect(again.status).toBe(200);
        const worst = Math.max(...seen.map(longestFlatChain));
        expect(worst).toBeLessThan(40);
    });

    test('an .or() filter with hundreds of values is nested, not one flat chain', async () => {
        seen.length = 0;
        const values = Array.from({ length: 300 }, (_, i) => `reference_number.eq.${9000000000 + i}`).join(',');
        const res = await call(queryHandler, { table: 'transactions', operation: 'select', columns: 'id', filters: [{ op: 'or', value: values }] }, token);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(300);
        expect(Math.max(...seen.map(longestFlatChain))).toBeLessThan(40);
    });

    test('joinShallow keeps every level at 32 terms or fewer', () => {
        const parts = Array.from({ length: 2000 }, (_, i) => `x = ${i}`);
        const sql = joinShallow(parts, 'OR');
        expect(longestFlatChain(sql)).toBeLessThanOrEqual(31);
        expect(joinShallow(['a', 'b'], 'AND')).toBe('(a AND b)');
    });
});
