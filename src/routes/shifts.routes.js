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
import { publishCommandEvent } from '../services/commandEventService.js';
import {
  assertCanAssignShift,
  enrichShiftsWithDutyState,
  ensureGuardTrainedForSite,
  autoMarkMissedShifts,
} from '../services/guardDutyService.js';
import {
  normalizeShiftDateTimeForQuery,
  normalizeShiftDateTimeForStorage,
  normalizeShiftRowsForApi,
  serializeShiftDateTime,
} from '../utils/ukDateTime.js';

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
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled', 'missed']).optional(),
  force: z.boolean().optional(),
});

const bulkScheduleBody = z.object({
  userId: z.number().int(),
  siteId: z.number().int(),
  force: z.boolean().optional(),
  shifts: z
    .array(
      z.object({
        startsAt: z.string().min(1),
        endsAt: z.string().min(1),
        siteId: z.number().int().optional(),
      })
    )
    .min(1)
    .max(14),
});

const shiftPatch = z
  .object({
    startsAt: z.string().min(1).optional(),
    endsAt: z.string().min(1).optional(),
    status: z.enum(['scheduled', 'active', 'completed', 'cancelled', 'missed']).optional(),
    siteId: z.number().int().optional(),
    userId: z.number().int().optional(),
    force: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields' });

const shiftListQuery = z.object({
  userId: z.coerce.number().int().optional(),
  siteId: z.coerce.number().int().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled', 'missed']).optional(),
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
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift_template.update',
      entityType: 'shift_template',
      entityId: id,
      payload: b,
      ip: req.ip,
    });
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
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift_template.delete',
      entityType: 'shift_template',
      entityId: id,
      ip: req.ip,
    });
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
      params.push(normalizeShiftDateTimeForQuery(q.from));
    }
    if (q.to) {
      where.push('s.starts_at <= ?');
      params.push(normalizeShiftDateTimeForQuery(q.to));
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    await autoMarkMissedShifts(pool, {
      userId: q.userId ?? (req.auth.role === 'guard' ? req.auth.userId : undefined),
      siteId: q.siteId,
    });
    const [rows] = await pool.query(
      `SELECT s.id, s.site_id AS siteId, s.user_id AS userId, s.template_id AS templateId,
              s.starts_at AS startsAt, s.ends_at AS endsAt, s.status, s.created_at AS createdAt,
              st.name AS siteName, u.email AS userEmail, u.phone AS userPhone, gp.full_name AS guardName
       FROM shifts s
       JOIN sites st ON st.id = s.site_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN guard_profiles gp ON gp.user_id = u.id
       ${sqlWhere} ORDER BY s.starts_at DESC LIMIT 500`,
      params
    );
    const items = normalizeShiftRowsForApi(await enrichShiftsWithDutyState(pool, rows));
    return ok(res, { items });
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
    await assertCanAssignShift(pool, {
      userId: b.userId,
      siteId: b.siteId,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      force: Boolean(b.force),
      actorRole: req.auth.role,
    });
    const [r] = await pool.query(
      `INSERT INTO shifts (site_id, user_id, template_id, starts_at, ends_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        b.siteId,
        b.userId,
        b.templateId ?? null,
        normalizeShiftDateTimeForStorage(b.startsAt),
        normalizeShiftDateTimeForStorage(b.endsAt),
        b.status ?? 'scheduled',
      ]
    );
    const startsAtIso = serializeShiftDateTime(b.startsAt);
    const endsAtIso = serializeShiftDateTime(b.endsAt);
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift.create',
      entityType: 'shift',
      entityId: r.insertId,
      payload: { siteId: b.siteId, userId: b.userId, startsAt: startsAtIso, endsAt: endsAtIso },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'shift.created',
      actorUserId: req.auth.userId,
      subjectUserId: b.userId,
      siteId: b.siteId,
      entityType: 'shift',
      entityId: r.insertId,
      payload: { startsAt: startsAtIso, endsAt: endsAtIso, status: b.status ?? 'scheduled' },
    });
    await createNotification({
      userId: b.userId,
      type: 'shift.assigned',
      title: 'New shift assigned',
      body: `Shift #${r.insertId} starts at ${startsAtIso}`,
      payload: { shiftId: Number(r.insertId), siteId: b.siteId, startsAt: startsAtIso, endsAt: endsAtIso },
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.post(
  '/shifts/bulk-schedule',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(bulkScheduleBody),
    asyncHandler(async (req, res) => {
      const b = req.validated.body;
      const pool = getPool();
      const force = Boolean(b.force);
      const sorted = [...b.shifts].sort(
        (a, c) => new Date(a.startsAt).getTime() - new Date(c.startsAt).getTime()
      );
      const validated = [];
      const pendingShifts = [];

      for (let i = 0; i < sorted.length; i += 1) {
        const row = sorted[i];
        const siteId = row.siteId ?? b.siteId;
        try {
          const meta = await assertCanAssignShift(pool, {
            userId: b.userId,
            siteId,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            force,
            actorRole: req.auth.role,
            pendingShifts,
          });
          pendingShifts.push({ startsAt: row.startsAt, endsAt: row.endsAt });
          validated.push({ row, siteId, meta });
        } catch (err) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            `Shift ${i + 1}: ${err.message ?? 'Invalid assignment'}`
          );
        }
      }

      const created = [];
      for (const { row, siteId } of validated) {
        const [r] = await pool.query(
          `INSERT INTO shifts (site_id, user_id, template_id, starts_at, ends_at, status)
           VALUES (?, ?, NULL, ?, ?, 'scheduled')`,
          [
            siteId,
            b.userId,
            normalizeShiftDateTimeForStorage(row.startsAt),
            normalizeShiftDateTimeForStorage(row.endsAt),
          ]
        );
        created.push(Number(r.insertId));
      }

      await writeAudit({
        userId: req.auth.userId,
        action: 'shift.bulk_schedule',
        entityType: 'shift',
        entityId: created[0] ?? null,
        payload: {
          userId: b.userId,
          siteId: b.siteId,
          shiftIds: created,
          count: created.length,
          force,
        },
        ip: req.ip,
      });

      if (created.length) {
        await createNotification({
          userId: b.userId,
          type: 'shift.assigned',
          title: 'Schedule updated',
          body: `${created.length} shift${created.length === 1 ? '' : 's'} added to your roster`,
          payload: { shiftIds: created, siteId: b.siteId, count: created.length },
        });
      }

      return ok(res, { ids: created, count: created.length }, 201);
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
      params.push(normalizeShiftDateTimeForStorage(b.startsAt));
    }
    if (b.endsAt !== undefined) {
      fields.push('ends_at = ?');
      params.push(normalizeShiftDateTimeForStorage(b.endsAt));
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
    const [existingRows] = await pool.query(
      `SELECT user_id AS userId, site_id AS siteId, starts_at AS startsAt, ends_at AS endsAt
       FROM shifts WHERE id = ?`,
      [id]
    );
    const existing = existingRows[0];
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    const nextUserId = b.userId ?? existing.userId;
    const nextSiteId = b.siteId ?? existing.siteId;
    const nextStartsAt = b.startsAt ?? existing.startsAt;
    const nextEndsAt = b.endsAt ?? existing.endsAt;
    const scheduleChanged =
      b.userId !== undefined ||
      b.startsAt !== undefined ||
      b.endsAt !== undefined ||
      b.siteId !== undefined;
    if (scheduleChanged && nextStartsAt && nextEndsAt) {
      await assertCanAssignShift(pool, {
        userId: nextUserId,
        siteId: nextSiteId,
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        excludeShiftId: id,
        force: Boolean(b.force),
        actorRole: req.auth.role,
      });
    } else {
      await ensureGuardTrainedForSite(pool, nextUserId, nextSiteId);
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
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift.update',
      entityType: 'shift',
      entityId: id,
      payload: b,
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'shift.updated',
      actorUserId: req.auth.userId,
      subjectUserId: Number(shift?.userId ?? 0) || null,
      siteId: Number(shift?.siteId ?? 0) || null,
      entityType: 'shift',
      entityId: id,
      payload: b,
    });
    return ok(res, { updated: true });
  })
  )
);

