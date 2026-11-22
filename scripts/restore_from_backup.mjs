// Restores a backup made by scripts/backup_to_drive.js into an EMPTY Turso database.
//
// Safe by default: without --confirm it only validates the backup (zip CRCs, SHA-256 of every
// file against manifest.json, row counts per table, duplicate primary keys) and, when
// TURSO_DATABASE_URL is set, checks that the target is empty. Nothing is written.
//
// Usage (PowerShell):
//   node scripts/restore_from_backup.mjs <fawry_backup_YYYYMMDD_HHmmss.zip> [--manifest <..._manifest.json>]
//   # 1. create a NEW, empty database and apply the schema:
//   #      turso db create fawry-restore ; set TURSO_DATABASE_URL / TURSO_AUTH_TOKEN for it
//   #      node scripts/turso_setup.mjs        (no ADMIN_INITIAL_PASSWORD needed; users come from the backup)
//   # 2. restore into it:
//   node scripts/restore_from_backup.mjs <zip> --confirm
//
// Only an EMPTY database is supported (every table empty, except the admin row that
// turso/schema.sql / turso_setup.mjs seed into user_roles / app_users, which the backup's rows
// replace). Restoring over existing data (--replace) is refused on purpose: audit_logs and
// transactions_archive are append-only (triggers forbid UPDATE/DELETE), so replacing them would
// mean dropping those safety triggers on a live database. Restore into a fresh database and then
// point the app (Vercel TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) at it instead.
//
// Every batch sets the period_lock_bypass row first and clears it last (same transaction), so
// rows in closed accounting periods can be inserted; no other connection ever sees it set.
// AUTOINCREMENT counters (sqlite_sequence) are restored too, so ids used before (e.g. archived
// transactions) are never issued again.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { withDbRetry, withDbWriteRetry } from '../api/_lib/db.js';
import {
  BACKUP_TABLES,
  readZip,
  sha256Buffer,
  computeFileSha256,
  parseTableFile
} from './backup_to_drive.js';

const BATCH_ROWS = 200;
// Tables the schema/turso_setup seed with the admin row; backup rows replace those.
const SEEDED_TABLES = new Set(['user_roles', 'app_users']);

// Format-1 backups (before the restore script) used these file names and statistics keys and
// stored booleans as true/false and JSON columns parsed.
const LEGACY_FILES = {
  user_roles: { file: 'user_roles.json', stat: 'user_roles_count' },
  item_mappings: { file: 'item_mappings.json', stat: 'mappings_count' },
  manual_fixes: { file: 'manual_fixes.json', stat: 'manual_fixes_count' },
  student_master: { file: 'student_master.jsonl', stat: 'students_count' },
  transactions: { file: 'transactions.jsonl', stat: 'transactions_count' },
  audit_logs: { file: 'audit_logs_full.json' },
  closed_periods: { file: 'closed_periods.json' },
  transactions_archive: { file: 'transactions_archive.json' },
  foreign_transactions: { file: 'foreign_transactions.json' },
  settlement_batches: { file: 'settlement_batches.json' },
  links: { file: 'links.json' },
  payment_links: { file: 'payment_links.json' },
  import_batches: { file: 'import_batches.json' },
  exchange_rates: { file: 'exchange_rates.json' }
};
const LEGACY_BOOL_COLS = new Set(['is_settled', 'is_active', 'is_closed']);

