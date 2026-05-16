import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { isInsideGeofence } from '../utils/geo.js';
import { writeAudit } from '../utils/audit.js';
import { publishCommandEvent } from '../services/commandEventService.js';
import { processUploadedMedia } from '../services/mediaProcessingService.js';

const router = Router();

const checkIn = z.object({
  shiftId: z.number().int(),
  lat: z.number(),
  lng: z.number(),
});

const checkOut = z.object({
  sessionId: z.number().int(),
  lat: z.number(),
  lng: z.number(),
});

const gpsBody = z.object({
  shiftId: z.number().int(),
  points: z
    .array(
      z.object({
        lat: z.number(),
        lng: z.number(),
        accuracyM: z.number().optional(),
        recordedAt: z.string(),
      })
    )
    .min(1)
    .max(500),
});

const patrolBody = z.object({
  checkpointId: z.number().int(),
  scannedAt: z.string(),
  clientMessageId: z.string().max(64).optional(),
});

const incidentBody = z.object({
  siteId: z.number().int(),
  category: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  shiftId: z.number().int().optional(),
  attendanceSessionId: z.number().int().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  capturedAt: z.string().optional(),
  deviceInfo: z.record(z.unknown()).optional(),
});

const incidentPatch = z.object({
  status: z.enum(['open', 'in_review', 'closed']),
});

const attachBody = z.object({
  mediaId: z.number().int(),
});

const attachmentDeleteParams = z.object({
  incidentId: z.coerce.number().int().positive(),
  attachmentId: z.coerce.number().int().positive(),
});

const sosBody = z.object({
  lat: z.number(),
  lng: z.number(),
  message: z.string().optional(),
});

const sosPatch = z.object({
  status: z.enum(['acknowledged', 'resolved']),
});

const mediaBody = z.object({
  kind: z.enum(['visual_log', 'incident', 'profile', 'other']).optional(),
  storageKey: z.string().min(1),
  publicUrl: z.string().url().optional(),
  mime: z.string().optional(),
  sizeBytes: z.number().int().optional(),
});

const mediaUploadBody = z.object({
  kind: z.enum(['visual_log', 'incident', 'profile', 'other']).optional(),
});
const visualLogBody = z.object({
  attendanceSessionId: z.number().int(),
  mediaId: z.number().int().optional(),
  note: z.string().optional(),
  completedAt: z.string().optional(),
});

