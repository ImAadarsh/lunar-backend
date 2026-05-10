import { getPool } from '../db/pool.js';

/**
 * @param {object} p
 * @param {number | null} p.userId
 * @param {string} p.action
 * @param {string} p.entityType
 * @param {string | number | null} [p.entityId]
 * @param {object | null} [p.payload]
 * @param {string | null} [p.ip]
 */
export async function writeAudit(p) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      p.userId,
      p.action,
      p.entityType,
      p.entityId != null ? String(p.entityId) : null,
      p.payload ? JSON.stringify(p.payload) : null,
      p.ip ?? null,
    ]
  );
}
