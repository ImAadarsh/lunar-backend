import { getPool } from '../db/pool.js';

let tableChecked = false;
let tableExistsCache = false;

async function userSiteAccessTableExists(pool) {
  if (tableChecked) return tableExistsCache;
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_site_access'`
  );
  tableExistsCache = rows.length > 0;
  tableChecked = true;
  return tableExistsCache;
}

/**
 * If supervisor has any rows in user_site_access, only those site IDs are allowed.
 * If the table is missing or the supervisor has no rows, returns null (no restriction).
 * @returns {Promise<number[] | null>}
 */
export async function supervisorAllowedSiteIds(userId, role) {
  if (role !== 'supervisor') return null;
  const pool = getPool();
  if (!(await userSiteAccessTableExists(pool))) return null;
  const [rows] = await pool.query(
    `SELECT site_id AS siteId FROM user_site_access WHERE user_id = ?`,
    [userId]
  );
  if (!rows.length) return null;
  return rows.map((r) => Number(r.siteId));
}

export async function supervisorCanAccessSite(userId, role, siteId) {
  const allowed = await supervisorAllowedSiteIds(userId, role);
  if (allowed === null) return true;
  return allowed.includes(Number(siteId));
}
