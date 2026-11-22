// Deletes ALL BM (USD) foreign transactions from the Turso database.
//
// Safe by default: without --confirm it only prints what WOULD be deleted (dry run).
// Before deleting it always saves a full JSON backup to backups/ (git-ignored).
//
// Usage (PowerShell):
//   $env:TURSO_DATABASE_URL = "libsql://..."
//   $env:TURSO_AUTH_TOKEN   = "..."
//   node scripts/delete_foreign_transactions.mjs                      # dry run: summary + backup only
//   node scripts/delete_foreign_transactions.mjs --confirm            # delete (open periods only)
//   node scripts/delete_foreign_transactions.mjs --confirm --include-closed-periods
//
// Rows in a CLOSED accounting period are protected by the database (period-lock triggers).
// If any exist, the delete stops unless --include-closed-periods is given; that switches the
// lock off for this one delete only (set and cleared inside the same transaction) and the
// audit log records it.
//
// The whole delete is one transaction: either every row is removed or none is.
//
// Browser copies: the BM Transactions page keeps a copy of the rows in each browser
// (localStorage "fawry_app_foreign_transactions_v1"). Since the page fix in this release it only
// re-uploads unsaved imports and drops rows deleted from the database, so nothing comes back.
// A browser still running an OLD version of the app (not reloaded since the deploy) could
// re-upload them; reload the app everywhere first, or clear the copy in its console (F12):
//   localStorage.removeItem('fawry_app_foreign_transactions_v1')
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { withDbRetry, withDbWriteRetry } from '../api/_lib/db.js';

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has('--confirm');
const INCLUDE_CLOSED = args.has('--include-closed-periods');
const ACTOR = (process.env.DELETE_ACTOR || 'maintenance script').trim();

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error('Error: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first.');
  process.exit(1);
}
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- 1. summary
const PERIOD = "substr(COALESCE(value_date, transaction_date), 1, 7)";
const [totRes, monthRes, erpRes, closedRes] = await withDbRetry(() => db.batch([
  'SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt FROM foreign_transactions',
  `SELECT ${PERIOD} AS month, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt
     FROM foreign_transactions GROUP BY month ORDER BY month`,
  "SELECT COUNT(*) AS n FROM foreign_transactions WHERE TRIM(COALESCE(erp_batch_number, '')) <> ''",
  `SELECT COUNT(*) AS n, GROUP_CONCAT(DISTINCT ${PERIOD}) AS months FROM foreign_transactions
     WHERE ${PERIOD} IN (SELECT period_month FROM closed_periods WHERE is_closed = 1)`
], 'read'));

const total = Number(totRes.rows[0].n);
console.log(`Database: ${url.replace(/\/\/([^.]+)\..*/, '//$1…')}`);
console.log(`Foreign transactions: ${total} rows, USD ${money(totRes.rows[0].amt)}`);
if (total === 0) {
  console.log('Nothing to delete.');
  process.exit(0);
}
console.log('\nBy month:');
for (const r of monthRes.rows) console.log(`  ${String(r.month || '(no date)').padEnd(9)} ${String(r.n).padStart(6)} rows   USD ${money(r.amt)}`);
const erpPosted = Number(erpRes.rows[0].n);
const closedCount = Number(closedRes.rows[0].n);
if (erpPosted > 0) console.log(`\n⚠ ${erpPosted} row(s) are already recorded in ERP (have an ERP batch number).`);
if (closedCount > 0) console.log(`⚠ ${closedCount} row(s) are in CLOSED accounting periods: ${closedRes.rows[0].months}.`);

// ---------------------------------------------------------------- 2. backup (always)
const all = await withDbRetry(() => db.execute('SELECT * FROM foreign_transactions ORDER BY id'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.resolve(import.meta.dirname, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `foreign_transactions_${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify(all.rows, null, 1));
if (all.rows.length !== total) {
  console.error(`\nBackup has ${all.rows.length} rows but the table has ${total}. Stopping.`);
  process.exit(1);
}
console.log(`\nBackup saved: ${backupFile} (${all.rows.length} rows)`);

// ---------------------------------------------------------------- 3. delete
if (!CONFIRM) {
  console.log('\nDry run only. Nothing was deleted. Re-run with --confirm to delete.');
  process.exit(0);
}
if (closedCount > 0 && !INCLUDE_CLOSED) {
  console.error(`\nStopped: ${closedCount} row(s) are in closed accounting periods. Reopen those months in Admin,`);
  console.error('or re-run with --include-closed-periods to delete them anyway (recorded in the audit log).');
  process.exit(1);
}

const statements = [];
if (INCLUDE_CLOSED) statements.push({ sql: 'INSERT OR IGNORE INTO period_lock_bypass (id) VALUES (1)', args: [] });
statements.push({ sql: 'DELETE FROM foreign_transactions', args: [] });
if (INCLUDE_CLOSED) statements.push({ sql: 'DELETE FROM period_lock_bypass', args: [] });
statements.push({
  sql: 'INSERT INTO audit_logs (user_email, action, affected_references, details) VALUES (?, ?, ?, ?)',
  args: [
    ACTOR,
    'Foreign Transactions Deleted (script)',
    `All ${total} BM deposits`,
    JSON.stringify({
      deleted_count: total,
      erp_posted_count: erpPosted,
      closed_period_count: closedCount,
      closed_periods_bypassed: INCLUDE_CLOSED && closedCount > 0,
      backup_file: path.basename(backupFile),
      deleted_at: new Date().toISOString()
    })
  ]
});

const results = await withDbWriteRetry(() => db.batch(statements, 'write'));
const deleted = results[INCLUDE_CLOSED ? 1 : 0].rowsAffected;
const left = Number((await db.execute('SELECT COUNT(*) AS n FROM foreign_transactions')).rows[0].n);
console.log(`\nDeleted ${deleted} row(s). Remaining: ${left}.`);
console.log('Recorded in the audit log as "Foreign Transactions Deleted (script)".');
console.log('\nNote: browsers drop the deleted rows automatically on their next visit. Only a browser still');
console.log('running an old version of the app (open since before the latest deploy) could re-upload them:');
console.log('reload the app there, or run in its console (F12):');
console.log("  localStorage.removeItem('fawry_app_foreign_transactions_v1')");
