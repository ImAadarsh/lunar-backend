import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

export async function pingDb() {
  const p = getPool();
  const [rows] = await p.query('SELECT 1 AS ok');
  return rows?.[0]?.ok === 1;
}
