/**
 * When does this fire next?
 *
 * Deliberately no date library. `Intl.DateTimeFormat` already knows every IANA
 * zone and ships with Node, and a scheduler that pulls in a 60kB dependency to
 * answer "what is 09:00 in Europe/London" is paying for convenience it doesn't
 * need. What it does need is to be right about the two days a year when local
 * time misbehaves:
 *
 * - **Spring forward.** 02:30 does not exist on the day the clocks jump. An
 *   automation set to 02:30 must still run — firing at the first real instant
 *   after the jump — rather than silently skipping a day.
 * - **Fall back.** 01:30 happens twice. It must fire once, on the first
 *   occurrence, not twice and not zero times.
 *
 * Both are tested. They are the bugs you find in production in March.
 */

export type ScheduleMode = 'ONE_TIME' | 'INTERVAL' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type Schedule =
  | { mode: 'ONE_TIME'; at: string }
  | { mode: 'INTERVAL'; everyMinutes: number }
  | { mode: 'DAILY'; time: string; timezone: string }
  | { mode: 'WEEKLY'; time: string; timezone: string; daysOfWeek: number[] }
  | { mode: 'MONTHLY'; time: string; timezone: string; dayOfMonth: number };

/** Matches the platform's bounds so a schedule set here is accepted there. */
export const INTERVAL_MIN_MINUTES = 1;
export const INTERVAL_MAX_MINUTES = 10_080; // one week

export class ScheduleError extends Error {}

// ── validation ───────────────────────────────────────────────────────────────

export function validateSchedule(s: Schedule): void {
  switch (s.mode) {
    case 'ONE_TIME': {
      if (Number.isNaN(Date.parse(s.at))) throw new ScheduleError(`"${s.at}" is not a valid date.`);
      return;
    }
    case 'INTERVAL': {
      if (!Number.isInteger(s.everyMinutes)) throw new ScheduleError('everyMinutes must be a whole number of minutes.');
      if (s.everyMinutes < INTERVAL_MIN_MINUTES || s.everyMinutes > INTERVAL_MAX_MINUTES) {
        throw new ScheduleError(
          `everyMinutes must be between ${INTERVAL_MIN_MINUTES} and ${INTERVAL_MAX_MINUTES} (one week).`,
        );
      }
      return;
    }
    case 'WEEKLY': {
      assertTime(s.time);
      assertZone(s.timezone);
      if (!s.daysOfWeek?.length) throw new ScheduleError('a weekly schedule needs at least one day.');
      if (s.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new ScheduleError('daysOfWeek entries must be 0 (Sunday) to 6 (Saturday).');
      }
      return;
    }
    case 'MONTHLY': {
      assertTime(s.time);
      assertZone(s.timezone);
      if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > 31) {
        throw new ScheduleError('dayOfMonth must be 1–31.');
      }
      return;
    }
    case 'DAILY': {
      assertTime(s.time);
      assertZone(s.timezone);
      return;
    }
    default: {
      throw new ScheduleError(`unknown schedule mode ${(s as { mode: string }).mode}`);
    }
  }
}

function assertTime(time: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) {
    throw new ScheduleError(`"${time}" is not a valid time — use HH:MM, 24-hour.`);
  }
}

function assertZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new ScheduleError(`"${timezone}" is not a known timezone. Use an IANA name like Europe/London.`);
  }
}

// ── next fire ────────────────────────────────────────────────────────────────

/**
 * The next instant this schedule fires strictly after `after`.
 *
 * Returns null when it will never fire again — a ONE_TIME schedule in the past,
 * or a MONTHLY day-of-month that no upcoming month has.
 */
