// 10-user read-only load test against a Turso database through the real API handlers.
//
// It signs in as an admin and fires ~70 concurrent API calls, so it must never be pointed at the
// production database by accident. It refuses to run unless ALL of these hold:
//   - LOAD_TEST_ALLOW=1
//   - --target <url> is given and equals TURSO_DATABASE_URL (you name the database explicitly)
//   - the target is not the production URL (LOAD_TEST_PRODUCTION_URL, if set, is refused)
//   - LOAD_TEST_EMAIL (or ADMIN_EMAIL) and ADMIN_INITIAL_PASSWORD are set
//
// Usage (PowerShell):
//   $env:TURSO_DATABASE_URL = "libsql://fawry-staging-....turso.io"; $env:TURSO_AUTH_TOKEN = "..."
//   $env:LOAD_TEST_ALLOW = "1"; $env:LOAD_TEST_EMAIL = "admin@example.edu"; $env:ADMIN_INITIAL_PASSWORD = "..."
//   node scripts/load_test_10_users.mjs --target $env:TURSO_DATABASE_URL

function checkLoadTestTarget({ env = process.env, argv = process.argv.slice(2) } = {}) {
  if (env.LOAD_TEST_ALLOW !== '1') {
    return 'Refusing to run: set LOAD_TEST_ALLOW=1 to confirm this is a load test on a non-production database.';
  }
  const idx = argv.indexOf('--target');
  const target = idx >= 0 ? String(argv[idx + 1] || '').trim() : '';
  const dbUrl = String(env.TURSO_DATABASE_URL || '').trim();
  if (!target) return 'Refusing to run: pass --target <database url> (must equal TURSO_DATABASE_URL).';
  if (!dbUrl) return 'Refusing to run: TURSO_DATABASE_URL is not set.';
  if (target !== dbUrl) return 'Refusing to run: --target does not match TURSO_DATABASE_URL.';
  const prod = String(env.LOAD_TEST_PRODUCTION_URL || '').trim();
  if (prod && prod === dbUrl) return 'Refusing to run: TURSO_DATABASE_URL is the production database (LOAD_TEST_PRODUCTION_URL).';
  if (!(env.LOAD_TEST_EMAIL || env.ADMIN_EMAIL)) return 'Refusing to run: set LOAD_TEST_EMAIL (or ADMIN_EMAIL) to the admin account to sign in with.';
  if (!env.ADMIN_INITIAL_PASSWORD) return 'Refusing to run: ADMIN_INITIAL_PASSWORD is required.';
  return null;
}

const refusal = checkLoadTestTarget();
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const { default: authHandler } = await import('../api/auth.js');
const { default: queryHandler } = await import('../api/query.js');
const { default: rpcHandler } = await import('../api/rpc.js');

const CONCURRENT_USERS = 10;

async function callApi(handler, body, token = null) {
  let raw = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) { raw = chunk || ''; }
  };
  await handler({
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body
  }, res);
  return { status: res.statusCode, body: JSON.parse(raw || '{}') };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const password = process.env.ADMIN_INITIAL_PASSWORD;
const loginEmail = String(process.env.LOAD_TEST_EMAIL || process.env.ADMIN_EMAIL).trim().toLowerCase();

const loginRes = await callApi(authHandler, {
  action: 'login',
  email: loginEmail,
  password
});
if (loginRes.status !== 200 || !loginRes.body.session?.access_token) {
  console.error('Login failed:', loginRes);
  process.exit(1);
}
const token = loginRes.body.session.access_token;

const timings = new Map();
let totalRequests = 0;
let totalErrors = 0;

async function measure(label, fn) {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  totalRequests++;
  if (out.status !== 200) {
    totalErrors++;
    console.error(`[ERROR] ${label}: HTTP ${out.status}`, out.body?.error || out.body);
  }
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
  return out;
}

async function simulateUserSession() {
  await Promise.all([
    measure('tx_page50_exact', () => callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      count: 'exact',
      orders: [{ column: 'payment_date', ascending: false }, { column: 'id', ascending: false }],
      range: { from: 0, to: 49 }
    }, token)),

    measure('get_dashboard_summary', () => callApi(rpcHandler, {
      fn: 'get_dashboard_summary',
      args: { start_date: '2020-01-01', end_date: '2027-01-01', group_col: 'date', status_filter: 'all' }
    }, token)),

    measure('get_unresolved_tx_count', () => callApi(rpcHandler, {
      fn: 'get_unresolved_tx_count',
      args: {}
    }, token)),

    measure('get_student_master_version', () => callApi(rpcHandler, {
      fn: 'get_student_master_version',
      args: {}
    }, token)),

    measure('get_distinct_values', () => callApi(rpcHandler, {
      fn: 'get_distinct_transaction_values',
      args: { col_name: 'bank' }
    }, token)),

    measure('filtered_or_search', () => callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      filters: [
        { op: 'or', value: 'student_id.ilike.%2024%,reference_number.ilike.%2024%,item_name.ilike.%Tuition%' }
      ],
      orders: [{ column: 'payment_date', ascending: false }],
      range: { from: 0, to: 49 }
    }, token)),

    measure('export_chunk_4000', () => callApi(queryHandler, {
      table: 'transactions',
      operation: 'select',
      columns: 'id,reference_number,payment_date,student_id,student_level,item_name,item_price,mapping,second_mapping,bank,id_status,is_settled',
      orders: [{ column: 'id', ascending: true }],
      range: { from: 0, to: 3999 }
    }, token))
  ]);
}

console.log(`Starting ${CONCURRENT_USERS}-user read-only concurrency load test against the --target Turso database...`);
const wallStart = performance.now();

await Promise.all(Array.from({ length: CONCURRENT_USERS }, () => simulateUserSession()));

const wallMs = Math.round(performance.now() - wallStart);

console.log('\n--- 10-User Turso Load Test Summary ---');
console.log(`Concurrent users: ${CONCURRENT_USERS} | Total requests: ${totalRequests} | Errors: ${totalErrors} | Wall time: ${wallMs}ms`);
for (const [label, list] of timings.entries()) {
  const sorted = [...list].sort((a, b) => a - b);
  const min = sorted[0];
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  console.log(`${label.padEnd(28)} min=${min}ms  p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
}

if (totalErrors > 0) {
  process.exit(1);
}