function legacyValue(col, v) {
  if (v === null || v === undefined) return null;
  if (LEGACY_BOOL_COLS.has(col) && typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function cellValue(v) {
  if (v === undefined) return null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * Opens and validates a backup zip. Throws on any integrity problem.
 * Returns { manifest, plan: [{ table, key, rows }], problems: [], warnings: [] }.
 */
export function loadBackup(zipPath, { externalManifestPath = null } = {}) {
  if (!fs.existsSync(zipPath)) throw new Error(`Backup file not found: ${zipPath}`);
  const problems = [];
  const warnings = [];

  if (externalManifestPath) {
    const ext = JSON.parse(fs.readFileSync(externalManifestPath, 'utf-8'));
    if (ext.archive_sha256) {
      const actual = computeFileSha256(zipPath);
      if (actual !== ext.archive_sha256) {
        problems.push(`Archive SHA-256 ${actual} does not match the manifest (${ext.archive_sha256}).`);
      }
    } else {
      warnings.push('External manifest has no archive_sha256; archive checksum not verified.');
    }
  }

  const entries = readZip(zipPath); // verifies CRC-32 of every entry
  const manifestBuf = entries.get('manifest.json');
  if (!manifestBuf) throw new Error('manifest.json is missing from the backup zip.');
  const manifest = JSON.parse(manifestBuf.toString('utf-8'));
  const checksums = manifest.checksums_sha256 || {};

  if (Object.keys(checksums).length === 0) problems.push('manifest.json lists no file checksums.');
  for (const [name, info] of Object.entries(checksums)) {
    const data = entries.get(name);
    if (!data) { problems.push(`${name} is listed in manifest.json but missing from the zip.`); continue; }
    if (info.bytes !== undefined && data.length !== info.bytes) problems.push(`${name}: size ${data.length} != manifest ${info.bytes}.`);
    if (sha256Buffer(data) !== info.sha256) problems.push(`${name}: SHA-256 does not match manifest.json.`);
  }
  for (const name of entries.keys()) {
    if (name !== 'manifest.json' && !checksums[name]) problems.push(`${name} is in the zip but not in manifest.json.`);
  }

  const isV2 = Number(manifest.format_version) >= 2;
  const plan = [];
  for (const spec of BACKUP_TABLES) {
    let file;
    let expected = null;
    if (isV2) {
      const t = manifest.tables?.[spec.table];
      if (!t) {
        if (manifest.skipped_tables?.[spec.table]) warnings.push(`${spec.table}: not in backup (${manifest.skipped_tables[spec.table]}).`);
        else problems.push(`${spec.table}: missing from manifest.tables.`);
        continue;
      }
      file = t.file;
      expected = t.rows;
    } else {
      const legacy = LEGACY_FILES[spec.table];
      if (!legacy || !entries.has(legacy.file)) {
        warnings.push(`${spec.table}: not in this (format 1) backup${spec.table === 'app_users' ? '; recreate logins with turso_setup.mjs (ADMIN_INITIAL_PASSWORD) and the Users page' : ''}.`);
        continue;
      }
      file = legacy.file;
      if (legacy.stat) expected = manifest.statistics?.[legacy.stat] ?? null;
      else expected = manifest.statistics?.extra_tables?.[spec.table] ?? null;
    }
    const data = entries.get(file);
    if (!data) { problems.push(`${spec.table}: file ${file} missing from the zip.`); continue; }
    let rows;
    try {
      rows = parseTableFile(file, data.toString('utf-8'));
    } catch (err) {
      problems.push(`${spec.table}: ${file} is not valid JSON (${err.message}).`);
      continue;
    }
    if (!isV2) rows = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, legacyValue(k, v)])));
    if (expected !== null && rows.length !== expected) {
      problems.push(`${spec.table}: ${rows.length} rows in ${file} but the manifest says ${expected}.`);
    }
    const seen = new Set();
    let dups = 0;
    for (const r of rows) {
      const k = JSON.stringify(spec.key.map(c => r[c]));
      if (seen.has(k)) dups++;
      seen.add(k);
    }
    if (dups > 0) problems.push(`${spec.table}: ${dups} duplicate primary key(s).`);
    plan.push({ table: spec.table, key: spec.key, file, rows });
  }

  // A transaction that is also in the archive would be silently skipped by
  // trg_skip_archived_transaction_insert if the archive were restored first; format-2 backups
  // never contain such pairs, but older ones can. Restore order (transactions first) handles it.
  return { manifest, plan, problems, warnings };
}