export function nextRunAt(schedule: Schedule, after: number = Date.now()): number | null {
  validateSchedule(schedule);

  switch (schedule.mode) {
    case 'ONE_TIME': {
      const at = Date.parse(schedule.at);
      return at > after ? at : null;
    }

    case 'INTERVAL': {
      // Anchored to `after` rather than to a fixed epoch grid: a schedule
      // created at 14:07 with a 30-minute interval should fire at 14:37, not
      // wait until 14:30 has already gone past.
      return after + schedule.everyMinutes * 60_000;
    }

    case 'DAILY': {
      return searchDays(after, schedule.timezone, schedule.time, 1, () => true);
    }

    case 'WEEKLY': {
      const wanted = new Set(schedule.daysOfWeek);
      return searchDays(after, schedule.timezone, schedule.time, 366, (parts) =>
        wanted.has(parts.weekday),
      );
    }

    case 'MONTHLY': {
      // Scanning days rather than months handles the awkward part for free:
      // day 31 simply doesn't match in a 30-day month, so it falls through to
      // the next month that has one. A schedule set for the 31st fires seven
      // times a year, which is what the user asked for — quietly moving it to
      // the 30th would be inventing intent.
      return searchDays(after, schedule.timezone, schedule.time, 800, (parts) =>
        parts.day === schedule.dayOfMonth,
      );
    }
  }
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/**
 * Walk forward a day at a time in the target zone, looking for the first day
 * that matches `accept` and whose local `time` lands strictly after `after`.
 */
function searchDays(
  after: number,
  timezone: string,
  time: string,
  maxDays: number,
  accept: (parts: DateParts) => boolean,
): number | null {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const start = partsIn(after, timezone);

  for (let offset = 0; offset <= maxDays; offset++) {
    const day = addLocalDays(start, offset);
    if (!accept(day)) continue;
    const ts = localTimeToInstant(day.year, day.month, day.day, hh, mm, timezone);
    if (ts !== null && ts > after) return ts;
  }
  return null;
}

/** Calendar arithmetic on local dates, independent of any zone offset. */
function addLocalDays(parts: DateParts, days: number): DateParts {
  // UTC is used purely as a calendar here — the offset never enters into it,
  // so month lengths and leap years come out right without touching zones.
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
    weekday: d.getUTCDay(),
  };
}

/** The wall-clock reading in `timezone` at a given instant. */
export function partsIn(instant: number, timezone: string): DateParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const found: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(instant))) found[part.type] = part.value;

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    // Intl renders midnight as "24" in some locales/zones; normalise it.
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    weekday: Math.max(0, weekdays.indexOf(found.weekday ?? 'Sun')),
  };
}

/** Zone offset in ms at an instant: local wall clock minus UTC. */
function offsetAt(instant: number, timezone: string): number {
  const p = partsIn(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Instants carry seconds and ms that the parts above drop; removing them
  // from both sides keeps the offset a clean multiple of a minute.
  const truncated = Math.floor(instant / 60_000) * 60_000;
  return asUtc - truncated;
}

/**
 * The instant at which the clock in `timezone` reads the given local time.
 *
 * Returns null when that reading never happens — the hour skipped by a
 * spring-forward transition. Callers decide what to do about it; see
 * {@link localTimeToInstant}.
 */
function resolveLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute);

  // Two passes: guess with the offset at the naive instant, then correct with
  // the offset actually in force at the guess. Converges everywhere except a
  // skipped hour, which the verification below catches.
  let ts = naive - offsetAt(naive, timezone);
  const corrected = naive - offsetAt(ts, timezone);
  if (corrected !== ts) ts = corrected;

  const check = partsIn(ts, timezone);
  const matches =
    check.year === year &&
    check.month === month &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute;

  return matches ? ts : null;
}

/**
 * Like {@link resolveLocalTime}, but never silently skips a day.
 *
 * When the requested local time falls in the hour a spring-forward transition
 * removes, walk forward minute by minute to the first reading that does exist —
 * so an automation set for 02:30 fires at 03:00 on that one day rather than not
 * at all. Missing a run because of a clock change is a bug the user would find
 * months later, if ever.
 */
function localTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  const direct = resolveLocalTime(year, month, day, hour, minute, timezone);
  if (direct !== null) return direct;

  // No transition anywhere is longer than a couple of hours.
  for (let bump = 1; bump <= 180; bump++) {
    const total = hour * 60 + minute + bump;
    if (total >= 24 * 60) return null; // ran off the end of the day
    const found = resolveLocalTime(year, month, day, Math.floor(total / 60), total % 60, timezone);
    if (found !== null) return found;
  }
  return null;
}

// ── describing a schedule ────────────────────────────────────────────────────

/** A plain-English rendering, for the CLI and the UI. */
export function describeSchedule(s: Schedule): string {
  switch (s.mode) {
    case 'ONE_TIME':
      return `once, at ${new Date(s.at).toISOString()}`;
    case 'INTERVAL': {
      const m = s.everyMinutes;
      if (m % 1440 === 0) return `every ${plural(m / 1440, 'day')}`;
      if (m % 60 === 0) return `every ${plural(m / 60, 'hour')}`;
      return `every ${plural(m, 'minute')}`;
    }
    case 'DAILY':
      return `daily at ${s.time} ${s.timezone}`;
    case 'WEEKLY': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = [...s.daysOfWeek].sort().map((d) => names[d]).join(', ');
      return `${days} at ${s.time} ${s.timezone}`;
    }
    case 'MONTHLY':
      return `on the ${ordinal(s.dayOfMonth)} at ${s.time} ${s.timezone}`;
  }
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
