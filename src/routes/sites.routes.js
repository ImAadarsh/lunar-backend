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
import { supervisorAllowedSiteIds, supervisorCanAccessSite } from '../utils/siteAccess.js';

const router = Router();

const siteBody = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  centerLat: z.number(),
  centerLng: z.number(),
  geofenceRadiusM: z.number().int().positive().nullable().optional(),
  geofencePolygon: z.unknown().optional(),
  isActive: z.boolean().optional(),
});

const sitePatch = siteBody.partial();

const cpBody = z.object({
  label: z.string().min(1),
  /** Optional; if omitted we will auto-set qr_code = insertId (checkpoint ID) */
  qrCode: z.string().min(1).optional(),
  lat: z.number(),
  lng: z.number(),
  sortOrder: z.number().int().optional(),
});

const cpPatch = cpBody.partial();

const siteListQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
  q: z.string().trim().min(1).optional(),
  isActive: z.coerce.boolean().optional(),
});

router.use(requireAuth);

router.get(
  '/',
  requireRoles('admin', 'supervisor'),
  validate(siteListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, q, isActive } = req.validated.query;
    const offset = (page - 1) * limit;
    const pool = getPool();
    const allowed = await supervisorAllowedSiteIds(req.auth.userId, req.auth.role);
    const where = [];
    const params = [];
    if (allowed && allowed.length > 0) {
      where.push(`id IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    if (isActive !== undefined) {
      where.push('is_active = ?');
      params.push(isActive ? 1 : 0);
    }
    if (q) {
      where.push(`(
        name LIKE ?
        OR COALESCE(address, '') LIKE ?
        OR CAST(center_lat AS CHAR) LIKE ?
        OR CAST(center_lng AS CHAR) LIKE ?
      )`);
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM sites ${sqlWhere}`, params);
    const total = Number(countRows[0]?.total ?? 0);
    const [rows] = await pool.query(
      `SELECT id, name, address, center_lat AS centerLat, center_lng AS centerLng,
              geofence_radius_m AS geofenceRadiusM, geofence_polygon AS geofencePolygon,
              is_active AS isActive, created_at AS createdAt
       FROM sites
       ${sqlWhere}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return ok(res, { items: rows, page, limit, total });
  })
);

router.post(
  '/',
  requireRoles('admin', 'supervisor'),
  validate(siteBody),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;
    const pool = getPool();
    const [r] = await pool.query(
      `INSERT INTO sites (name, address, center_lat, center_lng, geofence_radius_m, geofence_polygon, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name,
        b.address ?? null,
        b.centerLat,
        b.centerLng,
        b.geofenceRadiusM ?? null,
        b.geofencePolygon ? JSON.stringify(b.geofencePolygon) : null,
        b.isActive === false ? 0 : 1,
      ]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'site.create',
      entityType: 'site',
      entityId: r.insertId,
      ip: req.ip,
    });
    return ok(res, { id: r.insertId }, 201);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid id');
    const allowedRole = ['admin', 'supervisor', 'guard'].includes(req.auth.role);
    if (!allowedRole) throw new AppError(403, 'FORBIDDEN', 'Denied');
    if (req.auth.role === 'supervisor') {
      const okAccess = await supervisorCanAccessSite(req.auth.userId, req.auth.role, id);
      if (!okAccess) throw new AppError(403, 'FORBIDDEN', 'No access to this site');
    }
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, name, address, center_lat AS centerLat, center_lng AS centerLng,
              geofence_radius_m AS geofenceRadiusM, geofence_polygon AS geofencePolygon,
              is_active AS isActive, created_at AS createdAt
       FROM sites WHERE id = ?`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Site not found');
    return ok(res, rows[0]);
  })
);

router.patch(
  '/:id',
  requireRoles('admin', 'supervisor'),
  validate(sitePatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (req.auth.role === 'supervisor') {
      const okAccess = await supervisorCanAccessSite(req.auth.userId, req.auth.role, id);
      if (!okAccess) throw new AppError(403, 'FORBIDDEN', 'No access to this site');
    }
    const b = req.validated.body;
    const pool = getPool();
    const fields = [];
    const params = [];
    if (b.name !== undefined) {
      fields.push('name = ?');
      params.push(b.name);
    }
    if (b.address !== undefined) {
      fields.push('address = ?');
      params.push(b.address);
    }
    if (b.centerLat !== undefined) {
      fields.push('center_lat = ?');
      params.push(b.centerLat);
    }
    if (b.centerLng !== undefined) {
      fields.push('center_lng = ?');
      params.push(b.centerLng);
    }
    if (b.geofenceRadiusM !== undefined) {
      fields.push('geofence_radius_m = ?');
      params.push(b.geofenceRadiusM);
    }
    if (b.geofencePolygon !== undefined) {
      fields.push('geofence_polygon = ?');
      params.push(b.geofencePolygon ? JSON.stringify(b.geofencePolygon) : null);
    }
    if (b.isActive !== undefined) {
      fields.push('is_active = ?');
      params.push(b.isActive ? 1 : 0);
    }
    if (!fields.length) throw new AppError(400, 'VALIDATION_ERROR', 'No updates');
    params.push(id);
    const [r] = await pool.query(`UPDATE sites SET ${fields.join(', ')} WHERE id = ?`, params);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Site not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'site.update',
      entityType: 'site',
      entityId: id,
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
    const [r] = await pool.query(`UPDATE sites SET is_active = 0 WHERE id = ?`, [id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Site not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'site.deactivate',
      entityType: 'site',
      entityId: id,
      ip: req.ip,
    });
    return ok(res, { deactivated: true });
  })
);

const cpRouter = Router({ mergeParams: true });

cpRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const siteId = Number(req.params.siteId);
    if (req.auth.role === 'supervisor') {
      const okAccess = await supervisorCanAccessSite(req.auth.userId, req.auth.role, siteId);
      if (!okAccess) throw new AppError(403, 'FORBIDDEN', 'No access to this site');
    }
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, site_id AS siteId, label, qr_code AS qrCode, lat, lng, sort_order AS sortOrder, created_at AS createdAt
       FROM checkpoints WHERE site_id = ? ORDER BY sort_order, id`,
      [siteId]
    );
    return ok(res, { items: rows });
  })
);

