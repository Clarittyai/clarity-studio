/**
 * The "Build with Claude Code" panel.
 *
 * This is the answer to the question Studio never used to answer: *how do I
 * actually write an automation?* The seed already ships `CLAUDE.md`, `AGENTS.md`
 * and three slash commands; the agent already knows what to do once it is
 * started in the project. All that was missing was somewhere to start it.
 *
 * xterm renders; the pty lives in the main process. The renderer only exchanges
 * strings, so `sandbox: true` and `contextIsolation` are untouched.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ExternalLink, TerminalSquare } from 'lucide-react';

import { api } from '../api.js';
import { Button } from './ui.js';

import '@xterm/xterm/css/xterm.css';

/** The seed's own commands — the shortest path from empty project to automation. */
const COMMANDS: Array<{ cmd: string; hint: string }> = [
  { cmd: '/clarity-new-automation', hint: 'Replace the example with a real automation' },
  { cmd: '/clarity-convert', hint: 'Turn an existing repo into one' },
  { cmd: '/clarity-verify', hint: 'Check it before you run it' },
];

/**
 * Read the terminal's colours from the app's own tokens rather than xterm's
 * defaults, so the panel belongs to the window instead of looking pasted in.
 */
function themeFromTokens(): Record<string, string> {
  const read = (name: string, fallback: string) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  };
  return {
    background: read('--background', '#0F0F10'),
    foreground: read('--foreground', '#F8FAFC'),
    cursor: read('--accent', '#5B7FFF'),
    selectionBackground: 'rgba(91,127,255,0.28)',
  };
}

export function TerminalPanel({
  projectId,
  request,
  agentId,
  height = 320,
}: {
  projectId: string;
  /** What the person said it should do, handed to the agent as its first instruction. */
  request?: string;
  /** Which coding agent to run. Changing it restarts the session. */
  agentId?: string;
  /** Set by the dock's drag handle. */
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const [agentName, setAgentName] = useState<string | undefined>();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const send = useCallback((text: string) => api.writeTerminal(projectId, text), [projectId]);

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;

    const term = new XTerm({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => api.writeTerminal(projectId, data));
    const offData = api.onTerminalData((id, data) => {
      if (id === projectId) term.write(data);
    });
    const offExit = api.onTerminalExit((id) => {
      if (id !== projectId) return;
      term.writeln('\r\n\x1b[2m— session ended —\x1b[0m');
      setStarted(false);
    });

    const onResize = () => {
      fit.fit();
      api.resizeTerminal(projectId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(hostRef.current);

    void api
      .openTerminal(projectId, request, agentId)
      .then((result) => {
        setAgentName(result?.agent?.name);
        setStarted(true);
        onResize();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );

    return () => {
      offData();
      offExit();
      ro.disconnect();
      api.closeTerminal(projectId);
      term.dispose();
      termRef.current = undefined;
    };
    // `request` is deliberately not a dependency: it is the opening instruction
    // for a session that has already started, and re-running this would kill a
    // live conversation to say the same thing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, agentId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-6">
        {agentName ? (
          <>
            <span className="text-xs text-muted-foreground">
              {agentName} is signed in as you, running in this folder, with the project&rsquo;s
              instructions and skills already loaded. Your automation&rsquo;s API key is not used
              here. Try:
            </span>
            {COMMANDS.map(({ cmd, hint }) => (
              <button
                key={cmd}
                type="button"
                title={hint}
                onClick={() => send(`${cmd}\r`)}
                className="rounded-full border border-border px-2.5 py-1 font-mono text-[11.5px] text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
              >
                {cmd}
              </button>
            ))}
          </>
        ) : started ? (
          // Never a dead end: no agent installed is a state with an action.
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <TerminalSquare className="h-3.5 w-3.5" />
            <span>
              No coding agent found on your PATH — this is a plain shell. Install Claude Code to
              have it write the automation for you.
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => api.openExternal('https://claude.com/claude-code')}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Install
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Starting…</span>
        )}
      </div>

      {error && <p className="px-6 text-sm text-destructive">{error}</p>}

      {/* Full-bleed on purpose: a terminal inside a rounded card reads as a
          widget, and this is a place you work. It spans the dock. */}
      <div className="w-full" style={{ height }}>
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
