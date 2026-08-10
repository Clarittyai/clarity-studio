/**
 * The main process.
 *
 * Everything with real power lives here: the SQLite store, the control plane,
 * Docker. The renderer gets plain data over `contextBridge` and nothing else.
 *
 * The security posture is the strict one, and it is not negotiable for an app
 * that holds people's API keys:
 *
 * - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
 * - no remote content, ever — the renderer is a local file
 * - navigation and new windows are blocked; links open in the real browser
 * - a CSP that permits nothing but self
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, shell } from 'electron';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { detectAgents } from '@clarity-studio/agent-bridge';
import { CATALOG, findIntegration } from '@clarity-studio/connectors';
import { Store } from '@clarity-studio/db';

import { watch, type FSWatcher } from 'node:fs';

import { SafeStorageBackend, Vault, VaultUnavailableError, secretKey } from '@clarity-studio/vault';
import { safeStorage } from 'electron';

import { deliver, detail, headline, type DeliveryResult, type NotifyPrefs } from './notifier.js';
import { runVerdict } from '../shared/run-verdict.js';
import { nextRunAt } from '@clarity-studio/scheduler';
import { bootLogPath, RuntimeHost } from './runtime.js';
import { TerminalHost } from './terminal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_SERVER = process.env.STUDIO_DEV_SERVER;

/**
 * The product is one-`t` Clarity Studio, but it belongs to the two-`t` Claritty
 * brand, and the brand is what a person recognises in a dock. See CLAUDE.md for
 * which spelling goes where.
 *
 * This has to run before `whenReady`: Electron derives the menu-bar name, the
 * dock label *and* `getPath('userData')` from it. Without it the name falls back
 * to the package name, which put the store in a directory literally called
 * `@clarity-studio/desktop` — an npm scope leaking into a filesystem path.
 */
const APP_NAME = 'Claritty Studio';
app.setName(APP_NAME);

/**
 * One window, one runtime.
 *
 * A second instance is not a harmless duplicate here: each one opens the same
 * SQLite store, each tries to bind the control plane's fixed port, and each
 * spawns its own runners and ptys. The second loses the port race and reports a
 * confusing failure for something the first is doing fine.
 *
 * So the second instance hands its argv to the first and exits, and the first
 * surfaces its window — the behaviour people expect from clicking a dock icon.
 */
// ...except when STUDIO_HOME is set. A custom data directory IS the statement
// that this instance is deliberately separate — a screenshot run, a test, a
// second checkout — and it shares no store or port with the default one. Without
// this exemption the lock silently killed `pnpm shot` and the e2e harness
// whenever a window happened to be open, exiting 0 with nothing said.
const wantsOwnInstance = Boolean(process.env.STUDIO_HOME);

if (!wantsOwnInstance && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (!wantsOwnInstance) {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });
}

/** Bundled at `assets/icon.png`, three levels up from `dist/main`. */
const ICON_PATH = join(HERE, '../../assets/icon.png');

function dataDir(): string {
  return process.env.STUDIO_HOME ?? app.getPath('userData');
}

let store: Store | undefined;

function db(): Store {
  if (!store) {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    store = new Store(join(dir, 'studio.db'));
  }
  return store;
}

/** Holds the control plane and the running automations for this window. */
const runtime = new RuntimeHost(
  db,
  (runId) => void announce(runId),
  (event) => void announceScheduleFailure(event),
  () => modelOverride(),
  (projectId) => Promise.resolve(missingRequiredFor(projectId)),
);

/**
 * The REQUIRED services this project declares and still has no credential for.
 *
 * The same two questions `integrations:status` answers — is there a connector
 * for it, and is there a bundle — asked of the manifest's required entries
 * only. An OPTIONAL integration resolves to null at run time on purpose so a
 * tool can degrade, and a service Studio has no connector for cannot be
 * connected from here at all; neither should stop a schedule.
 */
function missingRequiredFor(projectId: string): string[] {
  const project = db().getProject(String(projectId));
  if (!project) return [];
  const file = manifestIn(project.path);
  if (!file) return [];
  let manifest: Record<string, unknown>;
  try {
    manifest = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // A manifest mid-edit is a normal state. Blocking a schedule over one would
    // be a worse fault than the one this prevents, and a quieter one.
    return [];
  }
  const declared =
    (manifest as { integrations?: Array<{ id?: string; required?: boolean } | string> })
      .integrations ?? [];
  const v = vault();
  return declared
    .map((i) =>
      typeof i === 'string'
        ? { id: i, required: true }
        : { id: i.id ?? '', required: i.required !== false },
    )
    .filter((i) => i.id && i.required)
    .filter((i) => Boolean(findIntegration(i.id)) && !v.bundle(i.id, String(projectId)))
    .map((i) => i.id);
}
/** Holds the coding-agent pty sessions. */
const terminals = new TerminalHost();

/**
 * Window preferences.
 *
 * A small JSON beside the store rather than a table: this is a handful of paths
 * a person set once, and adding a migration to the database for it would be
 * more machinery than the thing deserves. Unreadable or corrupt falls back to
 * the defaults rather than refusing to open.
 */
interface Settings {
  automationsRoot?: string;
  /** Per project: how to be told when a run finishes. */
  notify?: Record<string, NotifyPrefs>;
  /** Run everything on this model, whatever each manifest asked for. Empty or
   *  absent means honour the manifest. */
  modelOverride?: string;
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json');
}

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(next: Settings): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}

/** Where new automations go unless one is chosen for a particular build. */
function automationsRoot(): string {
  return readSettings().automationsRoot ?? join(app.getPath('home'), 'Automations');
}

