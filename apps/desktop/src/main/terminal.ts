/**
 * The terminal behind the "Build with Claude Code" panel.
 *
 * A pty, not a pipe. Claude Code is a full TUI — raw mode, alt screen, ANSI —
 * and `child_process` stdio cannot drive one. `node-pty` ships N-API prebuilds,
 * so Electron loads it without an ABI rebuild.
 *
 * The pty lives here, in main. The renderer stays `sandbox: true` /
 * `contextIsolation: true` and only ever exchanges text over IPC, so adding a
 * terminal does not widen what a compromised renderer can reach.
 *
 * The opening prompt is not invented here: `composeOpeningPrompt` in
 * `@clarity-studio/agent-bridge` already knows the four situations (no manifest
 * → /clarity-convert, problems → fix and verify, fresh seed →
 * /clarity-new-automation, otherwise → describe it), and the seed ships the
 * matching slash commands and CLAUDE.md. Studio's job is only to start the
 * agent in the right directory with the right first sentence.
 */

import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { AGENTS, composeOpeningPrompt, detectAgents, looksFresh } from '@clarity-studio/agent-bridge';
import type { WebContents } from 'electron';
import * as pty from 'node-pty';

export interface OpenOptions {
  projectId: string;
  cwd: string;
  /** Which agent to start; omitted means "the first one installed". */
  agentId?: string;
  hasManifest: boolean;
  manifestId?: string;
  agentIds: string[];
  problems?: string[];
  /** What the user typed, if they said what they want built. */
  request?: string;
}

interface Session {
  proc: pty.IPty;
  /** Kept so a resize before first paint is not lost. */
  cols: number;
  rows: number;
}

/**
 * The PATH the user actually has, not the one macOS hands a GUI app.
 *
 * A double-clicked .app inherits roughly `/usr/bin:/bin:/usr/sbin:/sbin` — it
 * never sources a profile. Claude Code installs to `~/.local/bin`, Homebrew to
 * `/opt/homebrew/bin`, and neither is on that list, so detection reported "no
 * coding agent found" on machines that plainly had one. The terminal still
 * worked, because its fallback is a LOGIN shell which does source the profile,
 * which made the bug look like a UI problem rather than a PATH one.
 *
 * Asked once, from the user's own login shell, and cached for the session.
 */
let cachedPath: string | undefined;

function loginPath(): string {
  if (cachedPath !== undefined) return cachedPath;
  const shell = process.env.SHELL ?? '/bin/zsh';
  try {
    const out = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    const resolved = (out.stdout ?? '').trim();
    cachedPath = resolved.includes('/') ? resolved : (process.env.PATH ?? '');
  } catch {
    cachedPath = process.env.PATH ?? '';
  }
  // Belt and braces: the common install locations, in case the profile is
  // unusual or the shell refused to run interactively.
  const extra = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter((dir) => !cachedPath!.split(':').includes(dir));
  if (extra.length) cachedPath = [cachedPath, ...extra].filter(Boolean).join(':');
  return cachedPath;
}