async function tableColumns(db, table) {
  const res = await withDbRetry(() => db.execute(`PRAGMA table_info("${table}")`));
  return new Set(res.rows.map(r => String(r.name)));
}

/**
 * Checks the target database: every table exists with the needed columns and is empty
 * (seeded admin rows in user_roles / app_users allowed). Returns a list of problems.
 */
export async function checkTarget(db, plan) {
  const problems = [];
  for (const { table, rows } of plan) {
    const cols = await tableColumns(db, table);
    if (cols.size === 0) {
      problems.push(`Target has no table ${table}. Create the database with scripts/turso_setup.mjs first.`);
      continue;
    }
    const needed = new Set();
    for (const r of rows) for (const c of Object.keys(r)) needed.add(c);
    const unknown = [...needed].filter(c => !cols.has(c));
    if (unknown.length > 0) problems.push(`Target table ${table} has no column(s): ${unknown.join(', ')}. Run scripts/turso_setup.mjs (latest schema) first.`);
    if (SEEDED_TABLES.has(table)) continue;
    const cnt = await withDbRetry(() => db.execute(`SELECT COUNT(*) AS cnt FROM "${table}"`));
    const n = Number(cnt.rows[0]?.cnt || 0);
    if (n > 0) problems.push(`Target table ${table} is not empty (${n} rows). Only restoring into an empty database is supported.`);
  }
  return problems;
}

