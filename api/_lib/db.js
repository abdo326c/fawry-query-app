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
