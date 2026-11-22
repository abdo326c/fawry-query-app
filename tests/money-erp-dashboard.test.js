import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { setDbClient } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import { classifyProgramStudentLevel } from '../api/_lib/rbac.js';
import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler, { EXEMPT_MAPPING_SQL, clusterDoublePaymentRows, previousPeriodRange } from '../api/rpc.js';
import { SUPABASE_EXEMPT_OR_FILTER } from '../app-utils.js';
import { isIdValidationExempt, classifyProgramLevelKeywords, getStudentProgramLevel } from '../rules.js';
import { isErpExportable, stampErpBatchSafely } from '../erp-export.js';
import {
  mergeExistingForeignMatch,
  shouldKeepExistingForeignMatch,
  scoreForeignDuplicateKeepCopy,
  isProtectedForeignRow
} from '../foreign-ui.js';
import { createEmptyFxStore, convertUsdToEgp } from '../fx-rates.js';
import { FawryProcessor } from '../csv-processor.js';
import '../settlement.js';

function createMockRes() {
  let body = '';
  return {
    statusCode: 200,
    setHeader() {},
    end(chunk) { body = chunk || ''; },
    json() { return JSON.parse(body || '{}'); }
  };
}

async function callApi(handler, body, token = null) {
  const req = { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const res = createMockRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.json() };
}

/** Minimal supabase-like client that talks to the real query handler (same payload as supabase.js). */
function makeClient(token) {
  return {
    from(table) {
      const p = { table, operation: 'select', columns: '*', filters: [], orders: [] };
      const b = {
        update(v) { p.operation = 'update'; p.values = v; return b; },
        delete() { p.operation = 'delete'; return b; },
        select(c) { if (p.operation === 'select') p.columns = c; else p.returning = c; return b; },
        in(c, v) { p.filters.push({ op: 'in', column: c, value: v }); return b; },
        is(c, v) { p.filters.push({ op: 'is', column: c, value: v }); return b; },
        or(e) { p.filters.push({ op: 'or', value: e }); return b; },
        then(resolve, reject) {
          return callApi(queryHandler, p, token)
            .then(o => (o.status === 200 ? { data: o.body.data, error: null } : { data: null, error: { message: o.body.error } }))
            .then(resolve, reject);
        }
      };
      return b;
    }
  };
}