/**
 * The model every run uses, regardless of what its manifest declares.
 *
 * Without this an automation written against Claude cannot be run by someone
 * holding only an OpenAI key or a local server — the manifest decides, and the
 * only way to change it is to edit somebody else's file. The model id also
 * chooses the provider (`claude…` → anthropic, `gpt-…`/`openai/…` → openai,
 * `ollama/…` → the local default), so this one field is also how you move a run
 * onto your own machine.
 *
 * Blank is not the same as unset here: a stored empty string means "honour the
 * manifest", so clearing the field is a way back rather than a wedged run.
 */
function modelOverride(): string | undefined {
  const stored = readSettings().modelOverride?.trim();
  return stored ? stored : undefined;
}

/**
 * Secrets go through the OS keyring. There is no passphrase prompt: a desktop
 * user is already authenticated to their machine, and inventing a second
 * password is how people end up keeping keys in a text file instead.
 */
function vault(): Vault {
  const store = db();
  return new Vault(new SafeStorageBackend(safeStorage), {
    put: (key, ciphertext, last4) => store.putSecret(key, ciphertext, last4),
    get: (key) => store.getSecret(key),
    remove: (key) => store.removeSecret(key),
    list: () => store.listSecrets(),
  });
}

/**
 * Turn a projectId from the renderer into a vault scope.
 *
 * `'*'`, `''` and undefined all mean machine-wide, which `secretKey` encodes by
 * the *absence* of a projectId — passing the literal `'*'` through as a project
 * would write `integration:*:…` by coincidence rather than by intent, and would
 * break the moment that encoding changed.
 */
function scopeOf(projectId: unknown): { projectId?: string } {
  const id = String(projectId ?? '').trim();
  return id && id !== '*' ? { projectId: id } : {};
}

/**
 * The last delivery attempt per project, so a channel that failed is visible
 * where it was switched on.
 *
 * In memory rather than on disk: it describes this session's sends, and a stale
 * "Slack failed" from three days ago sitting in a settings file would be read as
 * current. If nothing has been sent since launch there is honestly nothing to
 * report.
 */
const lastDelivery = new Map<string, DeliveryResult[]>();

/**
 * Tell the person a run finished, through whichever channels they chose.
 *
 * Called for every completed run — UI, schedule, or a failure before the
 * automation was even reached. It must never throw: a notification that fails
 * is not a reason for the run to be recorded differently than it happened.
 */
async function announce(runId: string): Promise<void> {
  try {
    const store = db();
    const run = store.getRun(runId);
    if (!run) return;
    const prefs = readSettings().notify?.[run.projectId] ?? { desktop: true };
    const project = store.listProjects().find((p) => p.id === run.projectId);
    const summary = {
      automation: project?.name ?? 'An automation',
      status: run.status,
      error: run.error,
      // The steps are what say whether the run achieved anything — the run row
      // alone cannot, because the engine calls a run successful when any single
      // step succeeded. A local SQLite read on a path that is already about to
      // make network calls.
      verdict: runVerdict(run, store.getSteps(runId)),
    };

    if (prefs.desktop !== false && Notification.isSupported()) {
      new Notification({ title: headline(summary), body: detail(summary) }).show();
    }

    const v = vault();
    const results = await deliver(
      prefs,
      summary,
      // Machine-wide first, overridden by anything this automation set for
      // itself — the same resolution order every other credential read uses.
      (integrationId) => v.bundle(integrationId, run.projectId),
      Date.now(),
    );
    if (results.length > 0) {
      lastDelivery.set(run.projectId, results);
      // A failed send is the one thing a person must not have to go looking
      // for, since the whole point of the channel was not having to look.
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0 && Notification.isSupported()) {
        new Notification({
          title: `Could not reach you by ${failed.map((f) => f.channel).join(' or ')}`,
          body: failed[0]?.error ?? 'The provider refused the message.',
        }).show();
      }
    }
  } catch {
    // Already best-effort; there is no second channel to report a failure of
    // the failure through.
  }
}

/**
 * A scheduled run that failed before it began.
 *
 * The dispatcher writes this straight to the store — it never reaches the
 * control plane's `completeRun`, where the normal notification hook lives. So
 * without this the failures nobody was watching would be exactly the silent
 * ones: the automation that could not start at 6am says nothing, and the first
 * you hear of it is a digest that never arrived.
 */
async function announceScheduleFailure(event: { runId?: string; error: string }): Promise<void> {
  try {
    const store = db();
    const run = event.runId ? store.getRun(event.runId) : undefined;
    const project = run ? store.listProjects().find((p) => p.id === run.projectId) : undefined;
    const prefs = run ? readSettings().notify?.[run.projectId] ?? { desktop: true } : { desktop: true };
    const summary = {
      automation: project?.name ?? 'A scheduled automation',
      status: 'failed',
      error: event.error,
    };

    if (prefs.desktop !== false && Notification.isSupported()) {
      new Notification({ title: headline(summary), body: detail(summary) }).show();
    }
    if (!run) return;
    const v = vault();
    const results = await deliver(prefs, summary, (i) => v.bundle(i, run.projectId), Date.now());
    if (results.length > 0) lastDelivery.set(run.projectId, results);
  } catch {
    // Best-effort, like announce(): there is no second channel through which to
    // report the failure of the failure.
  }
}

/**
 * Watch a project for edits so the window reflects what the coding agent just
 * wrote. This is the whole point of having the terminal in the same window: you
 * ask for a change, and the flow redraws — no refresh, no restart.
 *
 * Debounced because an editor save is several events, and recursive because the
 * manifest is not the only thing that matters (a prompt file or a tool body
 * changes what a step does).
 */
