import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

export const PRIMARY_ADMIN_EMAIL = 'ammahmoud@nu.edu.eg';
export const SESSION_COOKIE_NAME = 'fawry_session';
// Short-lived sessions: a stolen token is useful for at most 12 hours,
// and logout / password change / deactivation revoke it immediately via token_version.
export const TOKEN_TTL_SECONDS = 60 * 60 * 12;

export function parseCookies(req) {
  const raw = req?.headers?.cookie || req?.headers?.Cookie || '';
  const out = {};
  if (!raw || typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function buildSessionCookie(token, req, { clear = false } = {}) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = proto === 'https' || process.env.VERCEL === '1';
  const value = clear ? '' : encodeURIComponent(String(token || ''));
  const maxAge = clear ? 0 : TOKEN_TTL_SECONDS;
  return `${SESSION_COOKIE_NAME}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}`;
}

const scryptAsync = promisify(crypto.scrypt);

/**
 * Kept for backwards compatibility with callers that cleared the old 30 s role cache.
 * getAuthUser now reads role + token_version from the database on every request (two indexed
 * point lookups), so a revoked session or a role change takes effect on the very next request on
 * every serverless instance, not up to 30 s later on instances that had the old value cached.
 */
export function clearRoleCache() {}

function isLocalDatabaseUrl(url) {
  const u = String(url || '').trim();
  return u === ':memory:' || u.startsWith('file:');
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.TURSO_JWT_SECRET;
  if (secret) return secret;
  // The well-known dev secret is only acceptable where nobody else can reach the data: tests and
  // a local SQLite file. Anything else (Vercel, a remote Turso URL, a mis-set env) fails closed
  // instead of signing tokens anyone could forge.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST || isLocalDatabaseUrl(process.env.TURSO_DATABASE_URL)) {
    return 'fawry-local-dev-jwt-secret-change-in-prod';
  }
  throw new Error('JWT_SECRET environment variable is required.');
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Hashes a plaintext password using scrypt with a random 16-byte salt (sync; scripts and tests).
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/**
 * Async variant used by the API so hashing does not block the event loop.
 */
export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(String(password), salt, 64)).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/**
 * Checks whether a stored password hash uses legacy Supabase bcrypt format ($2a$/$2b$/$2y$).
 */
export function isLegacyBcryptHash(storedHash) {
  return typeof storedHash === 'string' && /^\$2[aby]\$\d{2}\$/.test(storedHash);
}

// A valid-format hash of an unknown password: verifying against it costs the same as a real
// verify, so "unknown email" and "wrong password" take about the same time.
const DUMMY_HASH = `scrypt:${crypto.randomBytes(16).toString('hex')}:${crypto.randomBytes(64).toString('hex')}`;

/**
 * Verifies a plaintext password against a stored scrypt or legacy bcrypt hash.
 * A missing storedHash still runs a full (dummy) scrypt verification and returns false.
 */
export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  if (isLegacyBcryptHash(storedHash)) {
    const normalized = storedHash.startsWith('$2y$') ? `$2a$${storedHash.slice(4)}` : storedHash;
    try {
      return await bcrypt.compare(String(password), normalized);
    } catch {
      return false;
    }
  }
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const actualBuf = await scryptAsync(String(password), salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Signs an HS256 JWT token.
 */
export function createJwt(payload, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(
    JSON.stringify({
      ...payload,
      iat: now,
      exp: now + ttlSeconds
    })
  );
  const signingInput = `${header}.${body}`;
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', getJwtSecret()).update(signingInput).digest()
  );
  return `${signingInput}.${sig}`;
}

/**
 * Verifies an HS256 JWT token and returns its decoded payload, or null if invalid/expired.
 */
export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const signingInput = `${header}.${body}`;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', getJwtSecret()).update(signingInput).digest()
  );

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * HMAC over data the server accepted (audit revert payloads), with a key derived from the JWT
 * secret and a purpose label so it can never be confused with a token signature.
 */
