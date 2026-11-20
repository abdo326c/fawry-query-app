import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler from '../api/rpc.js';

function createMockRes() {
  let body = '';
  const headers = {};
  return {
    statusCode: 200,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(chunk) { body = chunk || ''; },
    json() { return JSON.parse(body || '{}'); },
    headers
  };
}

async function callApi(handler, body, token = null) {
  const req = {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body
  };
  const res = createMockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.json() };
}

describe('Turso 10-User Simultaneous Concurrency Stress Test (File-Backed WAL)', () => {
  let db;
  let dbPath;
  const users = {
    admins: [],
    accountants: [],
    operators: [],
    viewers: []
  };

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `fawry-concurrency-${crypto.randomUUID()}.db`);
    db = createClient({ url: pathToFileURL(dbPath).href });
    setDbClient(db);

    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA busy_timeout = 5000');

    const schemaPath = path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await db.executeMultiple(schemaSql);

    // Seed primary admin + secondary admin + 2 accountants + 3 operators + 3 viewers = 10 users
    await db.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('AdminPass123!')]
    });

    const primaryLogin = await callApi(authHandler, {
      action: 'login',
      email: 'ammahmoud@nu.edu.eg',
      password: 'AdminPass123!'
    });
    expect(primaryLogin.status).toBe(200);
    users.admins.push({ email: 'ammahmoud@nu.edu.eg', password: 'AdminPass123!', token: primaryLogin.body.session.access_token });

    const roster = [
      { group: 'admins', email: 'admin2@nu.edu.eg', role: 'admin' },
      { group: 'accountants', email: 'acc1@nu.edu.eg', role: 'accountant' },
      { group: 'accountants', email: 'acc2@nu.edu.eg', role: 'accountant' },
      { group: 'operators', email: 'op1@nu.edu.eg', role: 'operator' },
      { group: 'operators', email: 'op2@nu.edu.eg', role: 'operator' },
      { group: 'operators', email: 'op3@nu.edu.eg', role: 'operator' },
      { group: 'viewers', email: 'view1@nu.edu.eg', role: 'viewer' },
      { group: 'viewers', email: 'view2@nu.edu.eg', role: 'viewer' },
      { group: 'viewers', email: 'view3@nu.edu.eg', role: 'viewer' }
    ];

    for (const u of roster) {
      const password = `Pass_${u.role}_123!`;
      const created = await callApi(authHandler, {
        action: 'admin_create_user',
        email: u.email,
        password,
        role: u.role
      }, users.admins[0].token);
      expect(created.status).toBe(200);

      const logged = await callApi(authHandler, { action: 'login', email: u.email, password });
      expect(logged.status).toBe(200);
      users[u.group].push({ email: u.email, password, token: logged.body.session.access_token });
    }

    // Seed baseline data so concurrent viewers have real rows to query while writers mutate
    const seedRows = Array.from({ length: 40 }, (_, i) => ({
      reference_number: `SEED-${i + 1}`,
      payment_date: '2026-08-01',
      student_id: '202400001',
      item_name: 'Tuition',
      item_price: 2000,
      bank: i % 2 === 0 ? 'NUADIB64' : 'NUADCB136',
      check_column: 'Tuition',
      id_status: 'Valid',
      mapping: 'Tuition',
      is_settled: false
    }));
    const seedRes = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: seedRows
    }, users.operators[0].token);
    expect(seedRes.status).toBe(200);
  });

  afterAll(async () => {
    setDbClient(null);
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch { /* ignore */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (fs.existsSync(target)) {
        try { fs.unlinkSync(target); } catch { /* ignore */ }
      }
    }
  });

  test('10 simultaneous user workflows complete with 100% status 200 and exact final counts', async () => {
    const operatorTasks = users.operators.map(async (op, idx) => {
      const loginRes = await callApi(authHandler, { action: 'login', email: op.email, password: op.password });
      expect(loginRes.status).toBe(200);

      const batchRows = Array.from({ length: 50 }, (_, j) => ({
        reference_number: `OP${idx + 1}-TX-${j + 1}`,
        payment_date: '2026-08-15',
        student_id: `2024000${idx + 1}0`,
        item_name: 'Tuition Fee',
        item_price: 1500 + j,
        bank: 'NUADIB64',
        check_column: 'Tuition Fee',
        id_status: 'Valid',
        mapping: 'Tuition',
        is_settled: false
      }));

      const upRes = await callApi(queryHandler, {
        table: 'transactions',
        operation: 'upsert',
        onConflict: 'reference_number,item_price,check_column',
        returning: 'id',
        values: batchRows
      }, op.token);
      expect(upRes.status).toBe(200);
      expect(upRes.body.data).toHaveLength(50);

      const bulkPayload = upRes.body.data.slice(0, 10).map(r => ({
        id: r.id,
        student_id: `2024000${idx + 1}0`,
        item_name: 'Tuition Fee',
        mapping: 'Tuition',
        second_mapping: 'UG',
        id_status: 'Valid'
      }));
      const bulkRes = await callApi(rpcHandler, {
        fn: 'bulk_update_rule_fields',
        args: { p_updates: bulkPayload }
      }, op.token);
      expect(bulkRes.status).toBe(200);
      expect(bulkRes.body.data).toBe(10);
    });

    const accountantTasks = users.accountants.map(async (acc, idx) => {
      const mapRes = await callApi(queryHandler, {
        table: 'item_mappings',
        operation: 'upsert',
        onConflict: 'item_name',
        values: Array.from({ length: 5 }, (_, k) => ({
          item_name: `ACC${idx + 1}-ITEM-${k + 1}`,
          adjusted_item_name: `Adjusted ${k + 1}`,
          mapping: 'Fees',
          second_mapping: 'UG'
        }))
      }, acc.token);
      expect(mapRes.status).toBe(200);

      const fixRes = await callApi(queryHandler, {
        table: 'manual_fixes',
        operation: 'upsert',
        onConflict: 'reference_number',
        values: Array.from({ length: 5 }, (_, k) => ({
          reference_number: `ACC${idx + 1}-FIX-${k + 1}`,
          correct_id: '202400001',
          item_name: 'Tuition',
          mapping: 'Tuition'
        }))
      }, acc.token);
      expect(fixRes.status).toBe(200);

      const logRes = await callApi(queryHandler, {
        table: 'audit_logs',
        operation: 'insert',
        values: {
          action: 'Concurrent Mapping Update',
          affected_references: `ACC${idx + 1}`,
          details: { count: 5 }
        }
      }, acc.token);
      expect(logRes.status).toBe(200);
    });

    const viewerTasks = users.viewers.map(async (vw) => {
      const [pageRes, dashRes, unresRes, boundsRes, dupRes] = await Promise.all([
        callApi(queryHandler, {
          table: 'transactions',
          operation: 'select',
          count: 'exact',
          orders: [{ column: 'payment_date', ascending: false }, { column: 'id', ascending: false }],
          range: { from: 0, to: 49 }
        }, vw.token),
        callApi(rpcHandler, {
          fn: 'get_dashboard_summary',
          args: { start_date: '2026-08-01', end_date: '2026-08-31', group_col: 'date', status_filter: 'all' }
        }, vw.token),
        callApi(rpcHandler, { fn: 'get_unresolved_tx_count', args: {} }, vw.token),
        callApi(rpcHandler, {
          fn: 'get_keyset_bounds',
          args: { p_table: 'transactions', p_col: 'id', p_chunk_size: 100, p_after: null }
        }, vw.token),
        callApi(rpcHandler, { fn: 'detect_double_payments', args: { p_days_window: 3 } }, vw.token)
      ]);

      expect(pageRes.status).toBe(200);
      expect(pageRes.body.count).toBeGreaterThanOrEqual(40);
      expect(dashRes.status).toBe(200);
      expect(dashRes.body.data.kpis.total_count).toBeGreaterThanOrEqual(40);
      expect(unresRes.status).toBe(200);
      expect(boundsRes.status).toBe(200);
      expect(dupRes.status).toBe(200);
    });

    const adminTasks = users.admins.map(async (adm, idx) => {
      const periodMonth = idx === 0 ? '2020-01' : '2020-02';
      const [storageRes, lockRes, syncRes] = await Promise.all([
        callApi(rpcHandler, { fn: 'get_database_storage_stats', args: {} }, adm.token),
        callApi(rpcHandler, {
          fn: 'set_accounting_period_lock',
          args: { p_period_month: periodMonth, p_is_closed: true, p_notes: `Lock ${idx + 1}` }
        }, adm.token),
        callApi(rpcHandler, { fn: 'sync_auth_users', args: {} }, adm.token)
      ]);

      expect(storageRes.status).toBe(200);
      expect(storageRes.body.data.limit_mb).toBe(5120);
      expect(lockRes.status).toBe(200);
      expect(syncRes.status).toBe(200);
      expect(syncRes.body.data.total).toBe(10);
    });

    await Promise.all([
      ...operatorTasks,
      ...accountantTasks,
      ...viewerTasks,
      ...adminTasks
    ]);

    const txCount = await db.execute('SELECT COUNT(*) AS cnt FROM transactions');
    const mapCount = await db.execute('SELECT COUNT(*) AS cnt FROM item_mappings');
    const fixCount = await db.execute('SELECT COUNT(*) AS cnt FROM manual_fixes');
    const lockCount = await db.execute('SELECT COUNT(*) AS cnt FROM closed_periods');

    expect(Number(txCount.rows[0].cnt)).toBe(40 + 3 * 50);
    expect(Number(mapCount.rows[0].cnt)).toBe(2 * 5);
    expect(Number(fixCount.rows[0].cnt)).toBe(2 * 5);
    expect(Number(lockCount.rows[0].cnt)).toBe(2);
  });
});
