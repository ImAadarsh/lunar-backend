import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { supervisorAllowedSiteIds } from '../utils/siteAccess.js';
import {
  evaluateGuardDutyForUser,
  fetchOnDutyAtSite,
  fetchShiftsForGuard,
  fetchShiftsForSite,
  fetchWorkedHoursByDay,
  fetchWorkedHoursByMonth,
  resolveDashboardPeriod,
  fetchDutyHoursByUsersAtSite,
  sumHours,
} from '../services/guardDutyService.js';
import {
  buildGuardAlerts,
  buildSiteAlerts,
  countOpenIncidentsAtSite,
  countSiteCheckpoints,
  fetchGuardLeaveSummary,
  fetchRecentAttendanceForGuard,
  partitionShifts,
  rosterAvailabilityCounts,
} from '../services/dashboardEnrichment.js';

const router = Router();
const withAuth = (...m) => [requireAuth, ...m];

const periodQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

async function assertSiteAccess(req, siteId) {
  const allowed = await supervisorAllowedSiteIds(req.auth.userId, req.auth.role);
  if (allowed && !allowed.includes(siteId)) {
    throw new AppError(403, 'FORBIDDEN', 'No access to this site');
  }
}

async function loadGuardDashboard(pool, userId, period) {
  const [[user]] = await pool.query(
    `SELECT u.id, u.email, u.phone, u.status, r.slug AS role, u.created_at AS createdAt,
            gp.full_name AS fullName, gp.given_names AS givenNames, gp.surname,
            gp.sia_number AS siaNumber, gp.sia_expiry_date AS siaExpiryDate
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN guard_profiles gp ON gp.user_id = u.id
     WHERE u.id = ?`,
    [userId]
  );
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (user.role !== 'guard') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Dashboard is only available for guards');
  }

  const [trainedSites] = await pool.query(
    `SELECT gst.id AS trainingId, gst.site_id AS siteId, s.name AS siteName,
            gst.trained_on AS trainedOn, gst.notes
     FROM guard_site_training gst
     JOIN sites s ON s.id = gst.site_id
     WHERE gst.user_id = ?
     ORDER BY s.name ASC`,
    [userId]
  );

  const hoursByDay = await fetchWorkedHoursByDay(pool, {
    userId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  });
  const hoursByMonth =
    period.from == null && period.month == null
      ? await fetchWorkedHoursByMonth(pool, { userId, year: period.year })
      : [];

  const availability = await evaluateGuardDutyForUser(pool, userId);
  const shifts = await fetchShiftsForGuard(pool, userId, 60);
  const partitions = partitionShifts(shifts);
  const [recentAttendance, leave] = await Promise.all([
    fetchRecentAttendanceForGuard(pool, userId, 10),
    fetchGuardLeaveSummary(pool, userId, period.periodStart, period.periodEnd),
  ]);
  const alerts = buildGuardAlerts({ user, availability, partitions });

  return {
    user,
    period,
    hours: {
      total: sumHours(hoursByDay),
      byDay: hoursByDay,
      byMonth: hoursByMonth,
    },
    trainedSites,
    availability,
    currentShift: availability.currentShift,
    shifts,
    summary: {
      upcoming: partitions.upcoming.length,
      today: partitions.today.length,
      inProgress: partitions.inProgress.length,
      missed: partitions.missed.length,
      completed: shifts.filter((s) => s.status === 'completed').length,
      cancelled: partitions.cancelled.length,
      trainedSites: trainedSites.length,
      pendingLeave: leave.pending,
    },
    alerts,
    recentAttendance,
    leave,
    shiftGroups: {
      upcoming: partitions.upcoming.slice(0, 8),
      today: partitions.today,
      inProgress: partitions.inProgress,
      past: partitions.past.slice(0, 15),
    },
  };
}

router.get(
  '/dashboard/guards/:userId',
  ...withAuth(
    requireRoles('admin', 'supervisor', 'guard'),
    validate(periodQuery, 'query'),
    asyncHandler(async (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user id');

      if (req.auth.role === 'guard' && req.auth.userId !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Guards can only view their own dashboard');
      }

      const q = req.validated.query;
      const period = resolveDashboardPeriod({
        year: q.year,
        month: q.month,
        from: q.from,
        to: q.to,
      });
      const pool = getPool();

      const data = await loadGuardDashboard(pool, userId, period);

      if (req.auth.role !== 'guard') {
        for (const row of data.trainedSites) {
          await assertSiteAccess(req, Number(row.siteId));
        }
      }

      return ok(res, data);
    })
  )
);

