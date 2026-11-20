import crypto from 'node:crypto';
import { getDb, readJsonBody, sendJson } from './_lib/db.js';
import { createJwt, getAuthUser, hashPassword, verifyPassword } from './_lib/auth.js';

const PRIMARY_ADMIN_EMAIL = 'ammahmoud@nu.edu.eg';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const db = getDb();
    const body = await readJsonBody(req);
    const action = String(body.action || '').trim().toLowerCase();

    if (action === 'session') {
      const user = await getAuthUser(req, db);
      if (!user || !user.isActive || user.role === 'none') {
        return sendJson(res, 200, { session: null });
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
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return sendJson(res, 400, { error: 'Email and password are required.' });
      }

      const userRes = await db.execute({
        sql: 'SELECT id, email, password_hash FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
        args: [email]
      });

      if (!userRes.rows.length || !verifyPassword(password, userRes.rows[0].password_hash)) {
        return sendJson(res, 401, { error: 'Invalid login credentials.' });
      }

      const dbUser = userRes.rows[0];
      let role = 'none';
      let isActive = false;

      if (email === PRIMARY_ADMIN_EMAIL) {
        role = 'admin';
        isActive = true;
      } else {
        const roleRes = await db.execute({
          sql: 'SELECT role, is_active FROM user_roles WHERE LOWER(TRIM(email)) = ? LIMIT 1',
          args: [email]
        });
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

      await db.execute({
        sql: "UPDATE app_users SET last_sign_in_at = datetime('now') WHERE id = ?",
        args: [dbUser.id]
      });

      const token = createJwt({ sub: dbUser.id, email });
      return sendJson(res, 200, {
        session: {
          access_token: token,
          user: { id: dbUser.id, email, role }
        }
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

      const userRes = await db.execute({
        sql: 'SELECT id, password_hash FROM app_users WHERE LOWER(TRIM(email)) = ? LIMIT 1',
        args: [user.email]
      });
      if (!userRes.rows.length || !verifyPassword(currentPassword, userRes.rows[0].password_hash)) {
        return sendJson(res, 401, { error: 'Current password is incorrect.' });
      }

      await db.execute({
        sql: 'UPDATE app_users SET password_hash = ? WHERE id = ?',
        args: [hashPassword(newPassword), userRes.rows[0].id]
      });
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'admin_create_user') {
      const actor = await getAuthUser(req, db);
      if (!actor || actor.role !== 'admin') {
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

      const id = crypto.randomUUID();
      const hash = hashPassword(password);
      await db.execute({
        sql: `INSERT INTO app_users (id, email, password_hash)
              VALUES (?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
        args: [id, targetEmail, hash]
      });
      await db.execute({
        sql: `INSERT INTO user_roles (email, role, is_active, updated_by, updated_at)
              VALUES (?, ?, 1, ?, datetime('now'))
              ON CONFLICT(email) DO UPDATE SET role = excluded.role, is_active = 1, updated_by = excluded.updated_by, updated_at = datetime('now')`,
        args: [targetEmail, role, actor.email]
      });
      return sendJson(res, 200, { ok: true, email: targetEmail, role });
    }

    if (action === 'admin_reset_password') {
      const actor = await getAuthUser(req, db);
      if (!actor || actor.role !== 'admin') {
        return sendJson(res, 403, { error: 'Access denied: admin role required.' });
      }
      const targetEmail = String(body.email || '').trim().toLowerCase();
      const newPassword = String(body.newPassword || '');
      if (!targetEmail || newPassword.length < 8) {
        return sendJson(res, 400, { error: 'Valid email and password (8+ chars) are required.' });
      }
      const resUpd = await db.execute({
        sql: 'UPDATE app_users SET password_hash = ? WHERE LOWER(TRIM(email)) = ?',
        args: [hashPassword(newPassword), targetEmail]
      });
      if (resUpd.rowsAffected === 0) {
        await db.execute({
          sql: 'INSERT INTO app_users (id, email, password_hash) VALUES (?, ?, ?)',
          args: [crypto.randomUUID(), targetEmail, hashPassword(newPassword)]
        });
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { error: `Unknown auth action: ${action}` });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'Authentication error' });
  }
}
