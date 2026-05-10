import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { writeAudit } from '../utils/audit.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();
const templates = Router();
const swaps = Router();

const tmplBody = z.object({
  name: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  recurrence: z.unknown().optional(),
});

const tmplPatch = tmplBody.partial();

const shiftBody = z.object({
  siteId: z.number().int(),
  userId: z.number().int(),
  templateId: z.number().int().nullable().optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
});

const shiftPatch = z
  .object({
    startsAt: z.string().min(1).optional(),
    endsAt: z.string().min(1).optional(),
    status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
    siteId: z.number().int().optional(),
    userId: z.number().int().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields' });

const shiftListQuery = z.object({
  userId: z.coerce.number().int().optional(),
  siteId: z.coerce.number().int().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
});

const swapBody = z.object({
  shiftId: z.number().int(),
  targetUserId: z.number().int().nullable().optional(),
});

const swapPatch = z.object({
  status: z.enum(['approved', 'rejected', 'cancelled']),
});

/** Auth only on real routes — avoid blanket middleware on `/` mounts (would 401 unknown paths). */
const withAuth = (...m) => [requireAuth, ...m];

templates.get(
  '/',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, name, start_time AS startTime, end_time AS endTime, recurrence, created_at AS createdAt
       FROM shift_templates ORDER BY id DESC`
    );
    return ok(res, { items: rows });
  })
  )
);

templates.post(
  '/',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(tmplBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO shift_templates (name, start_time, end_time, recurrence) VALUES (?, ?, ?, ?)`,
      [b.name, b.startTime, b.endTime, b.recurrence ? JSON.stringify(b.recurrence) : null]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift_template.create',
      entityType: 'shift_template',
      entityId: r.insertId,
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

templates.patch(
  '/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(tmplPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.validated.body;
    const pool = getPool();
    const fields = [];
    const params = [];
    if (b.name !== undefined) {
      fields.push('name = ?');
      params.push(b.name);
    }
    if (b.startTime !== undefined) {
      fields.push('start_time = ?');
      params.push(b.startTime);
    }
    if (b.endTime !== undefined) {
      fields.push('end_time = ?');
      params.push(b.endTime);
    }
    if (b.recurrence !== undefined) {
      fields.push('recurrence = ?');
      params.push(b.recurrence ? JSON.stringify(b.recurrence) : null);
    }
    if (!fields.length) throw new AppError(400, 'VALIDATION_ERROR', 'No updates');
    params.push(id);
    const [r] = await pool.query(`UPDATE shift_templates SET ${fields.join(', ')} WHERE id = ?`, params);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    return ok(res, { updated: true });
  })
  )
);

templates.delete(
  '/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [r] = await pool.query(`DELETE FROM shift_templates WHERE id = ?`, [id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    return ok(res, { deleted: true });
  })
  )
);

router.use('/shift-templates', templates);

router.get(
  '/shifts',
  ...withAuth(
    validate(shiftListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    const pool = getPool();
    const where = [];
    const params = [];
    if (req.auth.role === 'guard') {
      where.push('s.user_id = ?');
      params.push(req.auth.userId);
    } else if (q.userId) {
      where.push('s.user_id = ?');
      params.push(q.userId);
    }
    if (q.siteId) {
      where.push('s.site_id = ?');
      params.push(q.siteId);
    }
    if (q.status) {
      where.push('s.status = ?');
      params.push(q.status);
    }
    if (q.from) {
      where.push('s.ends_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('s.starts_at <= ?');
      params.push(q.to);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT s.id, s.site_id AS siteId, s.user_id AS userId, s.template_id AS templateId,
              s.starts_at AS startsAt, s.ends_at AS endsAt, s.status, s.created_at AS createdAt
       FROM shifts s ${sqlWhere} ORDER BY s.starts_at DESC LIMIT 500`,
      params
    );
    return ok(res, { items: rows });
  })
  )
);

router.post(
  '/shifts',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(shiftBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO shifts (site_id, user_id, template_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        b.siteId,
        b.userId,
        b.templateId ?? null,
        b.startsAt.slice(0, 19).replace('T', ' '),
        b.endsAt.slice(0, 19).replace('T', ' '),
        b.status ?? 'scheduled',
      ]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift.create',
      entityType: 'shift',
      entityId: r.insertId,
      ip: req.ip,
    });
    await createNotification({
      userId: b.userId,
      type: 'shift.assigned',
      title: 'New shift assigned',
      body: `Shift #${r.insertId} starts at ${b.startsAt}`,
      payload: { shiftId: Number(r.insertId), siteId: b.siteId, startsAt: b.startsAt, endsAt: b.endsAt },
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.patch(
  '/shifts/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(shiftPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.validated.body;
    const pool = getPool();
    const fields = [];
    const params = [];
    if (b.startsAt !== undefined) {
      fields.push('starts_at = ?');
      params.push(b.startsAt.slice(0, 19).replace('T', ' '));
    }
    if (b.endsAt !== undefined) {
      fields.push('ends_at = ?');
      params.push(b.endsAt.slice(0, 19).replace('T', ' '));
    }
    if (b.status !== undefined) {
      fields.push('status = ?');
      params.push(b.status);
    }
    if (b.siteId !== undefined) {
      fields.push('site_id = ?');
      params.push(b.siteId);
    }
    if (b.userId !== undefined) {
      fields.push('user_id = ?');
      params.push(b.userId);
    }
    params.push(id);
    const [r] = await pool.query(`UPDATE shifts SET ${fields.join(', ')} WHERE id = ?`, params);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    const [shiftRows] = await pool.query(
      `SELECT user_id AS userId, site_id AS siteId, starts_at AS startsAt, ends_at AS endsAt
       FROM shifts WHERE id = ?`,
      [id]
    );
    const shift = shiftRows[0];
    if (shift?.userId) {
      await createNotification({
        userId: Number(shift.userId),
        type: 'shift.updated',
        title: 'Shift updated',
        body: `Shift #${id} schedule/details changed`,
        payload: { shiftId: id, siteId: Number(shift.siteId), startsAt: shift.startsAt, endsAt: shift.endsAt },
      });
    }
    return ok(res, { updated: true });
  })
  )
);

swaps.post(
  '/',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
  validate(swapBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO shift_swaps (shift_id, requested_by, target_user_id, status) VALUES (?, ?, ?, 'pending')`,
      [b.shiftId, req.auth.userId, b.targetUserId ?? null]
    );
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

swaps.patch(
  '/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(swapPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `UPDATE shift_swaps SET status = ?, resolved_at = NOW() WHERE id = ?`,
      [status, id]
    );
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Swap not found');
    return ok(res, { updated: true });
  })
  )
);

router.use('/shift-swaps', swaps);

export default router;
