/**
 * Reset password for every user with role `guard`.
 * Run: cd backend && node scripts/resetGuardPasswords.js
 * Optional: GUARD_PASSWORD=yourPassword node scripts/resetGuardPasswords.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { getPool } from '../src/db/pool.js';
import { hashPassword } from '../src/utils/password.js';

const DEFAULT_PASSWORD = '1@Lunar';

async function run() {
  const password = process.env.GUARD_PASSWORD?.trim() || DEFAULT_PASSWORD;
  if (!password.length) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.warn(
      `Warning: password is ${password.length} characters (web "create user" requires 8+). Login still works.`
    );
  }

  const pool = getPool();
  const [[roleRow]] = await pool.query(`SELECT id FROM roles WHERE slug = 'guard' LIMIT 1`);
  if (!roleRow) {
    console.error('Guard role not found — run migrations first.');
    process.exit(1);
  }

  const [guards] = await pool.query(
    `SELECT u.id, u.email, u.status
     FROM users u
     WHERE u.role_id = ?
     ORDER BY u.email`,
    [roleRow.id]
  );

  if (!guards.length) {
    console.log('No guard accounts found.');
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(password);
  const ids = guards.map((g) => g.id);
  const placeholders = ids.map(() => '?').join(',');

  await pool.query(`UPDATE users SET password_hash = ? WHERE role_id = ?`, [passwordHash, roleRow.id]);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id IN (${placeholders}) AND revoked_at IS NULL`,
    ids
  );

  console.log(`Updated ${guards.length} guard account(s). Active sessions revoked.`);
  console.log('Guards can sign in with their email and the new password.');
  for (const g of guards) {
    console.log(`  - ${g.email} (${g.status})`);
  }

  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