export function signServerPayload(purpose, data) {
  const key = crypto.createHmac('sha256', getJwtSecret()).update(`fawry-server-payload:${purpose}`).digest();
  return crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

export function verifyServerPayload(purpose, data, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signServerPayload(purpose, data), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function isMissingColumnError(err) {
  return /no such column/i.test(String(err?.message || ''));
}

/**
 * The login's row id and session version (tv is 0 while the token_version column is not
 * migrated yet), or null if the login does not exist.
 */
export async function getLoginState(db, email) {
  let res;
  try {
    res = await db.execute({
      sql: 'SELECT id, COALESCE(token_version, 0) AS tv FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
      args: [email]
    });
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    res = await db.execute({
      sql: 'SELECT id, 0 AS tv FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
      args: [email]
    });
  }
  if (!res.rows.length) return null;
  return { id: String(res.rows[0].id), tv: Number(res.rows[0].tv || 0) };
}

/** Current session version of a login, or null if the login does not exist. */
export async function getTokenVersion(db, email) {
  const state = await getLoginState(db, email);
  return state ? state.tv : null;
}

/** SQL statement that invalidates every token issued to this login so far. */
export function bumpTokenVersionStmt(email) {
  return {
    sql: 'UPDATE app_users SET token_version = COALESCE(token_version, 0) + 1 WHERE LOWER(TRIM(email)) = ?',
    args: [String(email || '').trim().toLowerCase()]
  };
}

/**
 * Invalidates every token issued to this login so far (logout, password change, deactivation).
 * Only logs (does not fail) while the token_version column is not migrated yet.
 */
export async function bumpTokenVersion(db, email) {
  try {
    await db.execute(bumpTokenVersionStmt(email));
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    console.error('[auth] app_users.token_version is missing; run scripts/turso_setup.mjs to enable session revocation.');
  }
}

/**
 * Single-query lookup for login id, session version, and RBAC role/active state.
 */
export async function getLoginAndRoleState(db, email) {
  let res;
  try {
    res = await db.execute({
      sql: `SELECT u.id, COALESCE(u.token_version, 0) AS tv, r.role AS role, r.is_active AS is_active
            FROM app_users u
            LEFT JOIN user_roles r ON LOWER(TRIM(r.email)) = LOWER(TRIM(u.email))
            WHERE LOWER(TRIM(u.email)) = ?
            LIMIT 1`,
      args: [email]
    });
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    res = await db.execute({
      sql: `SELECT u.id, 0 AS tv, r.role AS role, r.is_active AS is_active
            FROM app_users u
            LEFT JOIN user_roles r ON LOWER(TRIM(r.email)) = LOWER(TRIM(u.email))
            WHERE LOWER(TRIM(u.email)) = ?
            LIMIT 1`,
      args: [email]
    });
  }
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    id: String(row.id),
    tv: Number(row.tv || 0),
    hasRoleRow: row.role !== null && row.role !== undefined,
    role: row.role ?? null,
    isActive: row.is_active
  };
}

/**
 * Resolves the authenticated user and their current RBAC role from the request.
 * Accepts either Authorization: Bearer <jwt> (API/tests) or HttpOnly session cookie
 * (browser requests, which must also carry X-Fawry-Client: 1 as a CSRF guard).
 * Rejects tokens whose `tv` claim no longer matches app_users.token_version (revoked sessions)
 * and tokens of deleted/re-created logins (`sub` must be the current row id). Read from the
 * database on every request in a single indexed join, never cached.
 */
export async function getAuthUser(req, db) {
  let rawToken = null;
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (match) {
    rawToken = match[1].trim();
  } else {
    const cookies = parseCookies(req);
    const cookieToken = cookies[SESSION_COOKIE_NAME];
    if (cookieToken) {
      // CSRF defense-in-depth: cross-site form posts or simple requests cannot attach custom headers.
      const clientHdr = String(req.headers?.['x-fawry-client'] || req.headers?.['X-Fawry-Client'] || '');
      if (clientHdr !== '1') return null;
      rawToken = cookieToken.trim();
    }
  }
  if (!rawToken) return null;

  const payload = verifyJwt(rawToken);
  if (!payload || !payload.email) return null;

  const email = String(payload.email).trim().toLowerCase();
  const login = await getLoginAndRoleState(db, email);
  // Deleted login, a different (re-created) login with the same email, or a revoked session.
  if (!login || String(payload.sub || '') !== login.id || Number(payload.tv || 0) !== login.tv) return null;
  const currentTv = login.tv;

  if (email === PRIMARY_ADMIN_EMAIL) {
    return { id: payload.sub || email, email, role: 'admin', isActive: true, tokenVersion: currentTv };
  }

  if (!login.hasRoleRow) {
    return { id: payload.sub || email, email, role: 'none', isActive: false, tokenVersion: currentTv };
  }

  const isActive = login.isActive !== 0 && login.isActive !== false;
  const resolvedRole = isActive ? String(login.role || 'none') : 'deactivated';
  return { id: payload.sub || email, email, role: resolvedRole, isActive, tokenVersion: currentTv };
}
