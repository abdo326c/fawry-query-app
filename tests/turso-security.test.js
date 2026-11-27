// @vitest-environment node
// Regression tests for the critical/high findings in the Turso API review:
// upsert permission bypass, period-lock gaps, append-only audit log/archive, primary admin
// takeover, manual_fixes ambiguous-column error, atomic writes and safe retries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient, withDbWriteRetry, withDbRetry } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import { hasMinRole } from '../api/_lib/rbac.js';
import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler from '../api/rpc.js';
import { isIdempotentRequest } from '../supabase.js';

const schemaSql = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8');

async function callApi(handler, body, token = null) {
  let out = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) { out = chunk || ''; }
  };
  await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return { status: res.statusCode, body: JSON.parse(out || '{}') };
}

const q = (token, payload) => callApi(queryHandler, payload, token);
const rpc = (token, fn, args = {}) => callApi(rpcHandler, { fn, args }, token);

describe('Turso API security fixes', () => {
  let db;
  const tokens = {};

  async function makeUser(email, password, role) {
    await callApi(authHandler, { action: 'admin_create_user', email, password, role }, tokens.owner);
    return (await callApi(authHandler, { action: 'login', email, password })).body.session.access_token;
  }

  beforeAll(async () => {
    db = createClient({ url: ':memory:' });
    setDbClient(db);
    await db.executeMultiple(schemaSql);
    await db.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('OwnerPass123!')]
    });
    tokens.owner = (await callApi(authHandler, { action: 'login', email: 'ammahmoud@nu.edu.eg', password: 'OwnerPass123!' })).body.session.access_token;
    tokens.admin2 = await makeUser('admin2@nu.edu.eg', 'Admin2Pass123!', 'admin');
    tokens.operator = await makeUser('op@nu.edu.eg', 'OperatorPass123!', 'operator');
    tokens.viewer = await makeUser('view@nu.edu.eg', 'ViewerPass123!', 'viewer');
    tokens.gone = await makeUser('gone@nu.edu.eg', 'GonePass123!', 'operator');
    await db.execute("UPDATE user_roles SET is_active = 0 WHERE email = 'gone@nu.edu.eg'");
  });

  beforeEach(async () => {
    await db.execute('DELETE FROM closed_periods');
    await db.execute('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete');
    await db.execute('DROP TRIGGER IF EXISTS trg_tx_archive_no_delete');
    for (const t of ['transactions', 'transactions_archive', 'foreign_transactions', 'manual_fixes', 'student_master', 'audit_logs', 'period_lock_bypass']) {
      await db.execute(`DELETE FROM ${t}`);
    }
    await db.executeMultiple(schemaSql);
  });

  const tx = (over = {}) => ({
    reference_number: 'R1', payment_date: '2026-10-05', item_name: 'Tuition', item_price: 100,
    check_column: 'Tuition', student_id: '231000123', is_settled: false, ...over
  });
  const closeMonth = (m) => db.execute({ sql: 'INSERT INTO closed_periods (period_month, is_closed) VALUES (?, 1)', args: [m] });

  // ---------------------------------------------------------------- critical: upsert bypass
  test('an unknown required role never grants access', () => {
    expect(hasMinRole('admin', undefined)).toBe(false);
    expect(hasMinRole('admin', 'superuser')).toBe(false);
    expect(hasMinRole('viewer', 'viewer')).toBe(true);
  });

  test('a viewer cannot make themselves admin with upsert', async () => {
    const r = await q(tokens.viewer, {
      table: 'user_roles', operation: 'upsert', values: { email: 'view@nu.edu.eg', role: 'admin', is_active: true }
    });
    expect(r.status).toBe(403);
    const row = await db.execute("SELECT role FROM user_roles WHERE email = 'view@nu.edu.eg'");
    expect(row.rows[0].role).toBe('viewer');
  });

  test('a viewer cannot upsert transactions or reopen a closed period', async () => {
    expect((await q(tokens.viewer, { table: 'transactions', operation: 'upsert', values: [tx()] })).status).toBe(403);
    await closeMonth('2026-09');
    const r = await q(tokens.viewer, { table: 'closed_periods', operation: 'upsert', values: { period_month: '2026-09', is_closed: false } });
    expect(r.status).toBe(403);
  });

  test('a deactivated user with a still-valid token cannot write anything', async () => {
    expect((await q(tokens.gone, { table: 'transactions', operation: 'insert', values: [tx()] })).status).toBe(403);
    expect((await q(tokens.gone, { table: 'user_roles', operation: 'upsert', values: { email: 'gone@nu.edu.eg', role: 'admin', is_active: true } })).status).toBe(403);
  });

  test('unknown operations are rejected', async () => {
    expect((await q(tokens.owner, { table: 'transactions', operation: 'truncate' })).status).toBe(400);
  });

  test('an operator can still upsert transactions (insert + update roles)', async () => {
    const r = await q(tokens.operator, { table: 'transactions', operation: 'upsert', values: [tx()] });
    expect(r.status).toBe(200);
  });

  // ---------------------------------------------------------------- audit log append-only
  test('nobody (not even an admin) can edit or delete audit entries through the API', async () => {
    await q(tokens.operator, { table: 'audit_logs', operation: 'insert', values: { action: 'X', details: { a: 1 } } });
    const id = (await db.execute('SELECT id FROM audit_logs LIMIT 1')).rows[0].id;
    expect((await q(tokens.owner, { table: 'audit_logs', operation: 'update', values: { action: 'Y' }, filters: [{ column: 'id', op: 'eq', value: id }] })).status).toBe(403);
    expect((await q(tokens.owner, { table: 'audit_logs', operation: 'delete', filters: [{ column: 'id', op: 'eq', value: id }] })).status).toBe(403);
    expect((await q(tokens.owner, { table: 'audit_logs', operation: 'upsert', values: { id, action: 'Forged' } })).status).toBe(403);
    await expect(db.execute('DELETE FROM audit_logs')).rejects.toThrow(/cannot be deleted/);
  });

  test('audit inserts cannot choose their id, timestamp or author', async () => {
    await q(tokens.operator, {
      table: 'audit_logs', operation: 'insert',
      values: { id: 999, created_at: '2020-01-01 00:00:00', user_email: 'someone-else@nu.edu.eg', action: 'Backdated' }
    });
    const row = (await db.execute("SELECT id, created_at, user_email FROM audit_logs WHERE action = 'Backdated'")).rows[0];
    expect(row.id).not.toBe(999);
    expect(String(row.created_at)).not.toMatch(/^2020/);
    expect(row.user_email).toBe('op@nu.edu.eg');
  });

  // ---------------------------------------------------------------- archive append-only + re-import
  test('archived rows cannot be changed or deleted, and re-imports of them are skipped', async () => {
    await db.execute({
      sql: `INSERT INTO transactions_archive (id, reference_number, payment_date, item_price, check_column, is_settled, erp_batch_number)
            VALUES (50, 'ARCH1', '2025-01-10', 100, 'Tuition', 1, 'B1')`
    });
    expect((await q(tokens.owner, { table: 'transactions_archive', operation: 'update', values: { erp_batch_number: null }, filters: [{ column: 'id', op: 'eq', value: 50 }] })).status).toBe(403);
    expect((await q(tokens.owner, { table: 'transactions_archive', operation: 'delete', filters: [{ column: 'id', op: 'eq', value: 50 }] })).status).toBe(403);
    await expect(db.execute('UPDATE transactions_archive SET erp_batch_number = NULL')).rejects.toThrow(/cannot be changed/);

    const r = await q(tokens.operator, { table: 'transactions', operation: 'insert', values: [tx({ reference_number: 'ARCH1', payment_date: '2025-01-10' }), tx({ reference_number: 'NEW1' })] });
    expect(r.status).toBe(200);
    const refs = (await db.execute('SELECT reference_number FROM transactions ORDER BY reference_number')).rows.map(x => x.reference_number);
    expect(refs).toEqual(['NEW1']);
  });

  // ---------------------------------------------------------------- period lock
  test('the database itself refuses writes inside a closed month', async () => {
    await db.execute({ sql: 'INSERT INTO transactions (reference_number, payment_date, item_price, check_column) VALUES (?, ?, ?, ?)', args: ['L1', '2026-09-10', 100, 'Tuition'] });
    await closeMonth('2026-09');
    await expect(db.execute("UPDATE transactions SET is_settled = 1 WHERE reference_number = 'L1'")).rejects.toThrow(/Accounting period is closed/);
    await expect(db.execute("DELETE FROM transactions WHERE reference_number = 'L1'")).rejects.toThrow(/Accounting period is closed/);
    await expect(db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column) VALUES ('L2', '2026-09-11', 5, 'X')")).rejects.toThrow(/Accounting period is closed/);
    // moving an open-month row INTO the closed month is blocked too
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column) VALUES ('O1', '2026-10-01', 5, 'X')");
    await expect(db.execute("UPDATE transactions SET payment_date = '2026-09-30' WHERE reference_number = 'O1'")).rejects.toThrow(/Accounting period is closed/);
  });

  test('bulk_update_rule_fields refuses closed-month rows (it used to skip the check)', async () => {
    const ins = await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column, student_id) VALUES ('L1', '2026-09-10', 100, 'Tuition', '1') RETURNING id");
    await closeMonth('2026-09');
    const r = await rpc(tokens.operator, 'bulk_update_rule_fields', { p_updates: [{ id: ins.rows[0].id, student_id: '999', id_status: 'Valid' }] });
    expect(r.status).toBe(403);
    expect((await db.execute('SELECT student_id FROM transactions')).rows[0].student_id).toBe('1');
  });

  test('an upsert cannot overwrite a closed-month row by sending an open-month date', async () => {
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column, student_id) VALUES ('R1', '2026-09-10', 100, 'Tuition', '1')");
    await closeMonth('2026-09');
    const r = await q(tokens.operator, { table: 'transactions', operation: 'upsert', values: [tx({ payment_date: '2026-10-05', student_id: '2' })] });
    expect(r.status).toBe(403);
    expect((await db.execute('SELECT payment_date, student_id FROM transactions')).rows[0]).toMatchObject({ payment_date: '2026-09-10', student_id: '1' });
  });

  test('student level propagation skips closed months instead of rewriting them', async () => {
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column, student_id, student_level) VALUES ('C1', '2026-09-10', 1, 'a', '231000123', 'UG'), ('O1', '2026-10-10', 1, 'b', '231000123', 'UG')");
    await closeMonth('2026-09');
    const r = await q(tokens.operator, { table: 'student_master', operation: 'upsert', values: [{ student_id: '231000123', full_name: 'X', program: 'MBA' }] });
    expect(r.status).toBe(200);
    const rows = (await db.execute('SELECT reference_number, student_level FROM transactions ORDER BY reference_number')).rows;
    expect(rows.find(x => x.reference_number === 'C1').student_level).toBe('UG');   // closed: unchanged
  });

  test('the archive RPC still archives old closed months, and the bypass never leaks', async () => {
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column, is_settled, erp_batch_number) VALUES ('OLD1', '2025-01-10', 100, 'Tuition', 1, 'B1')");
    await closeMonth('2025-01');
    const r = await rpc(tokens.owner, 'archive_settled_transactions', { p_before_date: '2025-02-01', p_dry_run: false });
    expect(r.status).toBe(200);
    expect(r.body.data.archived_count).toBe(1);
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM transactions')).rows[0].c)).toBe(0);
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM period_lock_bypass')).rows[0].c)).toBe(0);
  });

  test('the archive RPC never deletes a row it could not archive', async () => {
    await db.execute("INSERT INTO transactions_archive (id, reference_number, payment_date, item_price, check_column, is_settled, erp_batch_number) VALUES (7, 'K', '2025-01-02', 1, 'a', 1, 'B')");
    // Fixture: a live row with the same dedupe key as an archived one (possible for data from
    // before the skip trigger existed). Archiving it is skipped by INSERT OR IGNORE...
    await db.execute("DROP TRIGGER trg_skip_archived_transaction_insert");
    await db.execute("INSERT INTO transactions (id, reference_number, payment_date, item_price, check_column, is_settled, erp_batch_number) VALUES (8, 'K', '2025-01-02', 1, 'a', 1, 'B')");
    await db.executeMultiple(schemaSql);
    await rpc(tokens.owner, 'archive_settled_transactions', { p_before_date: '2025-02-01', p_dry_run: false });
    // ...so it must NOT be deleted (it used to be deleted anyway and lost).
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM transactions WHERE id = 8')).rows[0].c)).toBe(1);
  });

  // ---------------------------------------------------------------- manual_fixes ambiguous column
  test('manual fixes can be updated and deleted by reference number again', async () => {
    await db.execute("INSERT INTO manual_fixes (reference_number, correct_id) VALUES ('MF1', '231000123')");
    const up = await q(tokens.owner, { table: 'manual_fixes', operation: 'update', values: { correct_id: '231000124' }, filters: [{ column: 'reference_number', op: 'eq', value: 'MF1' }] });
    expect(up.status).toBe(200);
    const del = await q(tokens.owner, { table: 'manual_fixes', operation: 'delete', filters: [{ column: 'reference_number', op: 'eq', value: 'MF1' }] });
    expect(del.status).toBe(200);
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM manual_fixes')).rows[0].c)).toBe(0);
  });

  test('manual fixes for a closed-month payment are locked', async () => {
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column) VALUES ('MF2', '2026-09-10', 1, 'a')");
    await db.execute("INSERT INTO manual_fixes (reference_number, correct_id) VALUES ('MF2', '1')");
    await closeMonth('2026-09');
    const del = await q(tokens.owner, { table: 'manual_fixes', operation: 'delete', filters: [{ column: 'reference_number', op: 'eq', value: 'MF2' }] });
    expect(del.status).toBe(403);
  });

  // ---------------------------------------------------------------- primary admin takeover
  test('another admin cannot reset or overwrite the primary admin password', async () => {
    const reset = await callApi(authHandler, { action: 'admin_reset_password', email: 'ammahmoud@nu.edu.eg', newPassword: 'Hijacked123!' }, tokens.admin2);
    expect(reset.status).toBe(403);
    const create = await callApi(authHandler, { action: 'admin_create_user', email: 'ammahmoud@nu.edu.eg', password: 'Hijacked123!', role: 'admin' }, tokens.admin2);
    expect(create.status).toBe(403);
    const login = await callApi(authHandler, { action: 'login', email: 'ammahmoud@nu.edu.eg', password: 'OwnerPass123!' });
    expect(login.status).toBe(200);
    // the primary admin can still manage other accounts
    const ok = await callApi(authHandler, { action: 'admin_reset_password', email: 'view@nu.edu.eg', newPassword: 'ViewerPass123!' }, tokens.owner);
    expect(ok.status).toBe(200);
  });

  // ---------------------------------------------------------------- atomic writes / safe retries
  test('a failing row rolls back the whole insert request', async () => {
    // The second row violates the unique key; the first must not be left behind.
    const r = await q(tokens.operator, { table: 'transactions', operation: 'insert', values: [tx({ reference_number: 'A1' }), tx({ reference_number: 'A1' })] });
    expect(r.status).toBe(500);
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM transactions')).rows[0].c)).toBe(0);
  });

  test('writes are not retried after an ambiguous network error, reads are', async () => {
    const netErr = () => Object.assign(new Error('fetch failed'), {});
    const write = vi.fn(async () => { throw netErr(); });
    await expect(withDbWriteRetry(write, { baseDelayMs: 1 })).rejects.toThrow('fetch failed');
    expect(write).toHaveBeenCalledTimes(1);

    let n = 0;
    const busy = vi.fn(async () => { if (n++ < 2) throw new Error('SQLITE_BUSY: database is locked'); return 'ok'; });
    expect(await withDbWriteRetry(busy, { baseDelayMs: 1 })).toBe('ok');

    const read = vi.fn(async () => { throw netErr(); });
    await expect(withDbRetry(read, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('the browser client only treats reads as safe to re-send', () => {
    expect(isIdempotentRequest('/api/query', { operation: 'select' })).toBe(true);
    expect(isIdempotentRequest('/api/query', { operation: 'insert' })).toBe(false);
    expect(isIdempotentRequest('/api/query', { operation: 'upsert' })).toBe(false);
    expect(isIdempotentRequest('/api/rpc', { fn: 'get_dashboard_summary' })).toBe(true);
    expect(isIdempotentRequest('/api/rpc', { fn: 'get_operational_checklist' })).toBe(true);
    expect(isIdempotentRequest('/api/rpc', { fn: 'get_period_close_readiness' })).toBe(true);
    expect(isIdempotentRequest('/api/rpc', { fn: 'detect_fawry_duplicates' })).toBe(true);
    expect(isIdempotentRequest('/api/rpc', { fn: 'archive_settled_transactions' })).toBe(false);
    expect(isIdempotentRequest('/api/auth', { action: 'login' })).toBe(false);
  });

  // ---------------------------------------------------------------- HttpOnly cookie auth & CSRF
  test('cookie-auth mode sets HttpOnly cookie, omits access_token from JSON, requires X-Fawry-Client, and clears on logout', async () => {
    const callWithHeaders = async (handler, body, headers = {}) => {
      let out = '';
      const resHeaders = {};
      const res = {
        statusCode: 200,
        setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
        end(chunk) { out = chunk || ''; }
      };
      await handler({ method: 'POST', headers, body }, res);
      return { status: res.statusCode, body: JSON.parse(out || '{}'), headers: resHeaders };
    };

    const loginRes = await callWithHeaders(
      authHandler,
      { action: 'login', email: 'op@nu.edu.eg', password: 'OperatorPass123!' },
      { 'x-fawry-client': '1', 'x-fawry-cookie-auth': '1', 'x-forwarded-proto': 'https' }
    );
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.session.cookie_auth).toBe(true);
    expect(loginRes.body.session.access_token).toBeUndefined();
    const setCookie = String(loginRes.headers['set-cookie'] || '');
    expect(setCookie).toContain('fawry_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');

    const cookiePair = setCookie.split(';')[0];

    // Cookie without X-Fawry-Client header must be rejected (CSRF guard)
    const noCsrf = await callWithHeaders(
      queryHandler,
      { table: 'links', operation: 'select' },
      { cookie: cookiePair }
    );
    expect(noCsrf.status).toBe(401);

    // Cookie WITH X-Fawry-Client: 1 succeeds and resolves operator role
    const withCsrf = await callWithHeaders(
      queryHandler,
      { table: 'links', operation: 'select' },
      { cookie: cookiePair, 'x-fawry-client': '1' }
    );
    expect(withCsrf.status).toBe(200);

    // Logout clears cookie and revokes session
    const logoutRes = await callWithHeaders(
      authHandler,
      { action: 'logout' },
      { cookie: cookiePair, 'x-fawry-client': '1', 'x-fawry-cookie-auth': '1' }
    );
    expect(logoutRes.status).toBe(200);
    expect(String(logoutRes.headers['set-cookie'] || '')).toContain('Max-Age=0');

    const afterLogout = await callWithHeaders(
      queryHandler,
      { table: 'links', operation: 'select' },
      { cookie: cookiePair, 'x-fawry-client': '1' }
    );
    expect(afterLogout.status).toBe(401);
  });
});
