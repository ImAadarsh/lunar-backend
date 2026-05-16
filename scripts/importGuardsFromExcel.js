/**
 * Import guards from "Guards Data.xlsx" into users + guard_profiles (+ SIA HR document).
 *
 * Usage:
 *   cd backend && npm run db:migrate
 *   npm run seed:guards -- "/path/to/Guards Data.xlsx"
 *
 * Env (optional):
 *   GUARD_IMPORT_DEFAULT_PASSWORD  — default GuardImport#2026
 *   GUARD_IMPORT_EMAIL_DOMAIN      — default guards.lunarsecurity.local
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import { getPool } from '../src/db/pool.js';
import { hashPassword } from '../src/utils/password.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_XLSX =
  process.argv[2] ||
  path.join(__dirname, 'data', 'guards-data.xlsx') ||
  '/Users/aadarsh/Downloads/Guards Data.xlsx';

const DEFAULT_PASSWORD = process.env.GUARD_IMPORT_DEFAULT_PASSWORD || 'GuardImport#2026';
const EMAIL_DOMAIN = process.env.GUARD_IMPORT_EMAIL_DOMAIN || 'guards.lunarsecurity.local';
const IMPORT_SOURCE = 'guards_data_xlsx';

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // Cyrillic lookalikes sometimes used in the sheet
  '\u043e\u0441\u0442': 10,
  '\u043e\u043a\u0442': 10,
};

function slugify(part) {
  return String(part ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function normalizePhone(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const digits = s.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('44')) return `+${digits}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  return `+${digits}`;
}

function toDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const parsed = parseExpiryString(String(value));
  return parsed;
}

function parseExpiryString(raw) {
  let s = raw.trim().replace(/\u043e\u0441\u0442/gi, 'oct').replace(/\u043e\u043a\u0442/gi, 'oct');
  s = s.replace(/(\d)([A-Za-z]{3})(\d{2,4})/, '$1 $2 $3');
  const m = s.match(/(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{2,4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const monKey = m[2].slice(0, 3).toLowerCase();
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (year < 1000) year += 2000;
  const month = MONTHS[monKey];
  if (!month || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeSiaNumber(raw) {
  if (raw == null) return null;
  return String(raw).replace(/\s+/g, ' ').trim() || null;
}

function buildEmail(given, surname, used) {
  const base = [slugify(given), slugify(surname)].filter(Boolean).join('.') || 'guard';
  let candidate = `${base}@${EMAIL_DOMAIN}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}.${n}@${EMAIL_DOMAIN}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

async function readRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const v = (i) => row.getCell(i).value;
    const fullName = v(1);
    if (!fullName || String(fullName).trim() === '') return;
    rows.push({
      fullName: String(fullName).trim(),
      givenNames: v(2) != null ? String(v(2)).trim() : null,
      surname: v(3) != null ? String(v(3)).trim() : null,
      gender: v(4) != null ? String(v(4)).trim() : null,
      dateOfBirth: toDateOnly(v(5)),
      phone: normalizePhone(v(6)),
      siaType: v(7) != null ? String(v(7)).trim() : null,
      siaNumber: normalizeSiaNumber(v(8)),
      siaExpiry: toDateOnly(v(9)),
    });
  });
  return rows;
}

async function upsertSiaDocument(conn, userId, siaType, siaNumber, siaExpiry) {
  if (!siaNumber) return;
  const title = [siaType || 'SIA', siaNumber].filter(Boolean).join(' — ');
  const [existing] = await conn.query(
    `SELECT id FROM employee_documents
     WHERE user_id = ? AND document_type = 'sia_license' AND title = ?
     LIMIT 1`,
    [userId, title]
  );
  if (existing.length) {
    await conn.query(
      `UPDATE employee_documents SET expires_on = ?, status = 'active' WHERE id = ?`,
      [siaExpiry, existing[0].id]
    );
    return;
  }
  await conn.query(
    `INSERT INTO employee_documents (user_id, document_type, title, status, expires_on)
     VALUES (?, 'sia_license', ?, 'active', ?)`,
    [userId, title, siaExpiry]
  );
}

async function run() {
  const filePath = path.resolve(DEFAULT_XLSX);
  console.log(`Reading ${filePath}`);
  const rows = await readRows(filePath);
  console.log(`Parsed ${rows.length} guard rows`);

  const pool = getPool();
  const conn = await pool.getConnection();
  const usedEmails = new Set();
  const [[guardRole]] = await conn.query(`SELECT id FROM roles WHERE slug = 'guard' LIMIT 1`);
  if (!guardRole) {
    throw new Error('guard role missing — run migrations first');
  }
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await conn.beginTransaction();

    const [existingUsers] = await conn.query(`SELECT email FROM users`);
    for (const u of existingUsers) usedEmails.add(u.email.toLowerCase());

    for (const row of rows) {
      const email = buildEmail(row.givenNames, row.surname, usedEmails);

      const [byEmail] = await conn.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
      const [byPhone] =
        row.phone && !byEmail.length
          ? await conn.query(`SELECT id FROM users WHERE phone = ? LIMIT 1`, [row.phone])
          : [[]];
      const [byProfile] =
        !byEmail.length && !byPhone.length
          ? await conn.query(`SELECT user_id FROM guard_profiles WHERE full_name = ? LIMIT 1`, [
              row.fullName,
            ])
          : [[]];

      let userId;
      if (byEmail.length) {
        userId = byEmail[0].id;
        await conn.query(`UPDATE users SET phone = COALESCE(?, phone), status = 'active' WHERE id = ?`, [
          row.phone,
          userId,
        ]);
        updated += 1;
      } else if (byPhone.length) {
        userId = byPhone[0].id;
        await conn.query(`UPDATE users SET phone = ?, status = 'active' WHERE id = ?`, [
          row.phone,
          userId,
        ]);
        updated += 1;
      } else if (byProfile.length) {
        userId = byProfile[0].user_id;
        await conn.query(`UPDATE users SET phone = COALESCE(?, phone), status = 'active' WHERE id = ?`, [
          row.phone ?? null,
          userId,
        ]);
        updated += 1;
      } else {
        const [ins] = await conn.query(
          `INSERT INTO users (email, phone, password_hash, role_id, status)
           VALUES (?, ?, ?, ?, 'active')`,
          [email, row.phone, passwordHash, guardRole.id]
        );
        userId = ins.insertId;
        created += 1;
      }

      await conn.query(
        `INSERT INTO guard_profiles
          (user_id, full_name, given_names, surname, gender, date_of_birth,
           sia_type, sia_number, sia_expiry_date, import_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           full_name = VALUES(full_name),
           given_names = VALUES(given_names),
           surname = VALUES(surname),
           gender = VALUES(gender),
           date_of_birth = VALUES(date_of_birth),
           sia_type = VALUES(sia_type),
           sia_number = VALUES(sia_number),
           sia_expiry_date = VALUES(sia_expiry_date),
           import_source = VALUES(import_source)`,
        [
          userId,
          row.fullName,
          row.givenNames,
          row.surname,
          row.gender,
          row.dateOfBirth,
          row.siaType,
          row.siaNumber,
          row.siaExpiry,
          IMPORT_SOURCE,
        ]
      );

      await upsertSiaDocument(conn, userId, row.siaType, row.siaNumber, row.siaExpiry);
    }

    await conn.commit();
    console.log(`Import complete: ${created} created, ${updated} updated, ${skipped} skipped`);
    console.log(`Default password for new accounts: ${DEFAULT_PASSWORD}`);
    console.log(`Email domain: @${EMAIL_DOMAIN}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
