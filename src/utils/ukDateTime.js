/** UK (Europe/London) wall-clock ↔ UTC — matches lunar_security_web/src/lib/uk-datetime.ts */

export const UK_TIME_ZONE = 'Europe/London';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseWallString(value) {
  const v = String(value).trim().replace(' ', 'T');
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
}

export function getUkParts(utcMs) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function wallPartsToPseudoUtcMs(p) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

export function ukWallClockToUtcMs(wall) {
  let utc = wallPartsToPseudoUtcMs(wall);
  for (let i = 0; i < 4; i += 1) {
    const uk = getUkParts(utc);
    const diff = wallPartsToPseudoUtcMs(wall) - wallPartsToPseudoUtcMs(uk);
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

/** ISO or naive UK datetime → MySQL DATETIME string (UK wall clock). */
export function normalizeShiftDateTimeForStorage(input) {
  const raw = String(input).trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid datetime: ${input}`);
    }
    const p = getUkParts(d.getTime());
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  }
  const wall = parseWallString(raw);
  if (!wall) {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid datetime: ${input}`);
    }
    const p = getUkParts(d.getTime());
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  }
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;
}

/** Stored UK wall clock (or ISO) → ISO UTC for API clients. */
export function serializeShiftDateTime(value) {
  if (value == null) return value;
  if (value instanceof Date) {
    return new Date(value.getTime()).toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return raw;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  const wall = parseWallString(raw);
  if (!wall) return raw;
  return new Date(ukWallClockToUtcMs(wall)).toISOString();
}

export function normalizeShiftRowForApi(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  if ('startsAt' in row && row.startsAt != null) {
    out.startsAt = serializeShiftDateTime(row.startsAt);
  }
  if ('endsAt' in row && row.endsAt != null) {
    out.endsAt = serializeShiftDateTime(row.endsAt);
  }
  return out;
}

export function normalizeShiftRowsForApi(rows) {
  return rows.map((row) => normalizeShiftRowForApi(row));
}

/** API filter bound → MySQL UK wall clock for WHERE clauses. */
export function normalizeShiftDateTimeForQuery(input) {
  return normalizeShiftDateTimeForStorage(input);
}
