// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@libsql/client';
import {
  BACKUP_TABLES,
  EXCLUDED_TABLES,
  createLocalBackup,
  readZip,
  writeZip,
  applyDriveRetention,
  uploadFileToDriveRest,
  parseRetention
} from '../scripts/backup_to_drive.js';
import { restoreBackup, loadBackup } from '../scripts/restore_from_backup.mjs';
import { decideFxRun, buildFxUpsertSql, runFxUpdate } from '../scripts/update_fx_rate.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const schemaSql = fs.readFileSync(path.join(rootDir, 'turso', 'schema.sql'), 'utf8');
const quiet = () => {};

let tmpDir;
const clients = [];

async function makeDb(name) {
  const file = path.join(tmpDir, `${name}.db`);
  const db = createClient({ url: pathToFileURL(file).href });
  clients.push(db);
  await db.executeMultiple(schemaSql);
  return db;
}

async function seedSource(db) {
  const stmts = [
    ["INSERT INTO app_users (id, email, password_hash, last_sign_in_at) VALUES ('u-admin', 'ammahmoud@nu.edu.eg', 'scrypt$abc', '2026-11-01 10:00:00')", []],
    ["INSERT INTO app_users (id, email, password_hash) VALUES ('u-acc', 'acc@nu.edu.eg', 'scrypt$def')", []],
    ["INSERT INTO user_roles (email, role, is_active, updated_by) VALUES ('acc@nu.edu.eg', 'accountant', 1, 'admin')", []],
    ["INSERT INTO import_batches (id, user_email, file_name, status, details) VALUES ('b1', 'acc@nu.edu.eg', 'f.csv', 'done', '{\"rows\":3}')", []],
    ["INSERT INTO item_mappings (item_name, adjusted_item_name, mapping, second_mapping) VALUES ('Tuition Fee', 'Tuition', 'Tuition', 'UG')", []],
    ["INSERT INTO student_master (student_id, full_name, email) VALUES ('231000001', 'Student One', 's1@nu.edu.eg'), ('231000002', 'Student Two', NULL)", []],
    ["INSERT INTO links (invoice_number, payment_reference_number, paid_amount) VALUES ('INV1', 'REF-L1', 100.5)", []],
    ["INSERT INTO payment_links (id, name, amount, invoice_number, invoice_link) VALUES ('pl1', 'Fees', 1000, 'INV1', 'https://example.invalid/pay')", []],
    ["INSERT INTO exchange_rates (rate_date, currency_pair, rate, source) VALUES ('2026-11-01', 'USD_EGP', 48.25, 'manual'), ('2026-11-02', 'USD_EGP', 48.3, 'auto')", []],
    ["INSERT INTO settlement_batches (batch_label, summary_data) VALUES ('Run 1', '{\"ok\":true}')", []],
    ["INSERT INTO transactions (reference_number, payment_date, student_id, item_name, item_price, check_column, batch_id, is_settled, erp_batch_number) VALUES ('R1', '2026-09-10', '231000001', 'Tuition Fee', 5000, 'c1', 'b1', 1, 'ERP1')", []],
    ["INSERT INTO transactions (reference_number, payment_date, student_id, item_name, item_price, check_column, batch_id) VALUES ('R2', '2026-10-05', '231000002', 'Tuition Fee', 2500.75, 'c2', 'b1')", []],
    ["INSERT INTO transactions (reference_number, payment_date, item_name, item_price, check_column) VALUES ('R3', '2026-11-05', 'Bus', 300, 'c3')", []],
    // archived rows keep their transaction id; id 50 is above every live transaction id
    ["INSERT INTO transactions_archive (id, reference_number, payment_date, item_price, check_column, is_settled, archived_by) VALUES (50, 'RA', '2025-01-10', 900, 'ca', 1, 'admin')", []],
    ["INSERT INTO foreign_transactions (reference_number, value_date, amount, student_id) VALUES ('FX1', '2026-09-15', 120.5, '231000001')", []],
    ["INSERT INTO manual_fixes (reference_number, correct_id) VALUES ('R1', '231000001')", []],
    ["INSERT INTO audit_logs (user_email, action, details) VALUES ('acc@nu.edu.eg', 'IMPORT', '{\"rows\":3,\"is_reverted\":false}')", []],
    // close September last, so the inserts above were allowed
    ["INSERT INTO closed_periods (period_month, is_closed, closed_by) VALUES ('2026-09', 1, 'admin')", []]
  ];
  for (const [sql, args] of stmts) await db.execute({ sql, args });
  // Push the transactions AUTOINCREMENT counter past the live ids (a deleted row).
  await db.execute("INSERT INTO transactions (id, reference_number, payment_date, item_price, check_column) VALUES (70, 'RDEL', '2026-11-06', 1, 'cdel')");
  await db.execute('DELETE FROM transactions WHERE id = 70');
}