describe('money / ERP / dashboard fixes (server)', () => {
  let db;
  let adminToken;

  beforeAll(async () => {
    db = createClient({ url: ':memory:' });
    setDbClient(db);
    const schemaSql = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql'), 'utf8');
    await db.executeMultiple(schemaSql);
    await db.execute({
      sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
      args: [crypto.randomUUID(), 'ammahmoud@nu.edu.eg', hashPassword('AdminPass123!')]
    });
    const login = await callApi(authHandler, { action: 'login', email: 'ammahmoud@nu.edu.eg', password: 'AdminPass123!' });
    adminToken = login.body.session.access_token;
  });

  beforeEach(async () => {
    setDbClient(db);
    await db.execute('DELETE FROM closed_periods');
    await db.execute('DELETE FROM transactions');
    await db.execute('DELETE FROM foreign_transactions');
  });

  const insertTx = async rows => {
    const r = await callApi(queryHandler, { table: 'transactions', operation: 'insert', values: rows }, adminToken);
    expect(r.status).toBe(200);
    const all = await db.execute('SELECT id, reference_number FROM transactions ORDER BY id');
    return Object.fromEntries(all.rows.map(x => [x.reference_number, Number(x.id)]));
  };

  test('ERP stamping only stamps unposted rows and reports the already-posted ones', async () => {
    const ids = await insertTx([
      { reference_number: 'S1', payment_date: '2026-04-01', item_price: 10, check_column: 'a' },
      { reference_number: 'S2', payment_date: '2026-04-01', item_price: 20, check_column: 'b', erp_batch_number: 'OTHER', erp_voucher: 'V9' },
      { reference_number: 'S3', payment_date: '2026-04-01', item_price: 30, check_column: 'c' }
    ]);
    const res = await stampErpBatchSafely(makeClient(adminToken), 'transactions', [ids.S1, ids.S2, ids.S3],
      { erp_batch_number: 'B1', erp_voucher: 'V1' }, { chunkSize: 2 });
    expect(res.error).toBeNull();
    expect(res.stampedKeys.sort()).toEqual([ids.S1, ids.S3].sort());
    expect(res.alreadyPostedKeys).toEqual([ids.S2]);
    const s2 = await db.execute({ sql: 'SELECT erp_batch_number, erp_voucher FROM transactions WHERE id = ?', args: [ids.S2] });
    expect(s2.rows[0].erp_batch_number).toBe('OTHER');
    expect(s2.rows[0].erp_voucher).toBe('V9');
  });

  test('reverting an ERP audit entry clears only the ids it stamped', async () => {
    const ids = await insertTx([
      { reference_number: 'R1', payment_date: '2026-04-01', item_price: 10, check_column: 'a', erp_batch_number: 'B1', erp_voucher: 'V1' },
      { reference_number: 'R2', payment_date: '2026-04-01', item_price: 20, check_column: 'b', erp_batch_number: 'B1', erp_voucher: 'V1' }
    ]);
    await db.execute({
      sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
      args: ['ammahmoud@nu.edu.eg', 'ERP References Recorded', 'B1', JSON.stringify({
        revert_data: { table_name: 'transactions_erp', operation: 'update', batch_number: 'B1', stamped_ids: [ids.R1] }
      })]
    });
    const auditId = Number((await db.execute('SELECT MAX(id) AS id FROM audit_logs')).rows[0].id);
    const out = await callApi(rpcHandler, { fn: 'revert_audit_log_entry', args: { p_audit_id: auditId } }, adminToken);
    expect(out.status).toBe(200);
    expect(out.body.data.success).toBe(true);
    expect(out.body.data.restored_count).toBe(1);
    const rows = await db.execute('SELECT reference_number, erp_batch_number FROM transactions ORDER BY reference_number');
    expect(rows.rows.map(r => [r.reference_number, r.erp_batch_number])).toEqual([['R1', null], ['R2', 'B1']]);
  });

  test('Fawry duplicate delete re-checks settled / ERP on the server', async () => {
    const ids = await insertTx([
      { reference_number: 'D1', payment_date: '2026-04-01', item_price: 10, check_column: 'a' },
      { reference_number: 'D2', payment_date: '2026-04-01', item_price: 10, check_column: 'b', is_settled: true },
      { reference_number: 'D3', payment_date: '2026-04-01', item_price: 10, check_column: 'c', erp_batch_number: 'B1' }
    ]);
    const { data, error } = await makeClient(adminToken).from('transactions').delete()
      .in('id', [ids.D1, ids.D2, ids.D3])
      .or('is_settled.is.null,is_settled.eq.false')
      .is('erp_batch_number', null)
      .select('id');
    expect(error).toBeNull();
    expect(data.map(r => r.id)).toEqual([ids.D1]);
    const left = await db.execute('SELECT reference_number FROM transactions ORDER BY reference_number');
    expect(left.rows.map(r => r.reference_number)).toEqual(['D2', 'D3']);
  });

  test('exempt rule agrees in JS (rules.js), SQL (rpc.js) and the .or() filter (app-utils.js)', async () => {
    const labels = [
      'Dip', 'Diploma', 'PG Diploma', 'Dip Marketing', 'AI Workshop 101', 'Workshops', 'Dip & Workshop',
      'Dip-Workshop', 'Professional Diploma/Online', 'Diplomacy', 'Workshop2026', 'Tuition', 'Dipping',
      'Summer workshop.', 'Executive Ed', ''
    ];
    const rows = labels.map((m, i) => ({ reference_number: `E${i}`, payment_date: '2026-04-01', item_price: 1, check_column: `c${i}`, mapping: m || null, id_status: 'Missing ID' }));
    await insertTx(rows);
    const sqlRes = await db.execute(`SELECT reference_number FROM transactions WHERE ${EXEMPT_MAPPING_SQL}`);
    const sqlSet = new Set(sqlRes.rows.map(r => r.reference_number));
    const filterRes = await callApi(queryHandler, { table: 'transactions', operation: 'select', filters: [{ op: 'or', value: SUPABASE_EXEMPT_OR_FILTER }] }, adminToken);
    expect(filterRes.status).toBe(200);
    const filterSet = new Set(filterRes.body.data.map(r => r.reference_number));
    labels.forEach((m, i) => {
      const js = isIdValidationExempt(m);
      expect([m, sqlSet.has(`E${i}`)]).toEqual([m, js]);
      expect([m, filterSet.has(`E${i}`)]).toEqual([m, js]);
    });
    expect(isIdValidationExempt('PG Diploma')).toBe(true);
    expect(isIdValidationExempt('Diplomacy')).toBe(false);
  });

  test('dashboard summary: Valid filter includes Exempt, exempt count respects filter, levels and prior period', async () => {
    await insertTx([
      { reference_number: 'K1', payment_date: '2026-04-10', item_price: 100.005, check_column: 'a', bank: 'NUADCB136', id_status: 'Valid', student_level: 'UG' },
      { reference_number: 'K2', payment_date: '2026-04-11', item_price: 50, check_column: 'b', bank: 'NUADCB136', id_status: 'Missing ID', mapping: 'PG Diploma', student_level: 'PG' },
      { reference_number: 'K3', payment_date: '2026-04-12', item_price: 25, check_column: 'c', bank: 'NUADCB136', id_status: 'Missing ID', mapping: 'Tuition' },
      { reference_number: 'K0', payment_date: '2026-03-25', item_price: 70, check_column: 'd', bank: 'NUADCB136', id_status: 'Valid' }
    ]);
    const call = status_filter => callApi(rpcHandler, { fn: 'get_dashboard_summary', args: { start_date: '2026-04-01', end_date: '2026-04-30', banks: ['NUADCB136'], status_filter } }, adminToken);
    const valid = await call('valid');
    expect(valid.body.data.kpis.total_count).toBe(2);
    expect(valid.body.data.kpis.exempt_count).toBe(1);
    const invalid = await call('invalid');
    expect(invalid.body.data.kpis.total_count).toBe(1);
    expect(invalid.body.data.kpis.exempt_count).toBe(0);
    const all = await call(undefined);
    expect(all.body.data.levels).toMatchObject({ ug_count: 1, pg_count: 1, pg_total: 50, unknown_count: 1 });
    expect(all.body.data.prev_period).toMatchObject({ start_date: '2026-03-02', end_date: '2026-03-31', total_egp: 70 });
    for (const r of all.body.data.pivot) expect(Math.round(r.total_amount * 100) / 100).toBe(r.total_amount);
    expect(previousPeriodRange('2026-04-01', '2026-04-30')).toEqual({ start_date: '2026-03-02', end_date: '2026-03-31' });
  });

  test('double payments compare consecutive dates and survive a NaN window', async () => {
    const rows = [
      { payment_date: '2026-01-01', reference_number: 'A' },
      { payment_date: '2026-03-01', reference_number: 'B' },
      { payment_date: '2026-03-02', reference_number: 'C' }
    ];
    const clusters = clusterDoublePaymentRows(rows, 3);
    expect(clusters.map(c => c.map(r => r.reference_number))).toEqual([['A'], ['B', 'C']]);
    await insertTx([
      { reference_number: 'P1', payment_date: '2026-01-01', student_id: '202400001', item_name: 'Tuition', item_price: 100, check_column: 'a', id_status: 'Valid', mapping: 'Tuition' },
      { reference_number: 'P2', payment_date: '2026-03-01', student_id: '202400001', item_name: 'Tuition', item_price: 100, check_column: 'b', id_status: 'Valid', mapping: 'Tuition' },
      { reference_number: 'P3', payment_date: '2026-03-02', student_id: '202400001', item_name: 'Tuition', item_price: 100, check_column: 'c', id_status: 'Valid', mapping: 'Tuition' }
    ]);
    const out = await callApi(rpcHandler, { fn: 'detect_double_payments', args: { p_days_window: 'abc' } }, adminToken);
    expect(out.status).toBe(200);
    expect(out.body.data.length).toBe(1);
    expect(out.body.data[0].reference_numbers.sort()).toEqual(['P2', 'P3']);
  });
});