function insertStatement(table, row) {
  const cols = Object.keys(row);
  const verb = SEEDED_TABLES.has(table) ? 'INSERT OR REPLACE' : 'INSERT';
  return {
    sql: `${verb} INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    args: cols.map(c => cellValue(row[c]))
  };
}

/**
 * Validates a backup and (with confirm) restores it into `db`.
 * Returns { restored: boolean, counts, problems, warnings }. Throws on refusal / failure.
 */
export async function restoreBackup({ zipPath, externalManifestPath = null, db = null, confirm = false, replace = false, actor = 'restore script', log = console.log }) {
  if (replace) {
    throw new Error('--replace is not supported: audit_logs and transactions_archive are append-only (UPDATE/DELETE triggers). Create a new database with scripts/turso_setup.mjs and restore into it.');
  }
  const { manifest, plan, problems, warnings } = loadBackup(zipPath, { externalManifestPath });
  log(`Backup ${manifest.backup_id || path.basename(zipPath)} (format ${manifest.format_version || 1}, created ${manifest.created_at || 'unknown'})`);
  for (const p of plan) log(`  ${p.table.padEnd(22)} ${String(p.rows.length).padStart(9)} rows`);
  for (const w of warnings) log(`  ! ${w}`);
  if (problems.length > 0) {
    throw new Error(`Backup validation failed:\n  - ${problems.join('\n  - ')}`);
  }
  log('Backup validation passed (zip CRCs, SHA-256 checksums, row counts, primary keys).');

  if (!db) {
    if (confirm) throw new Error('No target database: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN).');
    log('Dry run: no target database configured (TURSO_DATABASE_URL), nothing else to check.');
    return { restored: false, counts: Object.fromEntries(plan.map(p => [p.table, p.rows.length])), problems: [], warnings };
  }

  const targetProblems = await checkTarget(db, plan);
  if (targetProblems.length > 0) {
    throw new Error(`Refusing to restore into this database:\n  - ${targetProblems.join('\n  - ')}`);
  }
  log('Target database is empty and has every table/column.');

  if (!confirm) {
    log('Dry run complete. Re-run with --confirm to restore.');
    return { restored: false, counts: Object.fromEntries(plan.map(p => [p.table, p.rows.length])), problems: [], warnings };
  }

  for (const { table, rows } of plan) {
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const stmts = [
        { sql: 'INSERT OR IGNORE INTO period_lock_bypass (id) VALUES (1)', args: [] },
        ...rows.slice(i, i + BATCH_ROWS).map(r => insertStatement(table, r)),
        { sql: 'DELETE FROM period_lock_bypass', args: [] }
      ];
      await withDbWriteRetry(() => db.batch(stmts, 'write'));
    }
    log(`  ✓ restored ${table}: ${rows.length} rows`);
  }

  // AUTOINCREMENT counters: never below the backup's counters, and transactions never below
  // the highest archived id (archived rows keep their transaction id).
  const seq = { ...(manifest.sqlite_sequence || {}) };
  const archive = plan.find(p => p.table === 'transactions_archive');
  if (archive && archive.rows.length > 0) {
    const maxArchived = Math.max(...archive.rows.map(r => Number(r.id) || 0));
    seq.transactions = Math.max(Number(seq.transactions || 0), maxArchived);
  }
  for (const [name, value] of Object.entries(seq)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const upd = await withDbWriteRetry(() => db.execute({ sql: 'UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?', args: [n, name] }));
    if (!upd.rowsAffected) {
      await withDbWriteRetry(() => db.execute({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', args: [name, n] }));
    }
  }

  // Verify: every table has exactly the backup's rows (seeded tables: at least, all keys present).
  const counts = {};
  const verifyProblems = [];
  for (const { table, key, rows } of plan) {
    const res = await withDbRetry(() => db.execute(`SELECT COUNT(*) AS cnt FROM "${table}"`));
    const n = Number(res.rows[0]?.cnt || 0);
    counts[table] = n;
    if (SEEDED_TABLES.has(table) ? n < rows.length : n !== rows.length) {
      verifyProblems.push(`${table}: ${n} rows after restore, backup has ${rows.length}.`);
    }
    if (table === 'transactions' || table === 'audit_logs') continue;
    if (SEEDED_TABLES.has(table) && rows.length > 0) {
      const keyRes = await withDbRetry(() => db.execute(`SELECT ${key.map(c => `"${c}"`).join(', ')} FROM "${table}"`));
      const present = new Set(keyRes.rows.map(r => JSON.stringify(key.map(c => r[c]))));
      const missing = rows.filter(r => !present.has(JSON.stringify(key.map(c => r[c])))).length;
      if (missing > 0) verifyProblems.push(`${table}: ${missing} backup row(s) missing after restore.`);
    }
  }
  if (verifyProblems.length > 0) {
    throw new Error(`Restore verification FAILED (the target is incomplete; drop it and restore again into a new database):\n  - ${verifyProblems.join('\n  - ')}`);
  }

  await withDbWriteRetry(() => db.execute({
    sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
    args: [
      'system@nu.edu.eg',
      'BACKUP_RESTORED',
      manifest.backup_id || path.basename(zipPath),
      JSON.stringify({ backup_created_at: manifest.created_at, actor, table_rows: counts })
    ]
  }));
  log('Restore complete and verified (row counts match the backup).');
  return { restored: true, counts, problems: [], warnings };
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const manifestIdx = argv.indexOf('--manifest');
  const externalManifestPath = manifestIdx >= 0 ? argv[manifestIdx + 1] : null;
  const zipPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--manifest');
  if (!zipPath) {
    console.error('Usage: node scripts/restore_from_backup.mjs <backup.zip> [--manifest <manifest.json>] [--confirm]');
    process.exit(1);
  }
  const url = process.env.TURSO_DATABASE_URL;
  const db = url ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined }) : null;
  if (db) console.log(`Target database: ${url.replace(/\?.*$/, '')}`);
  await restoreBackup({
    zipPath: path.resolve(zipPath),
    externalManifestPath: externalManifestPath ? path.resolve(externalManifestPath) : null,
    db,
    confirm: flags.has('--confirm'),
    replace: flags.has('--replace'),
    actor: (process.env.RESTORE_ACTOR || 'restore script').trim()
  });
}

if (process.argv[1] && process.argv[1].endsWith('restore_from_backup.mjs')) {
  main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
