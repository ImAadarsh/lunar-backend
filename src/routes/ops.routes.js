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

const router = Router();

const exportBody = z.object({
  type: z.string().min(1),
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

const certBody = z.object({
  userId: z.number().int(),
  name: z.string().min(1),
  issuer: z.string().optional(),
  obtainedOn: z.string().optional(),
  expiresOn: z.string().optional(),
});

const certPatch = certBody.partial().omit({ userId: true });
const commandEventsQuery = z.object({
  sinceId: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  siteId: z.coerce.number().int().optional(),
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
    const { type, params } = req.validated.body;
    const pool = getPool();
    const paramsJson = params !== undefined ? JSON.stringify(params) : null;
    const [r] = await pool.query(
      `INSERT INTO export_jobs (type, status, created_by, params) VALUES (?, 'queued', ?, ?)`,
      [type, req.auth.userId, paramsJson]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'export.queue',
      entityType: 'export_job',
      entityId: r.insertId,
      payload: { type, params: params ?? {} },
      ip: req.ip,
    });
    await publishCommandEvent({
      type: 'export.queued',
      actorUserId: req.auth.userId,
      entityType: 'export_job',
      entityId: r.insertId,
      payload: { type },
    });
    return ok(res, { id: r.insertId, status: 'queued', params: params ?? {} }, 201);
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
      `SELECT id, file_path AS filePath, status, error_message AS errorMessage FROM export_jobs WHERE id = ?`,
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="export-${id}.csv"`);
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
      `SELECT id, type, status, file_url AS fileUrl, params, error_message AS errorMessage,
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
                status, payload, issued_at AS issuedAt, created_at AS createdAt
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
  '/certifications',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const where = [];
    const params = [];
    if (req.query.userId) {
      where.push('user_id = ?');
      params.push(Number(req.query.userId));
    }
    if (req.query.expiringBefore) {
      where.push('expires_on IS NOT NULL AND expires_on <= ?');
      params.push(req.query.expiringBefore);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT id, user_id AS userId, name, issuer, obtained_on AS obtainedOn, expires_on AS expiresOn
       FROM employee_certifications ${sqlWhere} ORDER BY id DESC LIMIT 500`,
      params
    );
    return ok(res, { items: rows });
  })
  )
);

router.post(
  '/certifications',
  ...withAuth(
    requireRoles('admin'),
  validate(certBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO employee_certifications (user_id, name, issuer, obtained_on, expires_on)
       VALUES (?, ?, ?, ?, ?)`,
      [b.userId, b.name, b.issuer ?? null, b.obtainedOn ?? null, b.expiresOn ?? null]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'certification.create',
      entityType: 'employee_certification',
      entityId: r.insertId,
      payload: { userId: b.userId, name: b.name },
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
  )
);

router.patch(
  '/certifications/:id',
  ...withAuth(
    requireRoles('admin'),
  validate(certPatch),
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
    if (b.issuer !== undefined) {
      fields.push('issuer = ?');
      params.push(b.issuer);
    }
    if (b.obtainedOn !== undefined) {
      fields.push('obtained_on = ?');
      params.push(b.obtainedOn);
    }
    if (b.expiresOn !== undefined) {
      fields.push('expires_on = ?');
      params.push(b.expiresOn);
    }
    if (!fields.length) throw new AppError(400, 'VALIDATION_ERROR', 'No updates');
    params.push(id);
    const [r] = await pool.query(
      `UPDATE employee_certifications SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'certification.update',
      entityType: 'employee_certification',
      entityId: id,
      payload: b,
      ip: req.ip,
    });
    return ok(res, { updated: true });
  })
  )
);

router.delete(
  '/certifications/:id',
  ...withAuth(
    requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [r] = await pool.query(`DELETE FROM employee_certifications WHERE id = ?`, [id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'certification.delete',
      entityType: 'employee_certification',
      entityId: id,
      ip: req.ip,
    });
    return ok(res, { deleted: true });
  })
  )
);

export default router;
