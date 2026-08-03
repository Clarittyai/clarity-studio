import { describe, expect, it } from 'vitest';

import {
  describeSchedule,
  nextRunAt,
  partsIn,
  ScheduleError,
  validateSchedule,
  type Schedule,
} from './schedule.js';

/** Read an instant back as a wall clock, which is how a user would check it. */
function wall(ts: number | null, tz: string): string {
  if (ts === null) return 'never';
  const p = partsIn(ts, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

const at = (iso: string) => Date.parse(iso);

describe('daily', () => {
  it('fires today when the time is still ahead', () => {
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'Europe/London' };
    expect(wall(nextRunAt(s, at('2026-06-15T06:00:00Z')), 'Europe/London')).toBe('2026-06-15 09:00');
  });

  it('rolls to tomorrow once the time has passed', () => {
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'Europe/London' };
    expect(wall(nextRunAt(s, at('2026-06-15T09:00:01Z')), 'Europe/London')).toBe('2026-06-16 09:00');
  });

  it('is strictly after — a schedule cannot fire twice on its own boundary', () => {
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'UTC' };
    const boundary = at('2026-06-15T09:00:00Z');
    expect(nextRunAt(s, boundary)).toBeGreaterThan(boundary);
  });

  it('holds the wall-clock time across a DST change rather than drifting an hour', () => {
    // The whole point of storing a zone instead of an offset: 09:00 stays 09:00
    // in March, even though the UTC instant moves.
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'America/New_York' };
    const before = nextRunAt(s, at('2026-03-01T12:00:00Z'))!;
    const after = nextRunAt(s, at('2026-04-01T12:00:00Z'))!;
    expect(wall(before, 'America/New_York').endsWith('09:00')).toBe(true);
    expect(wall(after, 'America/New_York').endsWith('09:00')).toBe(true);
    expect(new Date(before).getUTCHours()).toBe(14); // EST
    expect(new Date(after).getUTCHours()).toBe(13); // EDT
  });
});

describe('DST — the two days a year this actually matters', () => {
  it('still fires when the local time is skipped by a spring-forward', () => {
    // 2026-03-08, New York: 01:59 EST jumps straight to 03:00 EDT. 02:30 never
    // happens. Skipping the run entirely would lose a day silently, so it fires
    // at the first real instant instead.
    const s: Schedule = { mode: 'DAILY', time: '02:30', timezone: 'America/New_York' };
    const next = nextRunAt(s, at('2026-03-08T06:00:00Z'));
    expect(next).not.toBeNull();
    expect(wall(next, 'America/New_York')).toBe('2026-03-08 03:00');
  });

  it('fires exactly once on the ambiguous hour of a fall-back', () => {
    // 2026-11-01, New York: 01:00–02:00 happens twice. 01:30 must fire once,
    // on the first pass — not twice, not zero times.
    const s: Schedule = { mode: 'DAILY', time: '01:30', timezone: 'America/New_York' };
    const first = nextRunAt(s, at('2026-11-01T04:00:00Z'))!;
    expect(wall(first, 'America/New_York')).toBe('2026-11-01 01:30');
    expect(new Date(first).toISOString()).toBe('2026-11-01T05:30:00.000Z'); // EDT, the first one

    // Asking again from just after that instant must move to the NEXT DAY,
    // not to the second 01:30 an hour later.
    const second = nextRunAt(s, first + 1000)!;
    expect(wall(second, 'America/New_York')).toBe('2026-11-02 01:30');
  });

  it('handles the southern hemisphere, where the transitions run the other way', () => {
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'Australia/Sydney' };
    const next = nextRunAt(s, at('2026-04-05T00:00:00Z'))!;
    expect(wall(next, 'Australia/Sydney').endsWith('09:00')).toBe(true);
  });

  it('handles a half-hour offset zone', () => {
    const s: Schedule = { mode: 'DAILY', time: '09:00', timezone: 'Asia/Kolkata' };
    const next = nextRunAt(s, at('2026-06-15T00:00:00Z'))!;
    expect(new Date(next).toISOString()).toBe('2026-06-15T03:30:00.000Z');
  });
});

