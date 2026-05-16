import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { listCommandEvents, publishCommandEvent } from '../services/commandEventService.js';
import { writeAudit } from '../utils/audit.js';
import { ensurePayslipPdf } from '../services/payslipService.js';
import { supervisorAllowedSiteIds } from '../utils/siteAccess.js';

const router = Router();

const exportBody = z.object({
  type: z.string().min(1),
  outputFormat: z.enum(['csv', 'xlsx', 'pdf']).optional(),
  params: z.record(z.unknown()).optional(),
});

const payrollBody = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const payrollAdjustmentBody = z.object({
  userId: z.number().int(),
  kind: z.enum(['bonus', 'deduction', 'correction', 'other']).optional(),
  amountPence: z.number().int(),
  reason: z.string().max(512).optional(),
});
const payrollStatusBody = z.object({
  status: z.enum(['approved', 'finalized']),
});

const trainingDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const trainingAssignmentBody = z.object({
  userId: z.number().int(),
  siteId: z.number().int(),
  trainedOn: trainingDateField,
  notes: z.string().max(512).optional(),
});

const trainingBulkAssignmentBody = z.object({
  userIds: z.array(z.number().int()).min(1).max(200),
  siteIds: z.array(z.number().int()).min(1).max(200),
  trainedOn: trainingDateField,
  notes: z.string().max(512).optional(),
});

const trainingListQuery = z.object({
  siteId: z.coerce.number().int().optional(),
  userId: z.coerce.number().int().optional(),
});
const commandEventsQuery = z.object({
  sinceId: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  siteId: z.coerce.number().int().optional(),
});
const availabilityBody = z.object({
  userId: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['available', 'unavailable', 'preferred']).optional(),
  reason: z.string().optional(),
});
const documentBody = z.object({
  mediaId: z.number().int().optional(),
  documentType: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['active', 'expired', 'archived']).optional(),
  expiresOn: z.string().optional(),
});
const emergencyContactBody = z.object({
  name: z.string().min(1),
  relationship: z.string().optional(),
  phone: z.string().min(1),
  email: z.string().email().optional(),
});
const lifecycleBody = z.object({
  eventType: z.enum(['onboarding', 'status_change', 'offboarding', 'archive']),
  notes: z.string().optional(),
  effectiveOn: z.string().optional(),
});
const withAuth = (...m) => [requireAuth, ...m];

router.get(
  '/dashboard/kpis',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const [[{ onDuty }]] = await pool.query(
      `SELECT COUNT(*) AS onDuty FROM attendance_sessions WHERE status = 'open'`
    );
    const [[{ openIncidents }]] = await pool.query(
      `SELECT COUNT(*) AS openIncidents FROM incidents WHERE status = 'open'`
    );
    const [[{ activeSos }]] = await pool.query(
      `SELECT COUNT(*) AS activeSos FROM sos_events WHERE status = 'active'`
    );
    return ok(res, {
      onDutyGuards: Number(onDuty),
      openIncidents: Number(openIncidents),
      activeSos: Number(activeSos),
      missedCheckpointsEstimate: 0,
    });
  })
  )
);

router.get(
  '/telemetry/latest',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (_req, res) => {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT gp.user_id AS userId, u.email, gp.shift_id AS shiftId, s.site_id AS siteId,
                gp.lat, gp.lng, gp.accuracy_m AS accuracyM, gp.recorded_at AS recordedAt
         FROM gps_points gp
         JOIN (
           SELECT user_id, MAX(recorded_at) AS maxRecordedAt
           FROM gps_points GROUP BY user_id
         ) latest ON latest.user_id = gp.user_id AND latest.maxRecordedAt = gp.recorded_at
         JOIN users u ON u.id = gp.user_id
         JOIN shifts s ON s.id = gp.shift_id
         ORDER BY gp.recorded_at DESC`
      );
      return ok(res, { items: rows });
    })
  )
);

router.get(
  '/telemetry/trails',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (req, res) => {
      const shiftId = Number(req.query.shiftId);
      if (!Number.isInteger(shiftId)) throw new AppError(400, 'VALIDATION_ERROR', 'shiftId is required');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, user_id AS userId, shift_id AS shiftId, lat, lng, accuracy_m AS accuracyM, recorded_at AS recordedAt
         FROM gps_points WHERE shift_id = ? ORDER BY recorded_at ASC LIMIT 2000`,
        [shiftId]
      );
      return ok(res, { items: rows });
    })
  )
);

