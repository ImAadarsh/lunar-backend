import { AppError } from '../utils/httpError.js';

export const GUARD_RECHARGE_HOURS = 7;
export const MISSED_DUTY_THRESHOLD = 0.5;

/** Display / availability states returned to clients */
export const DUTY_DISPLAY_STATES = [
  'disabled',
  'available',
  'recharging',
  'assigned',
  'duty_not_started',
  'on_duty',
  'missed_duty',
];

const CAN_ASSIGN_STATES = new Set(['available', 'missed_duty']);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatUkPeriodLabel(from, to) {
  const fmt = (d) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${fmt(new Date(`${from}T12:00:00`))} – ${fmt(new Date(`${to}T12:00:00`))}`;
}

function defaultLast30DaysRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: toIso(start), to: toIso(end) };
}

export function resolvePeriodBounds(year, month) {
  const y = year ?? new Date().getFullYear();
  if (month) {
    const m = Number(month);
    const lastDay = new Date(y, m, 0).getDate();
    return {
      year: y,
      month: m,
      periodStart: `${y}-${String(m).padStart(2, '0')}-01 00:00:00`,
      periodEnd: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')} 23:59:59`,
      label: new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
      from: null,
      to: null,
    };
  }
  return {
    year: y,
    month: null,
    periodStart: `${y}-01-01 00:00:00`,
    periodEnd: `${y}-12-31 23:59:59`,
    label: String(y),
    from: null,
    to: null,
  };
}

/** Date range (default last 30 days), or legacy year/month when no from/to. */
export function resolveDashboardPeriod({ year, month, from, to }) {
  if (from && to && DATE_ONLY.test(from) && DATE_ONLY.test(to)) {
    let periodStart = from;
    let periodEnd = to;
    if (periodStart > periodEnd) {
      [periodStart, periodEnd] = [periodEnd, periodStart];
    }
    const startYear = Number(periodStart.slice(0, 4));
    return {
      year: startYear,
      month: null,
      periodStart: `${periodStart} 00:00:00`,
      periodEnd: `${periodEnd} 23:59:59`,
      label: formatUkPeriodLabel(periodStart, periodEnd),
      from: periodStart,
      to: periodEnd,
    };
  }
  if (year != null) {
    return resolvePeriodBounds(year, month);
  }
  const fallback = defaultLast30DaysRange();
  return resolveDashboardPeriod({ from: fallback.from, to: fallback.to });
}

export async function ensureGuardTrainedForSite(pool, userId, siteId) {
  const [rows] = await pool.query(
    `SELECT 1 FROM guard_site_training WHERE user_id = ? AND site_id = ? LIMIT 1`,
    [userId, siteId]
  );
  if (!rows.length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Guard is not trained for this site');
  }
}

function shiftTimes(shift) {
  return {
    startMs: new Date(shift.startsAt).getTime(),
    endMs: new Date(shift.endsAt).getTime(),
  };
}

/**
 * Per-shift duty label (for shift lists).
 * assigned | duty_not_started | on_duty | missed_duty | null (past/completed/cancelled)
 */
export function computeShiftDutyState({ shift, hasCheckedIn, now = Date.now() }) {
  if (!shift || shift.status === 'cancelled' || shift.status === 'completed') return null;
  if (shift.status === 'missed') return 'missed_duty';

  const { startMs, endMs } = shiftTimes(shift);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;

  if (now < startMs) return 'assigned';
  if (now >= endMs) return null;

  if (hasCheckedIn || shift.status === 'active') return 'on_duty';

  const duration = endMs - startMs;
  const elapsed = now - startMs;
  if (duration > 0 && elapsed >= duration * MISSED_DUTY_THRESHOLD) return 'missed_duty';

  return 'duty_not_started';
}

/** Mark shifts missed when 50%+ of window elapsed without check-in. */
export async function autoMarkMissedShifts(pool, scope = {}) {
  const where = [
    `s.status IN ('scheduled', 'active')`,
    `s.starts_at <= NOW()`,
    `s.ends_at > NOW()`,
    `TIMESTAMPDIFF(MINUTE, s.starts_at, NOW()) >= TIMESTAMPDIFF(MINUTE, s.starts_at, s.ends_at) * ?`,
    `NOT EXISTS (
      SELECT 1 FROM attendance_sessions a
      WHERE a.shift_id = s.id AND a.user_id = s.user_id
        AND a.check_in_at IS NOT NULL
    )`,
  ];
  const params = [MISSED_DUTY_THRESHOLD];
  if (scope.userId) {
    where.push('s.user_id = ?');
    params.push(scope.userId);
  }
  if (scope.siteId) {
    where.push('s.site_id = ?');
    params.push(scope.siteId);
  }
  await pool.query(
    `UPDATE shifts s SET s.status = 'missed' WHERE ${where.join(' AND ')}`,
    params
  );
}

