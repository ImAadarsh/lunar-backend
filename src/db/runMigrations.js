/**
 * Idempotent migrations. 001: skip destructive replay if DB already provisioned.
 * Later migrations (002+): additive SQL files only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split `.sql` into statements on `;` outside single-quoted strings (mysql2: one query per call).
 * Handles SQL escaped quotes as `''` inside strings.
 */
function splitSqlStatements(sql) {
  const kept = [];
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line)) continue;
    kept.push(line);
  }
  const text = kept.join('\n');
  const statements = [];
  let cur = '';
  let inSingle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inSingle) {
      cur += c;
      if (c === "'" && next === "'") {
        cur += next;
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      continue;
    }
    if (c === ';') {
      const s = cur.trim();
      if (s) statements.push(s);
      cur = '';
      continue;
    }
    cur += c;
  }
  const rest = cur.trim();
  if (rest) statements.push(rest);
  return statements;
}

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_migration_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function isMigrationApplied(conn, name) {
  const [rows] = await conn.query(
    'SELECT 1 FROM schema_migrations WHERE name = ? LIMIT 1',
    [name]
  );
  return rows.length > 0;
}

async function recordMigration(conn, name) {
  await conn.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [name]);
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return rows.length > 0;
}

async function applyMigrationFile(conn, name, filename) {
  if (await isMigrationApplied(conn, name)) {
    console.log(`Migration ${name} already applied — skipping.`);
    return;
  }
  const markerTable =
    name === '002_user_site_access'
      ? 'user_site_access'
      : name === '003_payroll_export_enhancements'
        ? 'payroll_lines'
        : name === '005_leave_requests_notifications'
          ? 'leave_requests'
        : name === '006_backend_requirements'
          ? 'command_events'
        : name === '007_remaining_features'
          ? 'patrol_routes'
        : null;
  if (markerTable && (await tableExists(conn, markerTable))) {
    console.log(`Table ${markerTable} exists — recording ${name} without re-run.`);
    await recordMigration(conn, name);
    return;
  }
  const sqlPath = path.join(__dirname, '../../sql', filename);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log(`Applying ${name}...`);
  const statements = splitSqlStatements(sql);
  for (const stmt of statements) {
    await conn.query(stmt);
  }
  await recordMigration(conn, name);
  console.log(`Migration ${name} done.`);
}

async function run() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await ensureMigrationsTable(conn);

    const name001 = '001_initial_schema';
    if (!(await isMigrationApplied(conn, name001))) {
      const rolesExists = await tableExists(conn, 'roles');
      if (rolesExists) {
        console.log('Recording 001_initial_schema (DB already provisioned).');
        await recordMigration(conn, name001);
      } else {
        const sqlPath = path.join(__dirname, '../../sql/001_initial_schema.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log('Applying 001_initial_schema from file...');
        for (const stmt of splitSqlStatements(sql)) {
          await conn.query(stmt);
        }
        await recordMigration(conn, name001);
        console.log('Migration 001_initial_schema applied.');
      }
    } else {
      console.log('Migration 001_initial_schema already recorded — skipping.');
    }

    await applyMigrationFile(conn, '002_user_site_access', '002_user_site_access.sql');
    await applyMigrationFile(conn, '003_payroll_export_enhancements', '003_payroll_export_enhancements.sql');
    await applyMigrationFile(conn, '004_guard_mvp_indexes', '004_guard_mvp_indexes.sql');
    await applyMigrationFile(conn, '005_leave_requests_notifications', '005_leave_requests_notifications.sql');
    await applyMigrationFile(conn, '006_backend_requirements', '006_backend_requirements.sql');
    await applyMigrationFile(conn, '007_remaining_features', '007_remaining_features.sql');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
