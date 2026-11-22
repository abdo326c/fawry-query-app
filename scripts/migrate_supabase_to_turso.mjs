import { createClient } from '@libsql/client';
import { TABLE_COLUMNS } from '../api/_lib/rbac.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !TURSO_URL) {
  console.error('Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN');
  process.exit(1);
}

const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

const TABLE_ORDERS = {
  user_roles: 'email.asc',
  import_batches: 'id.asc',
  student_master: 'student_id.asc',
  item_mappings: 'id.asc',
  manual_fixes: 'id.asc',
  links: 'id.asc',
  payment_links: 'id.asc',
  transactions: 'id.asc',
  transactions_archive: 'id.asc',
  foreign_transactions: 'id.asc',
  exchange_rates: 'rate_date.asc,currency_pair.asc',
  settlement_batches: 'id.asc',
  closed_periods: 'period_month.asc',
  audit_logs: 'id.asc'
};

const TABLES = Object.keys(TABLE_ORDERS);

// Primary key of each table. Re-runs skip rows whose primary key is already copied; a clash
// on any OTHER unique key (e.g. two payment links with one invoice number) now fails loudly.
// (INSERT OR REPLACE silently deleted the existing row on any unique clash.)
const PRIMARY_KEYS = {
  user_roles: ['email'],
  import_batches: ['id'],
  student_master: ['student_id'],
  item_mappings: ['id'],
  manual_fixes: ['id'],
  links: ['id'],
  payment_links: ['id'],
  transactions: ['id'],
  transactions_archive: ['id'],
  foreign_transactions: ['id'],
  exchange_rates: ['rate_date', 'currency_pair'],
  settlement_batches: ['id'],
  closed_periods: ['period_month'],
  audit_logs: ['id']
};
const SELECTED_TABLES = process.env.MIGRATE_TABLES
  ? process.env.MIGRATE_TABLES.split(',').map(s => s.trim()).filter(t => TABLES.includes(t))
  : TABLES;
const BOOL_COLS = new Set(['is_settled', 'is_active', 'is_closed']);
const PAGE_SIZE = 1000;
const BATCH_SIZE = 200;

async function withRetry(fn, attempts = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '').toLowerCase();
      const isTransient = msg.includes('econnreset') || msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('etimedout');
      if (!isTransient || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchSupabasePage(table, from, to) {
  return withRetry(async () => {
    const order = TABLE_ORDERS[table];
    const baseUrl = SUPABASE_URL.replace(/\/+$/, '');
    const url = `${baseUrl}/rest/v1/${table}?select=*${order ? `&order=${encodeURIComponent(order)}` : ''}`;

    const headers = {
      apikey: SUPABASE_KEY,
      Range: `${from}-${to}`,
      Prefer: 'count=exact'
    };
    if (!SUPABASE_KEY.startsWith('sb_secret_')) {
      headers.Authorization = `Bearer ${SUPABASE_KEY}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || text.includes('PGRST205') || text.includes('does not exist')) {
        return { skipped: true, rows: [] };
      }
      throw new Error(`Supabase fetch failed for ${table} (${res.status}): ${text}`);
    }
    // Content-Range: "0-999/12345" -> total rows in Supabase
    const range = res.headers.get('content-range') || '';
    const totalInSource = /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : null;
    return { skipped: false, rows: await res.json(), totalInSource };
  });
}

function serializeCell(col, val) {
  if (val === undefined || val === null) return null;
  if (BOOL_COLS.has(col)) return val ? 1 : 0;
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

// turso/schema.sql has exactly one foreign key: transactions.batch_id -> import_batches(id)
// (ON DELETE SET NULL). A separate "PRAGMA foreign_keys = OFF" request is not reliable on Turso
// (each request may run on a different connection, and the pragma is a no-op inside the batch
// transaction), so it is not used. Instead import_batches is copied before transactions
// (TABLE_ORDERS), and a transaction pointing at a batch that no longer exists gets
// batch_id = NULL, which is what ON DELETE SET NULL did when that batch was deleted.
let knownBatchIds = null;
let orphanBatchRefs = 0;
async function loadKnownBatchIds() {
  const ids = new Set();
  const res = await withRetry(() => turso.execute('SELECT id FROM import_batches'));
  for (const r of res.rows) ids.add(String(r.id));
  return ids;
}

const migratedCounts = {};

for (const table of SELECTED_TABLES) {
  const allowedCols = TABLE_COLUMNS[table];
  let offset = 0;
  let total = 0;
  let skipped = false;
  let expected = null;

  while (true) {
    const page = await fetchSupabasePage(table, offset, offset + PAGE_SIZE - 1);
    if (page.skipped) {
      skipped = true;
      console.log(`Skipped ${table} (not present in Supabase)`);
      break;
    }

    if (expected === null && page.totalInSource !== null) expected = page.totalInSource;
    const rows = page.rows;
    if (!Array.isArray(rows) || rows.length === 0) break;

    if (table === 'transactions') {
      if (!knownBatchIds) knownBatchIds = await loadKnownBatchIds();
      for (const row of rows) {
        if (row.batch_id != null && !knownBatchIds.has(String(row.batch_id))) {
          row.batch_id = null;
          orphanBatchRefs++;
        }
      }
    }

    const cols = Object.keys(rows[0]).filter(c => !allowedCols || allowedCols.has(c));
    const colList = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const pk = PRIMARY_KEYS[table].map(c => `"${c}"`).join(', ');
    const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO NOTHING`;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const slice = rows.slice(i, i + BATCH_SIZE);
      // Historical rows may sit in closed accounting periods: switch the period-lock triggers
      // off inside this batch only (set and cleared in the same transaction).
      const stmts = [
        { sql: 'INSERT OR IGNORE INTO period_lock_bypass (id) VALUES (1)', args: [] },
        ...slice.map(row => ({
          sql,
          args: cols.map(c => serializeCell(c, row[c]))
        })),
        { sql: 'DELETE FROM period_lock_bypass', args: [] }
      ];
      await withRetry(() => turso.batch(stmts, 'write'));
    }

    total += rows.length;
    offset += rows.length; // not PAGE_SIZE: a capped page must not skip rows
    if (total > 0 && total % 2000 === 0) {
      console.log(`  ${table}: ${total} rows migrated so far...`);
    }
    // Supabase may cap pages below PAGE_SIZE (max_rows); trust the exact count when we have it.
    if (expected !== null ? total >= expected : rows.length < PAGE_SIZE) break;
  }

  if (!skipped && expected !== null && total !== expected) {
    throw new Error(`${table}: copied ${total} rows but Supabase has ${expected}. Migration is incomplete.`);
  }

  if (!skipped) {
    migratedCounts[table] = total;
    console.log(`Migrated ${table}: ${total} rows${expected !== null ? ` (Supabase: ${expected})` : ''}`);
  }
}

if (orphanBatchRefs > 0) {
  console.warn(`Warning: ${orphanBatchRefs} transaction(s) referenced an import batch that does not exist; their batch_id was set to NULL.`);
}

console.log('\n--- Turso Verification Row Counts ---');
for (const table of TABLES) {
  const res = await turso.execute(`SELECT COUNT(*) AS cnt FROM "${table}"`);
  const cnt = Number(res.rows[0]?.cnt || 0);
  console.log(`${table.padEnd(22)} ${String(cnt).padStart(8)} rows`);
}

console.log('\nSupabase -> Turso migration complete!');
