/**
 * Clarity Studio — the window.
 *
 * Two screens for now: the Launchpad, and a project. The project screen leads
 * with the run timeline rather than with settings, because the question people
 * actually arrive with is "what did it do, and what did it cost" — not "how is
 * it configured".
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ChevronDown, FolderOpen, Plus, Settings, Sparkles, TerminalSquare, Trash2 } from 'lucide-react';

import {
  api,
  isDemo,
  type AgentInfo,
  type LlmCall,
  type Project,
  type ProviderKey,
  type Run,
  type Step,
  type Trigger,
} from './api.js';
import { BrandLockup } from './components/Brand.js';
import { AutomationFlow, type StepStatus } from './components/flow/AutomationFlow.js';
import { toFlow } from './components/flow/blocks.js';
import { AutomationGraphScene } from './components/live/AutomationGraphScene.js';
import { TerminalPanel } from './components/Terminal.js';
import {
  Badge,
  Button,
  Card,
  duration,
  EmptyState,
  formatUsd,
  StatusDot,
  timeAgo,
  cn,
  type Status,
} from './components/ui.js';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pendingRequest, setPendingRequest] = useState<Record<string, string>>({});

  // Every load has a `catch`. Without one a rejected promise left the window on
  // an empty list forever with nothing said — indistinguishable from "you have
  // no automations", which is how a broken app looks like a working one.
  const refresh = useCallback(async (select?: string) => {
    try {
      const p = await api.listProjects();
      setProjects(p);
      setSelectedId((current) => select ?? current ?? p[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [composing, setComposing] = useState(false);

  const onNew = useCallback(
    async (name: string, request?: string, dir?: string) => {
      setError(undefined);
      try {
        const created = await api.createProject(name, request, dir);
        if (!created) return;
        // Remembered per project, so the agent's first instruction is the thing
        // the person actually asked for rather than a generic "build something".
        if (created.request) {
          setPendingRequest((prev) => ({ ...prev, [created.id]: created.request! }));
        }
        setComposing(false);
        await refresh(created.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (projectId: string) => {
      setError(undefined);
      try {
        const result = await api.deleteProject(projectId);
        if (result.removed) {
          setSelectedId(undefined);
          await refresh();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [refresh],
  );

  const onImport = useCallback(async () => {
    setError(undefined);
    try {
      const opened = await api.importProject();
      if (opened) await refresh(opened.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh]);

  const [showSettings, setShowSettings] = useState(false);
  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar onSettings={() => setShowSettings((v) => !v)} settingsOpen={showSettings} />
      {composing && (
        <NewAutomation onCreate={onNew} onCancel={() => setComposing(false)} />
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={() => setComposing(true)}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Failures are shown, never swallowed. A dismissible strip rather
              than a modal: it must not block the rest of the window. */}
          {error && (
            <div className="mx-6 mt-4 flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
              <p className="min-w-0 flex-1 text-sm text-destructive" data-selectable>
                {error}
              </p>
              <Button size="sm" variant="ghost" onClick={() => setError(undefined)}>
                Dismiss
              </Button>
            </div>
          )}
          {showSettings ? (
            <SettingsView />
          ) : selected ? (
            <ProjectView
              project={selected}
              request={pendingRequest[selected.id]}
              onDelete={() => void onDelete(selected.id)}
            />
          ) : (
            <EmptyState
              size="page"
              scene={<AutomationGraphScene />}
              title="No automations yet"
              body="Start one from the seed, or open a repo that already has an intelligence.yaml. Studio runs it, keeps it on schedule, and shows you what it did."
              action={
                <Button variant="accent" className="min-h-11" onClick={() => setComposing(true)}>
                  New automation
                </Button>
              }
              secondary={
                <>
                  Everything stays on this machine.{' '}
                  <button
                    type="button"
                    onClick={onImport}
                    className="rounded-full text-accent underline-offset-4 transition-colors hover:underline"
                  >
                    Or open an existing folder
                  </button>
                </>
              }
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────

/**
 * On macOS the window is `titleBarStyle: 'hiddenInset'`, so the traffic lights
 * float over the top-left of our own content. Without an inset they land on top
 * of the logo. 78px clears them at the standard control size.
 */
const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function TitleBar({
  onSettings,
  settingsOpen,
}: {
  onSettings: () => void;
  settingsOpen: boolean;
}) {
  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center justify-between border-b border-border px-4',
        isMac && 'pl-[78px]',
      )}
      style={DRAG}
    >
      {/* The brand lives in the sidebar, under the traffic lights, exactly as
          it does in the platform. This side is just the drag region. */}
      <div className="flex items-center gap-2">
        {isDemo && (
          <span style={NO_DRAG}>
            <Badge tone="warning">sample data</Badge>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground" style={NO_DRAG}>
        {/* Said plainly, and true. It is the product's main promise. */}
        <span>local only · no account</span>
        <Button
          size="sm"
          variant="ghost"
          title="Settings"
          onClick={onSettings}
          className={settingsOpen ? 'text-accent' : undefined}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

function Sidebar({
  projects,
  selectedId,
  onSelect,
  onNew,
}: {
  projects: Project[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border">
      {/* The platform's own brand row: 64px tall, 32px mark, gap-3, hairline
          under it. Sitting directly below the traffic lights, as it does there. */}
      <div className="flex h-16 shrink-0 items-center border-b border-border/50 px-4">
        <BrandLockup />
      </div>

      <div className="flex flex-col gap-1 p-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Automations
        </span>
        <Button size="sm" variant="ghost" title="New automation" onClick={onNew}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onSelect(project.id)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
            project.id === selectedId
              ? 'bg-foreground/[0.06] text-foreground'
              : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
          )}
        >
          <StatusDot status={project.status as Status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {project.runtime === 'docker' ? 'docker' : 'venv'}
          </span>
        </button>
      ))}
      </div>
    </aside>
  );
}

