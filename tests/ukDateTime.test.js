import { describe, expect, it } from 'vitest';
import {
  normalizeShiftDateTimeForStorage,
  serializeShiftDateTime,
} from '../src/utils/ukDateTime.js';

describe('ukDateTime', () => {
  it('stores UK wall clock from datetime-local style input', () => {
    const stored = normalizeShiftDateTimeForStorage('2026-05-25T05:30');
    expect(stored).toBe('2026-05-25 05:30:00');
  });

  it('round-trips UK wall clock through ISO for API', () => {
    const mysql = '2026-05-25 05:30:00';
    const iso = serializeShiftDateTime(mysql);
    expect(iso).toMatch(/2026-05-25T0[45]:30:00\.000Z/);
    const back = normalizeShiftDateTimeForStorage(iso);
    expect(back).toBe(mysql);
  });

  it('normalizes ISO UTC input to UK wall clock for storage', () => {
    const stored = normalizeShiftDateTimeForStorage('2026-05-25T04:30:00.000Z');
    expect(stored).toBe('2026-05-25 05:30:00');
  });
});
