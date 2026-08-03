/**
 * Finding the coding agent you already use.
 *
 * Studio does not ship an agent. It detects the one on your PATH and hands it a
 * project that already knows the rules — `CLAUDE.md`, `AGENTS.md`,
 * `.cursorrules` and `.claude/commands/` come with every automation. That is
 * why the authoring story costs nothing to run and improves whenever your agent
 * does.
 *
 * ── On node-pty ──────────────────────────────────────────────────────────────
 * A real terminal needs a pty, and `node-pty` is a native module — which cuts
 * against the rule that made the store use `node:sqlite`: installing Studio
 * should never require a C++ toolchain.
 *
 * The resolution is that they are different audiences. `node-pty` is a
 * dependency of the **desktop app only**, where users install a signed binary
 * with prebuilds already inside and never run `npm install` at all. The CLI and
 * every package it depends on stay native-free, so `pnpm install` on a fresh
 * machine still needs nothing but Node.
 *
 * Until the desktop terminal lands, this module does the part that needs no
 * pty: work out what is available, and compose the opening prompt.
 */

export interface AgentCli {
  id: string;
  /** Binary to look for on PATH. */
  bin: string;
  name: string;
  /** Arguments that make it print a version and exit. */
  versionArgs: string[];
  /** Build the argv for starting it on a project with an opening instruction.
   *  Some agents take a prompt as an argument; others must be typed into. */
  launch(prompt?: string): string[];
  /** True when the agent reads its instructions from a file the seed ships. */
  readsProjectRules: boolean;
}

export const AGENTS: AgentCli[] = [
  {
    id: 'claude',
    bin: 'claude',
    name: 'Claude Code',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? [prompt] : []),
    readsProjectRules: true, // CLAUDE.md + .claude/commands/
  },
  {
    id: 'codex',
    bin: 'codex',
    name: 'Codex',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? [prompt] : []),
    readsProjectRules: true, // AGENTS.md
  },
  {
    id: 'gemini',
    bin: 'gemini',
    name: 'Gemini CLI',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? ['-i', prompt] : []),
    readsProjectRules: true, // GEMINI.md, and it also reads AGENTS.md
  },
  {
    id: 'cursor-agent',
    bin: 'cursor-agent',
    name: 'Cursor',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? [prompt] : []),
    readsProjectRules: true, // .cursorrules
  },
  {
    id: 'opencode',
    bin: 'opencode',
    name: 'opencode',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? ['run', prompt] : []),
    readsProjectRules: true,
  },
  {
    id: 'aider',
    bin: 'aider',
    name: 'Aider',
    versionArgs: ['--version'],
    launch: (prompt) => (prompt ? ['--message', prompt] : []),
    readsProjectRules: false, // no convention file it reads by default
  },
];

export interface DetectedAgent extends AgentCli {
  version: string;
}

export type ProbeFn = (bin: string, args: string[]) => Promise<{ code: number; output: string }>;

/**
 * Which agents are installed.
 *
 * Probed in parallel because six sequential process spawns is a visible pause
 * on a cold start, and this runs every time the Author panel opens.
 */
export async function detectAgents(probe: ProbeFn): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const { code, output } = await probe(agent.bin, agent.versionArgs);
        if (code !== 0) return undefined;
        return { ...agent, version: firstVersion(output) };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((a): a is DetectedAgent => a !== undefined);
}

function firstVersion(output: string): string {
  const match = /\d+\.\d+(\.\d+)?/.exec(output);
  return match ? match[0] : output.trim().split('\n')[0]?.slice(0, 40) ?? 'unknown';
}

// ── the opening prompt ───────────────────────────────────────────────────────

export interface PromptContext {
  /** What the user typed, if anything. */
  request?: string;
  /** Whether the project still holds the seed's example automation. */
  isFresh: boolean;
  /** Problems the canvas found, so the agent starts by fixing what is broken. */
  problems?: string[];
  /** True when the repo has an intelligence.yaml already. */
  hasManifest: boolean;
}

/**
 * Compose what Studio types in for you.
 *
 * Kept short on purpose. The project already carries its own rules in
 * `CLAUDE.md` and `AGENTS.md`; repeating them here would waste context and,
 * worse, create a second copy to drift out of date. The prompt's whole job is
 * to say which situation the agent is in.
 */
export function composeOpeningPrompt(ctx: PromptContext): string {
  if (!ctx.hasManifest) {
    return [
      'This repo is not a Clarity automation yet.',
      ctx.request ? `The goal: ${ctx.request}` : '',
      'Run /clarity-convert to map what is already here onto intelligence.yaml.',
      'Wrap the existing code — do not rewrite it.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (ctx.problems?.length) {
    return [
      'This automation has problems that will stop it working:',
      ...ctx.problems.map((p) => `- ${p}`),
      '',
      'Fix them, then run `claritty-seed-verify .` and confirm it is clean.',
      ctx.request ? `\nAfter that: ${ctx.request}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (ctx.isFresh) {
    return [
      ctx.request
        ? `Replace the example automation with one that does this: ${ctx.request}`
        : 'Replace the example automation with a real one. Ask me what it should do.',
      '',
      'Follow /clarity-new-automation. Delete the example rather than leaving it alongside.',
    ].join('\n');
  }

  return (
    ctx.request ??
    'Read intelligence.yaml and tell me what this automation does, then ask what I want to change.'
  );
}

/** True when a project still looks like the untouched seed. */
export function looksFresh(manifestId: string | undefined, agentIds: string[]): boolean {
  return manifestId === 'my-automation' || agentIds.includes('digest-writer');
}
