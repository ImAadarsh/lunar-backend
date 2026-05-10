import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { hashPassword } from '../utils/password.js';
import { writeAudit } from '../utils/audit.js';

const router = Router();

const listQuery = z.object({
  role: z.enum(['admin', 'supervisor', 'guard']).optional(),
  status: z.enum(['active', 'invited', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(20),
});

const createBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['admin', 'supervisor', 'guard']),
  phone: z.string().optional(),
  status: z.enum(['active', 'invited', 'suspended']).optional(),
});

const patchBody = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().nullable().optional(),
    password: z.string().min(8).optional(),
    status: z.enum(['active', 'invited', 'suspended']).optional(),
    role: z.enum(['admin', 'supervisor', 'guard']).optional(),
    /** Gross hourly pay in pence; null clears to default */
    payRatePenceHour: z.number().int().min(0).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

router.use(requireAuth);

router.get(
  '/',
  requireRoles('admin', 'supervisor'),
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { role, status, page, limit } = req.validated.query;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const where = [];
    const params = [];
    if (role) {
      where.push('r.slug = ?');
      params.push(role);
    }
    if (status) {
      where.push('u.status = ?');
      params.push(status);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${sqlWhere}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.phone, u.status, r.slug AS role, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id
       ${sqlWhere}
       ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return ok(res, { items: rows, page, limit, total });
  })
);

const siteAccessBody = z.object({
  siteIds: z.array(z.number().int()),
});

router.get(
  '/:id/site-access',
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [t] = await pool.query(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_site_access'`
    );
    if (!t.length) return ok(res, { siteIds: [], note: 'user_site_access table not migrated' });
    const [rows] = await pool.query(
      `SELECT site_id AS siteId FROM user_site_access WHERE user_id = ? ORDER BY site_id`,
      [id]
    );
    return ok(res, { siteIds: rows.map((r) => Number(r.siteId)) });
  })
);

router.put(
  '/:id/site-access',
  requireRoles('admin'),
  validate(siteAccessBody),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { siteIds } = req.validated.body;
    const pool = getPool();
    const [u] = await pool.query(`SELECT r.slug FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [
      id,
    ]);
    if (!u[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (u[0].slug !== 'supervisor') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Site access applies to supervisors only');
    }
    const [tbl] = await pool.query(
      `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_site_access'`
    );
    if (!tbl.length) {
      throw new AppError(503, 'INTERNAL', 'Run migration 002_user_site_access first');
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM user_site_access WHERE user_id = ?`, [id]);
      for (const sid of siteIds) {
        await conn.query(`INSERT INTO user_site_access (user_id, site_id) VALUES (?, ?)`, [id, sid]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    await writeAudit({
      userId: req.auth.userId,
      action: 'user.site_access.set',
      entityType: 'user',
      entityId: id,
      payload: { siteIds },
      ip: req.ip,
    });
    return ok(res, { siteIds });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid id');
    const pool = getPool();
    const isSelf = req.auth.userId === id;
    const allowed = isSelf || ['admin', 'supervisor'].includes(req.auth.role);
    if (!allowed) throw new AppError(403, 'FORBIDDEN', 'Cannot view this user');
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.phone, u.status, r.slug AS role, u.created_at,
              u.two_factor_enabled AS twoFactorEnabled, u.pay_rate_pence_hour AS payRatePenceHour
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const u = rows[0];
    if (req.auth.role !== 'admin' && !isSelf) {
      delete u.payRatePenceHour;
    }
    return ok(res, u);
  })
);

router.post(
  '/',
  requireRoles('admin'),
  validate(createBody),
  asyncHandler(async (req, res) => {
    const { email, password, role, phone, status } = req.validated.body;
    const pool = getPool();
    const [[roleRow]] = await pool.query(`SELECT id FROM roles WHERE slug = ?`, [role]);
    if (!roleRow) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid role');
    const password_hash = await hashPassword(password);
    try {
      const [r] = await pool.query(
        `INSERT INTO users (email, phone, password_hash, role_id, status) VALUES (?, ?, ?, ?, ?)`,
        [email, phone ?? null, password_hash, roleRow.id, status ?? 'active']
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'user.create',
        entityType: 'user',
        entityId: r.insertId,
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'CONFLICT', 'Email exists');
      throw e;
    }
  })
);

router.patch(
  '/:id',
  validate(patchBody),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.validated.body;
    const pool = getPool();
    const isAdmin = req.auth.role === 'admin';
    const isSelf = req.auth.userId === id;
    if (!isAdmin && !isSelf) throw new AppError(403, 'FORBIDDEN', 'Cannot update this user');
    if (!isAdmin && (body.role || body.status)) {
      throw new AppError(403, 'FORBIDDEN', 'Cannot change role or status');
    }
    const fields = [];
    const params = [];
    if (body.email) {
      fields.push('email = ?');
      params.push(body.email);
    }
    if (body.phone !== undefined) {
      fields.push('phone = ?');
      params.push(body.phone);
    }
    if (body.password) {
      fields.push('password_hash = ?');
      params.push(await hashPassword(body.password));
    }
    if (body.status) {
      fields.push('status = ?');
      params.push(body.status);
    }
    if (body.role && isAdmin) {
      const [[rr]] = await pool.query(`SELECT id FROM roles WHERE slug = ?`, [body.role]);
      if (!rr) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid role');
      fields.push('role_id = ?');
      params.push(rr.id);
    }
    if (body.payRatePenceHour !== undefined) {
      if (!isAdmin) throw new AppError(403, 'FORBIDDEN', 'Only admin can set pay rate');
      fields.push('pay_rate_pence_hour = ?');
      params.push(body.payRatePenceHour);
    }
    if (!fields.length) throw new AppError(400, 'VALIDATION_ERROR', 'No updates');
    params.push(id);
    const [r] = await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      payload: body,
      ip: req.ip,
    });
    return ok(res, { updated: true });
  })
);

router.delete(
  '/:id',
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [r] = await pool.query(`UPDATE users SET status = 'suspended' WHERE id = ?`, [id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'user.suspend',
      entityType: 'user',
      entityId: id,
      ip: req.ip,
    });
    return ok(res, { suspended: true });
  })
);

export default router;
