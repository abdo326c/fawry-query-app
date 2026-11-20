import authHandler from '../api/auth.js';
import queryHandler from '../api/query.js';
import rpcHandler from '../api/rpc.js';

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
if (!password) {
  console.error('ADMIN_INITIAL_PASSWORD is required in environment / .env');
  process.exit(1);
}

const loginRes = await callApi(authHandler, {
  action: 'login',
  email: 'ammahmoud@nu.edu.eg',
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

console.log(`Starting ${CONCURRENT_USERS}-user read-only concurrency load test against live Turso...`);
const wallStart = performance.now();

await Promise.all(Array.from({ length: CONCURRENT_USERS }, () => simulateUserSession()));

const wallMs = Math.round(performance.now() - wallStart);

console.log('\n--- 10-User Live Turso Load Test Summary ---');
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