describe('weekly', () => {
  it('finds the next matching weekday', () => {
    // 2026-06-15 is a Monday. Ask for Wednesday and Friday.
    const s: Schedule = {
      mode: 'WEEKLY', time: '08:00', timezone: 'UTC', daysOfWeek: [3, 5],
    };
    const first = nextRunAt(s, at('2026-06-15T12:00:00Z'))!;
    expect(wall(first, 'UTC')).toBe('2026-06-17 08:00');
    expect(wall(nextRunAt(s, first + 1000), 'UTC')).toBe('2026-06-19 08:00');
  });

  it('wraps around the week', () => {
    const s: Schedule = { mode: 'WEEKLY', time: '08:00', timezone: 'UTC', daysOfWeek: [1] };
    expect(wall(nextRunAt(s, at('2026-06-16T12:00:00Z')), 'UTC')).toBe('2026-06-22 08:00');
  });
});

describe('monthly', () => {
  it('finds the next month with that day', () => {
    const s: Schedule = { mode: 'MONTHLY', time: '06:00', timezone: 'UTC', dayOfMonth: 15 };
    expect(wall(nextRunAt(s, at('2026-06-20T00:00:00Z')), 'UTC')).toBe('2026-07-15 06:00');
  });

  it('skips months that have no 31st instead of quietly moving the date', () => {
    // February has no 31st. Firing on the 28th would be inventing intent the
    // user never expressed, so it waits for March.
    const s: Schedule = { mode: 'MONTHLY', time: '06:00', timezone: 'UTC', dayOfMonth: 31 };
    expect(wall(nextRunAt(s, at('2026-02-01T00:00:00Z')), 'UTC')).toBe('2026-03-31 06:00');
  });

  it('handles the 29th in a leap year', () => {
    const s: Schedule = { mode: 'MONTHLY', time: '06:00', timezone: 'UTC', dayOfMonth: 29 };
    expect(wall(nextRunAt(s, at('2028-02-01T00:00:00Z')), 'UTC')).toBe('2028-02-29 06:00');
  });
});

describe('interval and one-time', () => {
  it('anchors an interval to now, not to a fixed grid', () => {
    // Created at 14:07 with a 30-minute interval, the user expects 14:37 —
    // not to wait out the rest of a grid they never saw.
    const s: Schedule = { mode: 'INTERVAL', everyMinutes: 30 };
    expect(new Date(nextRunAt(s, at('2026-06-15T14:07:00Z'))!).toISOString()).toBe(
      '2026-06-15T14:37:00.000Z',
    );
  });

  it('never fires a one-time schedule that has already passed', () => {
    const s: Schedule = { mode: 'ONE_TIME', at: '2026-01-01T00:00:00Z' };
    expect(nextRunAt(s, at('2026-06-15T00:00:00Z'))).toBeNull();
  });
});

describe('validation', () => {
  const bad: Array<[string, Schedule]> = [
    ['a time that is not HH:MM', { mode: 'DAILY', time: '9am', timezone: 'UTC' }],
    ['an hour past 23', { mode: 'DAILY', time: '25:00', timezone: 'UTC' }],
    ['a zone that does not exist', { mode: 'DAILY', time: '09:00', timezone: 'Mars/Olympus' }],
    ['an interval below one minute', { mode: 'INTERVAL', everyMinutes: 0 }],
    ['an interval beyond a week', { mode: 'INTERVAL', everyMinutes: 20_000 }],
    ['a weekly schedule with no days', { mode: 'WEEKLY', time: '09:00', timezone: 'UTC', daysOfWeek: [] }],
    ['a weekday out of range', { mode: 'WEEKLY', time: '09:00', timezone: 'UTC', daysOfWeek: [7] }],
    ['a day of month out of range', { mode: 'MONTHLY', time: '09:00', timezone: 'UTC', dayOfMonth: 32 }],
  ];

  for (const [label, schedule] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => validateSchedule(schedule)).toThrow(ScheduleError);
    });
  }
});

describe('describing', () => {
  it('reads like something a person would say', () => {
    expect(describeSchedule({ mode: 'DAILY', time: '09:00', timezone: 'Europe/London' }))
      .toBe('daily at 09:00 Europe/London');
    expect(describeSchedule({ mode: 'INTERVAL', everyMinutes: 120 })).toBe('every 2 hours');
    expect(describeSchedule({ mode: 'INTERVAL', everyMinutes: 1 })).toBe('every 1 minute');
    expect(describeSchedule({ mode: 'MONTHLY', time: '06:00', timezone: 'UTC', dayOfMonth: 1 }))
      .toBe('on the 1st at 06:00 UTC');
    expect(describeSchedule({ mode: 'MONTHLY', time: '06:00', timezone: 'UTC', dayOfMonth: 22 }))
      .toBe('on the 22nd at 06:00 UTC');
  });
});
