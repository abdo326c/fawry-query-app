import crypto from 'node:crypto';

const PRIMARY_ADMIN_EMAIL = 'ammahmoud@nu.edu.eg';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.TURSO_JWT_SECRET;
  if (secret) return secret;
  if (process.env.VERCEL === '1') {
    throw new Error('JWT_SECRET environment variable is required in production.');
  }
  return 'fawry-local-dev-jwt-secret-change-in-prod';
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
 * Hashes a plaintext password using scrypt with a random 16-byte salt.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash.
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const actualBuf = crypto.scryptSync(String(password), salt, 64);
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
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Resolves the authenticated user and their current RBAC role from the request.
 */
export async function getAuthUser(req, db) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const payload = verifyJwt(match[1].trim());
  if (!payload || !payload.email) return null;

  const email = String(payload.email).trim().toLowerCase();
  if (email === PRIMARY_ADMIN_EMAIL) {
    return {
      id: payload.sub || email,
      email,
      role: 'admin',
      isActive: true
    };
  }

  const res = await db.execute({
    sql: 'SELECT role, is_active FROM user_roles WHERE LOWER(TRIM(email)) = ? LIMIT 1',
    args: [email]
  });

  if (!res.rows.length) {
    return { id: payload.sub || email, email, role: 'none', isActive: false };
  }

  const row = res.rows[0];
  const isActive = row.is_active !== 0 && row.is_active !== false;
  return {
    id: payload.sub || email,
    email,
    role: isActive ? String(row.role || 'none') : 'deactivated',
    isActive
  };
}