const watchers = new Map<string, FSWatcher>();

function watchProject(projectId: string, path: string, send: Electron.WebContents): void {
  watchers.get(projectId)?.close();
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(path, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '');
      // Ignore the noise an automation makes about itself while running.
      if (/node_modules|__pycache__|\.git\/|\.venv|\.data|\.studio/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!send.isDestroyed()) send.send('project:changed', projectId, name);
      }, 200);
    });
    watchers.set(projectId, watcher);
  } catch {
    // A project on a volume that cannot be watched still works; it just does
    // not live-update, which is better than failing to open.
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/**
 * Handlers are registered explicitly, one name at a time. No dynamic dispatch
 * from a renderer-supplied string — that is how a UI bug becomes arbitrary
 * database access.
 */
function registerIpc(): void {
  ipcMain.handle('projects:list', () =>
    db()
      .listProjects()
      .map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        status: p.status,
        runtime: p.runtime,
        hostPort: p.hostPort,
        lastError: p.lastError,
      })),
  );

  ipcMain.handle('runs:list', (_event, projectId: string) => db().listRuns(String(projectId), 50));

  ipcMain.handle('steps:list', (_event, runId: string) => db().getSteps(String(runId)));

  // Which runs achieved nothing, in one query — the home screen asks this for
  // every project and cannot afford a steps fetch per run.
  ipcMain.handle('runs:blocked', (_event, projectId: string, since: number) =>
    db().blockedRunIds(String(projectId), Number(since)),
  );

/**
 * Make the store's trigger rows match what the manifest declares.
 *
 * The manifest DECLARES triggers; the dispatcher fires INSTANCES; nothing in
 * Studio created the instances. Only the CLI's `trigger add` did. So the
 * Triggers band was empty for every automation, and the scheduler I wired had
 * nothing to dispatch — the mechanism worked and fired nothing.
 *
 * Created DISABLED, always. An automation that starts running on a schedule
 * because you opened it is not a convenience; it is your machine doing work you
 * never asked for, possibly outward-facing, possibly at 3am. Turning it on is
 * one switch, and it should be yours to throw.
 *
 * Reconciles rather than appends: a trigger removed from the manifest has its
 * instance removed too, because an instance with no declaration behind it fires
 * a workflow the automation no longer describes.
 */