router.get(
  '/availability',
  ...withAuth(
    requireRoles('admin', 'supervisor', 'guard'),
    asyncHandler(async (req, res) => {
      const pool = getPool();
      const userId = req.auth.role === 'guard' ? req.auth.userId : Number(req.query.userId || 0);
      const where = [];
      const params = [];
      if (userId) {
        where.push('ea.user_id = ?');
        params.push(userId);
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT ea.id, ea.user_id AS userId, u.email, ea.starts_at AS startsAt, ea.ends_at AS endsAt,
                ea.status, ea.reason, ea.created_at AS createdAt
         FROM employee_availability ea
         JOIN users u ON u.id = ea.user_id
         ${sqlWhere}
         ORDER BY ea.starts_at DESC LIMIT 500`,
        params
      );
      return ok(res, { items: rows });
    })
  )
);

router.post(
  '/availability',
  ...withAuth(
    requireRoles('admin', 'supervisor', 'guard'),
    validate(availabilityBody),
    asyncHandler(async (req, res) => {
      const b = req.validated.body;
      if (req.auth.role === 'guard' && b.userId !== req.auth.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Guards can only manage their own availability');
      }
      const pool = getPool();
      const [r] = await pool.query(
        `INSERT INTO employee_availability (user_id, starts_at, ends_at, status, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          b.userId,
          b.startsAt.slice(0, 19).replace('T', ' '),
          b.endsAt.slice(0, 19).replace('T', ' '),
          b.status ?? 'unavailable',
          b.reason ?? null,
          req.auth.userId,
        ]
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'availability.create',
        entityType: 'employee_availability',
        entityId: r.insertId,
        payload: b,
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

router.get(
  '/hr/users/:userId',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.userId);
      const pool = getPool();
      const [[user]] = await pool.query(
        `SELECT u.id, u.email, u.phone, u.status, r.slug AS role, u.created_at AS createdAt
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [userId]
      );
      if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
      const [documents] = await pool.query(
        `SELECT id, media_id AS mediaId, document_type AS documentType, title, status, expires_on AS expiresOn, created_at AS createdAt
         FROM employee_documents WHERE user_id = ? ORDER BY id DESC`,
        [userId]
      );
      const [contacts] = await pool.query(
        `SELECT id, name, relationship, phone, email, created_at AS createdAt
         FROM employee_emergency_contacts WHERE user_id = ? ORDER BY id DESC`,
        [userId]
      );
      const [lifecycle] = await pool.query(
        `SELECT id, event_type AS eventType, notes, effective_on AS effectiveOn, created_at AS createdAt
         FROM employee_lifecycle_events WHERE user_id = ? ORDER BY id DESC`,
        [userId]
      );
      return ok(res, { user, documents, emergencyContacts: contacts, lifecycle });
    })
  )
);

router.post(
  '/hr/users/:userId/documents',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(documentBody),
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.userId);
      const b = req.validated.body;
      const pool = getPool();
      const [r] = await pool.query(
        `INSERT INTO employee_documents (user_id, media_id, document_type, title, status, expires_on, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, b.mediaId ?? null, b.documentType, b.title, b.status ?? 'active', b.expiresOn ?? null, req.auth.userId]
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'hr.document.create',
        entityType: 'employee_document',
        entityId: r.insertId,
        payload: { userId, documentType: b.documentType },
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

router.post(
  '/hr/users/:userId/emergency-contacts',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(emergencyContactBody),
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.userId);
      const b = req.validated.body;
      const pool = getPool();
      const [r] = await pool.query(
        `INSERT INTO employee_emergency_contacts (user_id, name, relationship, phone, email)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, b.name, b.relationship ?? null, b.phone, b.email ?? null]
      );
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

router.post(
  '/hr/users/:userId/lifecycle',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(lifecycleBody),
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.userId);
      const b = req.validated.body;
      const pool = getPool();
      const [r] = await pool.query(
        `INSERT INTO employee_lifecycle_events (user_id, event_type, notes, effective_on, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, b.eventType, b.notes ?? null, b.effectiveOn ?? null, req.auth.userId]
      );
      if (b.eventType === 'archive' || b.eventType === 'offboarding') {
        await pool.query(`UPDATE users SET status = 'suspended' WHERE id = ?`, [userId]);
      }
      await writeAudit({
        userId: req.auth.userId,
        action: `hr.${b.eventType}`,
        entityType: 'user',
        entityId: userId,
        payload: b,
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

async function ensureGuardUser(pool, userId) {
  const [rows] = await pool.query(
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND r.slug = 'guard'`,
    [userId]
  );
  if (!rows.length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'User must be a guard (staff)');
  }
}

router.get(
  '/training/assignments',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(trainingListQuery, 'query'),
    asyncHandler(async (req, res) => {
      const q = req.validated.query;
      const pool = getPool();
      const allowed = await supervisorAllowedSiteIds(req.auth.userId, req.auth.role);
      const where = [`r.slug = 'guard'`];
      const params = [];
      if (q.siteId) {
        where.push('gst.site_id = ?');
        params.push(q.siteId);
      }
      if (q.userId) {
        where.push('gst.user_id = ?');
        params.push(q.userId);
      }
      if (allowed && allowed.length > 0) {
        where.push(`gst.site_id IN (${allowed.map(() => '?').join(',')})`);
        params.push(...allowed);
      }
      const [rows] = await pool.query(
        `SELECT gst.id,
                gst.user_id AS userId,
                u.email AS userEmail,
                gp.full_name AS guardName,
                gst.site_id AS siteId,
                s.name AS siteName,
                gst.trained_on AS trainedOn,
                gst.notes,
                gst.created_at AS createdAt
         FROM guard_site_training gst
         JOIN users u ON u.id = gst.user_id
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN guard_profiles gp ON gp.user_id = u.id
         JOIN sites s ON s.id = gst.site_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.name ASC, u.email ASC
         LIMIT 2000`,
        params
      );
      return ok(res, { items: rows });
    })
  )
);

router.post(
  '/training/assignments',
  ...withAuth(
    requireRoles('admin'),
    validate(trainingAssignmentBody),
    asyncHandler(async (req, res) => {
      const b = req.validated.body;
      const pool = getPool();
      await ensureGuardUser(pool, b.userId);
      const [siteRows] = await pool.query(`SELECT id FROM sites WHERE id = ?`, [b.siteId]);
      if (!siteRows.length) throw new AppError(404, 'NOT_FOUND', 'Site not found');
      let r;
      try {
        [r] = await pool.query(
          `INSERT INTO guard_site_training (user_id, site_id, trained_on, notes, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          [b.userId, b.siteId, b.trainedOn ?? null, b.notes ?? null, req.auth.userId]
        );
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          throw new AppError(409, 'CONFLICT', 'This guard is already trained for that site');
        }
        throw err;
      }
      await writeAudit({
        userId: req.auth.userId,
        action: 'training.assign',
        entityType: 'guard_site_training',
        entityId: r.insertId,
        payload: b,
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

router.post(
  '/training/assignments/bulk',
  ...withAuth(
    requireRoles('admin'),
    validate(trainingBulkAssignmentBody),
    asyncHandler(async (req, res) => {
      const b = req.validated.body;
      const pool = getPool();
      const uniqueUserIds = [...new Set(b.userIds)];
      const uniqueSiteIds = [...new Set(b.siteIds)];

      for (const userId of uniqueUserIds) {
        await ensureGuardUser(pool, userId);
      }

      const [siteRows] = await pool.query(
        `SELECT id FROM sites WHERE id IN (${uniqueSiteIds.map(() => '?').join(',')})`,
        uniqueSiteIds
      );
      if (siteRows.length !== uniqueSiteIds.length) {
        throw new AppError(404, 'NOT_FOUND', 'One or more sites were not found');
      }

      let created = 0;
      let skipped = 0;
      const createdIds = [];

      for (const userId of uniqueUserIds) {
        for (const siteId of uniqueSiteIds) {
          try {
            const [r] = await pool.query(
              `INSERT INTO guard_site_training (user_id, site_id, trained_on, notes, created_by)
               VALUES (?, ?, ?, ?, ?)`,
              [userId, siteId, b.trainedOn ?? null, b.notes ?? null, req.auth.userId]
            );
            created += 1;
            createdIds.push(r.insertId);
          } catch (err) {
            if (err?.code === 'ER_DUP_ENTRY') {
              skipped += 1;
              continue;
            }
            throw err;
          }
        }
      }

      if (created > 0) {
        await writeAudit({
          userId: req.auth.userId,
          action: 'training.assign_bulk',
          entityType: 'guard_site_training',
          entityId: createdIds[0] ?? null,
          payload: {
            userIds: uniqueUserIds,
            siteIds: uniqueSiteIds,
            created,
            skipped,
            trainedOn: b.trainedOn,
            notes: b.notes,
          },
          ip: req.ip,
        });
      }

      return ok(res, { created, skipped, total: uniqueUserIds.length * uniqueSiteIds.length }, 201);
    })
  )
);

router.patch(
  '/training/assignments/:id',
  ...withAuth(
    requireRoles('admin'),
    validate(
      z.object({
        trainedOn: trainingDateField,
        notes: z.string().max(512).optional(),
      }),
      'body'
    ),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const b = req.validated.body;
      const pool = getPool();
      const [existing] = await pool.query(
        `SELECT id, user_id AS userId, site_id AS siteId FROM guard_site_training WHERE id = ?`,
        [id]
      );
      if (!existing.length) throw new AppError(404, 'NOT_FOUND', 'Training assignment not found');
      const row = existing[0];
      await pool.query(
        `UPDATE guard_site_training SET trained_on = ?, notes = COALESCE(?, notes) WHERE id = ?`,
        [b.trainedOn ?? null, b.notes ?? null, id]
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'training.update',
        entityType: 'guard_site_training',
        entityId: id,
        payload: { userId: row.userId, siteId: row.siteId, ...b },
        ip: req.ip,
      });
      return ok(res, { id, updated: true });
    })
  )
);

router.delete(
  '/training/assignments/:id',
  ...withAuth(
    requireRoles('admin'),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pool = getPool();
      const [existing] = await pool.query(
        `SELECT id, user_id AS userId, site_id AS siteId FROM guard_site_training WHERE id = ?`,
        [id]
      );
      if (!existing.length) throw new AppError(404, 'NOT_FOUND', 'Training assignment not found');
      const row = existing[0];
      const [r] = await pool.query(`DELETE FROM guard_site_training WHERE id = ?`, [id]);
      if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Training assignment not found');
      await writeAudit({
        userId: req.auth.userId,
        action: 'training.unassign',
        entityType: 'guard_site_training',
        entityId: id,
        payload: { userId: row.userId, siteId: row.siteId },
        ip: req.ip,
      });
      return ok(res, { deleted: true });
    })
  )
);

router.get(
  '/command/events',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(commandEventsQuery, 'query'),
    asyncHandler(async (req, res) => {
      const q = req.validated.query;
      const events = await listCommandEvents({
        sinceId: q.sinceId,
        limit: q.limit,
        siteId: q.siteId ?? null,
      });
      return ok(res, { items: events });
    })
  )
);

router.get(
  '/command/events/stream',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(commandEventsQuery, 'query'),
    asyncHandler(async (req, res) => {
      let sinceId = req.validated.query.sinceId;
      const siteId = req.validated.query.siteId ?? null;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = async () => {
        const events = await listCommandEvents({ sinceId, limit: 100, siteId });
        for (const event of events) {
          sinceId = Math.max(sinceId, Number(event.id));
          res.write(`id: ${event.id}\n`);
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      await send();
      const interval = setInterval(() => {
        send().catch((e) => {
          res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
        });
      }, 5000);
      req.on('close', () => clearInterval(interval));
    })
  )
);

router.get(
  '/audit-logs',
  ...withAuth(
    requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, action, entity_type AS entityType, entity_id AS entityId,
              payload, ip, created_at AS createdAt
       FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs`);
    return ok(res, { items: rows, page, limit, total: Number(total) });
  })
  )
);

router.post(
  '/reports/exports',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  validate(exportBody),
  asyncHandler(async (req, res) => {
    const { type, outputFormat, params } = req.validated.body;
    const format = outputFormat ?? (typeof params?.format === 'string' ? params.format : 'csv');
    const pool = getPool();
    const paramsJson = params !== undefined ? JSON.stringify(params) : null;
    const [r] = await pool.query(
      `INSERT INTO export_jobs (type, output_format, status, created_by, params) VALUES (?, ?, 'queued', ?, ?)`,
      [type, format, req.auth.userId, paramsJson]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'export.queue',
      entityType: 'export_job',
      entityId: r.insertId,
      payload: { type, outputFormat: format, params: params ?? {} },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'export.queued',
      actorUserId: req.auth.userId,
      entityType: 'export_job',
      entityId: r.insertId,
      payload: { type, outputFormat: format },
    });
    return ok(res, { id: r.insertId, status: 'queued', outputFormat: format, params: params ?? {} }, 201);
  })
  )
);

router.get(
  '/reports/exports/:id/file',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, output_format AS outputFormat, file_path AS filePath, file_mime AS fileMime,
              status, error_message AS errorMessage FROM export_jobs WHERE id = ?`,
      [id]
    );
    const job = rows[0];
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found');
    if (job.status === 'failed') {
      throw new AppError(400, 'VALIDATION_ERROR', job.errorMessage || 'Export failed');
    }
    if (job.status !== 'done' || !job.filePath) {
      throw new AppError(404, 'NOT_FOUND', 'Export file not ready');
    }
    const abs = path.isAbsolute(job.filePath) ? job.filePath : path.join(process.cwd(), job.filePath);
    if (!fs.existsSync(abs)) throw new AppError(404, 'NOT_FOUND', 'File missing on disk');
    const ext = job.outputFormat || path.extname(abs).replace('.', '') || 'csv';
    res.setHeader('Content-Type', job.fileMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="export-${id}.${ext}"`);
    fs.createReadStream(abs).pipe(res);
  })
  )
);

router.get(
  '/reports/exports/:id',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, type, output_format AS outputFormat, status, file_url AS fileUrl, params, error_message AS errorMessage,
              created_at AS createdAt FROM export_jobs WHERE id = ?`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Job not found');
    const row = rows[0];
    let parsedParams = row.params;
    if (typeof parsedParams === 'string') {
      try {
        parsedParams = JSON.parse(parsedParams);
      } catch {
        parsedParams = null;
      }
    }
    const base = env.publicBaseUrl?.replace(/\/$/, '') || '';
    const downloadUrl = `${base}/api/v1/reports/exports/${id}/file`;
    return ok(res, {
      id: row.id,
      type: row.type,
      status: row.status,
      fileUrl: row.fileUrl,
      params: parsedParams,
      errorMessage: row.errorMessage,
      downloadUrl,
      createdAt: row.createdAt,
    });
  })
  )
);

router.get(
  '/payroll/runs/:runId',
  ...withAuth(
    requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.runId);
    const pool = getPool();
    const [runs] = await pool.query(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd, status, notes, result_json AS resultJson, created_at AS createdAt
       FROM payroll_runs WHERE id = ?`,
      [id]
    );
    if (!runs[0]) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
    const run = runs[0];
    let parsedResult = run.resultJson;
    if (typeof parsedResult === 'string') {
      try {
        parsedResult = JSON.parse(parsedResult);
      } catch {
        parsedResult = null;
      }
    }
    let lines = [];
    try {
      const [lrows] = await pool.query(
        `SELECT id, user_id AS userId, hours_worked AS hoursWorked, gross_pence AS grossPence,
                paye_pence AS payePence, ni_employee_pence AS niEmployeePence,
                ni_employer_pence AS niEmployerPence, net_pence AS netPence, meta_json AS metaJson
         FROM payroll_lines WHERE payroll_run_id = ? ORDER BY id`,
        [id]
      );
      lines = lrows.map((r) => ({
        ...r,
        metaJson:
          typeof r.metaJson === 'string' ? JSON.parse(r.metaJson) : r.metaJson ?? null,
      }));
    } catch {
      lines = [];
    }
    return ok(res, {
      id: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      status: run.status,
      notes: run.notes,
      createdAt: run.createdAt,
      resultJson: parsedResult,
      lines,
    });
  })
  )
);

router.get(
  '/payroll/runs',
  ...withAuth(
    requireRoles('admin'),
  asyncHandler(async (_req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd, status, notes, created_at AS createdAt
       FROM payroll_runs ORDER BY id DESC LIMIT 100`
    );
    return ok(res, { items: rows });
  })
  )
);