// ── project ──────────────────────────────────────────────────────────────────

function ProjectView({
  project,
  request,
  onDelete,
}: {
  project: Project;
  request?: string;
  onDelete: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [spend, setSpend] = useState({ costMicros: 0, calls: 0 });
  const [openRunId, setOpenRunId] = useState<string | undefined>();
  const [manifest, setManifest] = useState<Record<string, unknown> | undefined>();
  const [codingAgents, setAgents] = useState<AgentInfo[]>([]);
  const [busy, setBusy] = useState<'start' | 'stop' | 'run' | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [tab, setTab] = useState<'flow' | 'runs'>('flow');
  const [latestSteps, setLatestSteps] = useState<Step[]>([]);
  const [latestCalls, setLatestCalls] = useState<LlmCall[]>([]);

  const flow = useMemo(() => (manifest ? toFlow(manifest) : undefined), [manifest]);

  /**
   * The pipeline lights from the most recent run's real checkpoints — the thing
   * the platform's page cannot do, because there the flow is a preview.
   */
  const flowStatus = useMemo(() => {
    const map: Record<string, StepStatus> = {};
    for (const step of latestSteps) {
      map[step.stepId] =
        step.status === 'success'
          ? 'ok'
          : step.status === 'failed'
            ? 'failed'
            : step.status === 'running'
              ? 'running'
              : 'idle';
    }
    return map;
  }, [latestSteps]);

  const load = useCallback(async () => {
    // Settled, not `all`: one unavailable source (no manifest on disk, no
    // coding agent installed) must not blank the whole screen.
    const [r, t, s, m, a] = await Promise.allSettled([
      api.listRuns(project.id),
      api.listTriggers(project.id),
      api.spend(project.id, Date.now() - 7 * 86_400_000),
      api.manifest(project.id),
      api.agents(),
    ]);
    if (r.status === 'fulfilled') {
      setRuns(r.value);
      setOpenRunId((current) => current ?? r.value[0]?.id);
      // The newest run drives the pipeline's lit state.
      const newest = r.value[0];
      setLatestSteps(newest ? await api.listSteps(newest.id).catch(() => []) : []);
      setLatestCalls(newest ? await api.llmCalls(newest.id).catch(() => []) : []);
    }
    if (t.status === 'fulfilled') setTriggers(t.value);
    if (s.status === 'fulfilled') setSpend(s.value);
    if (m.status === 'fulfilled') setManifest(m.value);
    if (a.status === 'fulfilled') setAgents(a.value);
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The point of having the terminal in this window: Claude Code writes a file,
   * and the flow above it redraws. No refresh, no restart.
   */
  useEffect(() => {
    void api.watchProject(project.id);
    const off = api.onProjectChanged((id) => {
      if (id === project.id) void load();
    });
    return () => {
      off();
      api.unwatchProject(project.id);
    };
  }, [project.id, load]);

  const running = project.status === 'running';

  /**
   * Lifecycle actions. Each reports its own failure inline instead of throwing
   * into the void, and refreshes afterwards so the timeline reflects what just
   * happened rather than waiting for a poll.
   */
  const act = useCallback(
    async (what: 'start' | 'stop' | 'run') => {
      setBusy(what);
      setActionError(undefined);
      try {
        if (what === 'start') await api.start(project.id);
        else if (what === 'stop') await api.stop(project.id);
        else await api.runWorkflow(project.id);
        await load();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [project.id, load],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
            <StatusDot status={project.status as Status} className="h-2.5 w-2.5" />
            {project.name}
          </h1>
          <p className="mt-1 truncate text-sm text-muted-foreground" data-selectable>
            {project.path}
            {project.hostPort && running && ` · 127.0.0.1:${project.hostPort}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            disabled={busy !== undefined}
            onClick={() => act(running ? 'stop' : 'start')}
          >
            {busy === 'start' ? 'Starting…' : busy === 'stop' ? 'Stopping…' : running ? 'Stop' : 'Start'}
          </Button>
          {/* The single accent action on this screen. Starts the automation
              first if it is not up — nobody should have to know Start exists. */}
          <Button variant="accent" disabled={busy !== undefined} onClick={() => act('run')}>
            {busy === 'run' ? 'Running…' : 'Run now'}
          </Button>
          <Button variant="ghost" title="Delete automation" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {actionError && (
        <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-destructive" data-selectable>
            {actionError}
          </p>
          <Button size="sm" variant="ghost" onClick={() => setActionError(undefined)}>
            Dismiss
          </Button>
        </div>
      )}

      {project.status === 'crashed' && project.lastError && (
        <Card className="border-l-2 border-l-destructive p-4">
          <p className="text-sm font-semibold text-destructive">This automation did not start</p>
          {/* The SDK's boot errors already name the offending manifest entry,
              so showing it verbatim is more useful than a summary. */}
          <p className="mt-1 font-mono text-xs text-muted-foreground" data-selectable>
            {project.lastError}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline">Rebuild</Button>
            <Button size="sm" variant="ghost">Open logs</Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Runs, 7 days" value={String(runs.length)} />
        <Stat
          label="Spend, 7 days"
          value={formatUsd(spend.costMicros)}
          hint={`${spend.calls} model calls`}
        />
        <Stat
          label="Next run"
          value={nextRunLabel(triggers)}
          hint={triggers.find((t) => t.missedCount > 0) ? 'some windows missed' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.9fr)_minmax(260px,1fr)]">
      <Band
        title={tab === 'flow' ? 'Flow' : 'Executions'}
        subtitle={
          tab === 'flow'
            ? 'What runs, in order, each time it fires.'
            : 'Every run, what it did, and what it cost.'
        }
        action={<Segmented value={tab} onChange={setTab} options={[['flow', 'Flow'], ['runs', 'Executions']]} />}
      >
        {tab === 'flow' ? (
          flow ? (
            <AutomationFlow flow={flow} status={flowStatus} />
          ) : (
            <EmptyState
              size="section"
              title={manifest ? 'No workflow declared' : 'No manifest'}
              body={
                manifest
                  ? 'This automation has an intelligence.yaml, but it declares no workflow to run.'
                  : 'This folder has no intelligence.yaml yet.'
              }
            />
          )
        ) : runs.length === 0 ? (
          <EmptyState
            size="section"
            title="No runs yet"
            body="Press Run now to see what this automation does."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                open={run.id === openRunId}
                onToggle={() => setOpenRunId(run.id === openRunId ? undefined : run.id)}
              />
            ))}
          </div>
        )}
      </Band>

      <aside className="flex flex-col gap-8">
      <Band
        title="Agents"
        subtitle="What is inside, and what each one costs."
      >
        <AgentsBand manifest={manifest} calls={latestCalls} />
      </Band>

      <Band title="Triggers" subtitle="What starts it, without you.">
        {triggers.length === 0 ? (
          <EmptyState
            size="section"
            title="Nothing scheduled"
            body="This automation only runs when you press Run. Give it a schedule and it will run on its own — while Studio is open."
          />
        ) : (
          <Card className="divide-y divide-border">
            {triggers.map((trigger) => (
              <TriggerRow key={trigger.id} trigger={trigger} />
            ))}
          </Card>
        )}
      </Band>
      </aside>
      </div>
        </div>
      </div>

      {/*
        The terminal is docked, not a section in the page.
        It was the last band, so the moment the agent produced any output you
        were scrolled away from the flow it was changing — and the flow redrawing
        live is the whole point of having both in one window. Docked, it stays
        put while the page above it scrolls, and it is collapsible because a
        person reading a run does not always want a shell taking a third of the
        window.
      */}
      <TerminalDock
        projectId={project.id}
        request={request}
        agents={codingAgents}
      />
    </div>
  );
}

/** The bottom dock: always there, collapsible, never scrolls away. */
function TerminalDock({
  projectId,
  request,
  agents,
}: {
  projectId: string;
  request?: string;
  agents: AgentInfo[];
}) {
  const [open, setOpen] = useState(true);
  // Undefined means "whichever is installed first" until a choice is made.
  const [agentId, setAgentId] = useState<string | undefined>();
  const chosen = agentId ?? agents[0]?.id;

  /**
   * Drag the top edge to resize.
   *
   * Clamped: below MIN the terminal is too short to read a prompt in, and above
   * MAX the flow it is meant to be changing is off screen — which is the reason
   * the terminal is docked rather than inline in the first place.
   */
  const MIN = 140;
  const [height, setHeight] = useState(320);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startHeight: height };
      if (!open) setOpen(true);
    },
    [height, open],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // Dragging up grows it, which is why the delta is inverted.
    const next = drag.current.startHeight + (drag.current.startY - e.clientY);
    const max = Math.max(MIN, window.innerHeight - 260);
    setHeight(Math.min(max, Math.max(MIN, next)));
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
  }, []);

  return (
    <div className="shrink-0 border-t border-border bg-background">
      {/* The grab strip. Taller than it looks — a 1px border is a cruel target. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setHeight(320)}
        title="Drag to resize · double-click to reset"
        className="group -mt-1 h-2 w-full cursor-row-resize"
      >
        <div className="mx-auto mt-[3px] h-[3px] w-16 rounded-full bg-border transition-colors group-hover:bg-accent/50" />
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-6 py-2.5 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <TerminalSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">Build it</span>
        <span className="truncate text-xs text-muted-foreground">
          {agents.length > 0
            ? 'runs here, in this folder, signed in as you'
            : 'Write this automation with a coding agent'}
        </span>

        {/* More than one installed is a real choice, so it is offered. One is
            not a choice, so it is not dressed up as one. Switching restarts the
            session — two agents in one folder would fight over the same files. */}
        {agents.length > 1 && (
          <div
            className="ml-auto flex items-center gap-1 rounded-full bg-foreground/[0.05] p-0.5"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setAgentId(agent.id)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                  agent.id === chosen
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {agent.name}
              </button>
            ))}
          </div>
        )}

        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            agents.length > 1 ? 'ml-2' : 'ml-auto',
            open ? '' : '-rotate-90',
          )}
        />
      </button>
      {/* Kept mounted when collapsed: unmounting would kill a live session. */}
      <div className={cn(open ? 'block' : 'hidden')}>
        <TerminalPanel
          projectId={projectId}
          request={request}
          agentId={chosen}
          height={height}
        />
      </div>
    </div>
  );
}

/** An editorial section band — title + subtitle, no card and no icon. */
function Band({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The platform's pill segmented control. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<[T, string]>;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.04] p-1">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
            key === value
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function nextRunLabel(triggers: Trigger[]): string {
  const next = triggers
    .filter((t) => t.enabled && t.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  if (!next?.nextRunAt) return '—';
  const mins = Math.round((next.nextRunAt - Date.now()) / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function TriggerRow({ trigger }: { trigger: Trigger }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <StatusDot status={trigger.enabled ? 'running' : 'stopped'} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{trigger.recipeTriggerId}</p>
        <p className="text-xs text-muted-foreground">{trigger.description}</p>
      </div>
      {trigger.missedCount > 0 && <Badge tone="warning">{trigger.missedCount} missed</Badge>}
      {trigger.type === 'WEBHOOK' && <Badge>webhook</Badge>}
      {trigger.nextRunAt && (
        <span className="text-xs tabular-nums text-muted-foreground">
          in {nextRunLabel([trigger])}
        </span>
      )}
    </div>
  );
}

// ── the run timeline ─────────────────────────────────────────────────────────

function RunRow({ run, open, onToggle }: { run: Run; open: boolean; onToggle: () => void }) {
  const [steps, setSteps] = useState<Step[]>([]);

  useEffect(() => {
    if (open) void api.listSteps(run.id).then(setSteps);
  }, [open, run.id]);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <StatusDot status={run.status as Status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{run.workflowId ?? 'workflow'}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{run.id}</p>
        </div>
        <Badge>{run.triggeredBy}</Badge>
        <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
          {duration(run.startedAt, run.endedAt)}
        </span>
        <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
          {formatUsd(run.costMicros)}
        </span>
        <span className="w-20 text-right text-xs text-muted-foreground">{timeAgo(run.startedAt)}</span>
      </button>

      {open && <Timeline run={run} steps={steps} />}
    </Card>
  );
}

/**
 * A waterfall, not a list.
 *
 * Bars are laid out against the run's own wall-clock span, so where the time
 * actually went is visible at a glance — which is the whole reason to look at a
 * trace rather than read a log.
 */
function Timeline({ run, steps }: { run: Run; steps: Step[] }) {
  const span = useMemo(() => {
    const end = run.endedAt ?? Date.now();
    return Math.max(1, end - run.startedAt);
  }, [run]);

  return (
    <div className="border-t border-border bg-foreground/[0.02] px-4 py-4">
      {steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">No steps were reported for this run.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {steps.map((step) => {
            const offset = ((step.startedAt - run.startedAt) / span) * 100;
            const width = step.endedAt ? Math.max(1.5, ((step.endedAt - step.startedAt) / span) * 100) : 3;
            const failed = step.status !== 'success';
            return (
              <div key={step.stepId} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-xs font-medium">{step.stepId}</span>
                <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-foreground/[0.04]">
                  <div
                    className={cn(
                      'absolute inset-y-0 rounded-md',
                      failed ? 'bg-destructive/70' : 'bg-accent/70',
                    )}
                    style={{ left: `${offset}%`, width: `${width}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {duration(step.startedAt, step.endedAt)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {run.error && (
        <p className="mt-3 font-mono text-[11px] text-destructive" data-selectable>
          {run.error}
        </p>
      )}
      {run.outputs != null && (
        <p className="mt-3 font-mono text-[11px] text-muted-foreground" data-selectable>
          {JSON.stringify(run.outputs)}
        </p>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        {run.promptTokens.toLocaleString()} in / {run.completionTokens.toLocaleString()} out ·{' '}
        {formatUsd(run.costMicros)}
      </p>
    </div>
  );
}

/**
 * The automation's OWN agents — the ones that run when it fires, not the coding
 * agent that writes it. The manifest says what each may touch; the run ledger
 * says what each actually cost. Both are real data; neither is estimated.
 */
function AgentsBand({
  manifest,
  calls,
}: {
  manifest?: Record<string, unknown>;
  calls: LlmCall[];
}) {
  const agents = useMemo(() => {
    const list = (manifest as { agents?: Array<Record<string, unknown>> } | undefined)?.agents ?? [];
    return list.map((a) => ({
      id: String(a.id ?? ''),
      description: typeof a.description === 'string' ? a.description : undefined,
      tools: Array.isArray(a.tools) ? (a.tools as string[]) : [],
      integrations: Array.isArray(a.integrations) ? (a.integrations as string[]) : [],
    }));
  }, [manifest]);

  // Per-agent totals from the last run's ledger.
  const spent = useMemo(() => {
    const acc = new Map<string, { calls: number; costMicros: number; tokens: number }>();
    for (const call of calls) {
      const key = call.agentId ?? '—';
      const prev = acc.get(key) ?? { calls: 0, costMicros: 0, tokens: 0 };
      acc.set(key, {
        calls: prev.calls + 1,
        costMicros: prev.costMicros + call.costMicros,
        tokens: prev.tokens + call.promptTokens + call.completionTokens,
      });
    }
    return acc;
  }, [calls]);

  if (agents.length === 0) {
    return (
      <EmptyState
        size="section"
        title="No agents in this automation"
        body="Every step here is a plain tool call. Add an agent when a step needs judgement rather than a fixed rule."
      />
    );
  }

  return (
    <Card className="divide-y divide-border">
      {agents.map((agent) => {
        const used = spent.get(agent.id);
        return (
          <div key={agent.id} className="flex items-start gap-3 px-4 py-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold text-foreground">{agent.id}</span>
                {agent.integrations.map((id) => (
                  <span
                    key={id}
                    className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300"
                  >
                    {id}
                  </span>
                ))}
              </div>
              {agent.description && (
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{agent.description}</p>
              )}
              {agent.tools.length > 0 && (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                  {agent.tools.join(' · ')}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              {used ? (
                <>
                  <div className="text-sm font-semibold tabular-nums">
                    {formatUsd(used.costMicros)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {used.calls} call{used.calls === 1 ? '' : 's'} · {used.tokens.toLocaleString()} tok
                  </div>
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">not used last run</span>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/**
 * Where a run's model access is configured.
 *
 * Deliberately separate from the terminal: authoring runs on the user's own
 * Claude Code session, this is what the automation itself spends. Keys are
 * written to the OS keyring and never read back into the window — only the last
 * four, which is enough to recognise which key is in there.
 *
 * `baseUrl` is how "bring your own model" works: point a provider at an
 * OpenAI-compatible server (a local one, or your own gateway) and runs go there
 * instead.
 */
function ModelBand() {
  const [providers, setProviders] = useState<ProviderKey[]>([]);
  const [editing, setEditing] = useState<string | undefined>();
  const [value, setValue] = useState('');
  const [field, setField] = useState<'api_key' | 'base_url'>('api_key');
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setProviders(await api.listKeys().catch(() => []));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (id: string) => {
      setError(undefined);
      try {
        await api.setKey(id, field, value.trim());
        setEditing(undefined);
        setValue('');
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [field, value, reload],
  );

  return (
    <div className="flex flex-col gap-2">
      <Card className="divide-y divide-border">
        {providers.map((provider) => (
          <div key={provider.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="text-sm font-semibold capitalize text-foreground">{provider.id}</span>
            {provider.hasKey ? (
              <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                ····{provider.last4}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">no key</span>
            )}
            {provider.baseUrl && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {provider.baseUrl}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(editing === provider.id ? undefined : provider.id);
                  setField('api_key');
                  setValue('');
                }}
              >
                {provider.hasKey ? 'Replace' : 'Add key'}
              </Button>
              {provider.hasKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.removeKey(provider.id, 'api_key');
                    await reload();
                  }}
                >
                  Remove
                </Button>
              )}
            </div>

            {editing === provider.id && (
              <div className="flex w-full flex-col gap-2 pt-1">
                <div className="flex items-center gap-1">
                  {(['api_key', 'base_url'] as const).map((which) => (
                    <button
                      key={which}
                      type="button"
                      onClick={() => setField(which)}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                        which === field
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {which === 'api_key' ? 'API key' : 'Your own endpoint'}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type={field === 'api_key' ? 'password' : 'text'}
                    value={value}
                    autoFocus
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && value.trim()) void save(provider.id);
                      if (e.key === 'Escape') setEditing(undefined);
                    }}
                    placeholder={field === 'api_key' ? 'sk-…' : 'http://localhost:11434/v1'}
                    className="min-w-0 flex-1 rounded-full border border-border bg-background px-3 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={!value.trim()}
                    onClick={() => void save(provider.id)}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </Card>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Stored in this machine&rsquo;s keyring. Runs spend it; the Build-it terminal never does.
      </p>
    </div>
  );
}

/**
 * Starting an automation.
 *
 * In the window, not in a Finder save panel. The native panel asked "where
 * should this file go", offered a Tags field that means nothing here, and left
 * no room for the only question worth asking — which is what the thing should
 * do. That sentence becomes the coding agent's opening instruction, so it is
 * the first field, not an afterthought.
 *
 * Location is a default, not a prompt: ~/Automations/<name>, changeable for
 * people who care and invisible to people who do not.
 */
function NewAutomation({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, request?: string, dir?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [dir, setDir] = useState<string | undefined>();
  const [root, setRoot] = useState('~/Automations');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Show the real destination, not a guess — the folder is a setting now.
  useEffect(() => {
    void api
      .getSettings()
      .then((s2) => setRoot(s2.automationsRoot))
      .catch(() => undefined);
  }, []);

  const create = useCallback(async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(name, request.trim() || undefined, dir);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [name, request, dir, busy, onCreate]);

  return (
    // Escape closes; a click on the scrim does not, because a half-typed brief
    // is easy to lose and annoying to retype.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-10 backdrop-blur-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="mt-16 w-full max-w-lg rounded-3xl border border-border bg-background p-6 shadow-2xl">
        <h2 className="text-lg font-semibold tracking-tight">New automation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Say what it should do and Claude Code starts on exactly that.
        </p>

        <label className="mt-5 block text-xs font-medium text-muted-foreground">
          What should it do?
        </label>
        <textarea
          value={request}
          autoFocus
          rows={3}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="Every Monday, email me last week's signups grouped by source."
          className="mt-1.5 w-full resize-none rounded-2xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent"
        />

        <label className="mt-4 block text-xs font-medium text-muted-foreground">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          placeholder="signup-digest"
          className="mt-1.5 w-full rounded-full border border-border bg-background px-3.5 py-2 font-mono text-[13px] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-accent"
        />

        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="truncate font-mono">
            {(dir ?? root)}/{slugify(name) || '…'}
          </span>
          <button
            type="button"
            onClick={async () => {
              const picked = await api.chooseFolder();
              if (picked) setDir(picked);
            }}
            className="rounded-full text-accent underline-offset-4 hover:underline"
          >
            Change
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!name.trim() || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Mirrors the slug the main process derives, so the preview is the real path. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Settings. Machine-wide, which is why it is not on a project screen: a key is
 * stored once (`provider:*:…`) and every automation on this machine uses it, so
 * showing it per-automation implied a per-automation setting that never existed.
 */
function SettingsView() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 p-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything here stays on this machine.
        </p>
      </header>

      <Band
        title="Library"
        subtitle="Where new automations are created. Existing ones keep the folder they are already in."
      >
        <AutomationsFolder />
      </Band>

      <Band
        title="Model"
        subtitle="What your automations call when they run. A hosted provider's key, or your own model."
      >
        <ModelBand />
      </Band>

      <Band
        title="Using a local model"
        subtitle="Anything speaking the OpenAI chat-completions API works. Point OpenAI at its address and runs go there instead."
      >
        <LocalModelHelp />
      </Band>
    </div>
  );
}

/** The servers people actually run, and the one call Studio makes to them. */
const LOCAL_SERVERS: Array<{ name: string; url: string; note: string }> = [
  { name: 'Ollama', url: 'http://localhost:11434/v1', note: 'ollama serve' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1', note: 'Local Server tab' },
  { name: 'vLLM', url: 'http://localhost:8000/v1', note: 'vllm serve <model>' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1', note: 'llama-server' },
];

function LocalModelHelp() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="divide-y divide-border">
        {LOCAL_SERVERS.map((server) => (
          <div key={server.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="w-24 shrink-0 text-sm font-semibold text-foreground">
              {server.name}
            </span>
            <code className="font-mono text-[12px] text-accent" data-selectable>
              {server.url}
            </code>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground/80">
              {server.note}
            </span>
          </div>
        ))}
      </Card>

      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          Studio sends exactly this — no proprietary fields, so any compatible server answers it:
        </p>
        {/* The real request shape, so it can be checked with curl before trusting a run. */}
        <pre
          className="overflow-x-auto rounded-2xl border border-border bg-foreground/[0.03] p-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground"
          data-selectable
        >
{`POST {your-endpoint}/chat/completions
Authorization: Bearer {key, or anything if your server ignores it}
Content-Type: application/json

{
  "model": "llama3.1:8b",
  "messages": [{ "role": "user", "content": "…" }],
  "tools": [ … ]            // only when the agent has tools
}

→ { "choices": [ { "message": { "role": "assistant", "content": "…" } } ],
    "usage": { "prompt_tokens": 0, "completion_tokens": 0 } }`}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Set the endpoint above under <span className="text-foreground">Openai → Your own
          endpoint</span>, and put the model id in your manifest. A server that ignores the
          Authorization header needs no key at all — the run precheck accepts an endpoint on its
          own.
        </p>
      </div>
    </div>
  );
}

/**
 * Where new automations are created.
 *
 * Changing it moves nothing: automations already in the library keep their own
 * paths, because relocating somebody's folders on a preference change would be
 * a surprise, and an irreversible one. It is the default for what comes next.
 */
function AutomationsFolder() {
  const [root, setRoot] = useState<string | undefined>();

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => setRoot(s.automationsRoot))
      .catch(() => undefined);
  }, []);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" data-selectable>
          {root ?? '…'}
        </code>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const picked = await api.chooseAutomationsRoot();
            if (picked) setRoot(picked);
          }}
        >
          Change
        </Button>
      </div>
    </Card>
  );
}
