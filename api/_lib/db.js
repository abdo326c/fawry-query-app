import { createClient } from '@libsql/client';

let cachedClient = null;

/**
 * Returns the singleton libSQL/Turso client.
 * Uses TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from environment variables.
 */
export function getDb() {
  if (cachedClient) return cachedClient;

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL environment variable is not configured.');
  }

  cachedClient = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined
  });
  return cachedClient;
}

/**
 * Overrides the cached libSQL client (used in local tests).
 */
export function setDbClient(client) {
  cachedClient = client;
}

const RETRYABLE_DB_RE = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|econnreset|etimedout|fetch failed|connect timeout|UND_ERR_CONNECT_TIMEOUT/i;

/**
 * Returns true if an error is a transient SQLite lock or network/transport hiccup.
 */
export function isRetryableDbError(err) {
  if (!err) return false;
  const hay = [
    err.code,
    err.message,
    err.cause?.code,
    err.cause?.message
  ].filter(Boolean).join(' ');
  return RETRYABLE_DB_RE.test(hay);
}

/**
 * Executes a DB operation with jittered exponential backoff for SQLITE_BUSY / transient errors.
 */
export async function withDbRetry(fn, { attempts = 5, baseDelayMs = 60 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbError(err) || i === attempts - 1) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 40);
      const delay = baseDelayMs * (2 ** i) + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// SQLite refuses a write it could not lock BEFORE applying anything, so these are safe to retry.
const WRITE_RETRYABLE_RE = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i;

export function isWriteRetryableDbError(err) {
  if (!err) return false;
  const hay = [err.code, err.message, err.cause?.code, err.cause?.message].filter(Boolean).join(' ');
  return WRITE_RETRYABLE_RE.test(hay);
}

/**
 * Like withDbRetry, but for writes: retries only lock errors. A network/transport error
 * ("fetch failed", ECONNRESET, timeout) can arrive after the write committed, so re-running
 * it could duplicate rows.
 */
export async function withDbWriteRetry(fn, { attempts = 5, baseDelayMs = 60 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isWriteRetryableDbError(err) || i === attempts - 1) throw err;
      const delay = baseDelayMs * (2 ** i) + Math.floor(Math.random() * 40);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Reads and parses a JSON request body safely in Vercel Node.js functions.
 */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * Sends a JSON response with standard headers.
 */
export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}