router.post(
  '/payroll/runs',
  ...withAuth(
    requireRoles('admin'),
  validate(payrollBody),
  asyncHandler(async (req, res) => {
    const { periodStart, periodEnd } = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO payroll_runs (period_start, period_end, status, notes) VALUES (?, ?, 'draft', NULL)`,
      [periodStart, periodEnd]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'payroll.create',
      entityType: 'payroll_run',
      entityId: r.insertId,
      payload: { periodStart, periodEnd },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'payroll.created',
      actorUserId: req.auth.userId,
      entityType: 'payroll_run',
      entityId: r.insertId,
      payload: { periodStart, periodEnd },
    });
    return ok(res, { id: r.insertId, status: 'draft' }, 201);
  })
  )
);

router.post(
  '/payroll/runs/:runId/adjustments',
  ...withAuth(
    requireRoles('admin'),
    validate(payrollAdjustmentBody),
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.runId);
      const b = req.validated.body;
      const pool = getPool();
      const [[run]] = await pool.query(`SELECT id, status FROM payroll_runs WHERE id = ?`, [runId]);
      if (!run) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
      if (!['draft', 'failed'].includes(run.status)) {
        throw new AppError(409, 'CONFLICT', 'Adjustments can only be added before processing/approval');
      }
      const [r] = await pool.query(
        `INSERT INTO payroll_adjustments
          (payroll_run_id, user_id, kind, amount_pence, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, b.userId, b.kind ?? 'other', b.amountPence, b.reason ?? null, req.auth.userId]
      );
      await writeAudit({
        userId: req.auth.userId,
        action: 'payroll.adjustment.create',
        entityType: 'payroll_adjustment',
        entityId: r.insertId,
        payload: { runId, userId: b.userId, kind: b.kind ?? 'other', amountPence: b.amountPence },
        ip: req.ip,
      });
      return ok(res, { id: r.insertId }, 201);
    })
  )
);

