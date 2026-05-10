/**
 * Idempotent demo users for Lunar Security (guard app + testing).
 * Run: cd backend && npm run seed:demo
 * Requires: DB migrated, .env with DB_* set.
 */
import dotenv from 'dotenv';
dotenv.config();

import { getPool } from '../src/db/pool.js';
import { hashPassword } from '../src/utils/password.js';

const DEMO_USERS = [
  { email: 'admin@lunarsecurity.demo', password: 'AdminDemo#2026', role: 'admin', phone: '+44 7700 900001' },
  { email: 'supervisor@lunarsecurity.demo', password: 'SuperDemo#2026', role: 'supervisor', phone: '+44 7700 900002' },
  { email: 'guard@lunarsecurity.demo', password: 'GuardDemo#2026', role: 'guard', phone: '+44 7700 900003' },
];

async function run() {
  const pool = getPool();
  for (const u of DEMO_USERS) {
    const [[roleRow]] = await pool.query(`SELECT id FROM roles WHERE slug = ?`, [u.role]);
    if (!roleRow) {
      console.error(`Role ${u.role} missing — run migrations.`);
      process.exit(1);
    }
    const [existing] = await pool.query(`SELECT id FROM users WHERE email = ?`, [u.email]);
    if (existing.length) {
      console.log(`Skip (exists): ${u.email}`);
      continue;
    }
    const password_hash = await hashPassword(u.password);
    await pool.query(
      `INSERT INTO users (email, phone, password_hash, role_id, status) VALUES (?, ?, ?, ?, 'active')`,
      [u.email, u.phone, password_hash, roleRow.id]
    );
    console.log(`Created: ${u.email} (${u.role})`);
  }
  await pool.end();
  console.log('Done.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
