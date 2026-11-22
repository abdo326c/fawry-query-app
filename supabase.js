// Turso + Vercel API client adapter implementing the Supabase JS client interface.
// Keeps all existing frontend queries (.from, .rpc, .auth) working without rewriting every module.

const TOKEN_STORAGE_KEY = 'fawry_turso_token';

function getApiBase() {
  if (typeof window !== 'undefined' && window.__FAWRY_API_BASE__) {
    return String(window.__FAWRY_API_BASE__).replace(/\/+$/, '');
  }
  return '';
}

function getStoredToken() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function setStoredToken(token) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* ignore storage errors */
  }
}

const RETRY_DELAYS_MS = [200, 600, 1400];
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_MSG_RE = /locked|busy|timeout|econnreset|fetch failed/i;
// For writes, only retry when the server certainly did NOT apply the request: rate-limited /
// unavailable before running it, or SQLite refused the write because the database was locked.
// A dropped connection, a gateway timeout (502/504) or a "timeout" error may come AFTER the
// write committed, and re-sending it would insert audit rows, settlement runs or payments twice.
const WRITE_SAFE_HTTP_STATUSES = new Set([429, 503]);
const WRITE_SAFE_MSG_RE = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i;
const READ_ONLY_RPCS = new Set([
  'get_dashboard_pivot', 'get_dashboard_pivot_by', 'get_dashboard_summary',
  'get_distinct_transaction_values', 'get_keyset_bounds', 'get_unresolved_tx_count',
  'get_student_master_version', 'get_database_storage_stats', 'detect_double_payments'
]);

export function isIdempotentRequest(path, payload) {
  if (String(path).endsWith('/api/query')) return String(payload?.operation || 'select').toLowerCase() === 'select';
  if (String(path).endsWith('/api/rpc')) return READ_ONLY_RPCS.has(payload?.fn);
  if (String(path).endsWith('/api/auth')) return payload?.action === 'session';
  return false;
}

