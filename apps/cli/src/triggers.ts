/**
 * Trigger commands: set a schedule, watch it fire, replay a webhook.
 *
 * `serve` is the one that matters. It holds the automation up, runs the tick,
 * and accepts webhooks — the mode in which Studio is an automation host rather
 * than a way to run something once by hand.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Store, TriggerInstanceRow } from '@claritty-studio/db';
import {
  describeSchedule,
  nextRunAt,
  ScheduleError,
  validateSchedule,
  type Schedule,
} from '@claritty-studio/scheduler';

export interface TriggerRecipe {
  id: string;
  type: 'SCHEDULE' | 'WEBHOOK';
  name?: string;
  description?: string;
  workflowId?: string;
  supportedSchedules?: string[];
  configFields?: Array<{ key: string; type: string; required?: boolean; default?: unknown; label?: string }>;
}

/**
 * What the automation says it supports.
 *
 * Read from the project rather than guessed, so the trigger picker can only
 * ever offer things the automation actually declares.
 */
export function readRecipes(projectPath: string): TriggerRecipe[] {
  try {
    const raw = readFileSync(join(projectPath, 'app-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { triggers?: TriggerRecipe[] };
    return parsed.triggers ?? [];
  } catch {
    return [];
  }
}

/**
 * Turn CLI flags into a schedule.
 *
 * `--every 30m`, `--daily 09:00`, `--weekly mon,wed@09:00`, `--monthly 1@06:00`.
 * The timezone defaults to the machine's own, because a person setting "9am"
 * means 9am where they are, and asking them to name their own timezone is a
 * question with an obvious answer.
 */
export function parseScheduleFlags(flags: {
  every?: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  once?: string;
  timezone?: string;
}): Schedule {
  const timezone = flags.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  if (flags.every) {
    const match = /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/i.exec(flags.every.trim());
    if (!match) throw new ScheduleError(`could not read "--every ${flags.every}". Try 30m, 2h or 1d.`);
    const value = Number(match[1]);
    const unit = (match[2] ?? 'm').toLowerCase();
    const minutes = unit.startsWith('h') ? value * 60 : unit.startsWith('d') ? value * 1440 : value;
    return { mode: 'INTERVAL', everyMinutes: minutes };
  }

  if (flags.daily) return { mode: 'DAILY', time: flags.daily, timezone };

  if (flags.weekly) {
    const [days, time] = flags.weekly.split('@');
    if (!time) throw new ScheduleError('use --weekly mon,wed@09:00');
    const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const daysOfWeek = days!.split(',').map((d) => {
      const index = names.indexOf(d.trim().slice(0, 3).toLowerCase());
      if (index === -1) throw new ScheduleError(`"${d}" is not a day. Use mon, tue, wed…`);
      return index;
    });
    return { mode: 'WEEKLY', time, timezone, daysOfWeek };
  }

  if (flags.monthly) {
    const [day, time] = flags.monthly.split('@');
    if (!time) throw new ScheduleError('use --monthly 1@06:00');
    return { mode: 'MONTHLY', time, timezone, dayOfMonth: Number(day) };
  }

  if (flags.once) return { mode: 'ONE_TIME', at: flags.once };

  throw new ScheduleError(
    'no schedule given. Use one of --every 30m, --daily 09:00, --weekly mon,fri@09:00, --monthly 1@06:00, --once <iso>.',
  );
}

export function addTrigger(
  store: Store,
  opts: {
    projectId: string;
    projectPath: string;
    recipeId?: string;
    schedule?: Schedule;
    missedPolicy?: 'skip' | 'run-once' | 'catch-up';
  },
): TriggerInstanceRow {
  const recipes = readRecipes(opts.projectPath);
  if (recipes.length === 0) {
    throw new Error(
      'this automation declares no triggers. Add one to app-config.json#triggers[] and intelligence.yaml.',
    );
  }

  const recipe = opts.recipeId ? recipes.find((r) => r.id === opts.recipeId) : recipes[0];
  if (!recipe) {
    throw new Error(
      `no trigger "${opts.recipeId}" in this automation. It declares: ${recipes.map((r) => r.id).join(', ')}`,
    );
  }

  if (recipe.type === 'SCHEDULE') {
    if (!opts.schedule) throw new ScheduleError(`"${recipe.id}" is a schedule — say when it should run.`);
    validateSchedule(opts.schedule);
    // The automation can restrict which cadences make sense for it; honouring
    // that here stops the user configuring something it will refuse to run.
    const allowed = recipe.supportedSchedules;
    if (allowed?.length && !allowed.includes(opts.schedule.mode)) {
      throw new ScheduleError(
        `"${recipe.id}" supports ${allowed.join(', ')} — not ${opts.schedule.mode}.`,
      );
    }
  }

  return store.triggers.add({
    projectId: opts.projectId,
    recipeTriggerId: recipe.id,
    workflowId: recipe.workflowId ?? null,
    type: recipe.type,
    enabled: true,
    schedule: recipe.type === 'SCHEDULE' ? opts.schedule : undefined,
    timezone: opts.schedule && 'timezone' in opts.schedule ? opts.schedule.timezone : null,
    nextRunAt: recipe.type === 'SCHEDULE' && opts.schedule ? nextRunAt(opts.schedule) : null,
    missedPolicy: opts.missedPolicy ?? 'skip',
  });
}

/** One line per trigger, for `claritty-studio trigger ls`. */
export function formatTrigger(instance: TriggerInstanceRow, colour: { dim: (s: string) => string }): string {
  const when =
    instance.type === 'WEBHOOK'
      ? 'on webhook'
      : instance.schedule
        ? describeSchedule(instance.schedule as Schedule)
        : 'no schedule';

  const next =
    instance.type === 'WEBHOOK'
      ? ''
      : instance.nextRunAt
        ? ` · next ${new Date(instance.nextRunAt).toLocaleString()}`
        : ' · never';

  const missed = instance.missedCount > 0 ? ` · ${instance.missedCount} missed` : '';
  const last = instance.lastStatus ? ` · last ${instance.lastStatus}` : '';

  return (
    `${instance.enabled ? '●' : '○'} ${instance.id.slice(0, 8)}  ${instance.recipeTriggerId.padEnd(18)}` +
    ` ${when}${colour.dim(`${next}${last}${missed}`)}`
  );
}
