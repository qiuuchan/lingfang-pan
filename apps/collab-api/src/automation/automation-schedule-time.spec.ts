import { describe, expect, it } from 'vitest';
import {
  assertIanaTimeZone,
  nextRecurringOccurrence,
  parseLocalTime,
  scheduleOccurrenceKey,
} from './automation-schedule-time';

describe('automation schedule wall-clock time', () => {
  it('validates IANA zones and strict local time', () => {
    expect(assertIanaTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(() => assertIanaTimeZone('Mars/Olympus')).toThrow('invalid_time_zone');
    expect(parseLocalTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(() => parseLocalTime('9:30')).toThrow('invalid_local_time');
    expect(() => parseLocalTime('24:00')).toThrow('invalid_local_time');
  });

  it('keeps a daily Shanghai schedule at the same wall-clock time', () => {
    const next = nextRecurringOccurrence(
      { kind: 'DAILY', timeZone: 'Asia/Shanghai', localTime: '09:30' },
      new Date('2026-07-16T01:31:00.000Z')
    );
    expect(next.toISOString()).toBe('2026-07-17T01:30:00.000Z');
  });

  it('skips a nonexistent New York DST gap wall-clock occurrence', () => {
    const next = nextRecurringOccurrence(
      { kind: 'DAILY', timeZone: 'America/New_York', localTime: '02:30' },
      new Date('2026-03-08T05:00:00.000Z')
    );
    expect(next.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('selects the first matching instant during a New York DST fold', () => {
    const next = nextRecurringOccurrence(
      { kind: 'DAILY', timeZone: 'America/New_York', localTime: '01:30' },
      new Date('2026-11-01T04:00:00.000Z')
    );
    expect(next.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('uses ISO weekday and stable generation-scoped occurrence keys', () => {
    const next = nextRecurringOccurrence(
      { kind: 'WEEKLY', timeZone: 'UTC', dayOfWeek: 1, localTime: '10:00' },
      new Date('2026-07-16T00:00:00.000Z')
    );
    expect(next.toISOString()).toBe('2026-07-20T10:00:00.000Z');
    expect(scheduleOccurrenceKey('schedule-1', 3, next)).toBe(
      'schedule-1:g3:2026-07-20T10:00:00.000Z'
    );
  });
});
