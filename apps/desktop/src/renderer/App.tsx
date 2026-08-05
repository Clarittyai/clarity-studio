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
import {
  Bell,
  Check,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderOpen,
  Home,
  Plus,
  Send,
  Settings,
  Sparkles,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

import {
  api,
  isDemo,
  type AgentInfo,
  type LlmCall,
  type IntegrationState,
  type Project,
  type ProviderKey,
  type Run,
  type Step,
  type Trigger,
} from './api.js';
import { BrandLockup } from './components/Brand.js';
import { AutomationFlow, type StepStatus } from './components/flow/AutomationFlow.js';
import { toFlow } from './components/flow/blocks.js';
import { AgentAvatar } from './components/live/AgentAvatar.js';
import { AutomationGraphScene } from './components/live/AutomationGraphScene.js';
import { CONTRIBUTE } from './components/cloud-links.js';
import { CloudShowcase } from './components/CloudShowcase.js';
import { REQUEST_INTEGRATION, TerminalPanel } from './components/Terminal.js';
import {
  Badge,
  Button,
  Card,
  duration,
  EmptyState,
  formatTokens,
  StatusDot,
  tildePath,
  timeAgo,
  timeUntil,
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
      // No `?? p[0]?.id`: opening an automation is a click, so Home is where
      // you land and the dashboard is actually reachable.
      setSelectedId((current) => select ?? current);
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
        setView('project');
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
          setView('home');
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

  /**
   * The screen, named. It used to be inferred from `selectedId` and
   * `showSettings` through chained ternaries — which is exactly how Home ended
   * up unreachable: a project was auto-selected on load, so the Home branch
   * could never be taken.
   */
  const [view, setView] = useState<'home' | 'project' | 'settings'>('home');
  const [version, setVersion] = useState<string | undefined>();

  useEffect(() => {
    void api
      .appVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  const selected = projects.find((p) => p.id === selectedId);

  const openProject = useCallback((id: string) => {
    setSelectedId(id);
    setView('project');
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar
        onSettings={() => setView((v) => (v === 'settings' ? 'home' : 'settings'))}
        settingsOpen={view === 'settings'}
      />
      {composing && (
        <NewAutomation onCreate={onNew} onCancel={() => setComposing(false)} />
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          selectedId={selectedId}
          onSelect={openProject}
          onNew={() => setComposing(true)}
          onHome={() => setView('home')}
          atHome={view === 'home'}
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
          {view === 'settings' ? (
            <SettingsView version={version} />
          ) : view === 'project' && selected ? (
            <ProjectView
              project={selected}
              request={pendingRequest[selected.id]}
              onDelete={() => void onDelete(selected.id)}
              onRenamed={() => void refresh()}
            />
          ) : projects.length > 0 ? (
            <HomeView projects={projects} onSelect={openProject} onNew={() => setComposing(true)} />
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
  onHome,
  atHome,
}: {
  projects: Project[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onHome: () => void;
  atHome: boolean;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border">
      {/* The platform's own brand row: 64px tall, 32px mark, gap-3, hairline
          under it. Sitting directly below the traffic lights, as it does there. */}
      <div className="flex h-16 shrink-0 items-center border-b border-border/50 px-4">
        <BrandLockup />
      </div>

      {/* Home is pinned above the list and separated from it: it is a place,
          not one of the automations. */}
      <div className="flex flex-col gap-1 p-3 pb-0">
        <button
          type="button"
          onClick={onHome}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
            atHome
              ? 'bg-foreground/[0.06] text-foreground'
              : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
          )}
        >
          <Home className="h-4 w-4 shrink-0" />
          <span className="text-[13px] font-medium">Home</span>
        </button>
      </div>

      <div className="mx-3 my-3 border-t border-border/60" />

      <div className="flex flex-col gap-1 px-3 pb-3">
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
  onRenamed,
}: {
  project: Project;
  request?: string;
  onDelete: () => void;
  /** Refresh the library so the sidebar shows the new name too. */
  onRenamed: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [spend, setSpend] = useState({ costMicros: 0, calls: 0 });
  const [openRunId, setOpenRunId] = useState<string | undefined>();
  const [manifest, setManifest] = useState<Record<string, unknown> | undefined>();
  const [codingAgents, setAgents] = useState<AgentInfo[]>([]);
  const [inspecting, setInspecting] = useState<
    { id: string; description?: string; tools: string[]; integrations: string[] } | undefined
  >();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
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

  const commitRename = useCallback(async () => {
    const next = draftName.trim();
    setRenaming(false);
    // Nothing to do, and no reason to write: an unchanged name is not an edit.
    if (!next || next === project.name) {
      setDraftName(project.name);
      return;
    }
    try {
      await api.renameProject(project.id, next);
      onRenamed();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      setDraftName(project.name);
    }
  }, [draftName, project.id, project.name, onRenamed]);

  /** What the last seven days of runs actually consumed. */
  const runTokens = useMemo(
    () => runs.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0),
    [runs],
  );

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
            {/* Click the title to rename. Editing in place beats a dialog for a
                single field, and the folder on disk is untouched — see the
                handler for why the label and the path are separate things. */}
            {renaming ? (
              <input
                value={draftName}
                autoFocus
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename();
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setDraftName(project.name);
                  }
                }}
                className="min-w-0 flex-1 rounded-lg border border-accent bg-background px-2 py-0.5 text-2xl font-bold tracking-tight outline-none"
              />
            ) : (
              <button
                type="button"
                title="Rename"
                onClick={() => {
                  setDraftName(project.name);
                  setRenaming(true);
                }}
                className="truncate rounded-lg px-1 text-left transition-colors hover:bg-foreground/[0.05]"
              >
                {project.name}
              </button>
            )}
          </h1>
          <p className="mt-1 truncate text-sm text-muted-foreground" data-selectable>
            {tildePath(project.path)}
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
          label="Tokens, 7 days"
          value={formatTokens(runTokens)}
          hint={`${spend.calls} model calls`}
        />
        <Stat
          label="Next run"
          value={nextRunLabel(triggers)}
          hint={triggers.find((t) => t.missedCount > 0) ? 'some windows missed' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
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
        title="Connections"
        subtitle="The services it uses — connect once, reused every run."
      >
        <ConnectionsBand manifest={manifest} projectId={project.id} />
      </Band>

      <Band
        title="Agents"
        subtitle="What is inside, and how many tokens each one used."
      >
        <AgentsBand manifest={manifest} calls={latestCalls} onOpen={setInspecting} />
      </Band>

      <Band title="How to reach you" subtitle="Where a finished run finds you.">
        <NotifyBand projectId={project.id} />
      </Band>

      <Band title="Triggers" subtitle="What starts it, without you.">
        {triggers.length === 0 ? (
          <EmptyState
            size="section"
            title="Nothing scheduled"
            body="This automation only runs when you press Run. Give it a schedule and it will run on its own — while Studio is open."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {triggers.map((trigger) => (
              <TriggerRow key={trigger.id} trigger={trigger} />
            ))}
          </div>
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
      {inspecting && (
        <AgentInspector
          projectId={project.id}
          agent={inspecting}
          onClose={() => setInspecting(undefined)}
        />
      )}

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
    <div className="flex items-center gap-3 py-3">
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

/**
 * A run where every step skipped is not a success, whatever status the engine
 * recorded. The invoice-digest simulation skipped three of four steps —
 * `gmail_not_connected` — and still reported `✓ workflow succeeded`, which on a
 * schedule means an automation that looks healthy for a week while doing
 * nothing. The engine's verdict is kept, but the timeline says what happened.
 */
function effectiveStatus(run: Run, steps: Step[]): { status: Status; note?: string } {
  if (steps.length > 0 && steps.every((s) => s.status === 'skipped')) {
    return { status: 'skipped', note: 'every step skipped — nothing ran' };
  }
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  if (run.status === 'success' && skipped > 0) {
    return { status: 'skipped', note: `${skipped} step${skipped === 1 ? '' : 's'} skipped` };
  }
  return { status: run.status as Status };
}

function RunRow({ run, open, onToggle }: { run: Run; open: boolean; onToggle: () => void }) {
  const [steps, setSteps] = useState<Step[]>([]);

  // Loaded whether or not the row is open: the row's own status depends on the
  // steps, and it is a local SQLite read.
  useEffect(() => {
    void api
      .listSteps(run.id)
      .then(setSteps)
      .catch(() => undefined);
  }, [run.id]);

  const verdict = useMemo(() => effectiveStatus(run, steps), [run, steps]);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="-mx-2 flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <StatusDot status={verdict.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {run.workflowId ?? 'workflow'}
            {verdict.note && (
              <span className="ml-2 font-normal text-warning">{verdict.note}</span>
            )}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{run.id}</p>
        </div>
        <Badge>{run.triggeredBy}</Badge>
        <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
          {duration(run.startedAt, run.endedAt)}
        </span>
        <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
          {formatTokens(run.promptTokens + run.completionTokens)}
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
      {/* In and out separately: they are priced differently everywhere and a
          run that is mostly output behaves nothing like one that is mostly
          input, which a single total hides. */}
      <p className="mt-3 text-[11px] text-muted-foreground">
        {run.promptTokens.toLocaleString()} in / {run.completionTokens.toLocaleString()} out ·{' '}
        {formatTokens(run.promptTokens + run.completionTokens)} total
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
  onOpen,
}: {
  manifest?: Record<string, unknown>;
  calls: LlmCall[];
  onOpen: (agent: {
    id: string;
    description?: string;
    tools: string[];
    integrations: string[];
  }) => void;
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
    const acc = new Map<string, { calls: number; tokens: number }>();
    for (const call of calls) {
      const key = call.agentId ?? '—';
      const prev = acc.get(key) ?? { calls: 0, tokens: 0 };
      acc.set(key, {
        calls: prev.calls + 1,
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
    <div className="divide-y divide-border/60">
      {agents.map((agent) => {
        const used = spent.get(agent.id);
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onOpen(agent)}
            className="-mx-2 flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
          >
            {/* The same face the canvas and the showcase draw for this agent —
                AgentAvatar is a pure function of the seed, so an agent looks
                like itself everywhere. A generic sparkle made every agent
                identical, which is the opposite of a team. */}
            <AgentAvatar seed={agent.id} size={28} className="mt-0.5" />
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
                <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
                  {agent.description}
                </p>
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
                    {formatTokens(used.tokens)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    tokens · {used.calls} call{used.calls === 1 ? '' : 's'}
                  </div>
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">not used last run</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
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
      <div className="divide-y divide-border/60">
        {providers.map((provider) => (
          <div key={provider.id} className="flex flex-wrap items-center gap-3 py-3">
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
      </div>
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
            {tildePath(dir ?? root)}/{slugify(name) || '…'}
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
function SettingsView({ version }: { version?: string }) {
  return (
    // The scroll wrapper Home has and this was missing: `main` is
    // `overflow-hidden` so each view owns its own scrolling, and without this
    // everything below the fold was simply unreachable.
    <div className="min-h-0 flex-1 overflow-y-auto">
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

      {/* Which build this is. A packaged .app is a snapshot — it does not track
          the source it was built from — so "I am looking at an old version" has
          to be answerable without guessing. */}
      <p className="text-xs text-muted-foreground">
        Claritty Studio {version ?? '—'}
      </p>
      </div>
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
      <div className="divide-y divide-border/60">
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
      </div>

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
    <div className="border-y border-border/60">
      <div className="flex flex-wrap items-center gap-3 py-3">
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" data-selectable>
          {root ? tildePath(root) : '…'}
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
    </div>
  );
}

/**
 * Home.
 *
 * What is actually true on this machine first — how many automations, what they
 * ran, what it cost — because a dashboard that leads with promotion is an
 * advert with a chart on it. The hosted product is mentioned underneath, and
 * only mentioned: nothing here is fetched, so an offline Studio shows the same
 * page as an online one.
 */
function HomeView({
  projects,
  onSelect,
  onNew,
}: {
  projects: Project[];
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [totals, setTotals] = useState({ runs: 0, tokens: 0, failures: 0 });
  const [nextRunAt, setNextRunAt] = useState<number | undefined>();
  /** Per project: its most recent run, for the row's status line. */
  const [lastRun, setLastRun] = useState<Record<string, Run | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const since = Date.now() - 7 * 86_400_000;
      let runs = 0;
      let tokens = 0;
      let failures = 0;
      let soonest: number | undefined;
      const latest: Record<string, Run | undefined> = {};

      for (const project of projects) {
        const list = await api.listRuns(project.id).catch(() => []);
        latest[project.id] = list[0];
        for (const run of list) {
          if (run.startedAt < since) continue;
          runs += 1;
          tokens += run.promptTokens + run.completionTokens;
          if (run.status === 'failed') failures += 1;
        }
        // "Is anything going to happen without me" is the question a dashboard
        // for scheduled work has to answer.
        const triggers = await api.listTriggers(project.id).catch(() => []);
        for (const trigger of triggers) {
          if (!trigger.enabled || !trigger.nextRunAt) continue;
          if (soonest === undefined || trigger.nextRunAt < soonest) soonest = trigger.nextRunAt;
        }
      }

      if (cancelled) return;
      setTotals({ runs, tokens, failures });
      setNextRunAt(soonest);
      setLastRun(latest);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  /**
   * Anything broken sorts to the top. A dashboard that hides the failed run
   * under alphabetical order is decoration.
   */
  const ordered = useMemo(() => {
    const rank = (p: Project) =>
      p.status === 'crashed' || lastRun[p.id]?.status === 'failed' ? 0 : 1;
    return [...projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [projects, lastRun]);

  const running = projects.filter((p) => p.status === 'running').length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* `min-h-full` + `mt-auto` on the last line: the footnote belongs at the
          bottom of the pane, not floating a third of the way up it with dead
          space underneath. */}
      <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-10 p-8">
        <CloudShowcase />

        <header>
          <h1 className="text-2xl font-bold tracking-tight">Your automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything here runs on this machine, with your keys.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Automations" value={String(projects.length)} hint={`${running} running`} />
          <Stat label="Runs, 7 days" value={String(totals.runs)} />
          <Stat label="Tokens, 7 days" value={formatTokens(totals.tokens)} />
          <Stat
            label="Failed"
            value={String(totals.failures)}
            hint={totals.failures > 0 ? 'check the timeline' : 'all clean'}
          />
          <Stat
            label="Next run"
            value={nextRunAt ? timeUntil(nextRunAt) : '—'}
            hint={nextRunAt ? 'while Studio is open' : 'nothing scheduled'}
          />
        </div>

        <Band title="Automations" subtitle="What is on this machine.">
          {projects.length === 0 ? (
            <EmptyState
              size="section"
              title="Nothing yet"
              body="Start one from the seed and Claude Code writes it for you."
              action={
                <Button variant="accent" className="min-h-11" onClick={onNew}>
                  New automation
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-border/60">
              {ordered.map((project) => {
                const run = lastRun[project.id];
                const broken = project.status === 'crashed' || run?.status === 'failed';
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => onSelect(project.id)}
                    className="-mx-2 flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
                  >
                    <StatusDot status={project.status as Status} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold">{project.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {run
                            ? `last run ${run.status} · ${timeAgo(run.startedAt)}`
                            : 'never run'}
                        </span>
                      </div>
                      {/* The reason, in the place you would look for it. */}
                      {broken && (project.lastError ?? run?.error) && (
                        <p className="mt-0.5 truncate font-mono text-[11px] text-destructive">
                          {project.lastError ?? run?.error}
                        </p>
                      )}
                    </div>
                    <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {project.runtime === 'docker' ? 'docker' : 'venv'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Band>

        {/* The showcase at the top does the telling now. This is the honest
            footnote under it, plus the way in for anyone who wants to help. */}
        <p className="mt-auto pt-2 text-xs text-muted-foreground">
          The showcase above opens your browser. Studio itself still talks to nobody —{' '}
          <button
            type="button"
            onClick={() => api.openExternal(CONTRIBUTE.repo)}
            className="rounded-full text-accent underline-offset-4 hover:underline"
          >
            it is open source, come and read it
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => api.openExternal(CONTRIBUTE.issues)}
            className="rounded-full text-accent underline-offset-4 hover:underline"
          >
            report an issue
          </button>
          .
        </p>
      </div>
    </div>
  );
}

/**
 * Connections — the services this automation needs, and what can be done here.
 *
 * Every integration is meant to be connectable HERE, with the user's own
 * credentials, in this panel. That is the product: local, no account, no
 * hosted middleman. Nothing in this file should ever send someone to the cloud
 * to connect something.
 *
 * Today `@clarity-studio/connectors` ships specs for nine of them, so the other
 * rows say what they are waiting on rather than pretending. The old panel
 * printed `clarity-studio connect gmail` — a command with no connector behind
 * it — and a run then skipped every Gmail step while reporting success.
 *
 * A row is one of three things, and never a button that cannot work:
 *   connected      ✓ and Disconnect
 *   connectable    Connect, opening a form built from the connector's own
 *                  `howToConnect` sentence and typed `fields[]`
 *   not yet wired  named honestly, with a link to add its connector — the fix
 *                  is a catalog entry in this repo, not a subscription
 */
function ConnectionsBand({
  manifest,
  projectId,
}: {
  manifest?: Record<string, unknown>;
  projectId: string;
}) {
  const declared = useMemo(() => {
    const list =
      (manifest as { integrations?: Array<{ id?: string } | string> } | undefined)?.integrations ??
      [];
    return list.map((i) => (typeof i === 'string' ? i : (i.id ?? ''))).filter(Boolean);
  }, [manifest]);

  const [rows, setRows] = useState<IntegrationState[]>([]);
  const [editing, setEditing] = useState<string | undefined>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    if (declared.length === 0) {
      setRows([]);
      return;
    }
    setRows(await api.integrationStatus(projectId, declared).catch(() => []));
  }, [projectId, declared]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (row: IntegrationState) => {
      setError(undefined);
      try {
        await api.connectIntegration(projectId, row.id, values);
        setEditing(undefined);
        setValues({});
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [projectId, values, reload],
  );

  if (declared.length === 0) {
    return (
      <EmptyState
        size="section"
        title="No outside services"
        body="This automation only uses its own tools, so there is nothing to connect."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border/60">
        {rows.map((row) => (
          <div key={row.id} className="py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-[11px] font-bold uppercase text-muted-foreground">
                {row.id.slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold capitalize text-foreground">{row.name}</div>
                {row.connected ? (
                  <div className="flex items-center gap-1 text-[11px] text-success">
                    <Check className="h-3 w-3" strokeWidth={3} />
                    Connected
                  </div>
                ) : row.local ? (
                  <div className="text-[11px] text-warning">Not connected</div>
                ) : (
                  <div className="text-[11px] text-muted-foreground">
                    No local connector yet — it needs a spec in
                    <span className="font-mono"> packages/connectors</span>
                  </div>
                )}
              </div>

              {row.connected ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.disconnectIntegration(projectId, row.id);
                    await reload();
                  }}
                >
                  Disconnect
                </Button>
              ) : row.local ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(editing === row.id ? undefined : row.id);
                    setValues({});
                    setError(undefined);
                  }}
                >
                  Connect
                </Button>
              ) : (
                /* Not an upsell. The honest action is "help add it", because
                   connecting locally is the whole point of this app. */
                /* The agent is already open in this window, in this project,
                   with the skill that knows the connector's shape. Asking it to
                   write the request beats opening a browser tab. */
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => api.writeTerminal(projectId, `${REQUEST_INTEGRATION}\r`)}
                >
                  Ask Claude for it
                </Button>
              )}
            </div>

            {editing === row.id && (
              <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                {/* The connector's own sentence, verbatim. It knows where the
                    token lives; no paraphrase of mine would be better. */}
                {row.howToConnect && (
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    {row.howToConnect}
                  </p>
                )}
                {row.fields.map((field) => (
                  <label key={field.key} className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {field.label}
                    </span>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      value={values[field.key] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      className="w-full rounded-full border border-border bg-background px-3 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                    />
                  </label>
                ))}
                <div className="flex justify-end gap-2 pt-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={row.fields.every((f) => !values[f.key]?.trim())}
                    onClick={() => void save(row)}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        Credentials go to this machine&rsquo;s keyring, scoped to this automation.
      </p>
    </div>
  );
}

/**
 * How to reach you.
 *
 * The platform's version offers Slack, Email, Telegram and WhatsApp plus an
 * "Ask me first / Just do it" gate. Studio offers the subset it can actually
 * deliver, and names the rest as hosted rather than showing buttons that do
 * nothing — the same rule the Connections panel now follows.
 *
 * Desktop is the honest default: no connection, no account, nothing leaves the
 * machine. Slack is genuinely available because it is one of the nine local
 * connectors. The rest need the hosted version.
 *
 * "Ask me first" is deliberately absent. The runtime already stubs `mode: write`
 * steps in a dry run and executes them on approval, so the machinery exists —
 * but holding a run and resuming it is runtime work, not a panel, and a toggle
 * that silently does nothing is worse than no toggle.
 */
function NotifyBand({ projectId }: { projectId: string }) {
  const [prefs, setPrefs] = useState<{ desktop?: boolean; slack?: boolean }>({ desktop: true });
  const [note, setNote] = useState<string | undefined>();

  useEffect(() => {
    void api
      .getNotify(projectId)
      .then(setPrefs)
      .catch(() => undefined);
  }, [projectId]);

  const update = useCallback(
    async (next: { desktop?: boolean; slack?: boolean }) => {
      const merged = { ...prefs, ...next };
      setPrefs(merged);
      await api.setNotify(projectId, merged).catch(() => undefined);
    },
    [prefs, projectId],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border/60">
        <button
          type="button"
          onClick={() => void update({ desktop: !prefs.desktop })}
          className="-mx-2 flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
        >
          <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">This computer</div>
            <div className="text-[11px] text-muted-foreground">
              A desktop notification when a run finishes or fails.
            </div>
          </div>
          <span
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition-colors',
              prefs.desktop ? 'bg-accent' : 'bg-foreground/15',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
                prefs.desktop ? 'left-[18px]' : 'left-0.5',
              )}
            />
          </span>
        </button>

        <div className="flex items-center gap-3 py-3">
          <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">Slack</div>
            <div className="text-[11px] text-muted-foreground">
              Connect Slack above and a run can post its result to a channel.
            </div>
          </div>
        </div>

        {/* Named, not hidden: knowing why something is missing beats
            wondering. And the fix is a connector in this repo, not an account. */}
        <div className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-muted-foreground">
              Email · Telegram · WhatsApp
            </div>
            <div className="text-[11px] text-muted-foreground">
              Once each has a local connector, a run can reach you there too.
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => api.openExternal(CONTRIBUTE.issues)}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            Request it
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            setNote(undefined);
            try {
              await api.testNotify('Claritty Studio', 'This is what a finished run looks like.');
              setNote('Sent. If nothing appeared, allow notifications for Claritty Studio.');
            } catch (cause) {
              setNote(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          Send a test
        </Button>
        {/* macOS asks on first send, so silence is expected once and confusing
            forever after if nothing says so. */}
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}

/**
 * An agent's behaviour, editable.
 *
 * This is the answer to "I cannot specify how the agent behaves". The manifest
 * points each agent at a `prompt_file`, so its instructions are a file on disk:
 * Studio can edit them without owning them, the coding agent in the dock sees
 * the same bytes, and git records the change. Putting the behaviour in a
 * database instead would give an agent two sources of truth.
 *
 * What it may touch — tools and integrations — is shown but not editable here.
 * Those are structural: changing them means changing the workflow that calls the
 * agent, which is the manifest's business and the flow's.
 */
function AgentInspector({
  projectId,
  agent,
  onClose,
}: {
  projectId: string;
  agent: { id: string; description?: string; tools: string[]; integrations: string[] };
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [path, setPath] = useState<string | undefined>();
  const [inline, setInline] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [docs, setDocs] = useState<Array<{ name: string; bytes: number }>>([]);

  useEffect(() => {
    void api
      .readAgent(projectId, agent.id)
      .then((found) => {
        setText(found?.text ?? '');
        setPath(found?.path);
        setInline(found?.inline ?? false);
      })
      .catch(() => undefined);
    void api
      .listKnowledge(projectId)
      .then(setDocs)
      .catch(() => undefined);
  }, [projectId, agent.id]);

  const save = useCallback(async () => {
    if (!path) return;
    await api.writeAgent(projectId, path, text);
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }, [projectId, path, text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-8 backdrop-blur-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !dirty) onClose();
      }}
    >
      <div className="mt-10 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-3xl border border-border bg-background">
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <AgentAvatar seed={agent.id} size={34} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">{agent.id}</h2>
            {agent.description && (
              <p className="truncate text-[12px] text-muted-foreground">{agent.description}</p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Behaviour</span>
              {path && <span className="font-mono text-[11px] text-muted-foreground/70">{path}</span>}
              {saved && <span className="text-[11px] text-success">saved</span>}
            </div>
            {inline ? (
              /* An inline prompt lives in the manifest, and editing YAML through
                 a textarea is how a manifest gets corrupted. */
              <p className="rounded-2xl border border-border p-4 text-[12.5px] text-muted-foreground">
                This agent&rsquo;s prompt is inline in <span className="font-mono">intelligence.yaml</span>.
                Move it to a <span className="font-mono">prompt_file</span> to edit it here.
              </p>
            ) : (
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
                rows={14}
                spellCheck={false}
                placeholder="Tell it what to do, what to leave alone, and what to return."
                className="w-full resize-y rounded-2xl border border-border bg-foreground/[0.02] p-4 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent"
              />
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold text-muted-foreground">
              What it may touch
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.length === 0 && agent.integrations.length === 0 && (
                <span className="text-[12px] text-muted-foreground">
                  Nothing — it reasons over what earlier steps hand it.
                </span>
              )}
              {agent.integrations.map((id) => (
                <span
                  key={id}
                  className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
                >
                  {id}
                </span>
              ))}
              {agent.tools.map((id) => (
                <span
                  key={id}
                  className="rounded-md bg-foreground/[0.06] px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {id}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Set by the workflow that calls it — change those in the flow, not here.
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Knowledge</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const added = await api.addKnowledge(projectId);
                  if (added > 0) setDocs(await api.listKnowledge(projectId));
                }}
              >
                Add documents
              </Button>
            </div>
            {docs.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                Nothing yet. Files added here are copied into the automation, so it still runs on
                another machine.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {docs.map((doc) => (
                  <div key={doc.name} className="flex items-center gap-2 py-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{doc.name}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.max(1, Math.round(doc.bytes / 1024))} KB
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Reference them by name in the behaviour above; the agent reads them at run time.
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {dirty && <span className="mr-auto text-[11px] text-warning">unsaved changes</span>}
          <Button variant="ghost" onClick={onClose}>
            {dirty ? 'Discard' : 'Close'}
          </Button>
          <Button variant="accent" disabled={!dirty || inline} onClick={() => void save()}>
            Save
          </Button>
        </footer>
      </div>
    </div>
  );
}
