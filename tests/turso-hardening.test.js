// @vitest-environment node
// Regression tests for the security-hardening pass: signed revert payloads, session revocation,
// login throttling, row caps, filter parsing, period-lock / archive / audit immutability, generic
// 500s, the dev JWT secret guard and input validation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { getJwtSecret, hashPassword, TOKEN_TTL_SECONDS } from '../api/_lib/auth.js';
import authHandler, { LOGIN_MAX_FAILURES_PER_EMAIL, LOGIN_MAX_FAILURES_PER_IP } from '../api/auth.js';
import queryHandler, { MAX_SELECT_ROWS, parseInList } from '../api/query.js';
import rpcHandler from '../api/rpc.js';

const schemaSql = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8');

async function callApi(handler, body, token = null, extraHeaders = {}) {
  let out = '';
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(chunk) { out = chunk || ''; }
  };
  const reqHeaders = { ...extraHeaders };
  if (token) reqHeaders.authorization = `Bearer ${token}`;
  await handler({ method: 'POST', headers: reqHeaders, body }, res);
  return { status: res.statusCode, body: JSON.parse(out || '{}'), headers };
}

const q = (token, payload) => callApi(queryHandler, payload, token);
const rpc = (token, fn, args = {}) => callApi(rpcHandler, { fn, args }, token);
let ipCounter = 0;
// Each login gets its own client IP unless a test pins one, so per-IP throttling never leaks
// between tests.
const login = (email, password, ip = `10.0.0.${++ipCounter}`) =>
  callApi(authHandler, { action: 'login', email, password }, null, { 'x-forwarded-for': `${ip}, 172.16.0.1` });
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