function syncTriggers(projectId: string): Array<Record<string, unknown>> {
  const store = db();
  const project = store.getProject(projectId);
  if (!project) return [];
  const file = manifestIn(project.path);
  if (!file) return [];

  let declared: Array<Record<string, unknown>> = [];
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8')) as { triggers?: Array<Record<string, unknown>> };
    declared = Array.isArray(parsed?.triggers) ? parsed.triggers : [];
  } catch {
    // Mid-edit. Leave what is there rather than deleting on a half-written file.
    return [];
  }

  const existing = store.triggers.list(projectId);
  const declaredIds = new Set(declared.map((t) => String(t.id ?? '')).filter(Boolean));

  for (const row of existing) {
    if (!declaredIds.has(row.recipeTriggerId)) store.triggers.remove(row.id);
  }

  for (const decl of declared) {
    const recipeId = String(decl.id ?? '');
    if (!recipeId) continue;
    if (existing.some((row) => row.recipeTriggerId === recipeId)) continue;

    const type = String(decl.type ?? 'SCHEDULE');
    // The defaults the automation itself suggests, so the row is usable the
    // moment it is switched on rather than needing a time typed in first.
    const fields = Array.isArray(decl.configFields) ? (decl.configFields as Array<Record<string, unknown>>) : [];
    const defaultOf = (key: string) =>
      fields.find((f) => f.key === key)?.default as string | undefined;
    const time = defaultOf('time') ?? '09:00';
    const timezone =
      defaultOf('timezone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

    store.triggers.add({
      projectId,
      recipeTriggerId: recipeId,
      workflowId: (decl.workflow as string | undefined) ?? null,
      type,
      // Never on by default. See above.
      enabled: false,
      schedule: type === 'SCHEDULE' ? { mode: 'DAILY', time, timezone } : undefined,
      timezone,
      // No next run until it is enabled — a due time on a disabled trigger
      // reads as "this will happen".
      nextRunAt: null,
      missedPolicy: 'skip',
    });
  }

  return declared;
}

  ipcMain.handle('triggers:list', (_event, projectId: string) => {
    // Reconciled on read: the manifest is the source of truth and it changes
    // under us every time the agent writes. A separate "sync" call would be one
    // more thing to forget at one more call site.
    const declared = syncTriggers(String(projectId));
    // The manifest gives each trigger a human `name`; the row only stores the
    // id. Rendering the id put a slug in the UI — "weekday-morning-triage" where
    // the automation had written "Weekday mornings" — which reads as a key
    // leaking through rather than a label.
    const names = new Map(
      declared.map((d) => [String(d.id ?? ''), typeof d.name === 'string' ? d.name : undefined]),
    );
    return db()
      .triggers.list(String(projectId))
      .map((t) => ({
        id: t.id,
        recipeTriggerId: t.recipeTriggerId,
        name: names.get(t.recipeTriggerId),
        type: t.type,
        enabled: t.enabled,
        description: describe(t.schedule, t.type),
        nextRunAt: t.nextRunAt,
        lastStatus: t.lastStatus,
        missedCount: t.missedCount,
      }));
  });

  /**
   * Switch a trigger on or off.
   *
   * Enabling is what gives it a next run: a disabled row has none, because a
   * time shown against something that will not fire reads as a promise. On the
   * way off it is cleared again for the same reason.
   */
  ipcMain.handle('trigger:enable', (_event, triggerId: string, enabled: boolean) => {
    const store = db();
    const row = store.triggers.get(String(triggerId));
    if (!row) return;
    store.triggers.setEnabled(row.id, Boolean(enabled));
    if (!enabled) {
      store.triggers.setNextRun(row.id, null);
      return;
    }
    const schedule = row.schedule as Parameters<typeof nextRunAt>[0] | undefined;
    store.triggers.setNextRun(row.id, schedule ? nextRunAt(schedule) : null);
  });

  ipcMain.handle('spend:get', (_event, projectId: string, sinceMs: number) =>
    db().spendSince(String(projectId), Number(sinceMs)),
  );

  /** The providers a run can use, and whether a key is stored for each. Never
   *  the key itself — only the last four, which is enough to recognise it. */
  ipcMain.handle('keys:list', () => {
    const stored = db().listSecrets();
    return ['anthropic', 'openai'].map((id) => {
      const entry = stored.find((s2) => s2.key === `provider:*:${id}:api_key`);
      const base = stored.find((s2) => s2.key === `provider:*:${id}:base_url`);
      return {
        id,
        last4: entry?.last4,
        hasKey: Boolean(entry),
        baseUrl: base ? vault().get({ kind: 'provider', id, field: 'base_url' }) : undefined,
      };
    });
  });

  ipcMain.handle('keys:set', (_event, providerId: string, field: string, value: string) => {
    const id = String(providerId);
    const which = String(field) === 'base_url' ? 'base_url' : 'api_key';
    try {
      vault().set({ kind: 'provider', id, field: which }, String(value));
    } catch (cause) {
      if (cause instanceof VaultUnavailableError) throw new Error(cause.message);
      throw cause;
    }
  });

  ipcMain.handle('keys:remove', (_event, providerId: string, field: string) => {
    db().removeSecret(`provider:*:${String(providerId)}:${String(field) === 'base_url' ? 'base_url' : 'api_key'}`);
  });

  /** Start live-updating a project while its screen is open. */
  ipcMain.handle('project:watch', (event, projectId: string) => {
    const project = db().getProject(String(projectId));
    if (project) watchProject(String(projectId), project.path, event.sender);
  });

  ipcMain.on('project:unwatch', (_event, projectId: string) => {
    watchers.get(String(projectId))?.close();
    watchers.delete(String(projectId));
  });

  /** Links open in the real browser — never in a window that holds keys. */
  ipcMain.on('shell:open-external', (_event, url: string) => {
    const target = String(url);
    // Only ever http(s). A `file:` or custom-scheme URL from the renderer is how
    // "open a link" turns into "launch something".
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
  });

  /** What the automation's own agents asked the model during a run. */
  ipcMain.handle('llm:list', (_event, runId: string) => db().getLlmCalls(String(runId)));

  ipcMain.handle(
    'terminal:open',
    async (event, projectId: string, request?: string, agentId?: string) => {
    const project = db().getProject(String(projectId));
    if (!project) throw new Error('That automation is no longer in the library.');
    const file = manifestIn(project.path);
    let manifestId: string | undefined;
    let agentIds: string[] = [];
    if (file) {
      try {
        const parsed = parseYaml(readFileSync(file, 'utf8')) as {
          id?: string;
          agents?: Array<{ id?: string }>;
        };
        manifestId = parsed?.id;
        agentIds = (parsed?.agents ?? []).map((a) => a?.id ?? '').filter(Boolean);
      } catch {
        // A manifest mid-edit still deserves a terminal.
      }
    }
    return terminals.open(
      {
        projectId: String(projectId),
        cwd: project.path,
        hasManifest: Boolean(file),
        manifestId,
        agentIds,
        agentId: agentId ? String(agentId) : undefined,
        request: request ? String(request) : undefined,
      },
      event.sender,
    );
    },
  );

  ipcMain.on('terminal:write', (_event, projectId: string, data: string) =>
    terminals.write(String(projectId), String(data)),
  );
  ipcMain.on('terminal:resize', (_event, projectId: string, cols: number, rows: number) =>
    terminals.resize(String(projectId), Number(cols), Number(rows)),
  );
  ipcMain.on('terminal:close', (_event, projectId: string) => terminals.close(String(projectId)));

  ipcMain.handle('project:start', async (_event, projectId: string) => {
    await runtime.start(String(projectId));
  });

  ipcMain.handle('project:stop', async (_event, projectId: string) => {
    await runtime.stop(String(projectId));
  });

  /** Throw the Python environment away and start again. The automation's own
   *  files are never touched — see RuntimeHost.rebuild. */
  ipcMain.handle('project:rebuild', async (_event, projectId: string) => {
    await runtime.rebuild(String(projectId));
  });

  /**
   * Open the full output of the last failed start.
   *
   * The panel shows the tail of it; the cause is often above that. When there
   * is no log — a project that has never failed, or one whose `.studio` was
   * cleaned out — reveal the folder rather than silently doing nothing, which
   * is what this button did before it was wired.
   */
  ipcMain.handle('project:open-logs', async (_event, projectId: string) => {
    const project = db().getProject(String(projectId));
    if (!project) throw new Error('That automation is not in the library.');

    const log = bootLogPath(project.path);
    if (existsSync(log)) {
      // openPath returns a REASON on failure and resolves either way — an
      // empty string is success. Without this check a missing text-file
      // association looks exactly like a working button.
      const failed = await shell.openPath(log);
      if (!failed) return { opened: log };
      shell.showItemInFolder(log);
      return { opened: log, revealed: true };
    }

    const studio = join(project.path, '.studio');
    const fallback = existsSync(studio) ? studio : project.path;
    const failed = await shell.openPath(fallback);
    if (failed) throw new Error(`Could not open ${fallback}: ${failed}`);
    return { opened: fallback, revealed: true };
  });

  ipcMain.handle(
    'workflow:run',
    async (
      _event,
      projectId: string,
      workflowId?: string,
      inputs?: Record<string, unknown>,
    ) => {
      await runtime.runWorkflow(
        String(projectId),
        workflowId ? String(workflowId) : undefined,
        inputs && typeof inputs === 'object' ? inputs : undefined,
      );
    },
  );

  /**
   * The project's manifest, for the canvas. Read fresh each time rather than
   * cached: the whole point of Studio is that you edit the automation in your
   * editor and see the change here.
   */
  ipcMain.handle('manifest:get', (_event, projectId: string) => {
    const project = db().getProject(String(projectId));
    if (!project) return undefined;
    const file = manifestIn(project.path);
    if (!file) return undefined;
    try {
      return parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // A manifest mid-edit is a normal state, not an error worth a dialog.
      return undefined;
    }
  });

  /**
   * Coding agents installed on this machine.
   *
   * Detection goes through the same login PATH the terminal uses. Its own probe
   * here used the process PATH, which in a double-clicked .app does not include
   * ~/.local/bin — so this reported "none installed" on machines where Claude
   * Code was sitting right there.
   */
  /**
   * An agent's behaviour, as text.
   *
   * The manifest points at `prompt_file`, so the instructions are a file on
   * disk — Studio can edit them without owning them, the coding agent in the
   * dock sees the same bytes, and git records the change. Keeping behaviour in
   * a database instead would give an agent two sources of truth.
   */
  ipcMain.handle('agent:read', (_event, projectId: string, agentId: string) => {
    const project = db().getProject(String(projectId));
    if (!project) return undefined;
    const file = manifestIn(project.path);
    if (!file) return undefined;
    const parsed = parseYaml(readFileSync(file, 'utf8')) as {
      agents?: Array<{
        id?: string;
        prompt_file?: string;
        promptFile?: string;
        system_prompt?: string;
      }>;
    };
    const agent = (parsed?.agents ?? []).find((a) => a?.id === String(agentId));
    if (!agent) return undefined;
    const rel = agent.prompt_file ?? agent.promptFile;
    // An inline prompt is legal; it is just not a file to edit.
    if (!rel) return { inline: true, text: agent.system_prompt ?? '' };
    const full = join(project.path, rel);
    return { inline: false, path: rel, text: existsSync(full) ? readFileSync(full, 'utf8') : '' };
  });

  ipcMain.handle('agent:write', (_event, projectId: string, relPath: string, text: string) => {
    const project = db().getProject(String(projectId));
    if (!project) throw new Error('That automation is no longer in the library.');
    const full = join(project.path, String(relPath));
    // A path from the renderer is input, even when the renderer is ours.
    if (!full.startsWith(project.path)) throw new Error('Refusing to write outside the project.');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, String(text));
  });

  /** Documents the agents can be given. Listed from the project, not invented. */
  ipcMain.handle('agent:knowledge', (_event, projectId: string) => {
    const project = db().getProject(String(projectId));
    if (!project) return [];
    const dir = join(project.path, 'knowledge');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size }));
  });

  ipcMain.handle('agent:add-knowledge', async (_event, projectId: string) => {
    const project = db().getProject(String(projectId));
    if (!project) throw new Error('That automation is no longer in the library.');
    const picked = await dialog.showOpenDialog({
      title: 'Add knowledge',
      message: 'Documents the agents in this automation can be given',
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled) return 0;
    const dir = join(project.path, 'knowledge');
    mkdirSync(dir, { recursive: true });
    // Copied in, not linked: an automation depending on a file elsewhere on this
    // machine cannot be committed, shared, or run anywhere else.
    for (const file of picked.filePaths) cpSync(file, join(dir, basename(file)));
    return picked.filePaths.length;
  });

  ipcMain.handle('agents:list', async () => {
    const found = await detectAgents(terminals.probe);
    return found.map((a) => ({ id: a.id, name: a.name, version: a.version }));
  });

  /**
   * Rename an automation.
   *
   * The DISPLAY name only. `slug` stays as the folder's basename because that
   * is how the CLI finds this project (`getProjectBySlug` on the directory it is
   * run in), and `path` stays because renaming somebody's folder from a text
   * field is a destructive act disguised as a label edit. So the automation is
   * called whatever you like here and still resolves on disk.
   */
  ipcMain.handle('project:rename', (_event, projectId: string, name: string) => {
    const store = db();
    const project = store.getProject(String(projectId));
    if (!project) throw new Error('That automation is no longer in the library.');
    const next = String(name).trim();
    if (!next) throw new Error('Give it a name.');
    store.upsertProject({
      ...project,
      name: next.slice(0, 80),
    });
  });

  /** Adopt an automation that already exists on disk. */
  ipcMain.handle('project:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Open an automation',
      message: 'Choose a folder containing an intelligence.yaml',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    return adopt(picked.filePaths[0]);
  });

  /** Scaffold a new automation from the seed, then adopt it. */
  /**
   * Scaffold a new automation.
   *
   * Deliberately NOT a native save panel. That panel asks "where should this
   * file go" — with a Tags field, a Finder browser and no room for the one
   * question that matters — and it is the wrong first impression for a product
   * whose pitch is that it writes the automation for you. The window asks what
   * it should do; this just puts it somewhere sensible.
   */
  ipcMain.handle(
    'project:create',
    async (_event, name: string, request?: string, dir?: string) => {
      const slug = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      if (!slug) throw new Error('Give the automation a name.');

      const root = dir ? String(dir) : automationsRoot();
      mkdirSync(root, { recursive: true });
      const target = join(root, slug);
      if (existsSync(target)) {
        throw new Error(`${target} already exists — pick another name.`);
      }

      const seed = seedDir();
      if (!seed) throw new Error('Could not find the automation seed — is the install complete?');
      cpSync(seed, target, {
        recursive: true,
        filter: (src) => !src.includes('/.studio') && !src.includes('__pycache__'),
      });

      const created = adopt(target);
      // Studio made this folder, from its own seed, just now.
      pretrustForCodingAgent(target);
      return { ...created, request: request ? String(request) : undefined };
    },
  );

  /**
   * Which integrations actually have credentials on this machine.
   *
   * Without this the UI could only say "connect it somehow", and a scheduled
   * automation whose Gmail is missing skips every step that touches it while
   * still reporting success — which is how a broken automation looks healthy
   * for a week.
   */
  ipcMain.handle('integrations:status', (_event, projectId: string, ids: string[]) => {
    const v = vault();
    const list = Array.isArray(ids) ? ids.map(String) : [];
    return list.map((id) => {
      // THE DISTINCTION THAT MATTERS. An automation may declare any of the 38
      // integrations in the seed catalog, but Studio can only wire the ones in
      // `@clarity-studio/connectors` — the rest are OAuth, and that flow is
      // platform-owned by design (see any seed manifest's `_authNote`).
      //
      // Without this the panel printed `clarity-studio connect gmail`, a command
      // that can never succeed, and a run then skipped every Gmail step while
      // reporting success. Saying "this one needs the hosted version" is the
      // honest answer, and it is also the funnel.
      const spec = findIntegration(id);
      // Where the credential came from, because the two are acted on in
      // different places: a machine-wide one is managed in Settings and shared
      // by every automation, so this panel must not offer to delete it.
      const shared = Boolean(v.bundle(id));
      return {
        id,
        name: spec?.name ?? id,
        connected: Boolean(v.bundle(id, String(projectId))),
        // A bundle exists when at least one field was stored. Project-scoped
        // wins over machine-wide, which is what `bundle` already resolves.
        shared,
        local: Boolean(spec),
        howToConnect: spec?.howToConnect,
        fields: spec?.fields ?? [],
      };
    });
  });

  /**
   * Every connector Studio can wire, with whether this machine has it.
   *
   * Connecting a service is an account-level act, not an automation-level one:
   * you have one Slack workspace and one bot token, and having to re-enter it
   * inside each automation is both tedious and how people end up with the same
   * credential stored five times and rotated in one place. So Settings lists
   * the whole catalog and writes machine-wide, and an automation just uses what
   * is already there.
   *
   * Per-project credentials still exist and still win — `bundle()` resolves the
   * specific over the general — they are simply no longer the thing you are
   * asked for first.
   */
  ipcMain.handle('integrations:all', () => {
    const v = vault();
    return CATALOG.map((spec) => ({
      id: spec.id,
      name: spec.name,
      howToConnect: spec.howToConnect,
      fields: spec.fields,
      // No projectId: the machine-wide bundle only.
      connected: Boolean(v.bundle(spec.id)),
    }));
  });

  /**
   * Store one connector's credentials, exactly as `clarity-studio connect` does.
   *
   * `projectId` of `'*'` (or empty) means machine-wide, which is what Settings
   * sends and what `secretKey` already encodes for a ref with no project.
   */
  ipcMain.handle(
    'integrations:connect',
    (_event, projectId: string, id: string, values: Record<string, string>) => {
      const spec = findIntegration(String(id));
      if (!spec) {
        throw new Error(`${id} has no local connector — nothing here can store its credentials.`);
      }
      const scope = scopeOf(projectId);
      const v = vault();
      for (const [field, value] of Object.entries(values)) {
        if (!spec.fields.some((f) => f.key === field)) {
          throw new Error(`${spec.name} has no "${field}" field.`);
        }
        if (!String(value).trim()) continue;
        v.set({ kind: 'integration', id: spec.id, field, ...scope }, String(value));
      }
    },
  );

  ipcMain.handle(
    'integrations:disconnect',
    (_event, projectId: string, id: string) => {
      const spec = findIntegration(String(id));
      const scope = scopeOf(projectId);
      const store = db();
      for (const field of spec?.fields ?? []) {
        // Only the scope that was asked for. Removing both — as this used to —
        // meant disconnecting one automation silently deleted the machine-wide
        // credential every other automation was relying on.
        store.removeSecret(
          secretKey({ kind: 'integration', id: String(id), field: field.key, ...scope }),
        );
      }
    },
  );

  /**
   * Tell the person a run finished.
   *
   * A desktop notification is the one channel Studio can honestly offer with no
   * connection and no account — which is the whole product's shape. Slack is
   * possible too, because `slack` is one of the nine local connectors; the rest
   * of the platform's channels are hosted-only and are listed as such rather
   * than shown as buttons that do nothing.
   */
  ipcMain.handle(
    'notify:test',
    (_event, title: string, body: string) => {
      if (!Notification.isSupported()) {
        throw new Error('This system does not support desktop notifications.');
      }
      new Notification({ title: String(title), body: String(body) }).show();
    },
  );

  /**
   * The preference, plus the two things the panel cannot work out for itself:
   * which channels this machine can actually use, and how the last send went.
   *
   * Availability is not cosmetic. A toggle you can switch on for a service with
   * no credentials is a toggle that silently sends nothing, which is exactly the
   * failure a notification exists to prevent.
   */
  ipcMain.handle('notify:get', (_event, projectId: string) => {
    const id = String(projectId);
    const v = vault();
    const has = (integrationId: string) => Boolean(v.bundle(integrationId, id));
    return {
      prefs: readSettings().notify?.[id] ?? { desktop: true },
      available: {
        desktop: Notification.isSupported(),
        slack: has('slack'),
        telegram: has('telegram'),
        whatsapp: has('whatsapp'),
        email: has('resend'),
      },
      lastDelivery: lastDelivery.get(id) ?? [],
    };
  });

  ipcMain.handle('notify:set', (_event, projectId: string, prefs: NotifyPrefs) => {
    const current = readSettings();
    writeSettings({
      ...current,
      notify: { ...(current.notify ?? {}), [String(projectId)]: { ...prefs } },
    });
  });

  /**
   * Send a real one, through the channels as configured, so "will this actually
   * reach me" is answerable before a run depends on it. It uses the same
   * delivery path a finished run uses — a test that took a different path would
   * prove nothing about the real one.
   */
  ipcMain.handle('notify:send-test', async (_event, projectId: string) => {
    const id = String(projectId);
    const prefs = readSettings().notify?.[id] ?? { desktop: true };
    const project = db().listProjects().find((p) => p.id === id);
    const summary = {
      automation: project?.name ?? 'An automation',
      status: 'success',
      error: null,
    };
    if (prefs.desktop !== false && Notification.isSupported()) {
      new Notification({ title: headline(summary), body: 'This is a test.' }).show();
    }
    const v = vault();
    const results = await deliver(prefs, summary, (i) => v.bundle(i, id), Date.now());
    if (results.length > 0) lastDelivery.set(id, results);
    return results;
  });

  /** Every connector Studio can wire locally — for the "what can I use" question. */
  ipcMain.handle('integrations:catalog', () =>
    CATALOG.map((c) => ({ id: c.id, name: c.name, howToConnect: c.howToConnect })),
  );

  /** Build identity, so a stale packaged app can say so. */
  ipcMain.handle('app:version', () => `${app.getVersion()}${app.isPackaged ? '' : ' (dev)'}`);

  ipcMain.handle('settings:get', () => ({
    automationsRoot: automationsRoot(),
    modelOverride: modelOverride() ?? '',
  }));

  /** Run everything on one model, or pass '' to go back to what each manifest
   *  asks for. Takes effect on the next run — the control plane reads this
   *  through a getter rather than holding a copy. */
  ipcMain.handle('settings:set-model-override', (_e, model: unknown) => {
    const next = typeof model === 'string' ? model.trim() : '';
    writeSettings({ ...readSettings(), modelOverride: next });
    return next;
  });

  /** Pick the folder new automations go into, and remember it. */
  ipcMain.handle('settings:choose-automations-root', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Where should new automations go?',
      defaultPath: automationsRoot(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    // Only the default for NEW ones. Automations already in the library keep
    // their own paths — moving somebody's folders because they changed a
    // preference would be a surprise, and a destructive one.
    writeSettings({ ...readSettings(), automationsRoot: picked.filePaths[0] });
    return picked.filePaths[0];
  });

  /** Only when someone explicitly wants them somewhere else. */
  ipcMain.handle('project:choose-folder', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Where should automations live?',
      properties: ['openDirectory', 'createDirectory'],
    });
    return picked.canceled ? undefined : picked.filePaths[0];
  });

  /**
   * Forget an automation, and optionally delete it.
   *
   * Two separate things, asked as two separate choices, because they are not
   * equally reversible: removing it from the library is undone by opening the
   * folder again, and deleting the folder is undone by nothing. Files are never
   * removed unless that button is the one pressed.
   */
  ipcMain.handle('project:delete', async (_event, projectId: string) => {
    const id = String(projectId);
    const project = db().getProject(id);
    if (!project) return { removed: false };

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Remove from Studio', 'Delete folder too'],
      defaultId: 1,
      cancelId: 0,
      title: 'Delete automation',
      message: `Delete “${project.name}”?`,
      detail:
        `Remove from Studio keeps the folder at ${project.path} — you can open it again later.\n\n` +
        'Delete folder too erases the code, its runs and its history from disk. That cannot be undone.',
    });
    if (response === 0) return { removed: false };

    // Stop it before forgetting it, or a runner keeps a port for something the
    // library no longer lists.
    await runtime.stop(id).catch(() => undefined);
    terminals.close(id);
    watchers.get(id)?.close();
    watchers.delete(id);

    if (response === 2) {
      rmSync(project.path, { recursive: true, force: true });
    }
    db().deleteProject(id);
    return { removed: true, deletedFiles: response === 2 };
  });
}

