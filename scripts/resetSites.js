/**
 * Remove all sites and related site-scoped data, then insert the standard site catalogue.
 *
 * Usage: cd backend && npm run seed:sites
 */
import dotenv from 'dotenv';
import { getPool } from '../src/db/pool.js';

dotenv.config();

const SITES = [
  {
    name: 'Manchester Airport',
    address: 'Manchester Airport, Manchester M90 1QX, UK',
    centerLat: 53.3537,
    centerLng: -2.275,
    geofenceRadiusM: 800,
  },
  {
    name: 'Manchester Bus Stand',
    address: 'Shudehill Interchange, Manchester M4 2AD, UK',
    centerLat: 53.4854,
    centerLng: -2.2369,
    geofenceRadiusM: 150,
  },
  {
    name: 'Manchester Metro',
    address: 'Piccadilly Gardens, Manchester M1 1RG, UK',
    centerLat: 53.4808,
    centerLng: -2.2374,
    geofenceRadiusM: 200,
  },
  {
    name: 'NYC Theater',
    address: 'Times Square, New York, NY 10036, USA',
    centerLat: 40.758,
    centerLng: -73.9855,
    geofenceRadiusM: 120,
  },
  {
    name: 'Villa House',
    address: 'Villa House, Manchester, UK',
    centerLat: 53.4723,
    centerLng: -2.2485,
    geofenceRadiusM: 100,
  },
];

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function safeDelete(conn, sql) {
  try {
    const [r] = await conn.query(sql);
    return r.affectedRows ?? 0;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return 0;
    throw err;
  }
}

async function clearSiteScopedData(conn) {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  const steps = [
    'DELETE FROM patrol_scans',
    'DELETE FROM visual_log_hours',
    'DELETE FROM gps_points',
    'DELETE FROM attendance_sessions',
    'DELETE FROM shift_swaps',
    'DELETE FROM shifts',
    'DELETE FROM incident_attachments',
    'DELETE FROM incidents',
    'DELETE FROM patrol_route_checkpoints',
    'DELETE FROM patrol_routes',
    'DELETE FROM checkpoints',
    'DELETE FROM guard_site_training',
    'DELETE FROM user_site_access',
    'UPDATE command_events SET site_id = NULL WHERE site_id IS NOT NULL',
    'DELETE FROM sites',
  ];

  for (const sql of steps) {
    if (sql.includes('command_events') && !(await tableExists(conn, 'command_events'))) continue;
    if (sql.includes('guard_site_training') && !(await tableExists(conn, 'guard_site_training'))) continue;
    if (sql.includes('patrol_route') && !(await tableExists(conn, 'patrol_routes'))) continue;
    if (sql.includes('visual_log_hours') && !(await tableExists(conn, 'visual_log_hours'))) continue;
    const n = await safeDelete(conn, sql);
    console.log(`  ${sql.split(' ').slice(0, 2).join(' ')}… ${n} row(s)`);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

async function run() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    console.log('Clearing existing sites and site-linked records…');
    await clearSiteScopedData(conn);

    console.log('Inserting sites…');
    for (const site of SITES) {
      const [r] = await conn.query(
        `INSERT INTO sites (name, address, center_lat, center_lng, geofence_radius_m, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [site.name, site.address, site.centerLat, site.centerLng, site.geofenceRadiusM]
      );
      console.log(`  + ${site.name} (id ${r.insertId})`);
    }

    await conn.commit();
    console.log(`Done. ${SITES.length} sites are active.`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

run();
