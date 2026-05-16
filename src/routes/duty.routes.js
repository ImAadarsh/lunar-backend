import { Router } from 'express';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { buildGuardRosterDuty } from '../services/guardDutyService.js';

const router = Router();
const withAuth = (...m) => [requireAuth, ...m];

router.get(
  '/duty/roster',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    asyncHandler(async (_req, res) => {
      const pool = getPool();
      const [guards] = await pool.query(
        `SELECT u.id, u.status
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.slug = 'guard'`
      );
      const items = await buildGuardRosterDuty(pool, guards);
      return ok(res, { items });
    })
  )
);

export default router;