router.delete(
  '/shifts/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pool = getPool();
      const [[shift]] = await pool.query(
        `SELECT id, user_id AS userId, site_id AS siteId, starts_at AS startsAt, ends_at AS endsAt, status
         FROM shifts WHERE id = ?`,
        [id]
      );
      if (!shift) throw new AppError(404, 'NOT_FOUND', 'Shift not found');

      const [[att]] = await pool.query(
        `SELECT id FROM attendance_sessions WHERE shift_id = ? LIMIT 1`,
        [id]
      );
      if (att) {
        throw new AppError(
          409,
          'CONFLICT',
          'Cannot delete a shift with attendance records. Cancel the shift instead.'
        );
      }

      await pool.query(`DELETE FROM shifts WHERE id = ?`, [id]);

      await writeAudit({
        userId: req.auth.userId,
        action: 'shift.delete',
        entityType: 'shift',
        entityId: id,
        payload: {
          userId: shift.userId,
          siteId: shift.siteId,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          status: shift.status,
        },
        ip: req.ip,
      });
      await publishCommandEvent({
        type: 'shift.deleted',
        actorUserId: req.auth.userId,
        subjectUserId: Number(shift.userId),
        siteId: Number(shift.siteId),
        entityType: 'shift',
        entityId: id,
        payload: { status: shift.status },
      });
      return ok(res, { deleted: true });
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
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift_swap.request',
      entityType: 'shift_swap',
      entityId: r.insertId,
      payload: { shiftId: b.shiftId, targetUserId: b.targetUserId ?? null },
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

swaps.get(
  '/mine',
  ...withAuth(
    requireRoles('guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT sw.id, sw.shift_id AS shiftId, sw.requested_by AS requestedBy,
                sw.target_user_id AS targetUserId, target.email AS targetEmail,
                sw.status, sw.created_at AS createdAt, sw.resolved_at AS resolvedAt,
                s.site_id AS siteId, st.name AS siteName,
                s.starts_at AS startsAt, s.ends_at AS endsAt
         FROM shift_swaps sw
         JOIN shifts s ON s.id = sw.shift_id
         JOIN sites st ON st.id = s.site_id
         LEFT JOIN users target ON target.id = sw.target_user_id
         WHERE sw.requested_by = ?
         ORDER BY sw.id DESC
         LIMIT 50`,
        [req.auth.userId]
      );
      return ok(res, {
        items: rows.map((row) => ({
          ...row,
          startsAt: serializeShiftDateTime(row.startsAt),
          endsAt: serializeShiftDateTime(row.endsAt),
        })),
      });
    })
  )
);

swaps.get(
  '/',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const pool = getPool();
      const where = [];
      const params = [];
      if (status) {
        where.push('sw.status = ?');
        params.push(status);
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT sw.id, sw.shift_id AS shiftId, sw.requested_by AS requestedBy,
                requester.email AS requesterEmail,
                sw.target_user_id AS targetUserId, target.email AS targetEmail,
                sw.status, sw.created_at AS createdAt, sw.resolved_at AS resolvedAt,
                s.site_id AS siteId, s.starts_at AS startsAt, s.ends_at AS endsAt
         FROM shift_swaps sw
         JOIN shifts s ON s.id = sw.shift_id
         JOIN users requester ON requester.id = sw.requested_by
         LEFT JOIN users target ON target.id = sw.target_user_id
         ${sqlWhere}
         ORDER BY sw.id DESC
         LIMIT 200`,
        params
      );
      return ok(res, { items: rows });
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
    const [rows] = await pool.query(
      `SELECT sw.id, sw.shift_id AS shiftId, sw.target_user_id AS targetUserId,
              s.starts_at AS startsAt, s.ends_at AS endsAt
       FROM shift_swaps sw
       JOIN shifts s ON s.id = sw.shift_id
       WHERE sw.id = ?`,
      [id]
    );
    const swap = rows[0];
    if (!swap) throw new AppError(404, 'NOT_FOUND', 'Swap not found');
    if (status === 'approved') {
      if (!swap.targetUserId) throw new AppError(400, 'VALIDATION_ERROR', 'Approved swaps require targetUserId');
      const [conflicts] = await pool.query(
        `SELECT id FROM shifts
         WHERE user_id = ?
           AND id <> ?
           AND status IN ('scheduled', 'active')
           AND starts_at < ?
           AND ends_at > ?
         LIMIT 1`,
        [swap.targetUserId, swap.shiftId, swap.endsAt, swap.startsAt]
      );
      if (conflicts[0]) throw new AppError(409, 'CONFLICT', 'Target guard has a conflicting shift');
      await pool.query(`UPDATE shifts SET user_id = ? WHERE id = ?`, [swap.targetUserId, swap.shiftId]);
    }
    await pool.query(`UPDATE shift_swaps SET status = ?, resolved_at = NOW() WHERE id = ?`, [status, id]);
    await writeAudit({
      userId: req.auth.userId,
      action: 'shift_swap.update_status',
      entityType: 'shift_swap',
      entityId: id,
      payload: { status },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'shift_swap.updated',
      actorUserId: req.auth.userId,
      subjectUserId: Number(swap.targetUserId ?? 0) || null,
      entityType: 'shift_swap',
      entityId: id,
      payload: { status, shiftId: Number(swap.shiftId) },
    });
    return ok(res, { updated: true });
  })
  )
);

router.use('/shift-swaps', swaps);

export default router;