router.get(
  '/dashboard/sites/:siteId',
  ...withAuth(
    requireRoles('admin', 'supervisor'),
    validate(periodQuery, 'query'),
    asyncHandler(async (req, res) => {
      const siteId = Number(req.params.siteId);
      if (!Number.isInteger(siteId)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid site id');

      await assertSiteAccess(req, siteId);

      const q = req.validated.query;
      const period = resolveDashboardPeriod({
        year: q.year,
        month: q.month,
        from: q.from,
        to: q.to,
      });
      const pool = getPool();

      const [[site]] = await pool.query(
        `SELECT id, name, address, center_lat AS centerLat, center_lng AS centerLng,
                geofence_radius_m AS geofenceRadiusM, is_active AS isActive
         FROM sites WHERE id = ?`,
        [siteId]
      );
      if (!site) throw new AppError(404, 'NOT_FOUND', 'Site not found');

      const [trainedGuards] = await pool.query(
        `SELECT gst.id AS trainingId, gst.user_id AS userId, u.email AS userEmail,
                gp.full_name AS guardName, u.status AS userStatus,
                gst.trained_on AS trainedOn, gst.notes
         FROM guard_site_training gst
         JOIN users u ON u.id = gst.user_id
         LEFT JOIN guard_profiles gp ON gp.user_id = u.id
         WHERE gst.site_id = ?
         ORDER BY gp.full_name ASC, u.email ASC`,
        [siteId]
      );

      const guardsWithAvailability = await Promise.all(
        trainedGuards.map(async (g) => {
          const uid = Number(g.userId);
          const availability = await evaluateGuardDutyForUser(pool, uid);
          return { ...g, availability, currentShift: availability.currentShift };
        })
      );

      const dutyHoursMap = await fetchDutyHoursByUsersAtSite(
        pool,
        siteId,
        guardsWithAvailability.map((g) => g.userId),
        period.periodStart,
        period.periodEnd
      );
      const trainedGuardsEnriched = guardsWithAvailability.map((g) => ({
        ...g,
        dutyHoursInPeriod: dutyHoursMap.get(Number(g.userId)) ?? 0,
      }));

      const hoursByDay = await fetchWorkedHoursByDay(pool, {
        siteId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
      const hoursByMonth =
        period.from == null && q.month == null
          ? await fetchWorkedHoursByMonth(pool, { siteId, year: period.year })
          : [];

      const shifts = await fetchShiftsForSite(pool, siteId, 60);
      const onDutyNow = await fetchOnDutyAtSite(pool, siteId);
      const partitions = partitionShifts(shifts);
      const [openIncidents, checkpoints] = await Promise.all([
        countOpenIncidentsAtSite(pool, siteId),
        countSiteCheckpoints(pool, siteId),
      ]);
      const rosterCounts = rosterAvailabilityCounts(trainedGuardsEnriched);
      const alerts = buildSiteAlerts({
        site,
        partitions,
        onDutyNow,
        trainedGuards: trainedGuardsEnriched,
        openIncidents,
      });

      const coverageGaps = shifts
        .filter((s) => s.dutyState === 'duty_not_started' || s.dutyState === 'missed_duty')
        .slice(0, 10)
        .map((s) => ({
          shiftId: s.id,
          userId: s.userId,
          guardName: s.guardName,
          userEmail: s.userEmail,
          dutyState: s.dutyState,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
        }));

      return ok(res, {
        site,
        period,
        hours: {
          total: sumHours(hoursByDay),
          byDay: hoursByDay,
          byMonth: hoursByMonth,
        },
        onDutyNow,
        trainedGuards: trainedGuardsEnriched,
        shifts,
        summary: {
          shiftsToday: partitions.today.length,
          upcoming: partitions.upcoming.length,
          onDuty: onDutyNow.length,
          openIncidents,
          checkpoints,
          trainedGuards: trainedGuardsEnriched.length,
          assignableGuards: rosterCounts.assignable,
          dutyNotStarted: rosterCounts.duty_not_started,
          missedRecent: partitions.missed.length,
        },
        rosterCounts,
        alerts,
        coverageGaps,
        shiftGroups: {
          upcoming: partitions.upcoming.slice(0, 8),
          today: partitions.today,
          inProgress: partitions.inProgress,
          past: partitions.past.slice(0, 15),
        },
      });
    })
  )
);

export default router;