const patrolListQuery = z.object({
  siteId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const incidentsListQuery = z.object({
  siteId: z.coerce.number().int().positive().optional(),
  status: z.enum(['open', 'in_review', 'closed']).optional(),
  userId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

const uploadDir = env.uploadFilesDir || path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 16);
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const withAuth = (...m) => [requireAuth, ...m];

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function mediaAccessToken() {
  return randomBytes(32).toString('hex');
}

router.post(
  '/attendance/check-in',
  ...withAuth(
    requireRoles('guard'),
  validate(checkIn),
  asyncHandler(async (req, res) => {
    const { shiftId, lat, lng } = req.validated.body;
    const pool = getPool();
    const [sh] = await pool.query(
      `SELECT s.id, s.user_id AS userId, s.site_id AS siteId, s.status,
              si.center_lat, si.center_lng, si.geofence_radius_m, si.geofence_polygon
       FROM shifts s JOIN sites si ON si.id = s.site_id WHERE s.id = ?`,
      [shiftId]
    );
    const shift = sh[0];
    if (!shift || shift.userId !== req.auth.userId) {
      throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    }
    if (!isInsideGeofence(shift, lat, lng)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Outside geofence');
    }
    const [open] = await pool.query(
      `SELECT id FROM attendance_sessions WHERE user_id = ? AND shift_id = ? AND status = 'open'`,
      [req.auth.userId, shiftId]
    );
    if (open[0]) throw new AppError(409, 'CONFLICT', 'Already checked in');
    const checkInAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const [r] = await pool.query(
      `INSERT INTO attendance_sessions (user_id, shift_id, check_in_at, check_in_lat, check_in_lng, inside_geofence_in, status)
       VALUES (?, ?, ?, ?, ?, 1, 'open')`,
      [req.auth.userId, shiftId, checkInAt, lat, lng]
    );
    await pool.query(`UPDATE shifts SET status = 'active' WHERE id = ? AND status = 'scheduled'`, [shiftId]);
    await writeAudit({
      userId: req.auth.userId,
      action: 'attendance.check_in',
      entityType: 'attendance_session',
      entityId: r.insertId,
      payload: { shiftId, lat, lng, siteId: shift.siteId },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'attendance.check_in',
      actorUserId: req.auth.userId,
      subjectUserId: req.auth.userId,
      siteId: Number(shift.siteId),
      entityType: 'attendance_session',
      entityId: r.insertId,
      payload: { shiftId, lat, lng },
    });
    return ok(res, { sessionId: r.insertId }, 201);
  })
  )
);

router.post(
  '/attendance/check-out',
  ...withAuth(
    requireRoles('guard'),
  validate(checkOut),
  asyncHandler(async (req, res) => {
    const { sessionId, lat, lng } = req.validated.body;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT a.id, a.shift_id, s.site_id, si.center_lat, si.center_lng, si.geofence_radius_m, si.geofence_polygon
       FROM attendance_sessions a
       JOIN shifts s ON s.id = a.shift_id
       JOIN sites si ON si.id = s.site_id
       WHERE a.id = ? AND a.user_id = ? AND a.status = 'open'`,
      [sessionId, req.auth.userId]
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Session not found');
    const inside = isInsideGeofence(row, lat, lng);
    const outAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      `UPDATE attendance_sessions SET check_out_at = ?, check_out_lat = ?, check_out_lng = ?,
       inside_geofence_out = ?, status = 'closed' WHERE id = ?`,
      [outAt, lat, lng, inside ? 1 : 0, sessionId]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'attendance.check_out',
      entityType: 'attendance_session',
      entityId: sessionId,
      payload: { shiftId: row.shift_id, lat, lng, insideGeofence: inside },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'attendance.check_out',
      actorUserId: req.auth.userId,
      subjectUserId: req.auth.userId,
      siteId: Number(row.site_id),
      entityType: 'attendance_session',
      entityId: sessionId,
      payload: { shiftId: row.shift_id, lat, lng, insideGeofence: inside },
    });
    return ok(res, { closed: true });
  })
  )
);

router.get(
  '/attendance/sessions',
  ...withAuth(
    requireRoles('guard', 'supervisor', 'admin'),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const targetUser = req.query.userId ? Number(req.query.userId) : req.auth.userId;
    if (req.auth.role === 'guard' && targetUser !== req.auth.userId) {
      throw new AppError(403, 'FORBIDDEN', 'Can only list own sessions');
    }
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, shift_id AS shiftId, check_in_at AS checkInAt, check_out_at AS checkOutAt,
              status FROM attendance_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 200`,
      [targetUser]
    );
    return ok(res, { items: rows });
  })
  )
);

router.post(
  '/telemetry/gps',
  ...withAuth(
    requireRoles('guard'),
  validate(gpsBody),
  asyncHandler(async (req, res) => {
    const { shiftId, points } = req.validated.body;
    const pool = getPool();
    const [sh] = await pool.query(
      `SELECT id, user_id FROM shifts WHERE id = ?`,
      [shiftId]
    );
    if (!sh[0] || sh[0].user_id !== req.auth.userId) {
      throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    }
    const batchId = randomUUID();
    const values = [];
    for (const p of points) {
      values.push([
        req.auth.userId,
        shiftId,
        p.lat,
        p.lng,
        p.accuracyM ?? null,
        p.recordedAt.slice(0, 23).replace('T', ' '),
        batchId,
      ]);
    }
    try {
      await pool.query(
        `INSERT INTO gps_points (user_id, shift_id, lat, lng, accuracy_m, recorded_at, batch_id) VALUES ?`,
        [values]
      );
    } catch {
      for (const row of values) {
        await pool.query(
          `INSERT INTO gps_points (user_id, shift_id, lat, lng, accuracy_m, recorded_at, batch_id) VALUES (?,?,?,?,?,?,?)`,
          row
        );
      }
    }
    await publishCommandEvent({
      type: 'telemetry.gps',
      actorUserId: req.auth.userId,
      subjectUserId: req.auth.userId,
      entityType: 'shift',
      entityId: shiftId,
      payload: {
        shiftId,
        batchId,
        points: points.length,
        latest: points[points.length - 1],
      },
    });
    return ok(res, { inserted: points.length, batchId }, 201);
  })
  )
);

router.post(
  '/patrols/scans',
  ...withAuth(
    requireRoles('guard'),
  validate(patrolBody),
  asyncHandler(async (req, res) => {
    const { checkpointId, scannedAt, clientMessageId } = req.validated.body;
    const pool = getPool();
    const [checkpointRows] = await pool.query(
      `SELECT id, site_id AS siteId, label FROM checkpoints WHERE id = ?`,
      [checkpointId]
    );
    if (!checkpointRows[0]) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid checkpointId');
    const checkpoint = checkpointRows[0];
    if (clientMessageId) {
      const [ex] = await pool.query(`SELECT id FROM patrol_scans WHERE client_message_id = ?`, [
        clientMessageId,
      ]);
      if (ex[0]) return ok(res, { id: ex[0].id, duplicate: true });
    }
    try {
      const [r] = await pool.query(
        `INSERT INTO patrol_scans (user_id, checkpoint_id, scanned_at, client_message_id)
         VALUES (?, ?, ?, ?)`,
        [req.auth.userId, checkpointId, scannedAt.slice(0, 23).replace('T', ' '), clientMessageId ?? null]
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'patrol.scan',
        entityType: 'patrol_scan',
        entityId: r.insertId,
        payload: { checkpointId, siteId: checkpoint.siteId, clientMessageId: clientMessageId ?? null },
        ip: req.ip,
      });
      await publishCommandEvent({
        type: 'patrol.scan',
        actorUserId: req.auth.userId,
        subjectUserId: req.auth.userId,
        siteId: Number(checkpoint.siteId),
        entityType: 'patrol_scan',
        entityId: r.insertId,
        payload: { checkpointId, checkpointLabel: checkpoint.label, scannedAt },
      });
      return ok(res, { id: r.insertId }, 201);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' && clientMessageId) {
        const [ex] = await pool.query(`SELECT id FROM patrol_scans WHERE client_message_id = ?`, [
          clientMessageId,
        ]);
        if (ex[0]) return ok(res, { id: ex[0].id, duplicate: true });
      }
      throw e;
    }
  })
  )
);