/** Both `intelligence.yaml` and the older `app.yaml` count as a manifest. */
function manifestIn(dir: string): string | undefined {
  for (const name of ['intelligence.yaml', 'app.yaml']) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/**
 * The automation seed, resolved the same way the CLI resolves it — from the
 * checkout when running from source, from the bundled copy otherwise.
 */
/**
 * Where the automation seed lives.
 *
 * Two homes, because the app has two lives. Running from the repo it is the
 * workspace package; packaged it is copied into the bundle's Resources by
 * electron-builder's `extraResources` and is NOT inside the asar, which is why
 * `process.resourcesPath` is the right root rather than anything relative to
 * this file.
 *
 * It shipped without that copy, so every packaged install failed at "New
 * automation" — the first thing anyone does — with "Could not find the
 * automation seed". Only the dev path was ever exercised.
 */
function seedDir(): string | undefined {
  const candidates = [
    // Packaged: Contents/Resources/seed
    join(process.resourcesPath ?? '', 'seed'),
    // From the repo, running `electron .`
    resolve(HERE, '../../../../packages/automation-seed'),
    resolve(HERE, '../../seed'),
  ];
  return candidates.find((dir) => dir && existsSync(join(dir, 'intelligence.yaml')));
}

/**
 * Tell the coding agent it already trusts a folder Studio just made.
 *
 * Claude Code asks "is this a project you created or one you trust?" the first
 * time it opens a directory. That question is worth asking about code you
 * downloaded. It is not worth asking about a folder Studio scaffolded from its
 * own bundled seed thirty seconds ago, at the user's request, on their machine —
 * there, the answer is known before the question is put, and every new
 * automation opening with a safety prompt reads as friction rather than care.
 *
 * Strictly limited to folders Studio CREATED. An imported one is somebody
 * else's code, arriving by exactly the route the dialog exists to guard, and
 * pre-trusting that would be answering a security question on the user's behalf
 * with a guess. See `project:import`, which deliberately does not call this.
 *
 * Written carefully, because this is another program's config and it holds the
 * user's whole Claude Code state:
 *   - never touches an entry that already exists
 *   - adds one key, changes nothing else
 *   - writes via a temp file and rename, so a crash cannot truncate it
 *   - fails silently: the cost of losing is one dialog, the cost of a bad write
 *     is somebody's settings
 */
function pretrustForCodingAgent(projectPath: string): void {
  try {
    const configPath = join(app.getPath('home'), '.claude.json');
    if (!existsSync(configPath)) return;

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      projects?: Record<string, Record<string, unknown>>;
    };
    if (!config.projects || typeof config.projects !== 'object') return;
    // Already known to it — including a folder the user answered "no" for.
    if (config.projects[projectPath]) return;

    config.projects[projectPath] = { hasTrustDialogAccepted: true };

    const temp = `${configPath}.studio-${randomUUID().slice(0, 8)}`;
    writeFileSync(temp, JSON.stringify(config, null, 2));
    renameSync(temp, configPath);
  } catch {
    // Unreadable, unwritable, or not JSON we understand. The agent asks once,
    // which is where this started.
  }
}