const probe = (bin: string, args: string[]) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawnProcess(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: loginPath() },
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += String(d)));
    child.stderr?.on('data', (d) => (output += String(d)));
    child.on('error', () => resolve({ code: 1, output: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

/**
 * Provider keys that must NOT reach the authoring session.
 *
 * Writing an automation and running one are paid for by different people in
 * different ways, and conflating them is a real cost bug. A run spends the key
 * in the vault, metered per step. Authoring is the user's own Claude Code
 * session, on whatever plan they already signed in with.
 *
 * Inheriting the shell's environment wholesale breaks that: with
 * `ANTHROPIC_API_KEY` exported, Claude Code silently bills that key instead of
 * the subscription the user is sitting in front of — and the automation's run
 * budget quietly pays for the conversation that wrote it. So the keys are
 * stripped here rather than trusted not to matter.
 */
const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

/**
 * State describing SOMEBODY ELSE'S agent session.
 *
 * If Studio was itself started from inside a coding-agent session — a developer
 * running `pnpm start` from one, or an agent launching the packaged app — that
 * session's identity is sitting in the environment, and copying the environment
 * wholesale hands it to the fresh session as though it were its own.
 *
 * The visible symptom is Claude Code opening with "Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker". It concluded, correctly from
 * what it was told, that it is a subprocess of another session, and quietly
 * stopped keeping a transcript. The user's authoring history disappears, and
 * nothing in Studio said why.
 *
 * These are the variables observed in a real session, not a guess at the set:
 * a marker, an id, a pid, an execpath, an entrypoint, an effort level. All
 * describe a RUNNING session. Configuration a user deliberately exported —
 * `CLAUDE_CONFIG_DIR` and friends — is not here and is passed through, because
 * that is their setting and not another session's leakage.
 */
const INHERITED_SESSION_STATE = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

/**
 * The environment the authoring session gets.
 *
 * Exported so it can be tested: both of the things scrubbed here are invisible
 * when they go wrong. A leaked provider key bills the wrong account, a leaked
 * session marker silently stops the transcript, and in each case the terminal
 * looks entirely normal.
 */
export function authoringEnv(base: NodeJS.ProcessEnv = process.env, path = loginPath()): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color', PATH: path };
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PROVIDER_KEYS.includes(key)) continue;
    if (INHERITED_SESSION_STATE.includes(key)) continue;
    if (key === 'PATH') continue; // loginPath() wins
    env[key] = value;
  }
  return env;
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();

  /** Shared so detection and launching can never disagree about PATH. */
  readonly probe = probe;

  /**
   * Start (or reuse) a session for a project. Returns which agent it started, so
   * the panel can say "Claude Code" rather than guessing — and `undefined` when
   * none is installed, which the UI turns into an install link rather than an
   * empty black rectangle.
   */
  async open(
    opts: OpenOptions,
    send: WebContents,
  ): Promise<{ agent?: { id: string; name: string }; shell: string }> {
    const existing = this.sessions.get(opts.projectId);
    if (existing) return { agent: undefined, shell: 'reused' };

    const installed = await detectAgents(probe);
    const chosen = opts.agentId
      ? installed.find((a) => a.id === opts.agentId)
      : installed[0];

    let file: string;
    let args: string[];

    if (chosen) {
      const prompt = composeOpeningPrompt({
        request: opts.request,
        isFresh: looksFresh(opts.manifestId, opts.agentIds),
        hasManifest: opts.hasManifest,
        problems: opts.problems,
      });
      const spec = AGENTS.find((a) => a.id === chosen.id);
      file = chosen.bin;
      args = spec?.launch(prompt) ?? [];
    } else {
      // No agent installed. Give a real shell rather than nothing — the panel
      // says what to install, and the user can still work in the project.
      file = process.env.SHELL ?? '/bin/bash';
      args = ['-l'];
    }

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 24,
      cwd: existsSync(opts.cwd) ? opts.cwd : process.env.HOME,
      env: authoringEnv(),
    });

    proc.onData((data) => {
      if (!send.isDestroyed()) send.send('terminal:data', opts.projectId, data);
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(opts.projectId);
      if (!send.isDestroyed()) send.send('terminal:exit', opts.projectId, exitCode);
    });

    this.sessions.set(opts.projectId, { proc, cols: 100, rows: 24 });
    return {
      agent: chosen ? { id: chosen.id, name: chosen.name } : undefined,
      shell: file,
    };
  }

  write(projectId: string, data: string): void {
    this.sessions.get(projectId)?.proc.write(data);
  }

  resize(projectId: string, cols: number, rows: number): void {
    const session = this.sessions.get(projectId);
    if (!session || cols < 2 || rows < 2) return;
    session.cols = cols;
    session.rows = rows;
    // A pty that has already exited throws on resize; the session map is only
    // cleared on the exit event, so a race here is normal rather than a fault.
    try {
      session.proc.resize(cols, rows);
    } catch {
      /* the process is gone; the exit handler will clean up */
    }
  }

  close(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    this.sessions.delete(projectId);
    try {
      session.proc.kill();
    } catch {
      /* already gone */
    }
  }

  /** Called on quit, so no agent process outlives the window. */
  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
