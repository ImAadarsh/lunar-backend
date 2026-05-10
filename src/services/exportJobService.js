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

  return rowsToCsv(['message'], [[`Unknown export type "${type}" — use users, audit_logs, attendance, incidents, sites, or bacs_stub`]]);
}