async function dumpTable(db, table, key) {
  const res = await db.execute(`SELECT * FROM "${table}" ORDER BY ${key.map(k => `"${k}"`).join(', ')}`);
  return res.rows.map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fawry-ops-test-'));
});

afterAll(() => {
  for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may keep a handle briefly */ }
});

describe('backup coverage', () => {
  test('every turso/schema.sql table is backed up or deliberately excluded', () => {
    // line-anchored: comments in the schema mention "CREATE TABLE IF NOT EXISTS does not ..."
    const schemaTables = [...schemaSql.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map(m => m[1]);
    const covered = new Set([...BACKUP_TABLES.map(t => t.table), ...Object.keys(EXCLUDED_TABLES)]);
    for (const t of schemaTables) expect(covered.has(t), `table ${t} not covered by the backup`).toBe(true);
    expect(BACKUP_TABLES.map(t => t.table)).toContain('app_users');
    // transactions must be read before transactions_archive (archive moves rows between them)
    const order = BACKUP_TABLES.map(t => t.table);
    expect(order.indexOf('transactions')).toBeLessThan(order.indexOf('transactions_archive'));
  });

  test('backup script never deletes the repo backups/ folder', () => {
    const src = fs.readFileSync(path.join(rootDir, 'scripts', 'backup_to_drive.js'), 'utf8');
    expect(src).not.toMatch(/path\.resolve\(['"]backups['"]\)\s*;?\s*\n\s*if \(fs\.existsSync/);
    expect(src).not.toContain('localBackupsDir');
    expect(src).not.toMatch(/LIMIT \? OFFSET \?/);
  });
});

describe('backup -> restore round trip (local file: databases)', () => {
  let source;
  let backup;

  beforeAll(async () => {
    source = await makeDb('source');
    await seedSource(source);
    backup = await createLocalBackup({ db: source, workDir: tmpDir, log: quiet, pageSize: 2 });
  });

  test('zip holds every table file plus a manifest with checksums and counts', () => {
    const entries = readZip(backup.zipPath);
    expect(entries.has('manifest.json')).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    expect(manifest.format_version).toBe(2);
    expect(manifest.tables.transactions.rows).toBe(3);
    expect(manifest.tables.transactions_archive.rows).toBe(1);
    expect(manifest.tables.app_users.rows).toBe(2);
    expect(manifest.tables.student_master.rows).toBe(2);
    expect(manifest.sqlite_sequence.transactions).toBe(70);
    for (const name of Object.keys(manifest.checksums_sha256)) expect(entries.has(name)).toBe(true);
    expect(backup.manifest.archive_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('dry run validates without writing, then --confirm restores into an empty database', async () => {
    const target = await makeDb('target');
    // turso_setup.mjs seeds the admin login with a different id than the backup's admin
    await target.execute("INSERT INTO app_users (id, email, password_hash) VALUES ('seed-id', 'ammahmoud@nu.edu.eg', 'seedhash')");

    const dry = await restoreBackup({ zipPath: backup.zipPath, externalManifestPath: backup.manifestPath, db: target, confirm: false, log: quiet });
    expect(dry.restored).toBe(false);
    expect(Number((await target.execute('SELECT COUNT(*) AS c FROM transactions')).rows[0].c)).toBe(0);

    const res = await restoreBackup({ zipPath: backup.zipPath, externalManifestPath: backup.manifestPath, db: target, confirm: true, log: quiet });
    expect(res.restored).toBe(true);

    for (const spec of BACKUP_TABLES) {
      const a = await dumpTable(source, spec.table, spec.key);
      let b = await dumpTable(target, spec.table, spec.key);
      if (spec.table === 'audit_logs') {
        expect(b.at(-1).action).toBe('BACKUP_RESTORED');
        b = b.slice(0, -1);
      }
      expect(b, `table ${spec.table} differs after restore`).toEqual(a);
    }
    expect(Number((await target.execute('SELECT COUNT(*) AS c FROM period_lock_bypass')).rows[0].c)).toBe(0);
    const seq = await target.execute("SELECT seq FROM sqlite_sequence WHERE name = 'transactions'");
    expect(Number(seq.rows[0].seq)).toBeGreaterThanOrEqual(70);
    // Period lock is active again after the restore
    await expect(target.execute("INSERT INTO transactions (reference_number, payment_date, item_price, check_column) VALUES ('X', '2026-09-20', 1, 'x')"))
      .rejects.toThrow(/Accounting period is closed/);

    // A second restore into the now non-empty database is refused
    await expect(restoreBackup({ zipPath: backup.zipPath, db: target, confirm: true, log: quiet })).rejects.toThrow(/not empty/);
    await expect(restoreBackup({ zipPath: backup.zipPath, db: target, confirm: true, replace: true, log: quiet })).rejects.toThrow(/--replace is not supported/);
  });

  test('a tampered file or wrong archive checksum fails validation', () => {
    const entries = readZip(backup.zipPath);
    const tx = entries.get('transactions.jsonl').toString('utf8').replace('5000', '5001');
    entries.set('transactions.jsonl', Buffer.from(tx));
    const tampered = path.join(tmpDir, 'tampered.zip');
    writeZip(tampered, [...entries].map(([name, data]) => ({ name, data })));
    const loaded = loadBackup(tampered);
    expect(loaded.problems.join('\n')).toMatch(/transactions\.jsonl: SHA-256 does not match/);
    expect(loadBackup(tampered, { externalManifestPath: backup.manifestPath }).problems.join('\n')).toMatch(/Archive SHA-256/);
  });

  test('a row archived while the backup runs is kept exactly once', async () => {
    const db = await makeDb('moving');
    await db.execute("INSERT INTO transactions (id, reference_number, payment_date, item_price, check_column, is_settled, erp_batch_number) VALUES (1, 'M1', '2025-01-01', 10, 'm1', 1, 'E'), (2, 'M2', '2025-01-02', 20, 'm2', 0, NULL)");
    // Simulate the archive job running between the transactions read and the archive read:
    // the row is in transactions when read, and in the archive when the archive is read.
    const realExecute = db.execute.bind(db);
    let moved = false;
    db.execute = async (stmt) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      if (!moved && /FROM "transactions_archive"/.test(sql)) {
        moved = true;
        await realExecute("INSERT INTO transactions_archive SELECT *, datetime('now'), 'test' FROM transactions WHERE id = 1");
        await realExecute('DELETE FROM transactions WHERE id = 1');
      }
      return realExecute(stmt);
    };
    const b = await createLocalBackup({ db, workDir: tmpDir, log: quiet, now: new Date(2026, 0, 2, 3, 4, 5) });
    db.execute = realExecute;
    expect(b.manifest.consistency.archived_during_backup).toBe(1);
    expect(b.manifest.tables.transactions.rows).toBe(1);
    expect(b.manifest.tables.transactions_archive.rows).toBe(1);
    expect(loadBackup(b.zipPath).problems).toEqual([]);
  });
});

describe('Google Drive upload and retention (mocked fetch)', () => {
  function jsonRes(body, status = 200, headers = {}) {
    return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) };
  }

  test('files over 5 MB use a resumable session and resume after a 308', async () => {
    const big = path.join(tmpDir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1));
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method, range: init.headers?.['Content-Range'] });
      if (String(url).includes('uploadType=resumable')) return jsonRes({}, 200, { location: 'https://upload.example/session1' });
      if (init.headers?.['Content-Range']?.startsWith('bytes 0-')) return jsonRes({}, 308, { range: 'bytes=0-8388607' });
      return jsonRes({ id: 'file1', name: 'big.bin' }, 200);
    };
    const out = await uploadFileToDriveRest('tok', big, 'big.bin', 'application/zip', 'folder', { fetchImpl });
    expect(out.id).toBe('file1');
    expect(calls[0].url).toContain('uploadType=resumable');
    expect(calls[1].range).toBe(`bytes 0-8388607/${9 * 1024 * 1024}`);
    expect(calls[2].range).toBe(`bytes 8388608-${9 * 1024 * 1024 - 1}/${9 * 1024 * 1024}`);
  });

  test('small files still use one multipart request', async () => {
    const small = path.join(tmpDir, 'small.json');
    fs.writeFileSync(small, '{}');
    const urls = [];
    await uploadFileToDriveRest('tok', small, 'small.json', 'application/json', 'folder', {
      fetchImpl: async (url) => { urls.push(url); return jsonRes({ id: 'x' }); }
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('uploadType=multipart');
  });

  test('retention trashes only this script\'s old backups under the backup root', async () => {
    const files = [
      { id: 'z1', name: 'fawry_backup_20260101_160000.zip', parents: ['w1'] },
      { id: 'z2', name: 'fawry_backup_20260108_160000.zip', parents: ['w2'] },
      { id: 'z3', name: 'fawry_backup_20260115_160000.zip', parents: ['w3'] },
      { id: 'm1', name: 'fawry_backup_20260101_160000_manifest.json', parents: ['w1'] },
      { id: 'm3', name: 'fawry_backup_20260115_160000_manifest.json', parents: ['w3'] },
      { id: 'other', name: 'fawry_backup_notes.zip', parents: ['w1'] },
      { id: 'elsewhere', name: 'fawry_backup_20250101_160000.zip', parents: ['x1'] }
    ];
    const parents = { w1: 'mo1', w2: 'mo1', w3: 'mo1', mo1: 'y1', y1: 'ROOT', x1: 'x2', x2: 'x3', x3: 'OTHER' };
    const trashed = [];
    const fetchImpl = async (url, init = {}) => {
      if (init.method === 'PATCH') { trashed.push(String(url).split('/files/')[1]); return jsonRes({}); }
      const m = /files\/([^?]+)\?fields=parents/.exec(url);
      if (m) return jsonRes({ parents: [parents[decodeURIComponent(m[1])]] });
      return jsonRes({ files });
    };
    const res = await applyDriveRetention('tok', 'ROOT', 2, { fetchImpl, log: quiet });
    expect(res.kept).toEqual(['fawry_backup_20260115_160000.zip', 'fawry_backup_20260108_160000.zip']);
    expect(trashed.sort()).toEqual(['m1', 'z1']);
    expect(parseRetention(undefined)).toBe(12);
    expect(parseRetention('0')).toBe(0);
    expect(() => parseRetention('-1')).toThrow();
  });
});

describe('daily FX rate job', () => {
  test('late GitHub runs catch up only when today has no rate yet', () => {
    expect(decideFxRun({ hour: 11 }).run).toBe(false);
    expect(decideFxRun({ hour: 12 }).run).toBe(true);
    expect(decideFxRun({ hour: 14, existing: null }).run).toBe(true);
    expect(decideFxRun({ hour: 14, existing: { source: 'auto' } }).run).toBe(false);
    expect(decideFxRun({ hour: 12, existing: { source: 'manual' } }).run).toBe(false);
    expect(decideFxRun({ hour: 12, force: true, existing: { source: 'manual' } }).run).toBe(false);
    expect(decideFxRun({ hour: 12, overwriteManual: true, existing: { source: 'manual' } }).run).toBe(true);
    expect(buildFxUpsertSql()).toContain("WHERE exchange_rates.source <> 'manual'");
    expect(buildFxUpsertSql({ overwriteManual: true })).not.toContain('WHERE exchange_rates.source');
  });

  test('the upsert never overwrites a manual rate saved meanwhile', async () => {
    const db = await makeDb('fx');
    // 10:30 UTC on 2026-11-22 = 12:30 Africa/Cairo (UTC+2)
    const now = new Date('2026-11-22T10:30:00Z');
    const first = await runFxUpdate({ db, now, fetchRate: async () => ({ rate: 50.1, provider: 'test' }) });
    expect(first.updated).toBe(true);
    await db.execute("UPDATE exchange_rates SET source = 'manual', rate = 49 WHERE rate_date = '2026-11-22'");
    // even if the pre-check is bypassed, the upsert's WHERE keeps the manual row
    await db.execute({ sql: buildFxUpsertSql(), args: ['2026-11-22', 51, now.toISOString()] });
    const row = (await db.execute("SELECT rate, source FROM exchange_rates WHERE rate_date = '2026-11-22'")).rows[0];
    expect(row.source).toBe('manual');
    expect(Number(row.rate)).toBe(49);
    const late = await runFxUpdate({ db, now: new Date('2026-11-22T13:00:00Z'), fetchRate: async () => ({ rate: 52, provider: 'test' }) });
    expect(late.updated).toBe(false);
  });
});

describe('workflows', () => {
  const wfDir = path.join(rootDir, '.github', 'workflows');
  const workflows = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml')).map(f => [f, fs.readFileSync(path.join(wfDir, f), 'utf8')]);

  test.each(workflows)('%s uses pinned actions, .nvmrc, npm ci, timeouts and concurrency', (_name, src) => {
    expect(src).not.toMatch(/actions\/checkout@v4|actions\/setup-node@v4/);
    expect(src).not.toContain('npm ci ||');
    expect(src).not.toMatch(/node-version:\s/);
    expect(src).toContain("node-version-file: '.nvmrc'");
    expect(src).toMatch(/^concurrency:/m);
    expect(src).not.toMatch(/SUPABASE_/);
    const jobs = src.split(/\n {2}[a-z0-9_-]+:\n {4}(?:name|runs-on)/).length - 1;
    const timeouts = (src.match(/timeout-minutes:/g) || []).length;
    expect(timeouts).toBeGreaterThanOrEqual(jobs);
  });
});
