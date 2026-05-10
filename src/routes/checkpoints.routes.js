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
import { supervisorCanAccessSite } from '../utils/siteAccess.js';

const router = Router();

const cpPatch = z
  .object({
    label: z.string().min(1).optional(),
    qrCode: z.string().min(1).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields' });

router.use(requireAuth);
router.use(requireRoles('admin', 'supervisor'));

router.patch(
  '/:id',
  validate(cpPatch),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [crows] = await pool.query(`SELECT site_id FROM checkpoints WHERE id = ?`, [id]);
    const cp = crows[0];
    if (!cp) throw new AppError(404, 'NOT_FOUND', 'Checkpoint not found');
    if (req.auth.role === 'supervisor') {
      const allowed = await supervisorCanAccessSite(req.auth.userId, req.auth.role, cp.site_id);
      if (!allowed) throw new AppError(403, 'FORBIDDEN', 'No access to this checkpoint');
    }
    const b = req.validated.body;
    const fields = [];
    const params = [];
    if (b.label !== undefined) {
      fields.push('label = ?');
      params.push(b.label);
    }
    if (b.qrCode !== undefined) {
      fields.push('qr_code = ?');
      params.push(b.qrCode);
    }
    if (b.lat !== undefined) {
      fields.push('lat = ?');
      params.push(b.lat);
    }
    if (b.lng !== undefined) {
      fields.push('lng = ?');
      params.push(b.lng);
    }
    if (b.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      params.push(b.sortOrder);
    }
    params.push(id);
    try {
      const [r] = await pool.query(`UPDATE checkpoints SET ${fields.join(', ')} WHERE id = ?`, params);
      if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Checkpoint not found');
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new AppError(409, 'CONFLICT', 'QR code already used');
      throw e;
    }
    await writeAudit({
      userId: req.auth.userId,
      action: 'checkpoint.update',
      entityType: 'checkpoint',
      entityId: id,
      ip: req.ip,
    });
    return ok(res, { updated: true });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const pool = getPool();
    const [crows] = await pool.query(`SELECT site_id FROM checkpoints WHERE id = ?`, [id]);
    const cp = crows[0];
    if (!cp) throw new AppError(404, 'NOT_FOUND', 'Checkpoint not found');
    if (req.auth.role === 'supervisor') {
      const allowed = await supervisorCanAccessSite(req.auth.userId, req.auth.role, cp.site_id);
      if (!allowed) throw new AppError(403, 'FORBIDDEN', 'No access to this checkpoint');
    }
    const [r] = await pool.query(`DELETE FROM checkpoints WHERE id = ?`, [id]);
    if (r.affectedRows === 0) throw new AppError(404, 'NOT_FOUND', 'Checkpoint not found');
    await writeAudit({
      userId: req.auth.userId,
      action: 'checkpoint.delete',
      entityType: 'checkpoint',
      entityId: id,
      ip: req.ip,
    });
    return ok(res, { deleted: true });
  })
);

export default router;
