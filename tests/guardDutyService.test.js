import { describe, it, expect } from 'vitest';
import {
  getDutyDate,
  GUARD_RECHARGE_MS,
  DUTY_TIMEZONE,
} from '../src/services/guardDutyService.js';

describe('getDutyDate', () => {
  it('uses UK calendar date of shift start (night shift counts on evening date)', () => {
    // 2025-05-20 21:00 UK (BST = UTC+1) → 20:00Z
    const dutyDate = getDutyDate('2025-05-20T20:00:00.000Z');
    expect(dutyDate).toBe('2025-05-20');
  });

  it('assigns overnight shift to start day not end morning', () => {
    // Start 23:00 UK on 21st, end 06:00 UK on 22nd — duty day is 21st
    const dutyDate = getDutyDate('2025-05-21T22:00:00.000Z');
    expect(dutyDate).toBe('2025-05-21');
  });
});

describe('recharge window', () => {
  it('7h gap after 06:00 end allows 13:00 same calendar day on next duty day', () => {
    const endMs = new Date('2025-05-22T05:00:00.000Z').getTime(); // 06:00 UK
    const nextStartMs = new Date('2025-05-22T12:00:00.000Z').getTime(); // 13:00 UK
    expect(nextStartMs - endMs).toBeGreaterThanOrEqual(GUARD_RECHARGE_MS);
  });
});

describe('DUTY_TIMEZONE', () => {
  it('uses Europe/London', () => {
    expect(DUTY_TIMEZONE).toBe('Europe/London');
  });
});
