import crypto from 'node:crypto';
import { getDb, readJsonBody, sendJson, sendServerError, withDbRetry } from './_lib/db.js';
import {
  buildSessionCookie,
  bumpTokenVersion,
  createJwt,
  getAuthUser,
  getTokenVersion,
  hashPasswordAsync,
  isLegacyBcryptHash,
  PRIMARY_ADMIN_EMAIL,
  verifyPassword
} from './_lib/auth.js';

// Login throttling: failed attempts per email and per client IP in a sliding 15-minute window.
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES_PER_EMAIL = 5;
export const LOGIN_MAX_FAILURES_PER_IP = 20;

// Only the primary admin may set the primary admin's password. Any other admin doing it
// (reset, or "create" over the existing login) could take over the owner account, which the
// app always treats as admin and which cannot be deactivated or deleted.
function refusePrimaryAdminTarget(res, actor, targetEmail) {
  if (targetEmail === PRIMARY_ADMIN_EMAIL && actor.email !== PRIMARY_ADMIN_EMAIL) {
    sendJson(res, 403, { error: 'Only the primary admin can change the primary admin account.' });
    return true;
  }
  return false;
}

/** Client IP: first hop of x-forwarded-for (set by the Vercel edge), else the socket address. */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  const first = String(Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();
  return first || String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
}

function isMissingTableError(err) {
  return /no such table/i.test(String(err?.message || ''));
}

/** Returns seconds until the key may try again, or 0 if it is not locked. */
function lockSecondsLeft(row, max, now) {
  if (!row) return 0;
  const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : NaN;
  if (Number.isFinite(lockedUntil) && lockedUntil > now) return Math.ceil((lockedUntil - now) / 1000);
  const windowStart = Date.parse(row.window_start);
  if (Number.isFinite(windowStart) && now - windowStart < LOGIN_WINDOW_MS && Number(row.count) >= max) {
    return Math.ceil((windowStart + LOGIN_WINDOW_MS - now) / 1000);
  }
  return 0;
}

async function readAttempts(db, keys) {
  const res = await withDbRetry(() => db.execute({
    sql: `SELECT key, count, window_start, locked_until FROM login_attempts WHERE key IN (${keys.map(() => '?').join(', ')})`,
    args: keys
  }));
  return new Map(res.rows.map(r => [r.key, r]));
}

