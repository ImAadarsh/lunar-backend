/**
 * Processes export_jobs (CSV to disk) and payroll_runs (UK-style illustrative payroll).
 * Run: npm run worker
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { buildExportCsv, writeExportFile } from '../services/exportJobService.js';
import { processPayrollRun } from '../services/payrollRunService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERVAL_MS = 5000;

function exportsDir() {
  const d = env.exportFilesDir || path.join(process.cwd(), 'exports');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function publicDownloadUrl(jobId) {
  const base = env.publicBaseUrl?.replace(/\/$/, '') || '';
  const rel = `/api/v1/reports/exports/${jobId}/file`;
  return base ? `${base}${rel}` : rel;
}

async function tableExists(conn, name) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name]
  );
  return rows.length > 0;
}

async function processExports(conn) {
  const [jobs] = await conn.query(
    `SELECT id, type, output_format AS outputFormat, params FROM export_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 5`
  );
  for (const j of jobs) {
    await conn.query(`UPDATE export_jobs SET status = 'running' WHERE id = ?`, [j.id]);
    try {
      let params = {};
      if (j.params) {
        params = typeof j.params === 'string' ? JSON.parse(j.params) : j.params;
      }
      const csv = await buildExportCsv(conn, j.type, params);
      const dir = exportsDir();
      const outputFormat = ['csv', 'xlsx', 'pdf'].includes(j.outputFormat) ? j.outputFormat : 'csv';
      const filename = `export-${j.id}.${outputFormat}`;
      const absPath = path.join(dir, filename);
      const { mime } = await writeExportFile({ csv, outputFormat, absPath, title: `${j.type} export` });
      const relPath = path.relative(process.cwd(), absPath);
      const fileUrl = publicDownloadUrl(j.id);
      await conn.query(
        `UPDATE export_jobs SET status = 'done', file_url = ?, file_path = ?, file_mime = ?, error_message = NULL WHERE id = ?`,
        [fileUrl, relPath, mime, j.id]
      );
      console.log(`[worker] export_jobs ${j.id} -> done (${relPath})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await conn.query(`UPDATE export_jobs SET status = 'failed', error_message = ? WHERE id = ?`, [
        msg.slice(0, 1000),
        j.id,
      ]);
      console.error(`[worker] export_jobs ${j.id} failed`, e);
    }
  }
}

async function processPayroll(conn) {
  if (!(await tableExists(conn, 'payroll_lines'))) return;

  const [runs] = await conn.query(
    `SELECT id, period_start, period_end FROM payroll_runs WHERE status IN ('draft', 'processing') ORDER BY id ASC LIMIT 3`
  );
  for (const r of runs) {
    try {
      await conn.query(`UPDATE payroll_runs SET status = 'processing' WHERE id = ? AND status = 'draft'`, [r.id]);
      await conn.query(`DELETE FROM payroll_lines WHERE payroll_run_id = ?`, [r.id]);
      await processPayrollRun(conn, r.id, dateStr(r.period_start), dateStr(r.period_end));
      await conn.query(`UPDATE payroll_runs SET status = 'completed' WHERE id = ?`, [r.id]);
      console.log(`[worker] payroll_runs ${r.id} -> completed`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await conn.query(`UPDATE payroll_runs SET status = 'failed', notes = ? WHERE id = ?`, [
        msg.slice(0, 500),
        r.id,
      ]);
      console.error(`[worker] payroll_runs ${r.id} failed`, e);
    }
  }
}

function dateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return String(v);
}

async function tick() {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await processExports(conn);
    await processPayroll(conn);
  } finally {
    conn.release();
  }
}

console.log(`Job worker started (every ${INTERVAL_MS}ms). Ctrl+C to stop.`);
await tick();
setInterval(() => {
  tick().catch((e) => console.error('[worker]', e));
}, INTERVAL_MS);