/**
 * Record a folder as a project. Refuses anything without a manifest rather than
 * adding a row that can only ever fail to start.
 */
function adopt(path: string): { id: string } {
  if (!manifestIn(path)) {
    throw new Error(`No intelligence.yaml in ${path} — that folder is not an automation.`);
  }
  const slug = basename(path);
  const existing = db().getProjectBySlug(slug);
  const id = existing?.id ?? randomUUID();
  db().upsertProject({
    id,
    name: slug,
    slug,
    path,
    runtime: existing?.runtime ?? 'native',
    status: 'stopped',
  });
  return { id };
}

function describe(schedule: unknown, type: string): string {
  if (type === 'WEBHOOK') return 'on webhook';
  const s = schedule as { mode?: string; time?: string; timezone?: string; everyMinutes?: number };
  if (!s?.mode) return 'no schedule';
  if (s.mode === 'INTERVAL') return `every ${s.everyMinutes} minute(s)`;
  if (s.mode === 'DAILY') return `daily at ${s.time} ${s.timezone}`;
  return s.mode.toLowerCase();
}

// ── window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    // Windows and Linux take the icon from the window; macOS takes it from the
    // bundle, so in an unpackaged dev run it is set on the dock below instead.
    ...(process.platform === 'darwin' ? {} : { icon: ICON_PATH }),
    backgroundColor: '#0F0F10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(HERE, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Painting a half-built window is the cheapest way to look unfinished.
  window.once('ready-to-show', () => {
    window.show();
    // Useful when someone reports "it launched but I see nothing" — the most
    // common desktop bug report there is.
    console.log(`[studio] window ready · data dir ${dataDir()}`);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const isLocal = DEV_SERVER ? url.startsWith(DEV_SERVER) : url.startsWith('file://');
    if (!isLocal) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER);
  } else {
    const html = join(HERE, '../renderer/index.html');
    if (!existsSync(html)) {
      throw new Error(`Renderer not built. Run: pnpm --filter @clarity-studio/desktop build`);
    }
    void window.loadFile(html);
  }
}