export async function fetchOpenAttendanceMap(pool, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const placeholders = userIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT user_id AS userId, shift_id AS shiftId, id AS sessionId, check_in_at AS checkInAt
     FROM attendance_sessions
     WHERE user_id IN (${placeholders}) AND status = 'open'`,
    userIds
  );
  for (const row of rows) {
    map.set(Number(row.userId), {
      shiftId: Number(row.shiftId),
      sessionId: Number(row.sessionId),
      checkInAt: row.checkInAt,
    });
  }
  return map;
}

export async function fetchOpenAttendanceByShift(pool, shiftIds) {
  const set = new Set();
  if (!shiftIds.length) return set;
  const placeholders = shiftIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT shift_id AS shiftId FROM attendance_sessions
     WHERE shift_id IN (${placeholders}) AND status = 'open' AND check_in_at IS NOT NULL`,
    shiftIds
  );
  for (const row of rows) set.add(Number(row.shiftId));
  return set;
}

/** Relevant shift: in-window first, else nearest upcoming scheduled. */
export function pickPrimaryShift(shifts, now = Date.now()) {
  const active = shifts.filter(
    (s) =>
      s.status !== 'cancelled' &&
      s.status !== 'completed' &&
      s.status !== 'missed'
  );
  const inWindow = active
    .filter((s) => {
      const { startMs, endMs } = shiftTimes(s);
      return now >= startMs && now < endMs;
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  if (inWindow.length) return inWindow[0];

  const upcoming = active
    .filter((s) => {
      const { startMs } = shiftTimes(s);
      return now < startMs && s.status === 'scheduled';
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  return upcoming[0] ?? null;
}

/** Last completed duty end (excludes missed — missed guards stay available). */
export async function fetchLastDutyEndedMap(pool, userIds) {
  if (!userIds.length) return new Map();
  const placeholders = userIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT s.user_id AS userId,
            MAX(COALESCE(a.check_out_at, s.ends_at)) AS lastEndedAt
     FROM shifts s
     LEFT JOIN attendance_sessions a
       ON a.shift_id = s.id AND a.user_id = s.user_id AND a.check_out_at IS NOT NULL
     WHERE s.user_id IN (${placeholders})
       AND s.status IN ('completed', 'active')
       AND s.status <> 'missed'
       AND s.status <> 'cancelled'
       AND s.ends_at <= NOW()
     GROUP BY s.user_id`,
    userIds
  );
  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.userId), row.lastEndedAt);
  }
  return map;
}

export function evaluateGuardDutySnapshot({
  userStatus,
  primaryShift,
  hasCheckedIn,
  lastDutyEndedAt,
  now = Date.now(),
}) {
  if (userStatus !== 'active') {
    return {
      state: 'disabled',
      dutyState: null,
      canAssign: false,
      rechargingUntil: null,
      lastShiftEndedAt: lastDutyEndedAt ?? null,
      currentShift: null,
    };
  }

  if (primaryShift) {
    const dutyState = computeShiftDutyState({ shift: primaryShift, hasCheckedIn, now });
    const currentShift =
      dutyState && ['on_duty', 'duty_not_started', 'missed_duty'].includes(dutyState)
        ? primaryShift
        : dutyState === 'assigned'
          ? primaryShift
          : null;

    if (dutyState === 'on_duty') {
      return {
        state: 'on_duty',
        dutyState,
        canAssign: false,
        rechargingUntil: null,
        lastShiftEndedAt: lastDutyEndedAt ?? null,
        currentShift: primaryShift,
      };
    }
    if (dutyState === 'duty_not_started') {
      return {
        state: 'duty_not_started',
        dutyState,
        canAssign: false,
        rechargingUntil: null,
        lastShiftEndedAt: lastDutyEndedAt ?? null,
        currentShift: primaryShift,
      };
    }
    if (dutyState === 'missed_duty') {
      return {
        state: 'missed_duty',
        dutyState,
        canAssign: true,
        rechargingUntil: null,
        lastShiftEndedAt: lastDutyEndedAt ?? null,
        currentShift: primaryShift,
      };
    }
    if (dutyState === 'assigned') {
      return {
        state: 'assigned',
        dutyState,
        canAssign: false,
        rechargingUntil: null,
        lastShiftEndedAt: lastDutyEndedAt ?? null,
        currentShift: primaryShift,
      };
    }
  }

  if (lastDutyEndedAt) {
    const ended = new Date(lastDutyEndedAt).getTime();
    const rechargeMs = GUARD_RECHARGE_HOURS * 60 * 60 * 1000;
    const elapsed = now - ended;
    if (elapsed < rechargeMs) {
      return {
        state: 'recharging',
        dutyState: null,
        canAssign: false,
        rechargingUntil: new Date(ended + rechargeMs),
        lastShiftEndedAt: lastDutyEndedAt,
        currentShift: null,
      };
    }
  }

  return {
    state: 'available',
    dutyState: null,
    canAssign: true,
    rechargingUntil: null,
    lastShiftEndedAt: lastDutyEndedAt ?? null,
    currentShift: null,
  };
}

export async function evaluateGuardDutyForUser(pool, userId) {
  await autoMarkMissedShifts(pool, { userId });

  const [[user]] = await pool.query(`SELECT status FROM users WHERE id = ?`, [userId]);
  const [shifts] = await pool.query(
    `SELECT s.id, s.site_id AS siteId, st.name AS siteName, s.starts_at AS startsAt, s.ends_at AS endsAt, s.status
     FROM shifts s
     JOIN sites st ON st.id = s.site_id
     WHERE s.user_id = ?
       AND s.status NOT IN ('cancelled', 'completed')
       AND s.ends_at >= NOW() - INTERVAL 1 DAY
     ORDER BY s.starts_at ASC
     LIMIT 50`,
    [userId]
  );

  const openAttendance = await fetchOpenAttendanceMap(pool, [userId]);
  const open = openAttendance.get(userId);
  const hasCheckedIn = Boolean(open?.checkInAt);
  const primaryShift = pickPrimaryShift(shifts);
  const lastDutyMap = await fetchLastDutyEndedMap(pool, [userId]);

  return evaluateGuardDutySnapshot({
    userStatus: user?.status ?? 'suspended',
    primaryShift,
    hasCheckedIn,
    lastDutyEndedAt: lastDutyMap.get(userId) ?? null,
  });
}

export async function buildGuardRosterDuty(pool, guards) {
  const userIds = guards.map((g) => Number(g.id ?? g.userId));
  if (!userIds.length) return [];

  await autoMarkMissedShifts(pool);

  const [allShifts] = await pool.query(
    `SELECT s.id, s.user_id AS userId, s.site_id AS siteId, s.starts_at AS startsAt, s.ends_at AS endsAt, s.status
     FROM shifts s
     WHERE s.user_id IN (${userIds.map(() => '?').join(',')})
       AND s.status NOT IN ('cancelled', 'completed')
       AND s.ends_at >= NOW() - INTERVAL 1 DAY
     ORDER BY s.starts_at ASC`,
    userIds
  );

  const shiftsByUser = new Map();
  for (const shift of allShifts) {
    const uid = Number(shift.userId);
    if (!shiftsByUser.has(uid)) shiftsByUser.set(uid, []);
    shiftsByUser.get(uid).push(shift);
  }

  const openAttendance = await fetchOpenAttendanceMap(pool, userIds);
  const lastDutyMap = await fetchLastDutyEndedMap(pool, userIds);

  return guards.map((guard) => {
    const uid = Number(guard.id ?? guard.userId);
    const userShifts = shiftsByUser.get(uid) ?? [];
    const open = openAttendance.get(uid);
    const primaryShift = pickPrimaryShift(userShifts);
    const availability = evaluateGuardDutySnapshot({
      userStatus: guard.status,
      primaryShift,
      hasCheckedIn: Boolean(open?.checkInAt),
      lastDutyEndedAt: lastDutyMap.get(uid) ?? null,
    });
    return { userId: uid, availability, primaryShift };
  });
}

export async function enrichShiftsWithDutyState(pool, shifts) {
  if (!shifts.length) return shifts;
  await autoMarkMissedShifts(pool);
  const shiftIds = shifts.map((s) => Number(s.id));
  const checkedInShiftIds = await fetchOpenAttendanceByShift(pool, shiftIds);
  return shifts.map((shift) => ({
    ...shift,
    dutyState: computeShiftDutyState({
      shift,
      hasCheckedIn: checkedInShiftIds.has(Number(shift.id)),
    }),
  }));
}

/** @deprecated Use evaluateGuardDutyForUser — kept for gradual migration */
export async function fetchCurrentShiftForGuard(pool, userId) {
  const snapshot = await evaluateGuardDutyForUser(pool, userId);
  return snapshot.currentShift;
}

export function evaluateAvailabilityFromDuty({ userStatus, currentShift, lastDutyEndedAt }) {
  return evaluateGuardDutySnapshot({
    userStatus,
    primaryShift: currentShift,
    hasCheckedIn: currentShift?.status === 'active',
    lastDutyEndedAt,
  });
}

export function canAssignFromAvailability(availability) {
  return Boolean(availability?.canAssign ?? CAN_ASSIGN_STATES.has(availability?.state));
}

/** Total worked hours per guard at a site within a period (attendance at this site). */
export async function fetchDutyHoursByUsersAtSite(pool, siteId, userIds, periodStart, periodEnd) {
  const ids = [...new Set(userIds.map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT a.user_id AS userId,
            ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.check_in_at, COALESCE(a.check_out_at, NOW()))) / 60, 2) AS hours
     FROM attendance_sessions a
     JOIN shifts s ON s.id = a.shift_id
     WHERE s.site_id = ?
       AND a.user_id IN (${placeholders})
       AND a.check_in_at >= ?
       AND a.check_in_at <= ?
     GROUP BY a.user_id`,
    [siteId, ...ids, periodStart, periodEnd]
  );

  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.userId), Number(row.hours) || 0);
  }
  return map;
}