describe('money / ERP fixes (client helpers)', () => {
  test('ERP "Ready" uses the same predicate as Record / Export (Exempt included)', () => {
    expect(isErpExportable({ id_status: 'Missing ID', mapping: 'Workshop' })).toBe(true);
    expect(isErpExportable({ id_status: 'Valid' })).toBe(true);
    expect(isErpExportable({ id_status: null })).toBe(true);
    expect(isErpExportable({ id_status: 'Missing ID', mapping: 'Tuition' })).toBe(false);
  });

  test('BM re-import keeps manual / Valid / ERP-posted student matches', () => {
    const incoming = { reference_number: 'X', description: 'new', amount: 5, student_id: null, id_status: 'Missing ID', match_source: 'unmatched', student_level: null };
    const manual = { student_id: '231000111', id_status: 'Valid', match_source: 'manual', student_level: 'UG', matched_student_name: 'A' };
    expect(mergeExistingForeignMatch(incoming, manual)).toMatchObject({ description: 'new', student_id: '231000111', match_source: 'manual' });
    expect(shouldKeepExistingForeignMatch({ erp_batch_number: 'B1', id_status: 'Missing ID' }, { id_status: 'Valid' })).toBe(true);
    expect(shouldKeepExistingForeignMatch({ id_status: 'Valid', match_source: 'name_match' }, { id_status: 'Missing ID' })).toBe(true);
    expect(shouldKeepExistingForeignMatch({ id_status: 'Missing ID', match_source: 'unmatched' }, { id_status: 'Valid' })).toBe(false);
    expect(mergeExistingForeignMatch(incoming, null)).toBe(incoming);
  });

  test('BM duplicate cleanup keeps the ERP-posted copy and never deletes protected rows', () => {
    expect(scoreForeignDuplicateKeepCopy({ erp_batch_number: 'B1' })).toBeGreaterThan(scoreForeignDuplicateKeepCopy({ id_status: 'Valid', match_source: 'manual' }));
    expect(isProtectedForeignRow({ erp_batch_number: 'B1' }, () => false)).toBe(true);
    expect(isProtectedForeignRow({ value_date: '2026-01-05' }, d => d.startsWith('2026-01'))).toBe(true);
    expect(isProtectedForeignRow({ value_date: '2026-02-05' }, d => d.startsWith('2026-01'))).toBe(false);
  });

  test('no FX rate means rate 0 / missing, never a hard-coded rate', () => {
    expect(convertUsdToEgp(100, '2026-01-01', createEmptyFxStore())).toMatchObject({ rate: 0, egpAmount: 0, missing: true });
  });

  test('UG/PG: server and UI use the same keyword rule; unknown programs are not guessed server-side', () => {
    const programs = ['Undergraduate / Bachelor of Science', 'Graduate / Master / MBA', 'MBA Executive', 'PG Diploma in Data', '(UG) Computer Engineering', 'Computer Engineering', 'PhD in Engineering'];
    for (const p of programs) expect(classifyProgramStudentLevel(p) || '').toBe(classifyProgramLevelKeywords(p));
    expect(classifyProgramStudentLevel('Computer Engineering')).toBeNull();
    expect(getStudentProgramLevel({ program: 'Computer Engineering', student_id: '202400001' })).toBe('UG');
  });

  test('settlement Matched threshold is 0.01 and "(1,500.00)" parses as negative', () => {
    const SP = window.SettlementProcessor;
    expect(SP.isAmountMatched(0)).toBe(true);
    expect(SP.isAmountMatched(0.05)).toBe(false);
    const fp = Object.create(FawryProcessor.prototype);
    expect(fp.parseAmount('(1,500.00)')).toBe(-1500);
    expect(fp.parseAmount('EGP 1,500.00')).toBe(1500);
    expect(fp.parseAmount('-25.5')).toBe(-25.5);
  });
});
