import { getPool } from '../db/pool.js';

/**
 * Stores operational events that the command center can poll or stream.
 *
 * @param {object} event
 * @param {string} event.type
 * @param {number | null} [event.actorUserId]
 * @param {number | null} [event.subjectUserId]
 * @param {number | null} [event.siteId]
 * @param {string | null} [event.entityType]
 * @param {string | number | null} [event.entityId]
 * @param {object | null} [event.payload]
 */
export async function publishCommandEvent(event) {
  const pool = getPool();
  const [r] = await pool.query(
    `INSERT INTO command_events
      (type, actor_user_id, subject_user_id, site_id, entity_type, entity_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event.type,
      event.actorUserId ?? null,
      event.subjectUserId ?? null,
      event.siteId ?? null,
      event.entityType ?? null,
      event.entityId != null ? String(event.entityId) : null,
      event.payload ? JSON.stringify(event.payload) : null,
    ]
  );
  return Number(r.insertId);
}

export async function listCommandEvents({ sinceId = 0, limit = 100, siteId = null } = {}) {
  const pool = getPool();
  const where = ['id > ?'];
  const params = [sinceId];
  if (siteId != null) {
    where.push('site_id = ?');
    params.push(siteId);
  }
  params.push(limit);
  const [rows] = await pool.query(
    `SELECT id, type, actor_user_id AS actorUserId, subject_user_id AS subjectUserId,
            site_id AS siteId, entity_type AS entityType, entity_id AS entityId,
            payload, created_at AS createdAt
     FROM command_events
     WHERE ${where.join(' AND ')}
     ORDER BY id ASC
     LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload ?? null,
  }));
}