async function recordFailure(db, entries, now) {
  const stmts = entries.map(({ key, max, row }) => {
    const windowStart = row ? Date.parse(row.window_start) : NaN;
    const inWindow = Number.isFinite(windowStart) && now - windowStart < LOGIN_WINDOW_MS;
    const start = inWindow ? windowStart : now;
    const count = inWindow ? Number(row.count || 0) + 1 : 1;
    const lockedUntil = count >= max ? new Date(start + LOGIN_WINDOW_MS).toISOString() : null;
    return {
      sql: `INSERT INTO login_attempts (key, count, window_start, locked_until) VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until`,
      args: [key, count, new Date(start).toISOString(), lockedUntil]
    };
  });
  await withDbRetry(() => db.batch(stmts, 'write'));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const db = getDb();
    const body = await readJsonBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    const cookieOnly = String(req.headers?.['x-fawry-cookie-auth'] || req.headers?.['X-Fawry-Cookie-Auth'] || '') === '1';

    if (action === 'session') {
      const user = await getAuthUser(req, db);
      if (!user || !user.isActive || user.role === 'none') {
        return sendJson(res, 200, { session: null });
      }
      if (cookieOnly) {
        return sendJson(res, 200, {
          session: {
            cookie_auth: true,
            user: { id: user.id, email: user.email, role: user.role }
          }
        });
      }
      const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
      const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
      return sendJson(res, 200, {
        session: {
          access_token: token,
          user: { id: user.id, email: user.email, role: user.role }
        }
      });
    }

    if (action === 'logout') {
      // Revokes every outstanding token of this login (all devices), not just this one.
      const user = await getAuthUser(req, db);
      if (user) await bumpTokenVersion(db, user.email);
      res.setHeader('Set-Cookie', buildSessionCookie('', req, { clear: true }));
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return sendJson(res, 400, { error: 'Email and password are required.' });
      }

      const now = Date.now();
      const emailKey = `email:${email}`;
      const ipKey = `ip:${clientIp(req)}`;
      let attempts = null;
      try {
        attempts = await readAttempts(db, [emailKey, ipKey]);
      } catch (err) {
        // Fail open only while the table has not been migrated yet (deploy ordering).
        if (!isMissingTableError(err)) throw err;
        console.error('[auth] login_attempts table missing; run scripts/turso_setup.mjs to enable login throttling.');
      }
      if (attempts) {
        const wait = Math.max(
          lockSecondsLeft(attempts.get(emailKey), LOGIN_MAX_FAILURES_PER_EMAIL, now),
          lockSecondsLeft(attempts.get(ipKey), LOGIN_MAX_FAILURES_PER_IP, now)
        );
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return sendJson(res, 429, { error: 'Too many failed sign-in attempts. Try again later.' });
        }
      }

      const userRes = await withDbRetry(() => db.execute({
        sql: 'SELECT id, email, password_hash FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
        args: [email]
      }));

      // Unknown email still runs a full (dummy) scrypt verify so timing does not reveal accounts.
      const passwordOk = await verifyPassword(password, userRes.rows[0]?.password_hash || null);
      if (!userRes.rows.length || !passwordOk) {
        if (attempts) {
          await recordFailure(db, [
            { key: emailKey, max: LOGIN_MAX_FAILURES_PER_EMAIL, row: attempts.get(emailKey) },
            { key: ipKey, max: LOGIN_MAX_FAILURES_PER_IP, row: attempts.get(ipKey) }
          ], now);
        }
        return sendJson(res, 401, { error: 'Invalid login credentials.' });
      }
      if (attempts && attempts.has(emailKey)) {
        // Only the email counter resets: one valid account must not let an IP clear its own
        // counter between guesses at other accounts.
        await withDbRetry(() => db.execute({ sql: 'DELETE FROM login_attempts WHERE key = ?', args: [emailKey] })).catch(() => {});
      }

      const dbUser = userRes.rows[0];
      let role = 'none';
      let isActive = false;

      if (email === PRIMARY_ADMIN_EMAIL) {
        role = 'admin';
        isActive = true;
      } else {
        const roleRes = await withDbRetry(() => db.execute({
          sql: 'SELECT role, is_active FROM user_roles WHERE LOWER(TRIM(email)) = ? LIMIT 1',
          args: [email]
        }));
        if (roleRes.rows.length) {
          isActive = roleRes.rows[0].is_active !== 0 && roleRes.rows[0].is_active !== false;
          role = isActive ? String(roleRes.rows[0].role || 'viewer') : 'deactivated';
        }
      }

      if (!isActive || role === 'deactivated') {
        return sendJson(res, 403, { error: 'Your account has been deactivated. Contact an administrator.' });
      }
      if (role === 'none') {
        return sendJson(res, 403, { error: 'Your account does not have an assigned role yet. Contact an administrator.' });
      }

      if (isLegacyBcryptHash(dbUser.password_hash)) {
        const upgraded = await hashPasswordAsync(password);
        await withDbRetry(() => db.execute({
          sql: "UPDATE app_users SET password_hash = ?, last_sign_in_at = datetime('now') WHERE id = ?",
          args: [upgraded, dbUser.id]
        })).catch(() => {});
      } else {
        await withDbRetry(() => db.execute({
          sql: "UPDATE app_users SET last_sign_in_at = datetime('now') WHERE id = ?",
          args: [dbUser.id]
        })).catch(() => {});
      }

      const tv = await withDbRetry(() => getTokenVersion(db, email));
      const token = createJwt({ sub: dbUser.id, email, tv: tv || 0 });
      res.setHeader('Set-Cookie', buildSessionCookie(token, req));
      return sendJson(res, 200, {
        session: cookieOnly
          ? { cookie_auth: true, user: { id: dbUser.id, email, role } }
          : { access_token: token, user: { id: dbUser.id, email, role } }
      });
    }

    if (action === 'change_password') {
      const user = await getAuthUser(req, db);
      if (!user || !user.isActive) {
        return sendJson(res, 401, { error: 'Authentication required.' });
      }
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 8) {
        return sendJson(res, 400, { error: 'New password must be at least 8 characters.' });
      }

      const userRes = await withDbRetry(() => db.execute({
        sql: 'SELECT id, password_hash FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
        args: [user.email]
      }));
      if (!userRes.rows.length || !(await verifyPassword(currentPassword, userRes.rows[0].password_hash))) {
        return sendJson(res, 401, { error: 'Current password is incorrect.' });
      }

      const newHash = await hashPasswordAsync(newPassword);
      await withDbRetry(() => db.execute({
        sql: 'UPDATE app_users SET password_hash = ? WHERE id = ?',
        args: [newHash, userRes.rows[0].id]
      }));
      // Sign out every other session, then hand this one a fresh token.
      await bumpTokenVersion(db, user.email);
      const tv = await getTokenVersion(db, user.email);
      const token = createJwt({ sub: userRes.rows[0].id, email: user.email, tv: tv || 0 });
      res.setHeader('Set-Cookie', buildSessionCookie(token, req));
      return sendJson(res, 200, {
        ok: true,
        session: cookieOnly
          ? { cookie_auth: true, user: { id: userRes.rows[0].id, email: user.email, role: user.role } }
          : { access_token: token, user: { id: userRes.rows[0].id, email: user.email, role: user.role } }
      });
    }

    if (action === 'admin_create_user') {
      const actor = await getAuthUser(req, db);
      if (!actor || !actor.isActive || actor.role !== 'admin') {
        return sendJson(res, 403, { error: 'Access denied: admin role required.' });
      }
      const targetEmail = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const role = String(body.role || 'viewer').trim().toLowerCase();
      if (!targetEmail || !targetEmail.includes('@')) {
        return sendJson(res, 400, { error: 'Valid email is required.' });
      }
      if (password.length < 8) {
        return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      }
      if (!['viewer', 'operator', 'accountant', 'admin'].includes(role)) {
        return sendJson(res, 400, { error: 'Invalid role.' });
      }
      if (refusePrimaryAdminTarget(res, actor, targetEmail)) return;

      const id = crypto.randomUUID();
      const hash = await hashPasswordAsync(password);
      const existing = await getTokenVersion(db, targetEmail);
      const stmts = [
        {
          sql: `INSERT INTO app_users (id, email, password_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
          args: [id, targetEmail, hash]
        },
        {
          sql: `INSERT INTO user_roles (email, role, is_active, updated_by, updated_at)
                VALUES (?, ?, 1, ?, datetime('now'))
                ON CONFLICT(email) DO UPDATE SET role = excluded.role, is_active = 1, updated_by = excluded.updated_by, updated_at = datetime('now')`,
          args: [targetEmail, role, actor.email]
        }
      ];
      await withDbRetry(() => db.batch(stmts, 'write'));
      // Overwriting an existing login's password: its old sessions must not survive.
      if (existing !== null) await bumpTokenVersion(db, targetEmail);
      return sendJson(res, 200, { ok: true, email: targetEmail, role });
    }

    if (action === 'admin_reset_password') {
      const actor = await getAuthUser(req, db);
      if (!actor || !actor.isActive || actor.role !== 'admin') {
        return sendJson(res, 403, { error: 'Access denied: admin role required.' });
      }
      const targetEmail = String(body.email || '').trim().toLowerCase();
      const newPassword = String(body.newPassword || '');
      if (!targetEmail || newPassword.length < 8) {
        return sendJson(res, 400, { error: 'Valid email and password (8+ chars) are required.' });
      }
      if (refusePrimaryAdminTarget(res, actor, targetEmail)) return;
      const hash = await hashPasswordAsync(newPassword);
      const resUpd = await withDbRetry(() => db.execute({
        sql: 'UPDATE app_users SET password_hash = ? WHERE LOWER(TRIM(email)) = ?',
        args: [hash, targetEmail]
      }));
      if (resUpd.rowsAffected === 0) {
        await withDbRetry(() => db.execute({
          sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
          args: [crypto.randomUUID(), targetEmail, hash]
        }));
      } else {
        await bumpTokenVersion(db, targetEmail);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { error: 'Unknown auth action.' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) {
      return sendServerError(res, err, 'api/auth');
    }
    return sendJson(res, status, { error: err.message || 'Authentication error' });
  }
}

