export type RecurringSchedule =
  | { kind: 'DAILY'; timeZone: string; localTime: string }
  | { kind: 'WEEKLY'; timeZone: string; localTime: string; dayOfWeek: number };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function assertIanaTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 100) throw new Error('invalid_time_zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new Error('invalid_time_zone');
  }
  return timeZone;
}

export function parseLocalTime(localTime: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error('invalid_local_time');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('invalid_local_time');
  return { hour, minute };
}

export function nextRecurringOccurrence(schedule: RecurringSchedule, after: Date): Date {
  assertIanaTimeZone(schedule.timeZone);
  const target = parseLocalTime(schedule.localTime);
  if (schedule.kind === 'WEEKLY' && (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 1 || schedule.dayOfWeek > 7)) {
    throw new Error('invalid_day_of_week');
  }
  // Scan UTC minutes, not local dates. This naturally skips nonexistent DST gap times and
  // returns the first occurrence during a fold. The upper bound covers one leap year.
  let cursorMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const endMs = cursorMs + 370 * 24 * 60 * 60_000;
  for (; cursorMs <= endMs; cursorMs += 60_000) {
    const parts = localParts(new Date(cursorMs), schedule.timeZone);
    if (parts.hour !== target.hour || parts.minute !== target.minute) continue;
    if (schedule.kind === 'WEEKLY' && parts.dayOfWeek !== schedule.dayOfWeek) continue;
    return new Date(cursorMs);
  }
  throw new Error('schedule_occurrence_not_found');
}

export function scheduleOccurrenceKey(scheduleId: string, generation: number, scheduledFor: Date): string {
  if (!scheduleId || !Number.isInteger(generation) || generation < 1 || Number.isNaN(scheduledFor.getTime())) {
    throw new Error('invalid_schedule_occurrence');
  }
  return `${scheduleId}:g${generation}:${scheduledFor.toISOString()}`;
}

function localParts(date: Date, timeZone: string): LocalParts {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(values.weekday) + 1;
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), dayOfWeek: weekday,
  };
}
