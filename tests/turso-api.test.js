import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler from '../api/rpc.js';
import { supabase } from '../supabase.js';
import { SUPABASE_EXEMPT_OR_FILTER } from '../app-utils.js';
import { fetchAll } from '../rules.js';

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

describe('Turso / Vercel API Backend (Auth, RBAC Query, RPCs)', () => {
  let db;
  let adminToken;
  let accountantToken;
  let operatorToken;
  let viewerToken;
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    db = createClient({ url: ':memory:' });
    setDbClient(db);
    const schemaPath = path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await db.executeMultiple(schemaSql);

    // Seed admin user
    await db.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('AdminPass123!')]
    });

    const loginRes = await callApi(authHandler, {
      action: 'login',
      email: 'ammahmoud@nu.edu.eg',
      password: 'AdminPass123!'
    });
    expect(loginRes.status).toBe(200);
    adminToken = loginRes.body.session.access_token;

    await callApi(authHandler, {
      action: 'admin_create_user',
      email: 'acc@nu.edu.eg',
      password: 'AccPassword123!',
      role: 'accountant'
    }, adminToken);

    // Admin creates an operator and a viewer
    await callApi(authHandler, {
      action: 'admin_create_user',
      email: 'op@nu.edu.eg',
      password: 'OpPassword123!',
      role: 'operator'
    }, adminToken);

    await callApi(authHandler, {
      action: 'admin_create_user',
      email: 'view@nu.edu.eg',
      password: 'ViewPassword123!',
      role: 'viewer'
    }, adminToken);

    accountantToken = (await callApi(authHandler, {
      action: 'login',
      email: 'acc@nu.edu.eg',
      password: 'AccPassword123!'
    })).body.session.access_token;

    operatorToken = (await callApi(authHandler, {
      action: 'login',
      email: 'op@nu.edu.eg',
      password: 'OpPassword123!'
    })).body.session.access_token;

    viewerToken = (await callApi(authHandler, {
      action: 'login',
      email: 'view@nu.edu.eg',
      password: 'ViewPassword123!'
    })).body.session.access_token;
  });

  beforeEach(async () => {
    // Test-only reset: the append-only guards (audit log, archive) are dropped for the wipe and
    // re-created from the schema afterwards. closed_periods is emptied first so the period-lock
    // triggers don't block the deletes.
    await db.execute('DELETE FROM closed_periods');
    await db.execute('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete');
    await db.execute('DROP TRIGGER IF EXISTS trg_tx_archive_no_delete');
    await db.execute('DELETE FROM transactions');
    await db.execute('DELETE FROM transactions_archive');
    await db.execute('DELETE FROM foreign_transactions');
    await db.execute('DELETE FROM closed_periods');
    await db.execute('DELETE FROM student_master');
    await db.execute('DELETE FROM item_mappings');
    await db.execute('DELETE FROM manual_fixes');
    await db.execute('DELETE FROM payment_links');
    await db.execute('DELETE FROM exchange_rates');
    await db.execute('DELETE FROM import_batches');
    await db.execute('DELETE FROM audit_logs');
    await db.executeMultiple(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8'));
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  test('auth rejects bad password and verifies valid session', async () => {
    const bad = await callApi(authHandler, {
      action: 'login',
      email: 'ammahmoud@nu.edu.eg',
      password: 'wrong'
    });
    expect(bad.status).toBe(401);

    const sess = await callApi(authHandler, { action: 'session' }, viewerToken);
    expect(sess.status).toBe(200);
    expect(sess.body.session.user.email).toBe('view@nu.edu.eg');
    expect(sess.body.session.user.role).toBe('viewer');
  });

  test('RBAC blocks viewer writes, allows operator tx upsert, blocks operator delete', async () => {
    const viewerInsert = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [{ reference_number: 'REF1', item_price: 100, check_column: 'Tuition' }]
    }, viewerToken);
    expect(viewerInsert.status).toBe(403);

    const opUpsert = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'upsert',
      onConflict: 'reference_number,item_price,check_column',
      returning: '*',
      values: [
        {
          reference_number: 'REF1',
          payment_date: '2026-01-15',
          student_id: '202400001',
          item_name: 'Tuition Fees',
          item_price: 5000,
          bank: 'NUADIB64',
          check_column: 'Tuition Fees',
          id_status: 'Valid',
          mapping: 'Tuition',
          is_settled: false
        }
      ]
    }, operatorToken);
    expect(opUpsert.status).toBe(200);
    expect(opUpsert.body.data).toHaveLength(1);
    expect(opUpsert.body.data[0].student_level).toBe('UG');
    expect(opUpsert.body.data[0].is_settled).toBe(false);

    const opDelete = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'delete',
      filters: [{ op: 'eq', column: 'reference_number', value: 'REF1' }]
    }, operatorToken);
    expect(opDelete.status).toBe(403);

    const adminDelete = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'delete',
      filters: [{ op: 'eq', column: 'reference_number', value: 'REF1' }]
    }, adminToken);
    expect(adminDelete.status).toBe(200);
  });

  test('accounting period lock prevents mutations in closed months', async () => {
    const lockRes = await callApi(rpcHandler, {
      fn: 'set_accounting_period_lock',
      args: { p_period_month: '2026-02', p_is_closed: true, p_notes: 'Closed Feb' }
    }, adminToken);
    expect(lockRes.status).toBe(200);

    const blockedInsert = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [{ reference_number: 'REF-FEB', payment_date: '2026-02-10', item_price: 100, check_column: 'Fees' }]
    }, operatorToken);
    expect(blockedInsert.status).toBe(403);
    expect(blockedInsert.body.error).toMatch(/closed/i);
  });

  test('dashboard summary, distinct values, double payment, and storage stats RPCs work', async () => {
    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [
        {
          reference_number: 'R1',
          payment_date: '2026-03-01',
          student_id: '202400001',
          item_name: 'Bus Fee',
          item_price: 1000,
          bank: 'NUADIB64',
          check_column: 'Bus Fee',
          id_status: 'Valid',
          mapping: 'Transport',
          is_settled: true,
          erp_batch_number: 'ERP-1'
        },
        {
          reference_number: 'R2',
          payment_date: '2026-03-02',
          student_id: '202400001',
          item_name: 'Bus Fee',
          item_price: 1000,
          bank: 'NUADCB136',
          check_column: 'Bus Fee',
          id_status: 'Invalid',
          mapping: null,
          is_settled: false
        }
      ]
    }, operatorToken);

    const summary = await callApi(rpcHandler, {
      fn: 'get_dashboard_summary',
      args: { start_date: '2026-03-01', end_date: '2026-03-31', group_col: 'date', status_filter: 'all' }
    }, viewerToken);
    expect(summary.status).toBe(200);
    expect(summary.body.data.kpis.total_count).toBe(2);
    expect(summary.body.data.kpis.valid_count).toBe(1);
    expect(summary.body.data.kpis.settled_count).toBe(1);
    expect(summary.body.data.kpis.unmapped_count).toBe(1);

    const distinctBanks = await callApi(rpcHandler, {
      fn: 'get_distinct_transaction_values',
      args: { col_name: 'bank' }
    }, viewerToken);
    expect(distinctBanks.status).toBe(200);
    expect(distinctBanks.body.data.map(r => r.val)).toEqual(['NUADCB136', 'NUADIB64']);

    const storage = await callApi(rpcHandler, {
      fn: 'get_database_storage_stats',
      args: {}
    }, adminToken);
    expect(storage.status).toBe(200);
    expect(storage.body.data.limit_mb).toBe(5120);
  });

  test('archive_settled_transactions enforces 90-day guard and archives old settled rows', async () => {
    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [
        {
          reference_number: 'OLD1',
          payment_date: '2025-01-10',
          item_price: 2500,
          check_column: 'Tuition',
          is_settled: true,
          erp_batch_number: 'B-OLD'
        }
      ]
    }, operatorToken);

    const dry = await callApi(rpcHandler, {
      fn: 'archive_settled_transactions',
      args: { p_before_date: '2025-06-01', p_dry_run: true }
    }, adminToken);
    expect(dry.status).toBe(200);
    expect(dry.body.data.eligible_count).toBe(1);

    const live = await callApi(rpcHandler, {
      fn: 'archive_settled_transactions',
      args: { p_before_date: '2025-06-01', p_dry_run: false }
    }, adminToken);
    expect(live.status).toBe(200);
    expect(live.body.data.archived_count).toBe(1);

    const txLeft = await db.execute('SELECT COUNT(*) AS cnt FROM transactions');
    const archCount = await db.execute('SELECT COUNT(*) AS cnt FROM transactions_archive');
    expect(Number(txLeft.rows[0].cnt)).toBe(0);
    expect(Number(archCount.rows[0].cnt)).toBe(1);
  });

  test('nested .or(and(...)) filters and SUPABASE_EXEMPT_OR_FILTER with * wildcards work', async () => {
    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [
        { reference_number: 'TX-MISSING', payment_date: '2026-04-01', item_price: 100, check_column: 'A', id_status: 'Missing ID', mapping: 'Tuition', second_mapping: null },
        { reference_number: 'TX-DIP', payment_date: '2026-04-01', item_price: 200, check_column: 'B', id_status: 'Missing ID', mapping: 'Dip Marketing', second_mapping: null },
        { reference_number: 'TX-WORKSHOP', payment_date: '2026-04-01', item_price: 300, check_column: 'C', id_status: 'Missing ID', mapping: null, second_mapping: 'AI Workshop 101' },
        { reference_number: 'TX-EXEMPT', payment_date: '2026-04-01', item_price: 400, check_column: 'D', id_status: 'Exempt', mapping: 'Other', second_mapping: null }
      ]
    }, operatorToken);

    const nonExemptRes = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      filters: [
        { op: 'ilike', column: 'id_status', value: '%Missing ID%' },
        { op: 'or', value: 'mapping.is.null,and(mapping.not.ilike.Dip,mapping.not.ilike.Dip *,mapping.not.ilike.Diploma*,mapping.not.ilike.*Workshop*)' },
        { op: 'or', value: 'second_mapping.is.null,and(second_mapping.not.ilike.Dip,second_mapping.not.ilike.Dip *,second_mapping.not.ilike.Diploma*,second_mapping.not.ilike.*Workshop*)' }
      ]
    }, viewerToken);
    expect(nonExemptRes.status).toBe(200);
    expect(nonExemptRes.body.data.map(r => r.reference_number)).toEqual(['TX-MISSING']);

    const exemptRes = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      orders: [{ column: 'reference_number', ascending: true }],
      filters: [{ op: 'or', value: SUPABASE_EXEMPT_OR_FILTER }]
    }, viewerToken);
    expect(exemptRes.status).toBe(200);
    expect(exemptRes.body.data.map(r => r.reference_number)).toEqual(['TX-DIP', 'TX-EXEMPT', 'TX-WORKSHOP']);
  });

  test('import_batches auto-UUID, default upsert onConflict, and student_master level propagation', async () => {
    const batchRes = await callApi(queryHandler, {
      table: 'import_batches',
      operation: 'insert',
      returning: '*',
      values: { user_email: 'op@nu.edu.eg', file_name: 'fawry.xlsx', status: 'completed' }
    }, operatorToken);
    expect(batchRes.status).toBe(200);
    expect(batchRes.body.data[0].id).toMatch(/^[0-9a-f-]{36}$/);

    // Upserts without explicit onConflict fall back to TABLE_DEFAULT_CONFLICT
    const fx1 = await callApi(queryHandler, {
      table: 'exchange_rates',
      operation: 'upsert',
      values: [{ rate_date: '2026-04-01', currency_pair: 'USD_EGP', rate: 50.25 }]
    }, operatorToken);
    expect(fx1.status).toBe(200);
    const fx2 = await callApi(queryHandler, {
      table: 'exchange_rates',
      operation: 'upsert',
      returning: '*',
      values: [{ rate_date: '2026-04-01', currency_pair: 'USD_EGP', rate: 50.75 }]
    }, operatorToken);
    expect(fx2.status).toBe(200);
    expect(fx2.body.data[0].rate).toBe(50.75);

    const pl1 = await callApi(queryHandler, {
      table: 'payment_links',
      operation: 'upsert',
      values: [{ name: 'Link A', invoice_number: 'INV-1', invoice_link: 'https://x/1', amount: 100 }]
    }, operatorToken);
    expect(pl1.status).toBe(200);
    const pl2 = await callApi(queryHandler, {
      table: 'payment_links',
      operation: 'upsert',
      returning: '*',
      values: [{ name: 'Link A Updated', invoice_number: 'INV-1', invoice_link: 'https://x/1', amount: 250 }]
    }, operatorToken);
    expect(pl2.status).toBe(200);
    expect(pl2.body.data[0].amount).toBe(250);

    // Student level propagation on student_master insert/update
    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [{ reference_number: 'TX-LVL', payment_date: '2026-04-01', student_id: '202500123', item_price: 500, check_column: 'Reg' }]
    }, operatorToken);

    await callApi(queryHandler, {
      table: 'student_master',
      operation: 'upsert',
      values: [{ student_id: '202500123', full_name: 'Omar Ali', program: 'MBA Executive' }]
    }, operatorToken);

    const txAfter = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      filters: [{ op: 'eq', column: 'reference_number', value: 'TX-LVL' }]
    }, viewerToken);
    expect(txAfter.body.data[0].student_level).toBe('PG');
  });

  test('detect_double_payments returns enriched Tuition clusters with student_master join', async () => {
    await callApi(queryHandler, {
      table: 'student_master',
      operation: 'upsert',
      values: [{ student_id: '202400001', full_name: 'Salma Hassan', college: 'EAS', program: 'Computer Engineering' }]
    }, operatorToken);

    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [
        {
          reference_number: 'DUP-1',
          payment_date: '2026-05-01',
          student_id: '202400001',
          item_name: 'Spring Tuition',
          item_price: 15000,
          bank: 'NUADIB64',
          check_column: 'Spring Tuition',
          id_status: 'Valid',
          mapping: 'Tuition',
          is_settled: true
        },
        {
          reference_number: 'DUP-2',
          payment_date: '2026-05-02',
          student_id: '202400001',
          item_name: 'Spring Tuition',
          item_price: 15000,
          bank: 'NUADCB136',
          check_column: 'Spring Tuition',
          id_status: 'Valid',
          mapping: 'Tuition',
          is_settled: false
        },
        {
          reference_number: 'NON-TUITION',
          payment_date: '2026-05-01',
          student_id: '202400001',
          item_name: 'Bus',
          item_price: 1000,
          bank: 'NUADIB64',
          check_column: 'Bus',
          id_status: 'Valid',
          mapping: 'Transport',
          is_settled: false
        }
      ]
    }, operatorToken);

    const dupes = await callApi(rpcHandler, {
      fn: 'detect_double_payments',
      args: { p_days_window: 3 }
    }, viewerToken);
    expect(dupes.status).toBe(200);
    expect(dupes.body.data).toHaveLength(1);
    expect(dupes.body.data[0]).toMatchObject({
      student_id: '202400001',
      student_name: 'Salma Hassan',
      faculty: 'EAS',
      item_name: 'Spring Tuition',
      mapping: 'Tuition',
      item_price: 15000,
      occurrences: 2,
      total_amount: 30000,
      first_date: '2026-05-01',
      last_date: '2026-05-02'
    });
    expect(dupes.body.data[0].reference_numbers).toEqual(['DUP-2', 'DUP-1']);
    expect(dupes.body.data[0].settled_flags).toEqual([false, true]);
  });

  test('hygiene audit & rollback, plus revert_audit_log_entry for mappings, fixes, and ERP', async () => {
    // Seed duplicate manual_fixes directly to verify hygiene audit clean + rollback
    await db.execute({
      sql: "INSERT INTO item_mappings (item_name, adjusted_item_name, mapping) VALUES ('Old Item', 'Old Item', 'Tuition')"
    });
    // Temporarily insert duplicate case variant for conflicting_case_mappings
    await db.execute({
      sql: "INSERT INTO item_mappings (item_name, adjusted_item_name, mapping) VALUES ('old item', 'Old Item Alt', 'Fees')"
    });

    const hyg = await callApi(rpcHandler, {
      fn: 'run_database_hygiene_audit',
      args: { p_clean: true }
    }, adminToken);
    expect(hyg.status).toBe(200);
    expect(hyg.body.data.conflicting_case_mappings).toBe(1);
    expect(hyg.body.data.audit_id).toBeTypeOf('number');

    const rb1 = await callApi(rpcHandler, {
      fn: 'rollback_database_hygiene_audit',
      args: { p_audit_id: hyg.body.data.audit_id }
    }, adminToken);
    expect(rb1.status).toBe(200);
    expect(rb1.body.data.success).toBe(true);

    const rb2 = await callApi(rpcHandler, {
      fn: 'rollback_database_hygiene_audit',
      args: { p_audit_id: hyg.body.data.audit_id }
    }, adminToken);
    expect(rb2.status).toBe(400);

    // Accountant-authored revert_data on item_mappings delete
    const logMap = await callApi(queryHandler, {
      table: 'audit_logs',
      operation: 'insert',
      returning: '*',
      values: {
        action: 'Item Mapping Deleted',
        affected_references: 'Deleted Map',
        details: {
          revert_data: {
            table_name: 'item_mappings',
            operation: 'delete',
            previous_rows: [{ item_name: 'Deleted Map', adjusted_item_name: 'Adj', mapping: 'Tuition', second_mapping: 'UG' }]
          }
        }
      }
    }, accountantToken);
    expect(logMap.status).toBe(200);

    const revMap = await callApi(rpcHandler, {
      fn: 'revert_audit_log_entry',
      args: { p_audit_id: logMap.body.data[0].id }
    }, adminToken);
    expect(revMap.status).toBe(200);
    expect(revMap.body.data.success).toBe(true);
    expect(revMap.body.data.restored_count).toBe(1);

    const restoredMap = await callApi(queryHandler, {
      table: 'item_mappings',
      operation: 'select',
      filters: [{ op: 'eq', column: 'item_name', value: 'Deleted Map' }]
    }, viewerToken);
    expect(restoredMap.body.data).toHaveLength(1);

    // ERP batch revert
    await callApi(queryHandler, {
      table: 'transactions',
      operation: 'insert',
      values: [{ reference_number: 'ERP-TX-1', payment_date: '2026-06-01', item_price: 900, check_column: 'Lab', erp_batch_number: 'B-99', erp_voucher: 'V-1' }]
    }, operatorToken);

    const logErp = await callApi(queryHandler, {
      table: 'audit_logs',
      operation: 'insert',
      returning: '*',
      values: {
        action: 'ERP Export Recorded',
        affected_references: 'B-99',
        details: {
          revert_data: {
            table_name: 'transactions_erp',
            operation: 'update',
            batch_number: 'B-99',
            previous_rows: [{ reference_number: 'ERP-TX-1', erp_batch_number: null, erp_voucher: null }]
          }
        }
      }
    }, accountantToken);
    expect(logErp.status).toBe(200);

    const revErp = await callApi(rpcHandler, {
      fn: 'revert_audit_log_entry',
      args: { p_audit_id: logErp.body.data[0].id }
    }, adminToken);
    expect(revErp.status).toBe(200);
    expect(revErp.body.data.success).toBe(true);

    const txCleared = await callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      filters: [{ op: 'eq', column: 'reference_number', value: 'ERP-TX-1' }]
    }, viewerToken);
    expect(txCleared.body.data[0].erp_batch_number).toBeNull();
  });

  test('sync_auth_users returns { inserted, total } and admin user controls block self-targeting', async () => {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'newstaff@nu.edu.eg', hashPassword('Pass12345!')]
    });

    const syncRes = await callApi(rpcHandler, { fn: 'sync_auth_users', args: {} }, adminToken);
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.data.inserted).toBe(1);
    expect(syncRes.body.data.total).toBeGreaterThanOrEqual(5);

    // Secondary admin cannot deactivate or delete themselves
    await callApi(authHandler, {
      action: 'admin_create_user',
      email: 'admin2@nu.edu.eg',
      password: 'Admin2Pass123!',
      role: 'admin'
    }, adminToken);
    const admin2Token = (await callApi(authHandler, {
      action: 'login',
      email: 'admin2@nu.edu.eg',
      password: 'Admin2Pass123!'
    })).body.session.access_token;

    const selfDeactivate = await callApi(rpcHandler, {
      fn: 'admin_set_user_active',
      args: { target_email: 'admin2@nu.edu.eg', active: false }
    }, admin2Token);
    expect(selfDeactivate.status).toBe(400);

    const selfDelete = await callApi(rpcHandler, {
      fn: 'admin_delete_user',
      args: { target_email: 'admin2@nu.edu.eg' }
    }, admin2Token);
    expect(selfDelete.status).toBe(400);
  });

  test('end-to-end supabase.js client + fetchAll + get_keyset_bounds through mock fetch', async () => {
    globalThis.fetch = async (url, init) => {
      const parsedBody = JSON.parse(init?.body || '{}');
      const headers = init?.headers || {};
      const token = headers.Authorization ? headers.Authorization.replace(/^Bearer\s+/i, '') : null;
      let handler = null;
      if (String(url).endsWith('/api/auth')) handler = authHandler;
      else if (String(url).endsWith('/api/query')) handler = queryHandler;
      else if (String(url).endsWith('/api/rpc')) handler = rpcHandler;
      const out = await callApi(handler, parsedBody, token);
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const signIn = await supabase.auth.signInWithPassword({
      email: 'op@nu.edu.eg',
      password: 'OpPassword123!'
    });
    expect(signIn.error).toBeNull();
    expect(signIn.data.session.user.role).toBe('operator');

    // Insert 250 transactions to test keyset bounds + fetchAll end-to-end
    const rows = Array.from({ length: 250 }, (_, idx) => ({
      reference_number: `KB-${idx + 1}`,
      payment_date: '2026-07-01',
      student_id: '202400001',
      item_price: 100 + idx,
      check_column: 'Tuition',
      id_status: 'Valid'
    }));
    const ins = await supabase.from('transactions').insert(rows);
    expect(ins.error).toBeNull();

    // Call get_keyset_bounds directly and verify chunk_idx, min_val, max_val
    const bounds = await supabase.rpc('get_keyset_bounds', {
      p_table: 'transactions',
      p_col: 'id',
      p_chunk_size: 100,
      p_after: null
    });
    expect(bounds.error).toBeNull();
    expect(bounds.data).toHaveLength(3);
    expect(bounds.data[0].chunk_idx).toBe(0);

    // Fetch all rows through rules.js fetchAll with pageSize = 100
    const fetched = await fetchAll('transactions', 'id,reference_number', null, 'id', { pageSize: 100 });
    expect(fetched).toHaveLength(250);
    expect(fetched[0].reference_number).toBe('KB-1');
    expect(fetched[249].reference_number).toBe('KB-250');

    await supabase.auth.signOut();
    const afterOut = await supabase.auth.getSession();
    expect(afterOut.data.session).toBeNull();
  });

  test('supabase.auth adminCreateUser, adminResetPassword, and changePassword work end-to-end', async () => {
    globalThis.fetch = async (url, init) => {
      const parsedBody = JSON.parse(init?.body || '{}');
      const headers = init?.headers || {};
      const token = headers.Authorization ? headers.Authorization.replace(/^Bearer\s+/i, '') : null;
      let handler = null;
      if (String(url).endsWith('/api/auth')) handler = authHandler;
      else if (String(url).endsWith('/api/query')) handler = queryHandler;
      else if (String(url).endsWith('/api/rpc')) handler = rpcHandler;
      const out = await callApi(handler, parsedBody, token);
      return new Response(JSON.stringify(out.body), {
        status: out.status,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    // Sign in as admin and create a colleague account
    const adminSignIn = await supabase.auth.signInWithPassword({
      email: 'ammahmoud@nu.edu.eg',
      password: 'AdminPass123!'
    });
    expect(adminSignIn.error).toBeNull();

    const createRes = await supabase.auth.adminCreateUser({
      email: 'colleague@nu.edu.eg',
      password: 'InitPassword1!',
      role: 'accountant'
    });
    expect(createRes.error).toBeNull();

    // Admin resets password for that colleague
    const resetRes = await supabase.auth.adminResetPassword({
      email: 'colleague@nu.edu.eg',
      newPassword: 'ResetPassword2!'
    });
    expect(resetRes.error).toBeNull();

    // Colleague signs in with reset password and changes their own password
    await supabase.auth.signOut();
    const colSignIn = await supabase.auth.signInWithPassword({
      email: 'colleague@nu.edu.eg',
      password: 'ResetPassword2!'
    });
    expect(colSignIn.error).toBeNull();
    expect(colSignIn.data.session.user.role).toBe('accountant');

    const chRes = await supabase.auth.changePassword({
      currentPassword: 'ResetPassword2!',
      newPassword: 'SelfPassword3!'
    });
    expect(chRes.error).toBeNull();

    await supabase.auth.signOut();
    const finalSignIn = await supabase.auth.signInWithPassword({
      email: 'colleague@nu.edu.eg',
      password: 'SelfPassword3!'
    });
    expect(finalSignIn.error).toBeNull();
  });

  test('verifies legacy Supabase bcrypt hashes and auto-upgrades active users to scrypt', async () => {
    const legacyHash = bcrypt.hashSync('LegacySecret99!', 4);

    await db.batch([
      {
        sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
        args: ['legacy-active-1', 'legacy-active@nu.edu.eg', legacyHash]
      },
      {
        sql: 'INSERT INTO user_roles (email, role, is_active) VALUES (?, ?, ?)',
        args: ['legacy-active@nu.edu.eg', 'accountant', 1]
      },
      {
        sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
        args: ['legacy-inactive-1', 'legacy-inactive@nu.edu.eg', legacyHash]
      },
      {
        sql: 'INSERT INTO user_roles (email, role, is_active) VALUES (?, ?, ?)',
        args: ['legacy-inactive@nu.edu.eg', 'operator', 0]
      }
    ], 'write');

    // Wrong password returns 401
    const badLogin = await callApi(authHandler, {
      action: 'login',
      email: 'legacy-active@nu.edu.eg',
      password: 'WrongPassword!'
    });
    expect(badLogin.status).toBe(401);

    // Active user logs in with legacy password -> 200 and upgrades to scrypt
    const goodLogin = await callApi(authHandler, {
      action: 'login',
      email: 'legacy-active@nu.edu.eg',
      password: 'LegacySecret99!'
    });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body.session.user.role).toBe('accountant');

    const upgradedRow = await db.execute({
      sql: 'SELECT password_hash FROM app_users WHERE email = ?',
      args: ['legacy-active@nu.edu.eg']
    });
    expect(String(upgradedRow.rows[0].password_hash).startsWith('scrypt:')).toBe(true);

    // Active user can sign in again using the upgraded scrypt hash
    const secondLogin = await callApi(authHandler, {
      action: 'login',
      email: 'legacy-active@nu.edu.eg',
      password: 'LegacySecret99!'
    });
    expect(secondLogin.status).toBe(200);

    // Deactivated user returns 403 and does NOT upgrade stored hash
    const inactiveLogin = await callApi(authHandler, {
      action: 'login',
      email: 'legacy-inactive@nu.edu.eg',
      password: 'LegacySecret99!'
    });
    expect(inactiveLogin.status).toBe(403);

    const inactiveRow = await db.execute({
      sql: 'SELECT password_hash FROM app_users WHERE email = ?',
      args: ['legacy-inactive@nu.edu.eg']
    });
    expect(inactiveRow.rows[0].password_hash).toBe(legacyHash);
  });
});
