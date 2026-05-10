import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { isInsideCircularGeofence } from '../utils/geo.js';
import { writeAudit } from '../utils/audit.js';

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
              si.center_lat, si.center_lng, si.geofence_radius_m
       FROM shifts s JOIN sites si ON si.id = s.site_id WHERE s.id = ?`,
      [shiftId]
    );
    const shift = sh[0];
    if (!shift || shift.userId !== req.auth.userId) {
      throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    }
    if (!isInsideCircularGeofence(shift, lat, lng)) {
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
      `SELECT a.id, a.shift_id, s.site_id, si.center_lat, si.center_lng, si.geofence_radius_m
       FROM attendance_sessions a
       JOIN shifts s ON s.id = a.shift_id
       JOIN sites si ON si.id = s.site_id
       WHERE a.id = ? AND a.user_id = ? AND a.status = 'open'`,
      [sessionId, req.auth.userId]
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Session not found');
    const inside = isInsideCircularGeofence(row, lat, lng);
    const outAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      `UPDATE attendance_sessions SET check_out_at = ?, check_out_lat = ?, check_out_lng = ?,
       inside_geofence_out = ?, status = 'closed' WHERE id = ?`,
      [outAt, lat, lng, inside ? 1 : 0, sessionId]
    );
    return ok(res, { closed: true });
  })
  )
);

router.get(
  '/attendance/sessions',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
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
      `INSERT INTO incidents (user_id, site_id, category, title, description, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
      [req.auth.userId, b.siteId, b.category, b.title, b.description ?? null]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'incident.create',
      entityType: 'incident',
      entityId: r.insertId,
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.get(
  '/incidents',
  ...withAuth(
    requireRoles('guard', 'supervisor'),
    validate(incidentsListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { siteId, status, userId, q, page, limit } = req.validated.query;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const where = [];
    const params = [];
    if (req.auth.role === 'guard') {
      where.push('user_id = ?');
      params.push(req.auth.userId);
    } else if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    if (siteId) {
      where.push('site_id = ?');
      params.push(siteId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (q) {
      where.push(`(
        title LIKE ?
        OR category LIKE ?
        OR COALESCE(description, '') LIKE ?
        OR CAST(site_id AS CHAR) LIKE ?
        OR CAST(user_id AS CHAR) LIKE ?
      )`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM incidents ${sqlWhere}`,
      params
    );
    const total = Number(countRows[0]?.total ?? 0);
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, site_id AS siteId, category, title, status, created_at AS createdAt
       FROM incidents ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`,
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
      ip: req.ip,
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
      `SELECT id, user_id AS userId, lat, lng, message, status, created_at AS createdAt, resolved_at AS resolvedAt
       FROM sos_events ORDER BY id DESC LIMIT 100`
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
      const storageKey = req.file.filename;
      const origin = (env.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const publicUrl = `${origin}/uploads/${encodeURIComponent(storageKey)}`;
      const pool = getPool();
      try {
        const [r] = await pool.query(
          `INSERT INTO media_assets (user_id, kind, storage_key, public_url, mime, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.auth.userId, kind, storageKey, publicUrl, req.file.mimetype || null, req.file.size || null]
        );
        return ok(
          res,
          {
            id: r.insertId,
            kind,
            storageKey,
            publicUrl,
            mime: req.file.mimetype || null,
            sizeBytes: req.file.size || null,
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
    const [r] = await pool.query(
      `INSERT INTO media_assets (user_id, kind, storage_key, public_url, mime, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.auth.userId,
        b.kind ?? 'other',
        b.storageKey,
        b.publicUrl ?? null,
        b.mime ?? null,
        b.sizeBytes ?? null,
      ]
    );
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

export default router;