router.get(
  '/patrols/scans',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
    validate(patrolListQuery, 'query'),
    asyncHandler(async (req, res) => {
      const { siteId, limit } = req.validated.query;
      const pool = getPool();
      const where = [];
      const params = [];
      if (req.auth.role === 'guard') {
        where.push('ps.user_id = ?');
        params.push(req.auth.userId);
      } else if (req.query.userId) {
        where.push('ps.user_id = ?');
        params.push(Number(req.query.userId));
      }
      if (siteId) {
        where.push('cp.site_id = ?');
        params.push(siteId);
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT ps.id, ps.user_id AS userId, ps.checkpoint_id AS checkpointId, ps.scanned_at AS scannedAt,
                cp.label AS checkpointLabel, cp.site_id AS siteId, s.name AS siteName
         FROM patrol_scans ps
         JOIN checkpoints cp ON cp.id = ps.checkpoint_id
         JOIN sites s ON s.id = cp.site_id
         ${sqlWhere}
         ORDER BY ps.scanned_at DESC
         LIMIT ?`,
        [...params, limit]
      );
      return ok(res, { items: rows });
    })
  )
);

router.get(
  '/patrols/schedule',
  ...withAuth(
    requireRoles('guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const [sessions] = await pool.query(
        `SELECT a.id AS attendanceSessionId, a.shift_id AS shiftId, s.site_id AS siteId,
                s.starts_at AS startsAt, s.ends_at AS endsAt
         FROM attendance_sessions a
         JOIN shifts s ON s.id = a.shift_id
         WHERE a.user_id = ? AND a.status = 'open'
         ORDER BY a.id DESC LIMIT 1`,
        [req.auth.userId]
      );
      const active = sessions[0] ?? null;
      if (!active) return ok(res, { activeSession: null, items: [] });
      const [routeRows] = await pool.query(
        `SELECT id, interval_minutes AS intervalMinutes FROM patrol_routes
         WHERE site_id = ? AND is_active = 1 ORDER BY id LIMIT 1`,
        [active.siteId]
      );
      let route = routeRows[0] ?? null;
      if (!route) {
        const [r] = await pool.query(
          `INSERT INTO patrol_routes (site_id, name, interval_minutes) VALUES (?, 'Default Patrol', 60)`,
          [active.siteId]
        );
        route = { id: r.insertId, intervalMinutes: 60 };
        const [cps] = await pool.query(`SELECT id FROM checkpoints WHERE site_id = ? ORDER BY sort_order, id`, [
          active.siteId,
        ]);
        for (let i = 0; i < cps.length; i++) {
          await pool.query(
            `INSERT IGNORE INTO patrol_route_checkpoints (route_id, checkpoint_id, sort_order, due_offset_minutes)
             VALUES (?, ?, ?, ?)`,
            [route.id, cps[i].id, i, i * Number(route.intervalMinutes)]
          );
        }
      }
      const [items] = await pool.query(
        `SELECT prc.checkpoint_id AS checkpointId, c.label, c.lat, c.lng, prc.sort_order AS sortOrder,
                DATE_ADD(?, INTERVAL prc.due_offset_minutes MINUTE) AS dueAt,
                MAX(ps.scanned_at) AS scannedAt
         FROM patrol_route_checkpoints prc
         JOIN checkpoints c ON c.id = prc.checkpoint_id
         LEFT JOIN patrol_scans ps
           ON ps.checkpoint_id = c.id
          AND ps.user_id = ?
          AND ps.scanned_at >= ?
         WHERE prc.route_id = ?
         GROUP BY prc.checkpoint_id, c.label, c.lat, c.lng, prc.sort_order, prc.due_offset_minutes
         ORDER BY prc.sort_order`,
        [active.startsAt, req.auth.userId, active.startsAt, route.id]
      );
      const now = Date.now();
      return ok(res, {
        activeSession: active,
        routeId: route.id,
        items: items.map((item) => {
          const due = new Date(item.dueAt);
          const scanned = item.scannedAt ? new Date(item.scannedAt) : null;
          return {
            ...item,
            status: scanned ? 'completed' : due.getTime() < now ? 'missed' : 'due',
          };
        }),
      });
    })
  )
);

router.get(
  '/visual-logs/due',
  ...withAuth(
    requireRoles('guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const [sessions] = await pool.query(
        `SELECT a.id AS attendanceSessionId, a.shift_id AS shiftId, a.user_id AS userId,
                s.site_id AS siteId, a.check_in_at AS checkInAt, s.ends_at AS shiftEndsAt
         FROM attendance_sessions a
         JOIN shifts s ON s.id = a.shift_id
         WHERE a.user_id = ? AND a.status = 'open'
         ORDER BY a.id DESC LIMIT 1`,
        [req.auth.userId]
      );
      const session = sessions[0] ?? null;
      if (!session) return ok(res, { activeSession: null, items: [] });
      const start = new Date(session.checkInAt);
      const end = new Date(Math.min(Date.now() + 60 * 60 * 1000, new Date(session.shiftEndsAt).getTime()));
      const dueTimes = [];
      for (let t = new Date(start); t <= end; t = new Date(t.getTime() + 60 * 60 * 1000)) {
        dueTimes.push(t.toISOString().slice(0, 19).replace('T', ' '));
      }
      for (const dueAt of dueTimes) {
        await pool.query(
          `INSERT IGNORE INTO visual_log_hours
            (attendance_session_id, user_id, shift_id, site_id, due_at, status)
           VALUES (?, ?, ?, ?, ?, IF(? < NOW(), 'missed', 'due'))`,
          [session.attendanceSessionId, session.userId, session.shiftId, session.siteId, dueAt, dueAt]
        );
      }
      const [rows] = await pool.query(
        `SELECT id, attendance_session_id AS attendanceSessionId, shift_id AS shiftId, site_id AS siteId,
                due_at AS dueAt, completed_at AS completedAt, status, note
         FROM visual_log_hours
         WHERE attendance_session_id = ?
         ORDER BY due_at ASC`,
        [session.attendanceSessionId]
      );
      return ok(res, { activeSession: session, items: rows });
    })
  )
);

router.post(
  '/visual-logs',
  ...withAuth(
    requireRoles('guard'),
    validate(visualLogBody),
    asyncHandler(async (req, res) => {
      const b = req.validated.body;
      const pool = getPool();
      const [[session]] = await pool.query(
        `SELECT a.id, a.user_id AS userId, a.shift_id AS shiftId, s.site_id AS siteId
         FROM attendance_sessions a JOIN shifts s ON s.id = a.shift_id WHERE a.id = ?`,
        [b.attendanceSessionId]
      );
      if (!session || Number(session.userId) !== req.auth.userId) throw new AppError(404, 'NOT_FOUND', 'Session not found');
      const completedAt = b.completedAt ? b.completedAt.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
      const dueAt = completedAt.slice(0, 13) + ':00:00';
      const [r] = await pool.query(
        `INSERT INTO visual_log_hours
          (attendance_session_id, user_id, shift_id, site_id, due_at, completed_at, status, note)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
         ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at), status = 'completed', note = VALUES(note)`,
        [session.id, req.auth.userId, session.shiftId, session.siteId, dueAt, completedAt, b.note ?? null]
      );
      const [rows] = await pool.query(
        `SELECT id FROM visual_log_hours WHERE attendance_session_id = ? AND due_at = ?`,
        [session.id, dueAt]
      );
      const visualLogId = rows[0]?.id ?? r.insertId;
      if (b.mediaId) {
        await pool.query(
          `INSERT INTO incidents (user_id, site_id, shift_id, attendance_session_id, category, title, description, status)
           VALUES (?, ?, ?, ?, 'visual_log', 'Hourly visual log', ?, 'closed')`,
          [req.auth.userId, session.siteId, session.shiftId, session.id, b.note ?? null]
        );
      }
      await writeAudit({
        userId: req.auth.userId,
        action: 'visual_log.complete',
        entityType: 'visual_log_hour',
        entityId: visualLogId,
        payload: { attendanceSessionId: session.id, mediaId: b.mediaId ?? null },
        ip: req.ip,
      });
      await publishCommandEvent({
        type: 'visual_log.completed',
        actorUserId: req.auth.userId,
        subjectUserId: req.auth.userId,
        siteId: Number(session.siteId),
        entityType: 'visual_log_hour',
        entityId: visualLogId,
        payload: { dueAt, completedAt },
      });
      return ok(res, { id: visualLogId, status: 'completed' }, 201);
    })
  )
);

router.post(
  '/incidents',
  ...withAuth(
    requireRoles('guard'),
  validate(incidentBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [siteRows] = await pool.query(`SELECT id, is_active AS isActive FROM sites WHERE id = ?`, [b.siteId]);
    const site = siteRows[0];
    if (!site) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid siteId');
    }
    if (Number(site.isActive) !== 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Selected site is inactive');
    }
    const [r] = await pool.query(
      `INSERT INTO incidents
        (user_id, site_id, shift_id, attendance_session_id, category, title, description, status, lat, lng, captured_at, device_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [
        req.auth.userId,
        b.siteId,
        b.shiftId ?? null,
        b.attendanceSessionId ?? null,
        b.category,
        b.title,
        b.description ?? null,
        b.lat ?? null,
        b.lng ?? null,
        b.capturedAt ? b.capturedAt.slice(0, 19).replace('T', ' ') : null,
        b.deviceInfo ? JSON.stringify(b.deviceInfo) : null,
      ]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'incident.create',
      entityType: 'incident',
      entityId: r.insertId,
      payload: { siteId: b.siteId, category: b.category, title: b.title, shiftId: b.shiftId ?? null },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'incident.created',
      actorUserId: req.auth.userId,
      subjectUserId: req.auth.userId,
      siteId: b.siteId,
      entityType: 'incident',
      entityId: r.insertId,
      payload: { category: b.category, title: b.title, lat: b.lat ?? null, lng: b.lng ?? null },
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.get(
  '/incidents',
  ...withAuth(
    requireRoles('guard', 'supervisor', 'admin'),
    validate(incidentsListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { siteId, status, userId, q, page, limit } = req.validated.query;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const where = [];
    const params = [];
    if (req.auth.role === 'guard') {
      where.push('i.user_id = ?');
      params.push(req.auth.userId);
    } else if (userId) {
      where.push('i.user_id = ?');
      params.push(userId);
    }
    if (siteId) {
      where.push('i.site_id = ?');
      params.push(siteId);
    }
    if (status) {
      where.push('i.status = ?');
      params.push(status);
    }
    if (q) {
      where.push(`(
        i.title LIKE ?
        OR i.category LIKE ?
        OR COALESCE(i.description, '') LIKE ?
        OR CAST(i.site_id AS CHAR) LIKE ?
        OR CAST(i.user_id AS CHAR) LIKE ?
        OR st.name LIKE ?
        OR u.email LIKE ?
        OR gp.full_name LIKE ?
      )`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like, like);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const fromJoin = `FROM incidents i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN guard_profiles gp ON gp.user_id = u.id
       JOIN sites st ON st.id = i.site_id`;
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total ${fromJoin} ${sqlWhere}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);
    const [rows] = await pool.query(
      `SELECT i.id, i.user_id AS userId, i.site_id AS siteId, i.shift_id AS shiftId,
              i.attendance_session_id AS attendanceSessionId, i.category, i.title, i.status,
              i.lat, i.lng, i.captured_at AS capturedAt, i.created_at AS createdAt,
              st.name AS siteName, u.email AS userEmail, u.phone AS userPhone, gp.full_name AS guardName
       ${fromJoin}
       ${sqlWhere}
       ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return ok(res, { items: rows, page, limit, total });
  })
  )
);

router.get(
  '/incidents/:id',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [rows] = await pool.query(`SELECT * FROM incidents WHERE id = ?`, [id]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Not found');
    if (req.auth.role === 'guard' && rows[0].user_id !== req.auth.userId) {
      throw new AppError(403, 'FORBIDDEN', 'Denied');
    }
    const inc = rows[0];
    const [attachments] = await pool.query(
      `SELECT ia.id, ia.media_id AS mediaId, m.kind, m.storage_key AS storageKey, m.public_url AS publicUrl,
              m.mime, m.size_bytes AS sizeBytes, m.created_at AS createdAt
       FROM incident_attachments ia
       JOIN media_assets m ON m.id = ia.media_id
       WHERE ia.incident_id = ?
       ORDER BY ia.id DESC`,
      [id]
    );
    return ok(res, {
      id: inc.id,
      userId: inc.user_id,
      siteId: inc.site_id,
      category: inc.category,
      title: inc.title,
      description: inc.description,
      status: inc.status,
      shiftId: inc.shift_id,
      attendanceSessionId: inc.attendance_session_id,
      lat: inc.lat,
      lng: inc.lng,
      capturedAt: inc.captured_at,
      deviceInfo: typeof inc.device_info === 'string' ? JSON.parse(inc.device_info) : inc.device_info ?? null,
      createdAt: inc.created_at,
      updatedAt: inc.updated_at,
      attachments,
    });
  })
  )
);

router.patch(
  '/incidents/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(incidentPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(`UPDATE incidents SET status = ? WHERE id = ?`, [status, id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const [rows] = await pool.query(`SELECT user_id AS userId, site_id AS siteId FROM incidents WHERE id = ?`, [id]);
    await writeAudit({
      userId: req.auth.userId,
      action: 'incident.update_status',
      entityType: 'incident',
      entityId: id,
      payload: { status },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'incident.updated',
      actorUserId: req.auth.userId,
      subjectUserId: Number(rows[0]?.userId ?? 0) || null,
      siteId: Number(rows[0]?.siteId ?? 0) || null,
      entityType: 'incident',
      entityId: id,
      payload: { status },
    });
    return ok(res, { updated: true });
  })
  )
);

router.post(
  '/incidents/:id/attachments',
  ...withAuth(
    requireRoles('guard'),
  validate(attachBody),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { mediaId } = req.validated.body;
    const pool = getPool();
    const [inc] = await pool.query(`SELECT user_id FROM incidents WHERE id = ?`, [id]);
    if (!inc[0] || inc[0].user_id !== req.auth.userId) throw new AppError(404, 'NOT_FOUND', 'Not found');
    try {
      await pool.query(`INSERT INTO incident_attachments (incident_id, media_id) VALUES (?, ?)`, [
        id,
        mediaId,
      ]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'CONFLICT', 'Already attached');
      throw e;
    }
    await writeAudit({
      userId: req.auth.userId,
      action: 'incident.attach_media',
      entityType: 'incident',
      entityId: id,
      payload: { mediaId },
      ip: req.ip,
    });
    return ok(res, { linked: true }, 201);
  })
  )
);

router.delete(
  '/incidents/:incidentId/attachments/:attachmentId',
  ...withAuth(
    requireRoles('guard', 'supervisor', 'admin'),
    validate(attachmentDeleteParams, 'params'),
    asyncHandler(async (req, res) => {
      const { incidentId, attachmentId } = req.validated.params;
      const pool = getPool();

      const [incRows] = await pool.query(`SELECT id, user_id AS userId FROM incidents WHERE id = ?`, [
        incidentId,
      ]);
      const incident = incRows[0];
      if (!incident) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
      if (req.auth.role === 'guard' && Number(incident.userId) !== req.auth.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Denied');
      }

      const [del] = await pool.query(
        `DELETE FROM incident_attachments WHERE id = ? AND incident_id = ?`,
        [attachmentId, incidentId]
      );
      if (!del.affectedRows) throw new AppError(404, 'NOT_FOUND', 'Attachment not found');
      return ok(res, { deleted: true });
    })
  )
);

router.post(
  '/sos',
  ...withAuth(
    requireRoles('guard'),
  validate(sosBody),
  asyncHandler(async (req, res) => {
    const { lat, lng, message } = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO sos_events (user_id, lat, lng, message, status) VALUES (?, ?, ?, ?, 'active')`,
      [req.auth.userId, lat, lng, message ?? null]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'sos.trigger',
      entityType: 'sos',
      entityId: r.insertId,
      payload: { lat, lng },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'sos.triggered',
      actorUserId: req.auth.userId,
      subjectUserId: req.auth.userId,
      entityType: 'sos',
      entityId: r.insertId,
      payload: { lat, lng, message: message ?? null },
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.get(
  '/sos',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT se.id, se.user_id AS userId, se.lat, se.lng, se.message, se.status,
              se.created_at AS createdAt, se.resolved_at AS resolvedAt,
              u.email AS userEmail, u.phone AS userPhone, gp.full_name AS guardName
       FROM sos_events se
       JOIN users u ON u.id = se.user_id
       LEFT JOIN guard_profiles gp ON gp.user_id = u.id
       ORDER BY se.id DESC LIMIT 100`
    );
    return ok(res, { items: rows });
  })
  )
);

router.patch(
  '/sos/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(sosPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.validated.body;
    const pool = getPool();
    const resolved = status === 'resolved' ? new Date() : null;
    const [r] = await pool.query(
      `UPDATE sos_events SET status = ?, resolved_at = IF(? = 'resolved', NOW(), resolved_at) WHERE id = ?`,
      [status, status, id]
    );
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const [rows] = await pool.query(`SELECT user_id AS userId FROM sos_events WHERE id = ?`, [id]);
    await writeAudit({
      userId: req.auth.userId,
      action: 'sos.update_status',
      entityType: 'sos',
      entityId: id,
      payload: { status },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'sos.updated',
      actorUserId: req.auth.userId,
      subjectUserId: Number(rows[0]?.userId ?? 0) || null,
      entityType: 'sos',
      entityId: id,
      payload: { status },
    });
    return ok(res, { updated: true });
  })
  )
);

router.get(
  '/guard/summary',
  ...withAuth(
    requireRoles('guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const userId = req.auth.userId;

      const [activeRows] = await pool.query(
        `SELECT a.id, a.shift_id AS shiftId, a.check_in_at AS checkInAt, a.status,
                s.site_id AS siteId, si.name AS siteName, s.starts_at AS shiftStartsAt, s.ends_at AS shiftEndsAt
         FROM attendance_sessions a
         JOIN shifts s ON s.id = a.shift_id
         JOIN sites si ON si.id = s.site_id
         WHERE a.user_id = ? AND a.status = 'open'
         ORDER BY a.id DESC
         LIMIT 1`,
        [userId]
      );
      const activeSession = activeRows[0] ?? null;

      const [nextRows] = await pool.query(
        `SELECT s.id, s.site_id AS siteId, si.name AS siteName, s.starts_at AS startsAt, s.ends_at AS endsAt, s.status
         FROM shifts s
         JOIN sites si ON si.id = s.site_id
         WHERE s.user_id = ? AND s.status IN ('scheduled', 'active') AND s.ends_at >= NOW()
         ORDER BY s.starts_at ASC
         LIMIT 1`,
        [userId]
      );
      const nextShift = nextRows[0] ?? null;

      const [scanRows] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM patrol_scans
         WHERE user_id = ? AND scanned_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`,
        [userId]
      );

      const [incidentRows] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM incidents
         WHERE user_id = ? AND status = 'open'`,
        [userId]
      );

      return ok(res, {
        activeSession,
        nextShift,
        patrolScansLast24h: Number(scanRows[0]?.cnt ?? 0),
        openIncidentCount: Number(incidentRows[0]?.cnt ?? 0),
      });
    })
  )
);

router.get(
  '/payslips',
  ...withAuth(
    requireRoles('guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT p.id, p.payroll_run_id AS payrollRunId, p.status, p.payload,
                p.issued_at AS issuedAt, p.sent_at AS sentAt, p.read_at AS readAt,
                pr.period_start AS periodStart, pr.period_end AS periodEnd
         FROM payslips p
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         WHERE p.user_id = ?
         ORDER BY p.issued_at DESC, p.id DESC`,
        [req.auth.userId]
      );
      return ok(res, {
        items: rows.map((row) => ({
          ...row,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        })),
      });
    })
  )
);

router.post(
  '/media/upload',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new AppError(400, 'VALIDATION_ERROR', 'Missing file upload field: file');
      const parsed = mediaUploadBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid upload metadata');

      const kind = parsed.data.kind ?? 'other';
      const processed = await processUploadedMedia({
        filePath: req.file.path,
        filename: req.file.filename,
        mime: req.file.mimetype || null,
      });
      const storageKey = processed.storageKey ?? req.file.filename;
      const origin = (env.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const publicUrl = `${origin}/uploads/${encodeURIComponent(storageKey)}`;
      const sha256 = sha256File(processed.filePath ?? req.file.path);
      const accessToken = mediaAccessToken();
      const pool = getPool();
      try {
        const [r] = await pool.query(
          `INSERT INTO media_assets
            (user_id, kind, storage_provider, storage_key, object_key, public_url, mime, size_bytes,
             sha256, access_token, processing_status, processing_note, scan_status, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            req.auth.userId,
            kind,
            processed.storageProvider ?? 'local',
            storageKey,
            processed.objectKey ?? storageKey,
            publicUrl,
            processed.mime || req.file.mimetype || null,
            processed.sizeBytes || req.file.size || null,
            sha256,
            accessToken,
            processed.processingStatus ?? 'validated',
            processed.processingNote ?? null,
            processed.scanStatus ?? 'skipped',
          ]
        );
        await writeAudit({
          userId: req.auth.userId,
          action: 'media.upload',
          entityType: 'media_asset',
          entityId: r.insertId,
          payload: { kind, mime: req.file.mimetype || null, sizeBytes: req.file.size || null },
          ip: req.ip,
        });
        return ok(
          res,
          {
            id: r.insertId,
            kind,
            storageKey,
            publicUrl,
            mime: processed.mime || req.file.mimetype || null,
            sizeBytes: processed.sizeBytes || req.file.size || null,
            sha256,
          },
          201
        );
      } catch (e) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        throw e;
      }
    })
  )
);

router.post(
  '/media',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
  validate(mediaBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const accessToken = mediaAccessToken();
    const [r] = await pool.query(
      `INSERT INTO media_assets
        (user_id, kind, storage_key, public_url, mime, size_bytes, access_token, processing_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'stored')`,
      [
        req.auth.userId,
        b.kind ?? 'other',
        b.storageKey,
        b.publicUrl ?? null,
        b.mime ?? null,
        b.sizeBytes ?? null,
        accessToken,
      ]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'media.register',
      entityType: 'media_asset',
      entityId: r.insertId,
      payload: { kind: b.kind ?? 'other', storageKey: b.storageKey },
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

export default router;