router.patch(
  '/payroll/runs/:runId/status',
  ...withAuth(
    requireRoles('admin'),
    validate(payrollStatusBody),
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.runId);
      const { status } = req.validated.body;
      const pool = getPool();
      const [[run]] = await pool.query(`SELECT id, status FROM payroll_runs WHERE id = ?`, [runId]);
      if (!run) throw new AppError(404, 'NOT_FOUND', 'Payroll run not found');
      if (status === 'approved' && run.status !== 'completed') {
        throw new AppError(409, 'CONFLICT', 'Only completed payroll runs can be approved');
      }
      if (status === 'finalized' && run.status !== 'approved') {
        throw new AppError(409, 'CONFLICT', 'Only approved payroll runs can be finalized');
      }

      if (status === 'approved') {
        await pool.query(
          `UPDATE payroll_runs SET status = 'approved', approved_at = NOW(), approved_by = ? WHERE id = ?`,
          [req.auth.userId, runId]
        );
      } else {
        await pool.query(
          `UPDATE payroll_runs SET status = 'finalized', finalized_at = NOW(), finalized_by = ? WHERE id = ?`,
          [req.auth.userId, runId]
        );
        await pool.query(
          `INSERT INTO payslips (payroll_run_id, user_id, payroll_line_id, status, payload, issued_at)
           SELECT ?, pl.user_id, pl.id, 'issued',
                  JSON_OBJECT(
                    'payrollRunId', ?,
                    'userId', pl.user_id,
                    'hoursWorked', pl.hours_worked,
                    'grossPence', pl.gross_pence,
                    'payePence', pl.paye_pence,
                    'niEmployeePence', pl.ni_employee_pence,
                    'niEmployerPence', pl.ni_employer_pence,
                    'netPence', pl.net_pence,
                    'meta', pl.meta_json
                  ),
                  NOW()
           FROM payroll_lines pl
           WHERE pl.payroll_run_id = ?
           ON DUPLICATE KEY UPDATE status = 'issued', payload = VALUES(payload), issued_at = NOW()`,
          [runId, runId, runId]
        );
      }
      await writeAudit({
        userId: req.auth.userId,
        action: `payroll.${status}`,
        entityType: 'payroll_run',
        entityId: runId,
        ip: req.ip,
      });
      await publishCommandEvent({
        type: `payroll.${status}`,
        actorUserId: req.auth.userId,
        entityType: 'payroll_run',
        entityId: runId,
        payload: { status },
      });
      return ok(res, { id: runId, status });
    })
  )
);

