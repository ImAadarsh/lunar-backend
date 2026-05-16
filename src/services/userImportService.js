import { getPool } from '../db/pool.js';
import { AppError } from '../utils/httpError.js';
import { hashPassword } from '../utils/password.js';
import { writeAudit } from '../utils/audit.js';

function normalizeOptionalString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normalizeDateOnly(v) {
  const s = normalizeOptionalString(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid date: ${s} (use YYYY-MM-DD)`);
  }
  return s;
}

export function parsePayRatePence(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'payRatePenceHour must be a non-negative integer');
  }
  return n;
}

/**
 * @param {object} row
 * @param {number} actorUserId
 * @param {string} [ip]
 */
export async function createUserWithProfile(row, actorUserId, ip) {
  const email = normalizeOptionalString(row.email);
  const password = String(row.password ?? '');
  const role = normalizeOptionalString(row.role) ?? 'guard';
  const status = normalizeOptionalString(row.status) ?? 'active';
  const phone = normalizeOptionalString(row.phone);
  const payRatePenceHour = row.payRatePenceHour !== undefined ? parsePayRatePence(row.payRatePenceHour) : null;

  if (!email) throw new AppError(400, 'VALIDATION_ERROR', 'email is required');
  if (password.length < 8) throw new AppError(400, 'VALIDATION_ERROR', 'password must be at least 8 characters');
  if (!['admin', 'supervisor', 'guard'].includes(role)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'role must be admin, supervisor, or guard');
  }
  if (!['active', 'invited', 'suspended'].includes(status)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'status must be active, invited, or suspended');
  }

  const profile = row.profile ?? {};
  const fullName =
    normalizeOptionalString(profile.fullName ?? row.fullName) ||
    (role === 'guard' ? null : email.split('@')[0]);

  if (role === 'guard' && !fullName) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fullName is required for guard users');
  }

  const pool = getPool();
  const [[roleRow]] = await pool.query(`SELECT id FROM roles WHERE slug = ?`, [role]);
  if (!roleRow) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid role');

  const password_hash = await hashPassword(password);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO users (email, phone, password_hash, role_id, status, pay_rate_pence_hour)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email, phone, password_hash, roleRow.id, status, payRatePenceHour]
    );
    const userId = r.insertId;

    if (role === 'guard' && fullName) {
      await conn.query(
        `INSERT INTO guard_profiles
          (user_id, full_name, given_names, surname, gender, date_of_birth,
           sia_type, sia_number, sia_expiry_date, import_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          fullName,
          normalizeOptionalString(profile.givenNames ?? row.givenNames),
          normalizeOptionalString(profile.surname ?? row.surname),
          normalizeOptionalString(profile.gender ?? row.gender),
          normalizeDateOnly(profile.dateOfBirth ?? row.dateOfBirth),
          normalizeOptionalString(profile.siaType ?? row.siaType),
          normalizeOptionalString(profile.siaNumber ?? row.siaNumber),
          normalizeDateOnly(profile.siaExpiryDate ?? row.siaExpiryDate),
          normalizeOptionalString(row.importSource) ?? 'admin_portal',
        ]
      );
    }

    await conn.commit();
    await writeAudit({
      userId: actorUserId,
      action: 'user.create',
      entityType: 'user',
      entityId: userId,
      payload: { email, role, status },
      ip,
    });
    return { id: userId, email, role, status };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'CONFLICT', `Email already exists: ${email}`);
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * @param {object[]} rows
 * @param {number} actorUserId
 * @param {string} [ip]
 */
export async function bulkCreateUsers(rows, actorUserId, ip) {
  const created = [];
  const failed = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const item = await createUserWithProfile(rows[i], actorUserId, ip);
      created.push({ row: i + 1, ...item });
    } catch (e) {
      const message = e instanceof AppError ? e.message : e instanceof Error ? e.message : 'Import failed';
      failed.push({ row: i + 1, email: rows[i]?.email ?? '', message });
    }
  }
  return { created, failed, total: rows.length };
}
