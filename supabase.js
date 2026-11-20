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

async function apiFetch(path, payload) {
  const token = getStoredToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {})
  });

  let json = {};
  try {
    json = await res.json();
  } catch {
    json = { error: `HTTP ${res.status}` };
  }

  if (!res.ok) {
    return { data: null, count: null, error: { message: json.error || `HTTP ${res.status}`, status: res.status } };
  }
  return { data: json.data ?? null, count: json.count ?? null, error: null, _raw: json };
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
