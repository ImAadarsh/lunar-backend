import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();
const withAuth = (...m) => [requireAuth, ...m];

const leaveCreateSchema = z.object({
  leaveType: z.enum(['annual', 'sick', 'unpaid', 'other']),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(1024).optional(),
});

const leaveDecisionSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  managerComment: z.string().max(1024).optional(),
});

const leaveListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  userId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const tokenBody = z.object({
  token: z.string().min(8).max(512),
  platform: z.enum(['android', 'ios', 'web', 'other']).optional(),
});

const notifListQuery = z.object({
  unreadOnly: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

router.post(
  '/leave-requests',
  ...withAuth(
  requireRoles('guard', 'supervisor', 'admin'),
  validate(leaveCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    if (b.endDate < b.startDate) {
      throw new AppError(400, 'VALIDATION_ERROR', 'endDate must be on/after startDate');
    }
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, reason, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.auth.userId, b.leaveType, b.startDate, b.endDate, b.reason ?? null]
    );
    return ok(res, { id: Number(r.insertId) }, 201);
  })
  )
);

router.get(
  '/leave-requests',
  ...withAuth(
  validate(leaveListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    const pool = getPool();
    const where = [];
    const params = [];
    if (req.auth.role === 'guard') {
      where.push('lr.user_id = ?');
      params.push(req.auth.userId);
    } else if (q.userId) {
      where.push('lr.user_id = ?');
      params.push(q.userId);
    }
    if (q.status) {
      where.push('lr.status = ?');
      params.push(q.status);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT lr.id, lr.user_id AS userId, lr.leave_type AS leaveType, lr.start_date AS startDate,
              lr.end_date AS endDate, lr.reason, lr.status, lr.requested_at AS requestedAt,
              lr.decided_at AS decidedAt, lr.decided_by AS decidedBy, lr.manager_comment AS managerComment,
              u.email AS userEmail
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
       ${sqlWhere}
       ORDER BY lr.requested_at DESC
       LIMIT ?`,
      [...params, q.limit]
    );
    return ok(res, { items: rows });
  })
  )
);

router.patch(
  '/leave-requests/:id/decision',
  ...withAuth(
  requireRoles('supervisor', 'admin'),
  validate(leaveDecisionSchema),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.validated.body;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, status FROM leave_requests WHERE id = ?`,
      [id]
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    if (row.status !== 'pending') {
      throw new AppError(409, 'CONFLICT', 'Only pending leave requests can be decided');
    }
    await pool.query(
      `UPDATE leave_requests
       SET status = ?, decided_at = NOW(), decided_by = ?, manager_comment = ?
       WHERE id = ?`,
      [b.status, req.auth.userId, b.managerComment ?? null, id]
    );
    await createNotification({
      userId: Number(row.userId),
      type: 'leave.decision',
      title: `Leave request ${b.status}`,
      body: b.managerComment ?? null,
      payload: { leaveRequestId: id, status: b.status },
    });
    return ok(res, { updated: true });
  })
  )
);

router.patch(
  '/leave-requests/:id/cancel',
  ...withAuth(
  requireRoles('guard', 'supervisor', 'admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, status FROM leave_requests WHERE id = ?`,
      [id]
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Leave request not found');
    if (req.auth.role === 'guard' && Number(row.userId) !== req.auth.userId) {
      throw new AppError(403, 'FORBIDDEN', 'Cannot cancel another user request');
    }
    if (row.status !== 'pending') {
      throw new AppError(409, 'CONFLICT', 'Only pending leave requests can be cancelled');
    }
    await pool.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = ?`, [id]);
    return ok(res, { updated: true });
  })
  )
);

router.post(
  '/notifications/device-token',
  ...withAuth(
  validate(tokenBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    await pool.query(
      `INSERT INTO device_tokens (user_id, platform, token, last_seen_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), last_seen_at = NOW()`,
      [req.auth.userId, b.platform ?? 'other', b.token]
    );
    return ok(res, { saved: true }, 201);
  })
  )
);

router.get(
  '/notifications',
  ...withAuth(
  validate(notifListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, type, title, body, payload, created_at AS createdAt, read_at AS readAt
       FROM notifications
       WHERE user_id = ? ${q.unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC
       LIMIT ?`,
      [req.auth.userId, q.limit]
    );
    return ok(res, { items: rows });
  })
  )
);

router.get(
  '/notifications/unread-count',
  ...withAuth(
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL`,
      [req.auth.userId]
    );
    return ok(res, { count: Number(rows[0]?.cnt ?? 0) });
  })
  )
);

router.patch(
  '/notifications/:id/read',
  ...withAuth(
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [r] = await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?`,
      [id, req.auth.userId]
    );
    if (!r.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Notification not found');
    return ok(res, { updated: true });
  })
  )
);

router.patch(
  '/notifications/read-all',
  ...withAuth(
  asyncHandler(async (req, res) => {
    const pool = getPool();
    await pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL`, [
      req.auth.userId,
    ]);
    return ok(res, { updated: true });
  })
  )
);

export default router;
