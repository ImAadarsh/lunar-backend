import { getPool } from '../db/pool.js';

export async function createNotification({ userId, type, title, body = null, payload = null }) {
  const pool = getPool();
  const [r] = await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, body, payload ? JSON.stringify(payload) : null]
  );
  return Number(r.insertId);
}