cpRouter.post(
  '/',
  requireRoles('admin', 'supervisor'),
  validate(cpBody),
  asyncHandler(async (req, res) => {
    const siteId = Number(req.params.siteId);
    if (req.auth.role === 'supervisor') {
      const okAccess = await supervisorCanAccessSite(req.auth.userId, req.auth.role, siteId);
      if (!okAccess) throw new AppError(403, 'FORBIDDEN', 'No access to this site');
    }
    const b = req.validated.body;
    const pool = getPool();
    try {
      const [r] = await pool.query(
        `INSERT INTO checkpoints (site_id, label, qr_code, lat, lng, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [siteId, b.label, b.qrCode ?? String(Date.now()), b.lat, b.lng, b.sortOrder ?? 0]
      );
      const checkpointId = Number(r.insertId);
      if (!b.qrCode) {
        // Default QR payload is numeric checkpoint ID to match guard app scanning behavior.
        await pool.query(`UPDATE checkpoints SET qr_code = ? WHERE id = ?`, [String(checkpointId), checkpointId]);
      }
      await writeAudit({
        userId: req.auth.userId,
        action: 'checkpoint.create',
        entityType: 'checkpoint',
        entityId: checkpointId,
        ip: req.ip,
      });
      return ok(res, { id: checkpointId, qrCode: b.qrCode ?? String(checkpointId) }, 201);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'CONFLICT', 'QR code already used');
      throw e;
    }
  })
);

router.use('/:siteId/checkpoints', cpRouter);

export default router;
