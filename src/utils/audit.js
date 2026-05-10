import { getPool } from '../db/pool.js';
import { createHash } from 'crypto';

function canonical(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = canonical(value[key]);
      return acc;
    }, {});
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
  const payloadJson = p.payload ? JSON.stringify(canonical(p.payload)) : null;
  try {
    const [[prev]] = await pool.query(`SELECT row_hash AS rowHash FROM audit_logs ORDER BY id DESC LIMIT 1`);
    const prevHash = prev?.rowHash ?? null;
    const rowHash = sha256(
      JSON.stringify({
        prevHash,
        userId: p.userId ?? null,
        action: p.action,
        entityType: p.entityType,
        entityId: p.entityId != null ? String(p.entityId) : null,
        payload: payloadJson,
        ip: p.ip ?? null,
      })
    );
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload, prev_hash, row_hash, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.userId,
        p.action,
        p.entityType,
        p.entityId != null ? String(p.entityId) : null,
        payloadJson,
        prevHash,
        rowHash,
        p.ip ?? null,
      ]
    );
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        p.userId,
        p.action,
        p.entityType,
        p.entityId != null ? String(p.entityId) : null,
        payloadJson,
        p.ip ?? null,
      ]
    );
  }
}
