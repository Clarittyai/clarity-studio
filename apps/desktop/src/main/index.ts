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

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '@claritty-studio/db';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV_SERVER = process.env.STUDIO_DEV_SERVER;

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

  ipcMain.handle('triggers:list', (_event, projectId: string) =>
    db()
      .triggers.list(String(projectId))
      .map((t) => ({
        id: t.id,
        recipeTriggerId: t.recipeTriggerId,
        type: t.type,
        enabled: t.enabled,
        description: describe(t.schedule, t.type),
        nextRunAt: t.nextRunAt,
        lastStatus: t.lastStatus,
        missedCount: t.missedCount,
      })),
  );

  ipcMain.handle('spend:get', (_event, projectId: string, sinceMs: number) =>
    db().spendSince(String(projectId), Number(sinceMs)),
  );

  // Lifecycle is stubbed until the runner is hosted in-process. Returning a
  // clear "not wired yet" beats a button that silently does nothing.
  for (const channel of ['project:start', 'project:stop', 'workflow:run']) {
    ipcMain.handle(channel, () => {
      throw new Error(
        `${channel} is not wired to the desktop app yet — use the CLI: claritty-studio serve`,
      );
    });
  }
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
      throw new Error(`Renderer not built. Run: pnpm --filter @claritty-studio/desktop build`);
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

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  store?.close();
  if (process.platform !== 'darwin') app.quit();
});
