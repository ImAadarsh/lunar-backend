const SIA_WARN_DAYS = 30;

function parseMs(value) {
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfLocalDayMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfLocalDayMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Bucket shifts for dashboard summaries and lists. */
export function partitionShifts(shifts, now = Date.now()) {
  const dayStart = startOfLocalDayMs(now);
  const dayEnd = endOfLocalDayMs(now);

  const upcoming = [];
  const today = [];
  const inProgress = [];
  const past = [];
  const missed = [];
  const cancelled = [];

  for (const shift of shifts) {
    const start = parseMs(shift.startsAt);
    const end = parseMs(shift.endsAt);
    if (shift.status === 'cancelled') {
      cancelled.push(shift);
      continue;
    }
    if (shift.status === 'missed' || shift.dutyState === 'missed_duty') {
      missed.push(shift);
    }
    if (shift.dutyState === 'on_duty' || shift.status === 'active') {
      inProgress.push(shift);
    }
    if (end != null && end < now && shift.status !== 'active') {
      past.push(shift);
      continue;
    }
    if (start != null && start > now && shift.status === 'scheduled') {
      upcoming.push(shift);
    }
    if (start != null && start <= dayEnd && end != null && end >= dayStart) {
      today.push(shift);
    }
  }

  upcoming.sort((a, b) => parseMs(a.startsAt) - parseMs(b.startsAt));
  today.sort((a, b) => parseMs(a.startsAt) - parseMs(b.startsAt));
  past.sort((a, b) => parseMs(b.startsAt) - parseMs(a.startsAt));

  return { upcoming, today, inProgress, past, missed, cancelled };
}

export function buildGuardAlerts({ user, availability, partitions }) {
  const alerts = [];
  const now = Date.now();

  if (user.status !== 'active') {
    alerts.push({
      severity: 'warning',
      code: 'account_inactive',
      message: 'Guard account is not active — cannot be scheduled.',
    });
  }

  if (availability?.state === 'duty_not_started') {
    alerts.push({
      severity: 'critical',
      code: 'duty_not_started',
      message: 'Shift has started but guard has not checked in.',
    });
  }
  if (availability?.state === 'missed_duty') {
    alerts.push({
      severity: 'critical',
      code: 'missed_duty',
      message: 'Missed duty — no check-in by halfway point. Guard is available to reassign.',
    });
  }
  if (availability?.state === 'recharging' && availability.rechargingUntil) {
    alerts.push({
      severity: 'info',
      code: 'recharging',
      message: `Recharging until ${new Date(availability.rechargingUntil).toISOString()}`,
    });
  }

  if (user.siaExpiryDate) {
    const exp = parseMs(user.siaExpiryDate);
    if (exp != null) {
      const days = Math.ceil((exp - now) / (24 * 60 * 60 * 1000));
      if (days < 0) {
        alerts.push({ severity: 'critical', code: 'sia_expired', message: 'SIA licence has expired.' });
      } else if (days <= SIA_WARN_DAYS) {
        alerts.push({
          severity: 'warning',
          code: 'sia_expiring',
          message: `SIA licence expires in ${days} day${days === 1 ? '' : 's'}.`,
        });
      }
    }
  }

  const next = partitions.upcoming[0];
  if (next) {
    const start = parseMs(next.startsAt);
    if (start != null && start - now < 24 * 60 * 60 * 1000 && start > now) {
      alerts.push({
        severity: 'info',
        code: 'shift_soon',
        message: `Next shift at ${next.siteName ?? 'site'} starts within 24 hours.`,
      });
    }
  }

  return alerts;
}

export function buildSiteAlerts({ site, partitions, onDutyNow, trainedGuards, openIncidents }) {
  const alerts = [];

  if (!site.isActive) {
    alerts.push({
      severity: 'warning',
      code: 'site_inactive',
      message: 'Site is marked inactive.',
    });
  }

  if (openIncidents > 0) {
    alerts.push({
      severity: 'critical',
      code: 'open_incidents',
      message: `${openIncidents} open incident${openIncidents === 1 ? '' : 's'} at this site.`,
      href: '/manager/incidents',
    });
  }

  const dutyNotStarted = trainedGuards.filter((g) => g.availability?.state === 'duty_not_started');
  if (dutyNotStarted.length > 0) {
    alerts.push({
      severity: 'critical',
      code: 'coverage_gap',
      message: `${dutyNotStarted.length} guard(s) have not checked in for an active shift.`,
    });
  }

  const missed = partitions.missed.filter((s) => {
    const end = parseMs(s.endsAt);
    return end == null || end > Date.now() - 7 * 24 * 60 * 60 * 1000;
  });
  if (missed.length > 0) {
    alerts.push({
      severity: 'warning',
      code: 'recent_missed',
      message: `${missed.length} missed duty shift(s) in the last 7 days.`,
    });
  }

  const scheduledToday = partitions.today.filter((s) => s.status === 'scheduled' && s.dutyState !== 'on_duty');
  if (scheduledToday.length > 0 && onDutyNow.length === 0) {
    alerts.push({
      severity: 'info',
      code: 'awaiting_checkin',
      message: `${scheduledToday.length} shift(s) scheduled today — no check-ins yet.`,
    });
  }

  return alerts;
}

export async function fetchRecentAttendanceForGuard(pool, userId, limit = 8) {
  const [rows] = await pool.query(
    `SELECT a.id, s.site_id AS siteId, st.name AS siteName, a.check_in_at AS checkInAt,
            a.check_out_at AS checkOutAt, a.status,
            ROUND(TIMESTAMPDIFF(MINUTE, a.check_in_at, COALESCE(a.check_out_at, NOW())) / 60, 2) AS hours
     FROM attendance_sessions a
     JOIN shifts s ON s.id = a.shift_id
     JOIN sites st ON st.id = s.site_id
     WHERE a.user_id = ?
     ORDER BY a.check_in_at DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

export async function fetchGuardLeaveSummary(pool, userId, periodStart, periodEnd) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS cnt
     FROM leave_requests
     WHERE user_id = ?
       AND start_date <= DATE(?)
       AND end_date >= DATE(?)
     GROUP BY status`,
    [userId, periodEnd, periodStart]
  );
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.cnt)]));
  const [pendingRow] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM leave_requests WHERE user_id = ? AND status = 'pending'`,
    [userId]
  );
  return {
    pending: Number(pendingRow[0]?.cnt ?? 0),
    byStatus,
  };
}

export async function countOpenIncidentsAtSite(pool, siteId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM incidents WHERE site_id = ? AND status IN ('open', 'in_review')`,
    [siteId]
  );
  return Number(row?.cnt ?? 0);
}

export async function countSiteCheckpoints(pool, siteId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM checkpoints WHERE site_id = ?`,
    [siteId]
  );
  return Number(row?.cnt ?? 0);
}

export function rosterAvailabilityCounts(trainedGuards) {
  const counts = {
    available: 0,
    assignable: 0,
    on_duty: 0,
    assigned: 0,
    duty_not_started: 0,
    missed_duty: 0,
    recharging: 0,
    disabled: 0,
  };
  for (const g of trainedGuards) {
    const state = g.availability?.state ?? 'disabled';
    if (counts[state] !== undefined) counts[state] += 1;
    if (g.availability?.canAssign) counts.assignable += 1;
  }
  return counts;
}