export async function fetchWorkedHoursByDay(pool, { userId, siteId, periodStart, periodEnd }) {
  const where = ['a.check_in_at >= ?', 'a.check_in_at <= ?'];
  const params = [periodStart, periodEnd];
  if (userId) {
    where.push('a.user_id = ?');
    params.push(userId);
  }
  if (siteId) {
    where.push('s.site_id = ?');
    params.push(siteId);
  }
  const [rows] = await pool.query(
    `SELECT DATE(a.check_in_at) AS workDate,
            ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.check_in_at, COALESCE(a.check_out_at, NOW()))) / 60, 2) AS hours,
            COUNT(*) AS sessionCount
     FROM attendance_sessions a
     JOIN shifts s ON s.id = a.shift_id
     WHERE ${where.join(' AND ')}
     GROUP BY DATE(a.check_in_at)
     ORDER BY workDate DESC`,
    params
  );
  return rows;
}

export async function fetchWorkedHoursByMonth(pool, { userId, siteId, year }) {
  const periodStart = `${year}-01-01 00:00:00`;
  const periodEnd = `${year}-12-31 23:59:59`;
  const where = ['a.check_in_at >= ?', 'a.check_in_at <= ?'];
  const params = [periodStart, periodEnd];
  if (userId) {
    where.push('a.user_id = ?');
    params.push(userId);
  }
  if (siteId) {
    where.push('s.site_id = ?');
    params.push(siteId);
  }
  const [rows] = await pool.query(
    `SELECT YEAR(a.check_in_at) AS year,
            MONTH(a.check_in_at) AS month,
            ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.check_in_at, COALESCE(a.check_out_at, NOW()))) / 60, 2) AS hours,
            COUNT(*) AS sessionCount
     FROM attendance_sessions a
     JOIN shifts s ON s.id = a.shift_id
     WHERE ${where.join(' AND ')}
     GROUP BY YEAR(a.check_in_at), MONTH(a.check_in_at)
     ORDER BY year DESC, month DESC`,
    params
  );
  return rows;
}

