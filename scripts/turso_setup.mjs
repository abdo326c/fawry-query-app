import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { hashPassword } from '../api/_lib/auth.js';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('Error: TURSO_DATABASE_URL is required.');
  process.exit(1);
}

const db = createClient({ url, authToken });
const schemaPath = path.resolve(import.meta.dirname, '..', 'turso', 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

console.log('Applying Turso schema...');
await db.executeMultiple(schemaSql);
console.log('Schema applied successfully.');

const adminEmail = (process.env.ADMIN_EMAIL || 'ammahmoud@nu.edu.eg').trim().toLowerCase();
const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;

if (adminPassword) {
  if (adminPassword.length < 8) {
    console.error('Error: ADMIN_INITIAL_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }
  const hash = hashPassword(adminPassword);
  await db.execute({
    sql: `INSERT INTO app_users (id, email, password_hash)
          VALUES (?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
    args: [crypto.randomUUID(), adminEmail, hash]
  });
  console.log(`Admin user ${adminEmail} created/updated.`);
} else {
  console.log('Tip: Set ADMIN_INITIAL_PASSWORD=... to create/reset the initial admin login.');
}