void app.whenReady().then(() => {
  app.on('web-contents-created', (_event, contents) => {
    contents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          // Nothing is loaded from anywhere but the app itself.
          'Content-Security-Policy': [
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
          ],
        },
      });
    });
  });

  // Unpackaged macOS runs (`electron .`) show the Electron binary's own icon,
  // because the dock reads the .app bundle rather than the window. Setting it
  // explicitly means `pnpm start` looks like the product, not like a toolchain.
  if (process.platform === 'darwin' && app.dock && existsSync(ICON_PATH)) {
    const image = nativeImage.createFromPath(ICON_PATH);
    if (!image.isEmpty()) app.dock.setIcon(image);
  }

  registerIpc();
  createWindow();

  // Run the schedules. Until now Studio listed triggers and showed a next-run
  // time while nothing fired them — the Dispatcher was only ever constructed by
  // the CLI's `serve`, so a weekday-morning automation did nothing unless you
  // separately kept a terminal open. An app that says "it runs on its schedule"
  // has to be the thing that runs it.
  runtime.startScheduling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Quitting must take the automations with it. Without this, a container or a
 * uvicorn process outlives the window that started it and keeps a port — and
 * the next launch reports the port as taken by nothing visible.
 */
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  for (const w of watchers.values()) w.close();
  watchers.clear();
  terminals.shutdown();
  runtime.stopScheduling();
  void runtime.shutdown().finally(() => {
    store?.close();
    store = undefined;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