describe('Security hardening', () => {
  let db;
  const tokens = {};

  async function makeUser(email, password, role) {
    await callApi(authHandler, { action: 'admin_create_user', email, password, role }, tokens.owner);
    return (await login(email, password)).body.session.access_token;
  }

  beforeAll(async () => {
    db = createClient({ url: ':memory:' });
    setDbClient(db);
    await db.executeMultiple(schemaSql);
    await db.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('OwnerPass123!')]
    });
    tokens.owner = (await login('ammahmoud@nu.edu.eg', 'OwnerPass123!')).body.session.access_token;
    tokens.accountant = await makeUser('acct@nu.edu.eg', 'AcctPass123!', 'accountant');
    tokens.operator = await makeUser('op@nu.edu.eg', 'OperatorPass123!', 'operator');
    tokens.viewer = await makeUser('view@nu.edu.eg', 'ViewerPass123!', 'viewer');
  });

  beforeEach(async () => {
    await db.execute('DELETE FROM closed_periods');
    await db.execute('DELETE FROM login_attempts');
    await db.execute('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete');
    for (const t of ['transactions', 'item_mappings', 'audit_logs', 'links']) {
      await db.execute(`DELETE FROM ${t}`);
    }
    await db.executeMultiple(schemaSql);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const insertAudit = async (token, values) => q(token, { table: 'audit_logs', operation: 'insert', returning: '*', values });
  const mappingRevert = { table_name: 'item_mappings', operation: 'delete', previous_rows: [{ item_name: 'Planted', mapping: 'Evil' }] };

  // ---------------------------------------------------------------- 1. planted revert data
  test('operators cannot store revert data, snapshots or Drive links; accountants get a server signature', async () => {
    const op = await insertAudit(tokens.operator, {
      action: 'X', details: { note: 'ok', revert_data: mappingRevert, revert_snapshot: { deleted_mappings: [] }, drive_folder_url: 'https://evil', revert_sig: 'a'.repeat(64) }
    });
    expect(op.body.data[0].details).toEqual({ note: 'ok' });

    const acct = await insertAudit(tokens.accountant, {
      action: 'Item Mapping Deleted', details: { revert_data: mappingRevert, revert_snapshot: { x: 1 }, drive_folder_url: 'https://evil', revert_sig: 'forged' }
    });
    const d = acct.body.data[0].details;
    expect(d.revert_data).toEqual(mappingRevert);
    expect(d.revert_snapshot).toBeUndefined();
    expect(d.drive_folder_url).toBeUndefined();
    expect(d.revert_sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('details sent as a JSON string are sanitized too (they used to bypass the stripping)', async () => {
    const r = await insertAudit(tokens.operator, { action: 'X', details: JSON.stringify({ revert_data: mappingRevert, keep: 1 }) });
    expect(r.body.data[0].details).toEqual({ keep: 1 });
  });

  test('server-only audit actions cannot be forged through /api/query, not even by an admin', async () => {
    for (const action of ['Database Hygiene Audit', 'Accounting Period Unlocked']) {
      expect((await insertAudit(tokens.owner, { action, details: {} })).status).toBe(403);
    }
  });

  test('revert replays only signed payloads bound to their entry', async () => {
    // Unsigned (planted directly in the DB, or a legacy row)
    const planted = await db.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, details) VALUES (?, ?, ?) RETURNING id',
      args: ['acct@nu.edu.eg', 'Item Mapping Deleted', JSON.stringify({ revert_data: mappingRevert })]
    });
    const r1 = await rpc(tokens.owner, 'revert_audit_log_entry', { p_audit_id: Number(planted.rows[0].id) });
    expect(r1.status).toBe(403);

    // A real signature copied onto another entry (different action) does not verify
    const signed = (await insertAudit(tokens.accountant, { action: 'Item Mapping Deleted', details: { revert_data: mappingRevert } })).body.data[0];
    const copy = await db.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, details) VALUES (?, ?, ?) RETURNING id',
      args: ['acct@nu.edu.eg', 'Something Else', JSON.stringify(signed.details)]
    });
    expect((await rpc(tokens.owner, 'revert_audit_log_entry', { p_audit_id: Number(copy.rows[0].id) })).status).toBe(403);

    // Altered payload under the original signature does not verify
    const altered = { ...signed.details, revert_data: { ...mappingRevert, previous_rows: [{ item_name: 'Other' }] } };
    await db.execute({ sql: 'UPDATE audit_logs SET details = ? WHERE id = ?', args: [JSON.stringify(altered), signed.id] });
    expect((await rpc(tokens.owner, 'revert_audit_log_entry', { p_audit_id: signed.id })).status).toBe(403);
    expect(Number((await db.execute('SELECT COUNT(*) AS c FROM item_mappings')).rows[0].c)).toBe(0);

    // The genuine signed entry works
    const ok = (await insertAudit(tokens.accountant, { action: 'Item Mapping Deleted', details: { revert_data: mappingRevert } })).body.data[0];
    const r2 = await rpc(tokens.owner, 'revert_audit_log_entry', { p_audit_id: ok.id });
    expect(r2.status).toBe(200);
    expect(r2.body.data.success).toBe(true);
  });

  test('hygiene rollback requires a real hygiene entry with a server-written snapshot', async () => {
    const other = await db.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, details) VALUES (?, ?, ?) RETURNING id',
      args: ['ammahmoud@nu.edu.eg', 'Item Mapping Deleted', JSON.stringify({ revert_snapshot: { deleted_mappings: [{ item_name: 'Z' }] } })]
    });
    expect((await rpc(tokens.owner, 'rollback_database_hygiene_audit', { p_audit_id: Number(other.rows[0].id) })).status).toBe(400);

    const byOperator = await db.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, details) VALUES (?, ?, ?) RETURNING id',
      args: ['op@nu.edu.eg', 'Database Hygiene Audit', JSON.stringify({ revert_snapshot: { deleted_mappings: [{ item_name: 'Z' }] } })]
    });
    expect((await rpc(tokens.owner, 'rollback_database_hygiene_audit', { p_audit_id: Number(byOperator.rows[0].id) })).status).toBe(403);
    expect((await rpc(tokens.owner, 'revert_audit_log_entry', { p_audit_id: Number(byOperator.rows[0].id) })).status).toBe(403);

    const run = await rpc(tokens.owner, 'run_database_hygiene_audit', { p_clean: true });
    const back = await rpc(tokens.owner, 'rollback_database_hygiene_audit', { p_audit_id: run.body.data.audit_id });
    expect(back.status).toBe(200);
    expect(back.body.data.success).toBe(true);
  });

  // ---------------------------------------------------------------- 2. session revocation
  test('tokens carry tv, expire in 12 hours, and logout revokes them (primary admin included)', async () => {
    await login('ammahmoud@nu.edu.eg', 'OwnerPass123!');
    const t = (await login('ammahmoud@nu.edu.eg', 'OwnerPass123!')).body.session.access_token;
    const p = decode(t);
    expect(typeof p.tv).toBe('number');
    expect(p.exp - p.iat).toBe(TOKEN_TTL_SECONDS);
    expect(TOKEN_TTL_SECONDS).toBe(12 * 3600);
    expect((await q(t, { table: 'links', operation: 'select' })).status).toBe(200);
    await callApi(authHandler, { action: 'logout' }, t);
    expect((await q(t, { table: 'links', operation: 'select' })).status).toBe(401);
    tokens.owner = (await login('ammahmoud@nu.edu.eg', 'OwnerPass123!')).body.session.access_token;
  });

  test('change_password revokes old tokens and returns a working new one', async () => {
    const old = await makeUser('pw@nu.edu.eg', 'FirstPass123!', 'viewer');
    const r = await callApi(authHandler, { action: 'change_password', currentPassword: 'FirstPass123!', newPassword: 'SecondPass123!' }, old);
    expect(r.status).toBe(200);
    expect((await q(old, { table: 'links', operation: 'select' })).status).toBe(401);
    expect((await q(r.body.session.access_token, { table: 'links', operation: 'select' })).status).toBe(200);
  });

  test('admin reset, create-over-existing, deactivation and delete+recreate all revoke tokens', async () => {
    const a = await makeUser('rev1@nu.edu.eg', 'Rev1Pass123!', 'viewer');
    await callApi(authHandler, { action: 'admin_reset_password', email: 'rev1@nu.edu.eg', newPassword: 'Rev1New123!' }, tokens.owner);
    expect((await q(a, { table: 'links', operation: 'select' })).status).toBe(401);

    const b = (await login('rev1@nu.edu.eg', 'Rev1New123!')).body.session.access_token;
    await callApi(authHandler, { action: 'admin_create_user', email: 'rev1@nu.edu.eg', password: 'Rev1Again123!', role: 'viewer' }, tokens.owner);
    expect((await q(b, { table: 'links', operation: 'select' })).status).toBe(401);

    const c = (await login('rev1@nu.edu.eg', 'Rev1Again123!')).body.session.access_token;
    await rpc(tokens.owner, 'admin_set_user_active', { target_email: 'rev1@nu.edu.eg', active: false });
    await rpc(tokens.owner, 'admin_set_user_active', { target_email: 'rev1@nu.edu.eg', active: true });
    expect((await q(c, { table: 'links', operation: 'select' })).status).toBe(401);

    const d = (await login('rev1@nu.edu.eg', 'Rev1Again123!')).body.session.access_token;
    await rpc(tokens.owner, 'admin_delete_user', { target_email: 'rev1@nu.edu.eg' });
    await callApi(authHandler, { action: 'admin_create_user', email: 'rev1@nu.edu.eg', password: 'Rev1Fresh123!', role: 'viewer' }, tokens.owner);
    expect((await q(d, { table: 'links', operation: 'select' })).status).toBe(401);
  });

  test('getAuthUser tolerates a database without the token_version column', async () => {
    const legacy = createClient({ url: ':memory:' });
    // An app_users table from before token_version existed (CREATE TABLE IF NOT EXISTS keeps it).
    await legacy.execute(`CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      last_sign_in_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    await legacy.executeMultiple(schemaSql);
    await legacy.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('OwnerPass123!')]
    });
    setDbClient(legacy);
    try {
      const t = (await login('ammahmoud@nu.edu.eg', 'OwnerPass123!')).body.session.access_token;
      expect(decode(t).tv).toBe(0);
      expect((await q(t, { table: 'links', operation: 'select' })).status).toBe(200);
      expect((await callApi(authHandler, { action: 'logout' }, t)).status).toBe(200);
    } finally {
      setDbClient(db);
    }
  });

  // ---------------------------------------------------------------- 3. login throttling
  test('5 failed logins for one email lock it (429 + Retry-After), even for the right password', async () => {
    await makeUser('lock@nu.edu.eg', 'LockPass123!', 'viewer');
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_EMAIL; i++) {
      expect((await login('lock@nu.edu.eg', 'wrong-password')).status).toBe(401);
    }
    const locked = await login('lock@nu.edu.eg', 'LockPass123!');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('a successful login resets the email counter', async () => {
    await makeUser('reset@nu.edu.eg', 'ResetPass123!', 'viewer');
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_EMAIL - 1; i++) await login('reset@nu.edu.eg', 'nope-nope');
    expect((await login('reset@nu.edu.eg', 'ResetPass123!')).status).toBe(200);
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_EMAIL - 1; i++) await login('reset@nu.edu.eg', 'nope-nope');
    expect((await login('reset@nu.edu.eg', 'ResetPass123!')).status).toBe(200);
  });

  test('20 failures from one IP (first x-forwarded-for hop) lock that IP across emails', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i++) {
      expect((await login(`nobody${i}@nu.edu.eg`, 'whatever1', '203.0.113.9')).status).toBe(401);
    }
    expect((await login('ammahmoud@nu.edu.eg', 'OwnerPass123!', '203.0.113.9')).status).toBe(429);
    expect((await login('ammahmoud@nu.edu.eg', 'OwnerPass123!', '203.0.113.10')).status).toBe(200);
  });

  test('an unknown email gets the same 401 as a wrong password', async () => {
    const unknown = await login('ghost@nu.edu.eg', 'whatever1');
    const wrong = await login('view@nu.edu.eg', 'whatever1');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  // ---------------------------------------------------------------- 4. row caps
  test('selects are capped at MAX_SELECT_ROWS and oversized write arrays get 413', async () => {
    const stmts = [];
    for (let i = 0; i < MAX_SELECT_ROWS + 5; i++) stmts.push({ sql: 'INSERT INTO links (invoice_number) VALUES (?)', args: [`I${i}`] });
    await db.batch(stmts, 'write');
    expect((await q(tokens.viewer, { table: 'links', operation: 'select', columns: 'id' })).body.data).toHaveLength(MAX_SELECT_ROWS);
    expect((await q(tokens.viewer, { table: 'links', operation: 'select', columns: 'id', limit: 999999 })).body.data).toHaveLength(MAX_SELECT_ROWS);
    expect((await q(tokens.viewer, { table: 'links', operation: 'select', columns: 'id', range: { from: 0, to: 999999 } })).body.data).toHaveLength(MAX_SELECT_ROWS);
    expect((await q(tokens.viewer, { table: 'links', operation: 'select', columns: 'id', range: { from: 5000, to: 5999 } })).body.data).toHaveLength(5);

    const big = Array.from({ length: 5001 }, (_, i) => ({ invoice_number: `B${i}` }));
    expect((await q(tokens.operator, { table: 'links', operation: 'insert', values: big })).status).toBe(413);
    const updates = Array.from({ length: 5001 }, (_, i) => ({ id: i }));
    expect((await rpc(tokens.operator, 'bulk_update_rule_fields', { p_updates: updates })).status).toBe(413);
  });

  // ---------------------------------------------------------------- 5/6. filters
  test('not-in with the PostgREST string form excludes the listed values; non-list "in" is a 400', async () => {
    await db.execute("INSERT INTO item_mappings (item_name, mapping) VALUES ('a', 'x'), ('b', 'y'), ('c,d', 'z'), ('e', NULL)");
    const r = await q(tokens.viewer, { table: 'item_mappings', operation: 'select', filters: [{ op: 'not', column: 'item_name', innerOp: 'in', value: '(a,"c,d")' }] });
    expect(r.body.data.map(x => x.item_name).sort()).toEqual(['b', 'e']);
    expect((await q(tokens.viewer, { table: 'item_mappings', operation: 'select', filters: [{ op: 'in', column: 'item_name', value: 'a' }] })).status).toBe(400);
    expect((await q(tokens.viewer, { table: 'item_mappings', operation: 'select', filters: [{ op: 'eq', column: 'item_name', value: { a: 1 } }] })).status).toBe(400);
    expect(parseInList('( a , "b,c" ,"" )')).toEqual(['a', 'b,c', '']);
  });

  test('neq follows Postgres: NULL rows do not match', async () => {
    await db.execute("INSERT INTO item_mappings (item_name, mapping) VALUES ('a', 'x'), ('b', 'y'), ('e', NULL)");
    const r = await q(tokens.viewer, { table: 'item_mappings', operation: 'select', filters: [{ op: 'neq', column: 'mapping', value: 'x' }] });
    expect(r.body.data.map(x => x.item_name)).toEqual(['b']);
  });

  test('gt/gte/lt/lte values are serialized like eq (booleans become 0/1)', async () => {
    await db.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column, is_settled) VALUES ('S1', '2026-10-01', 1, 'a', 1), ('S2', '2026-10-01', 1, 'b', 0)");
    const r = await q(tokens.viewer, { table: 'transactions', operation: 'select', filters: [{ op: 'gte', column: 'is_settled', value: true }] });
    expect(r.body.data.map(x => x.reference_number)).toEqual(['S1']);
  });

  // ---------------------------------------------------------------- 7/8. locks, archive, audit
  test('closed_periods can only change through the RPC; unlocking needs a reason and records the previous state', async () => {
    for (const op of ['insert', 'upsert']) {
      expect((await q(tokens.owner, { table: 'closed_periods', operation: op, values: { period_month: '2026-01', is_closed: true } })).status).toBe(403);
    }
    expect((await q(tokens.owner, { table: 'closed_periods', operation: 'update', values: { is_closed: false }, filters: [{ op: 'eq', column: 'period_month', value: '2026-01' }] })).status).toBe(403);
    expect((await q(tokens.owner, { table: 'closed_periods', operation: 'delete', filters: [{ op: 'eq', column: 'period_month', value: '2026-01' }] })).status).toBe(403);

    expect((await rpc(tokens.owner, 'set_accounting_period_lock', { p_period_month: '2026-01', p_is_closed: true })).status).toBe(200);
    expect((await rpc(tokens.owner, 'set_accounting_period_lock', { p_period_month: '2026-01', p_is_closed: false, p_notes: '   ' })).status).toBe(400);
    expect((await rpc(tokens.owner, 'set_accounting_period_lock', { p_period_month: '2026-01', p_is_closed: false, p_notes: 'Late invoice' })).status).toBe(200);
    const audit = (await db.execute("SELECT details FROM audit_logs WHERE action = 'Accounting Period Unlocked'")).rows[0];
    const details = JSON.parse(audit.details);
    expect(details.notes).toBe('Late invoice');
    expect(details.previous_state).toMatchObject({ is_closed: true, closed_by: 'ammahmoud@nu.edu.eg' });
  });

  test('nobody inserts into transactions_archive through the API', async () => {
    const r = await q(tokens.owner, { table: 'transactions_archive', operation: 'insert', values: { id: 1, reference_number: 'X', item_price: 1, check_column: 'a' } });
    expect(r.status).toBe(403);
  });

  test('audit entries: only details may change at the database level', async () => {
    const id = Number((await db.execute("INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES ('a@nu.edu.eg', 'X', 'R', '{}') RETURNING id")).rows[0].id);
    await expect(db.execute({ sql: "UPDATE audit_logs SET action = 'Y' WHERE id = ?", args: [id] })).rejects.toThrow(/cannot be changed/);
    await expect(db.execute({ sql: "UPDATE audit_logs SET user_email = 'b@nu.edu.eg' WHERE id = ?", args: [id] })).rejects.toThrow(/cannot be changed/);
    await expect(db.execute({ sql: "UPDATE audit_logs SET created_at = '2000-01-01' WHERE id = ?", args: [id] })).rejects.toThrow(/cannot be changed/);
    await expect(db.execute({ sql: "UPDATE audit_logs SET affected_references = 'Z' WHERE id = ?", args: [id] })).rejects.toThrow(/cannot be changed/);
    await db.execute({ sql: 'UPDATE audit_logs SET details = ? WHERE id = ?', args: ['{"is_reverted":true}', id] });
  });

  // ---------------------------------------------------------------- 9. generic 500s
  test('unexpected database errors return a generic message (logged server-side)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realExecute = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation((stmt) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      if (/FROM "links"/.test(sql)) throw new Error('SQLITE_ERROR: no such column: secret_internal_col');
      return realExecute(stmt);
    });
    const r = await q(tokens.viewer, { table: 'links', operation: 'select' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret_internal_col|SQLITE/);
    expect(spy).toHaveBeenCalled();
    // 4xx messages are still specific
    expect((await q(tokens.viewer, { table: 'links', operation: 'insert', values: {} })).body.error).toMatch(/requires operator/);
  });

  // ---------------------------------------------------------------- 10. dev JWT secret
  test('the dev JWT secret is refused outside tests / local SQLite', () => {
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('TURSO_JWT_SECRET', '');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TURSO_DATABASE_URL', 'libsql://prod.turso.io');
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
    vi.stubEnv('TURSO_DATABASE_URL', 'file:local.db');
    expect(getJwtSecret()).toBeTruthy();
    vi.stubEnv('TURSO_DATABASE_URL', 'libsql://prod.turso.io');
    vi.stubEnv('JWT_SECRET', 'real-secret');
    expect(getJwtSecret()).toBe('real-secret');
  });

  // ---------------------------------------------------------------- 11. input validation
  test('the archive RPC requires a real YYYY-MM-DD date', async () => {
    for (const bad of ['2', '2025-13-01', '2025-02-30', '0000-99-99', "2025-01-01' OR 1=1", null]) {
      expect((await rpc(tokens.owner, 'archive_settled_transactions', { p_before_date: bad })).status).toBe(400);
    }
    expect((await rpc(tokens.owner, 'archive_settled_transactions', { p_before_date: '2024-01-01' })).status).toBe(200);
  });

  // ---------------------------------------------------------------- 15. staff list
  test('viewers and operators see only their own user_roles row; accountants see the list', async () => {
    const v = await q(tokens.viewer, { table: 'user_roles', operation: 'select' });
    expect(v.body.data.map(r => r.email)).toEqual(['view@nu.edu.eg']);
    const o = await q(tokens.operator, { table: 'user_roles', operation: 'select', filters: [{ op: 'eq', column: 'email', value: 'ammahmoud@nu.edu.eg' }] });
    expect(o.body.data).toEqual([]);
    const a = await q(tokens.accountant, { table: 'user_roles', operation: 'select' });
    expect(a.body.data.length).toBeGreaterThan(1);
  });
});