router.get(
  '/payroll/runs/:runId/payslips',
  ...withAuth(
    requireRoles('admin'),
    asyncHandler(async (req, res) => {
      const runId = Number(req.params.runId);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, payroll_run_id AS payrollRunId, user_id AS userId, payroll_line_id AS payrollLineId,
                status, payload, file_path AS filePath, file_mime AS fileMime,
                issued_at AS issuedAt, sent_at AS sentAt, read_at AS readAt, created_at AS createdAt
         FROM payslips
         WHERE payroll_run_id = ?
         ORDER BY id`,
        [runId]
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

router.get(
  '/payroll/payslips/:id/file',
  ...withAuth(
    requireRoles('admin', 'guard'),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pool = getPool();
      const payslip = await ensurePayslipPdf(pool, id);
      if (!payslip) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
      if (req.auth.role === 'guard' && Number(payslip.user_id) !== req.auth.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Denied');
      }
      if (req.auth.role === 'guard') {
        await pool.query(`UPDATE payslips SET read_at = COALESCE(read_at, NOW()) WHERE id = ?`, [id]);
      }
      const abs = path.isAbsolute(payslip.file_path)
        ? payslip.file_path
        : path.join(process.cwd(), payslip.file_path);
      if (!fs.existsSync(abs)) throw new AppError(404, 'NOT_FOUND', 'Payslip file missing');
      res.setHeader('Content-Type', payslip.file_mime || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="payslip-${id}.pdf"`);
      fs.createReadStream(abs).pipe(res);
    })
  )
);

router.post(
  '/payroll/payslips/:id/send',
  ...withAuth(
    requireRoles('admin'),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pool = getPool();
      const payslip = await ensurePayslipPdf(pool, id);
      if (!payslip) throw new AppError(404, 'NOT_FOUND', 'Payslip not found');
      await pool.query(`UPDATE payslips SET sent_at = NOW(), status = 'sent' WHERE id = ?`, [id]);
      await writeAudit({
        userId: req.auth.userId,
        action: 'payslip.send',
        entityType: 'payslip',
        entityId: id,
        ip: req.ip,
      });
      return ok(res, { id, sent: true });
    })
  )
);

export default router;