async function apiFetch(path, payload) {
  const idempotent = isIdempotentRequest(path, payload);
  const token = getStoredToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${getApiBase()}${path}`;
  const body = JSON.stringify(payload || {});
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (networkErr) {
      if (idempotent && attempt < RETRY_DELAYS_MS.length) {
        const jitter = Math.floor(Math.random() * 80);
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
        continue;
      }
      return { data: null, count: null, error: { message: networkErr?.message || 'Network request failed', status: 0 } };
    }

    let json = {};
    try {
      json = await res.json();
    } catch {
      json = { error: `HTTP ${res.status}` };
    }

    if (res.ok) {
      return { data: json.data ?? null, count: json.count ?? null, error: null, _raw: json };
    }

    const errMsg = json.error || `HTTP ${res.status}`;
    const shouldRetry = attempt < RETRY_DELAYS_MS.length && (idempotent
      ? (TRANSIENT_HTTP_STATUSES.has(res.status) || (res.status === 500 && TRANSIENT_MSG_RE.test(errMsg)))
      : (WRITE_SAFE_HTTP_STATUSES.has(res.status) || (res.status === 500 && WRITE_SAFE_MSG_RE.test(errMsg))));
    if (shouldRetry) {
      const jitter = Math.floor(Math.random() * 80);
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt] + jitter));
      continue;
    }

    return { data: null, count: null, error: { message: errMsg, status: res.status } };
  }

  return { data: null, count: null, error: { message: 'Request failed after retries', status: 500 } };
}

class TursoQueryBuilder {
  constructor(table) {
    this._payload = {
      table,
      operation: 'select',
      columns: '*',
      filters: [],
      orders: [],
      limit: null,
      range: null,
      count: null,
      head: false,
      single: false,
      maybeSingle: false,
      returning: null,
      values: null,
      onConflict: null,
      ignoreDuplicates: false
    };
  }

  select(columns = '*', opts = {}) {
    if (this._payload.operation === 'select') {
      this._payload.columns = columns || '*';
      if (opts?.count) this._payload.count = opts.count;
      if (opts?.head) this._payload.head = true;
    } else {
      // Chained .select() after insert/upsert/update/delete
      this._payload.returning = columns || '*';
    }
    return this;
  }

  insert(values) {
    this._payload.operation = 'insert';
    this._payload.values = values;
    return this;
  }

  upsert(values, opts = {}) {
    this._payload.operation = 'upsert';
    this._payload.values = values;
    if (opts?.onConflict) this._payload.onConflict = opts.onConflict;
    if (opts?.ignoreDuplicates) this._payload.ignoreDuplicates = true;
    return this;
  }

  update(values) {
    this._payload.operation = 'update';
    this._payload.values = values;
    return this;
  }

  delete() {
    this._payload.operation = 'delete';
    return this;
  }

  eq(column, value) { this._payload.filters.push({ op: 'eq', column, value }); return this; }
  neq(column, value) { this._payload.filters.push({ op: 'neq', column, value }); return this; }
  gt(column, value) { this._payload.filters.push({ op: 'gt', column, value }); return this; }
  gte(column, value) { this._payload.filters.push({ op: 'gte', column, value }); return this; }
  lt(column, value) { this._payload.filters.push({ op: 'lt', column, value }); return this; }
  lte(column, value) { this._payload.filters.push({ op: 'lte', column, value }); return this; }
  like(column, value) { this._payload.filters.push({ op: 'like', column, value }); return this; }
  ilike(column, value) { this._payload.filters.push({ op: 'ilike', column, value }); return this; }
  is(column, value) { this._payload.filters.push({ op: 'is', column, value }); return this; }
  in(column, value) { this._payload.filters.push({ op: 'in', column, value }); return this; }
  not(column, innerOp, value) { this._payload.filters.push({ op: 'not', column, innerOp, value }); return this; }
  or(expr) { this._payload.filters.push({ op: 'or', value: expr }); return this; }

  order(column, opts = {}) {
    this._payload.orders.push({
      column,
      ascending: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst
    });
    return this;
  }

  limit(n) { this._payload.limit = n; return this; }
  range(from, to) { this._payload.range = { from, to }; return this; }
  single() { this._payload.single = true; return this; }
  maybeSingle() { this._payload.maybeSingle = true; return this; }

  async _exec() {
    const res = await apiFetch('/api/query', this._payload);
    return { data: res.data, count: res.count, error: res.error };
  }

  then(resolve, reject) {
    return this._exec().then(resolve, reject);
  }
}

const authListeners = new Set();

function notifyAuth(event, session) {
  for (const cb of authListeners) {
    try {
      cb(event, session);
    } catch {
      /* ignore listener errors */
    }
  }
}

export const supabase = {
  isTurso: true,

  from(table) {
    return new TursoQueryBuilder(table);
  },

  async rpc(fn, args = {}) {
    const res = await apiFetch('/api/rpc', { fn, args });
    return { data: res.data, error: res.error };
  },

  auth: {
    async getSession() {
      const token = getStoredToken();
      if (!token) return { data: { session: null }, error: null };
      const res = await apiFetch('/api/auth', { action: 'session' });
      if (res.error) {
        return { data: { session: null }, error: res.error };
      }
      const session = res._raw?.session || null;
      if (!session) setStoredToken(null);
      return { data: { session }, error: null };
    },

    async signInWithPassword({ email, password }) {
      const res = await apiFetch('/api/auth', { action: 'login', email, password });
      if (res.error) {
        return { data: { session: null, user: null }, error: res.error };
      }
      const session = res._raw?.session || null;
      if (session?.access_token) {
        setStoredToken(session.access_token);
        notifyAuth('SIGNED_IN', session);
      }
      return { data: { session, user: session?.user || null }, error: null };
    },

    async signOut() {
      setStoredToken(null);
      notifyAuth('SIGNED_OUT', null);
      await apiFetch('/api/auth', { action: 'logout' }).catch(() => {});
      return { error: null };
    },

    async adminCreateUser({ email, password, role }) {
      const res = await apiFetch('/api/auth', { action: 'admin_create_user', email, password, role });
      return { data: res._raw || null, error: res.error };
    },

    async adminResetPassword({ email, newPassword }) {
      const res = await apiFetch('/api/auth', { action: 'admin_reset_password', email, newPassword });
      return { data: res._raw || null, error: res.error };
    },

    async changePassword({ currentPassword, newPassword }) {
      const res = await apiFetch('/api/auth', { action: 'change_password', currentPassword, newPassword });
      return { data: res._raw || null, error: res.error };
    },

    onAuthStateChange(callback) {
      if (typeof callback === 'function') authListeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe() {
              authListeners.delete(callback);
            }
          }
        }
      };
    }
  },

  // Lightweight stub for realtime channel (Turso uses request/response HTTP)
  channel() {
    const ch = {
      on() { return ch; },
      subscribe() { return ch; }
    };
    return ch;
  },

  removeChannel() {
    return Promise.resolve('ok');
  }
};