export function sumHours(rows) {
  return Number(rows.reduce((acc, row) => acc + Number(row.hours ?? 0), 0).toFixed(2));
}

export async function fetchOnDutyAtSite(pool, siteId) {
  await autoMarkMissedShifts(pool, { siteId });
  const [rows] = await pool.query(
    `SELECT s.id AS shiftId, s.user_id AS userId, u.email AS userEmail, gp.full_name AS guardName,
            s.starts_at AS startsAt, s.ends_at AS endsAt, s.status,
            a.check_in_at AS checkInAt
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN guard_profiles gp ON gp.user_id = u.id
     INNER JOIN attendance_sessions a
       ON a.shift_id = s.id AND a.user_id = s.user_id AND a.status = 'open' AND a.check_in_at IS NOT NULL
     WHERE s.site_id = ?
       AND s.status IN ('scheduled', 'active')
       AND s.starts_at <= NOW()
       AND s.ends_at > NOW()
     ORDER BY s.starts_at ASC`,
    [siteId]
  );
  return rows.map((row) => ({ ...row, dutyState: 'on_duty' }));
}

export async function fetchShiftsForGuard(pool, userId, limit = 30) {
  const [rows] = await pool.query(
    `SELECT s.id, s.site_id AS siteId, st.name AS siteName, s.starts_at AS startsAt, s.ends_at AS endsAt, s.status
     FROM shifts s
     JOIN sites st ON st.id = s.site_id
     WHERE s.user_id = ?
     ORDER BY s.starts_at DESC
     LIMIT ?`,
    [userId, limit]
  );
  return enrichShiftsWithDutyState(pool, rows);
}

export async function fetchShiftsForSite(pool, siteId, limit = 40) {
  const [rows] = await pool.query(
    `SELECT s.id, s.user_id AS userId, u.email AS userEmail, gp.full_name AS guardName,
            s.starts_at AS startsAt, s.ends_at AS endsAt, s.status
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN guard_profiles gp ON gp.user_id = u.id
     WHERE s.site_id = ?
     ORDER BY s.starts_at DESC
     LIMIT ?`,
    [siteId, limit]
  );
  return enrichShiftsWithDutyState(pool, rows);
}
