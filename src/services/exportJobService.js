import { DEFAULT_PAY_PENCE_HOUR } from './payrollUk.js';

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} type
 * @param {Record<string, unknown>} params
 */
export async function buildExportCsv(pool, type, params) {
  const from = typeof params.from === 'string' ? params.from : null;
  const to = typeof params.to === 'string' ? params.to : null;

  if (type === 'users' || type === 'staff_directory') {
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.phone, u.status, r.slug AS role, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`
    );
    const data = rows.map((r) => [
      r.id,
      r.email,
      r.phone ?? '',
      r.status,
      r.role,
      r.created_at,
    ]);
    return rowsToCsv(['id', 'email', 'phone', 'status', 'role', 'created_at'], data);
  }

  if (type === 'audit_logs' || type === 'audit') {
    const limit = Math.min(5000, Math.max(1, Number(params.limit) || 500));
    const [rows] = await pool.query(
      `SELECT id, user_id, action, entity_type, entity_id, created_at FROM audit_logs ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    const data = rows.map((r) => [
      r.id,
      r.user_id ?? '',
      r.action,
      r.entity_type,
      r.entity_id ?? '',
      r.created_at,
    ]);
    return rowsToCsv(['id', 'user_id', 'action', 'entity_type', 'entity_id', 'created_at'], data);
  }

  if (type === 'attendance' || type === 'attendance_sessions') {
    if (!from || !to) {
      return rowsToCsv(['error'], [['params.from and params.to (YYYY-MM-DD) are required for attendance export']]);
    }
    const [rows] = await pool.query(
      `SELECT a.id, a.user_id, a.shift_id, a.check_in_at, a.check_out_at, a.status
       FROM attendance_sessions a
       WHERE a.check_in_at < ? AND (a.check_out_at IS NULL OR a.check_out_at >= ?)
       ORDER BY a.id DESC LIMIT 10000`,
      [`${to} 23:59:59`, `${from} 00:00:00`]
    );
    const data = rows.map((r) => [
      r.id,
      r.user_id,
      r.shift_id,
      r.check_in_at,
      r.check_out_at ?? '',
      r.status,
    ]);
    return rowsToCsv(['id', 'user_id', 'shift_id', 'check_in_at', 'check_out_at', 'status'], data);
  }

  if (type === 'incidents') {
    const [rows] = await pool.query(
      `SELECT id, user_id, site_id, category, title, status, created_at FROM incidents ORDER BY id DESC LIMIT 5000`
    );
    const data = rows.map((r) => [
      r.id,
      r.user_id,
      r.site_id,
      r.category,
      r.title,
      r.status,
      r.created_at,
    ]);
    return rowsToCsv(['id', 'user_id', 'site_id', 'category', 'title', 'status', 'created_at'], data);
  }

  if (type === 'sites') {
    const [rows] = await pool.query(
      `SELECT id, name, address, center_lat, center_lng, geofence_radius_m, is_active FROM sites ORDER BY id`
    );
    const data = rows.map((r) => [
      r.id,
      r.name,
      r.address ?? '',
      r.center_lat,
      r.center_lng,
      r.geofence_radius_m ?? '',
      r.is_active,
    ]);
    return rowsToCsv(['id', 'name', 'address', 'center_lat', 'center_lng', 'geofence_radius_m', 'is_active'], data);
  }

  if (type === 'staffing_utilization') {
    if (!from || !to) {
      return rowsToCsv(['error'], [['params.from and params.to (YYYY-MM-DD) are required for staffing_utilization export']]);
    }
    const [rows] = await pool.query(
      `SELECT u.id AS user_id, u.email,
              COUNT(DISTINCT s.id) AS scheduled_shifts,
              COALESCE(SUM(TIMESTAMPDIFF(MINUTE, a.check_in_at, a.check_out_at)) / 60.0, 0) AS worked_hours,
              SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS attended_sessions
       FROM users u
       JOIN roles r ON r.id = u.role_id AND r.slug = 'guard'
       LEFT JOIN shifts s
         ON s.user_id = u.id
        AND s.starts_at <= ?
        AND s.ends_at >= ?
       LEFT JOIN attendance_sessions a
         ON a.shift_id = s.id
        AND a.status = 'closed'
       GROUP BY u.id, u.email
       ORDER BY worked_hours DESC, u.email`,
      [`${to} 23:59:59`, `${from} 00:00:00`]
    );
    const data = rows.map((r) => [
      r.user_id,
      r.email,
      r.scheduled_shifts,
      Number(r.worked_hours).toFixed(2),
      r.attended_sessions,
    ]);
    return rowsToCsv(['user_id', 'email', 'scheduled_shifts', 'worked_hours', 'attended_sessions'], data);
  }

  if (type === 'patrol_compliance') {
    if (!from || !to) {
      return rowsToCsv(['error'], [['params.from and params.to (YYYY-MM-DD) are required for patrol_compliance export']]);
    }
    const [rows] = await pool.query(
      `SELECT si.id AS site_id, si.name AS site_name, c.id AS checkpoint_id, c.label,
              COUNT(ps.id) AS scans,
              MAX(ps.scanned_at) AS last_scan_at
       FROM checkpoints c
       JOIN sites si ON si.id = c.site_id
       LEFT JOIN patrol_scans ps
         ON ps.checkpoint_id = c.id
        AND ps.scanned_at BETWEEN ? AND ?
       GROUP BY si.id, si.name, c.id, c.label
       ORDER BY si.name, c.sort_order, c.id`,
      [`${from} 00:00:00`, `${to} 23:59:59`]
    );
    const data = rows.map((r) => [
      r.site_id,
      r.site_name,
      r.checkpoint_id,
      r.label,
      r.scans,
      r.last_scan_at ?? '',
      Number(r.scans) > 0 ? 'scanned' : 'missed',
    ]);
    return rowsToCsv(['site_id', 'site_name', 'checkpoint_id', 'label', 'scans', 'last_scan_at', 'status'], data);
  }

  if (type === 'payroll_variance') {
    const [rows] = await pool.query(
      `SELECT pr.id AS payroll_run_id, pr.period_start, pr.period_end, pr.status,
              pl.user_id, u.email, pl.hours_worked, pl.gross_pence, pl.net_pence,
              JSON_EXTRACT(pl.meta_json, '$.baseGrossPence') AS base_gross_pence,
              JSON_EXTRACT(pl.meta_json, '$.adjustmentPence') AS adjustment_pence
       FROM payroll_lines pl
       JOIN payroll_runs pr ON pr.id = pl.payroll_run_id
       JOIN users u ON u.id = pl.user_id
       ORDER BY pr.id DESC, u.email
       LIMIT 10000`
    );
    const data = rows.map((r) => [
      r.payroll_run_id,
      r.period_start,
      r.period_end,
      r.status,
      r.user_id,
      r.email,
      r.hours_worked,
      r.base_gross_pence ?? '',
      r.adjustment_pence ?? '',
      r.gross_pence,
      r.net_pence,
    ]);
    return rowsToCsv(
      [
        'payroll_run_id',
        'period_start',
        'period_end',
        'status',
        'user_id',
        'email',
        'hours_worked',
        'base_gross_pence',
        'adjustment_pence',
        'gross_pence',
        'net_pence',
      ],
      data
    );
  }

  if (type === 'bacs_stub' || type === 'bacs_payments') {
    const [rows] = await pool.query(
      `SELECT u.id, u.email,
              COALESCE(u.pay_rate_pence_hour, ?) AS pay_pence_hr
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'guard' AND u.status = 'active'`,
      [DEFAULT_PAY_PENCE_HOUR]
    );
    const lines = [
      'BACS_GENERIC_STUB_V1',
      'SortCode,AccountNumber,AmountPence,Reference,UserId',
    ];
    for (const r of rows) {
      lines.push(
        ['00-00-00', '00000000', '0', csvEscape(`PAY_${r.id}`), r.id].join(',')
      );
    }
    return `${lines.join('\n')}\n`;
  }

  return rowsToCsv(['message'], [[`Unknown export type "${type}" — use users, audit_logs, attendance, incidents, sites, staffing_utilization, patrol_compliance, payroll_variance, or bacs_stub`]]);
}
