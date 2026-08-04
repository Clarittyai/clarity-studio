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

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { detectAgents } from '@clarity-studio/agent-bridge';
import { Store } from '@clarity-studio/db';

import { RuntimeHost } from './runtime.js';

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
const runtime = new RuntimeHost(db);

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

  ipcMain.handle('project:start', async (_event, projectId: string) => {
    await runtime.start(String(projectId));
  });

  ipcMain.handle('project:stop', async (_event, projectId: string) => {
    await runtime.stop(String(projectId));
  });

  ipcMain.handle('workflow:run', async (_event, projectId: string, workflowId?: string) => {
    await runtime.runWorkflow(String(projectId), workflowId ? String(workflowId) : undefined);
  });

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

  /** Coding agents installed on this machine, for the "author with…" hint. */
  ipcMain.handle('agents:list', async () => {
    const probe = (bin: string, args: string[]) =>
      new Promise<{ code: number; output: string }>((resolveProbe) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout?.on('data', (d) => (output += String(d)));
        child.stderr?.on('data', (d) => (output += String(d)));
        child.on('error', () => resolveProbe({ code: 1, output: '' }));
        child.on('close', (code) => resolveProbe({ code: code ?? 1, output }));
      });
    const found = await detectAgents(probe);
    return found.map((a) => ({ id: a.id, name: a.name, version: a.version }));
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
  ipcMain.handle('project:create', async () => {
    const picked = await dialog.showSaveDialog({
      title: 'New automation',
      message: 'Where should the automation live?',
      nameFieldLabel: 'Name:',
      defaultPath: join(app.getPath('home'), 'my-automation'),
      buttonLabel: 'Create',
    });
    if (picked.canceled || !picked.filePath) return undefined;
    if (existsSync(picked.filePath)) {
      throw new Error(`${picked.filePath} already exists — pick a name that is not taken.`);
    }
    const seed = seedDir();
    if (!seed) throw new Error('Could not find the automation seed — is the install complete?');
    cpSync(seed, picked.filePath, {
      recursive: true,
      filter: (src) => !src.includes('/.studio') && !src.includes('__pycache__'),
    });
    return adopt(picked.filePath);
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
function seedDir(): string | undefined {
  const candidates = [
    resolve(HERE, '../../../../packages/automation-seed'),
    resolve(HERE, '../../seed'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'intelligence.yaml')));
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
  void runtime.shutdown().finally(() => {
    store?.close();
    store = undefined;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
