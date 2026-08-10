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
  type NotifyPrefs,
  type NotifyState,
} from './api.js';
import { BrandLockup } from './components/Brand.js';
import { AutomationFlow, type StepStatus } from './components/flow/AutomationFlow.js';
import { toFlow, type Flow } from './components/flow/blocks.js';
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
  humanError,
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
      setError(humanError(cause));
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
        setError(humanError(cause));
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
        setError(humanError(cause));
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
      setError(humanError(cause));
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
              onOpenSettings={() => setView('settings')}
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
  onOpenSettings,
}: {
  project: Project;
  request?: string;
  onDelete: () => void;
  /** Refresh the library so the sidebar shows the new name too. */
  onRenamed: () => void;
  /** Accounts are connected once, in Settings — this is how you get there from
   *  the automation that turned out to need one. */
  onOpenSettings: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [spend, setSpend] = useState({ costMicros: 0, calls: 0 });
  const [openRunId, setOpenRunId] = useState<string | undefined>();
  const [manifest, setManifest] = useState<Record<string, unknown> | undefined>();
  const [codingAgents, setAgents] = useState<AgentInfo[]>([]);
  const [asking, setAsking] = useState(false);
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

  /**
   * Still the untouched example.
   *
   * The seed ships as `my-automation`, and an agent that has not written yet
   * leaves it that way. Without saying so, Studio draws a complete, plausible
   * automation the person did not ask for — and they reasonably read the agent
   * below as working on it.
   *
   * Keyed on the manifest id rather than a file hash: the id is the first thing
   * any real build replaces, and a hash would go stale the moment someone
   * touched a comment.
   */
  /**
   * When the flow last actually changed.
   *
   * The redraw is instant and therefore easy to miss: you ask the agent for a
   * step, glance down at the terminal, and by the time you look up the diagram
   * has quietly become the new one. This is the difference between "it works"
   * and "I can see that it worked".
   *
   * Undefined after a few seconds, because a permanent badge stops being read.
   */
  const [changedAt, setChangedAt] = useState<number | undefined>();
  /** The last manifest we drew, serialised. Undefined until the first load, so
   *  opening a project never counts as a change. */
  const lastManifest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!changedAt) return;
    const timer = setTimeout(() => setChangedAt(undefined), 6000);
    return () => clearTimeout(timer);
  }, [changedAt]);

  const isUntouchedExample = (manifest as { id?: string } | undefined)?.id === 'my-automation';

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
    if (m.status === 'fulfilled') {
      // Compare, don't just assign. The watcher fires for every file in the
      // folder — a .pyc, a log, the agent's own scratch — and flashing
      // "updated" at each one teaches the person to ignore it, which costs the
      // signal exactly when the manifest really does change.
      //
      // The comparison is held in a ref rather than derived inside the state
      // updater: React may invoke an updater during render, and calling another
      // setState from there is how a badge silently never appears.
      const serialised = JSON.stringify(m.value ?? null);
      if (lastManifest.current !== undefined && lastManifest.current !== serialised) {
        setChangedAt(Date.now());
      }
      lastManifest.current = serialised;
      setManifest(m.value);
    }
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
      setActionError(humanError(cause));
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
    async (what: 'start' | 'stop' | 'run', inputs?: Record<string, unknown>) => {
      setBusy(what);
      setActionError(undefined);
      try {
        if (what === 'start') await api.start(project.id);
        else if (what === 'stop') await api.stop(project.id);
        else await api.runWorkflow(project.id, flow?.workflowId, inputs);
        await load();
      } catch (cause) {
        setActionError(humanError(cause));
      } finally {
        setBusy(undefined);
      }
    },
    [project.id, load, flow?.workflowId],
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
          <Button
            variant="accent"
            disabled={busy !== undefined}
            // A workflow that declares inputs gets asked for them. One that
            // declares none runs straight away — a dialog with nothing in it is
            // a step for its own sake.
            onClick={() => (flow?.inputs.length ? setAsking(true) : void act('run'))}
          >
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
        action={
          <div className="flex items-center gap-2">
            {changedAt && tab === 'flow' && (
              <span
                data-updated-badge
                className="flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Updated
              </span>
            )}
            <Segmented value={tab} onChange={setTab} options={[['flow', 'Flow'], ['runs', 'Executions']]} />
          </div>
        }
      >
        {tab === 'flow' ? (
          flow ? (
            <div className="flex flex-col gap-4">
              {/* Say when this is still the example. Otherwise a diagram of
                  somebody else's daily-digest reads as YOUR automation, and the
                  agent talking below it looks like it is working on this — the
                  one case where an unchanged screen means nothing happened
                  rather than nothing needed to. */}
              {isUntouchedExample && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-warning/10 px-3 py-2 text-[12px] text-warning">
                  <span className="font-semibold">This is still the example.</span>
                  <span className="text-warning/80">
                    Nothing has been built yet — ask below, and this diagram becomes yours.
                  </span>
                </div>
              )}
              <AutomationFlow flow={flow} status={flowStatus} />
            </div>
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
        <ConnectionsBand manifest={manifest} projectId={project.id} onOpenSettings={onOpenSettings} />
      </Band>

      <Band
        title="Agents"
        subtitle="What is inside, and how many tokens each one used."
      >
        <AgentsBand manifest={manifest} calls={latestCalls} onOpen={setInspecting} />
      </Band>

      <Band title="How to reach you" subtitle="Where a finished run finds you.">
        <NotifyBand projectId={project.id} onOpenSettings={onOpenSettings} />
      </Band>

      <Band title="Triggers" subtitle="What starts it, without you.">
        {triggers.length === 0 ? (
          <EmptyState
            size="section"
            title="Nothing scheduled"
            body="This automation declares no trigger. Add one to intelligence.yaml and it appears here, ready to switch on."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {triggers.map((trigger) => (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                onToggle={async (on) => {
                  await api.enableTrigger(trigger.id, on).catch(() => undefined);
                  await load();
                }}
              />
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
      {asking && flow && (
        <RunInputs
          flow={flow}
          onCancel={() => setAsking(false)}
          onRun={(inputs: Record<string, unknown>) => {
            setAsking(false);
            void act('run', inputs);
          }}
        />
      )}

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
   * Every automation whose terminal has been opened, in visit order. Nothing is
   * removed: a session you walked away from is still working, and its panel is
   * what holds the scrollback.
   */
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    setSeen((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
  }, [projectId]);

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
      {/* One panel per automation you have opened, all kept mounted — the same
          reason collapsing hides rather than unmounts. Switching automations
          used to change `projectId` on a single panel, whose effect cleanup
          killed the previous session and threw away its scrollback. Now the
          panel for each automation simply stops being visible. */}
      <div className={cn(open ? 'block' : 'hidden')}>
        {seen.map((id) => (
          <div key={id} className={cn(id === projectId ? 'block' : 'hidden')}>
            <TerminalPanel
              projectId={id}
              request={id === projectId ? request : undefined}
              agentId={chosen}
              height={height}
            />
          </div>
        ))}
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

/**
 * One trigger, and the switch that arms it.
 *
 * Instances arrive disabled — Studio creates them from the manifest, and an
 * automation that began running on a schedule because you opened it would be
 * your machine doing work you never asked for. So this switch is the moment a
 * schedule becomes real, and it should feel like one.
 */
function TriggerRow({ trigger, onToggle }: { trigger: Trigger; onToggle: (on: boolean) => void }) {
  return (
    <div data-trigger className="flex items-center gap-3 py-3">
      <StatusDot status={trigger.enabled ? 'running' : 'stopped'} />
      <div className="min-w-0 flex-1">
        {/* The automation's own name for it, falling back to the id only when it
            declared none — a slug in the UI means a key is showing through. */}
        <p className="truncate text-sm font-medium">{trigger.name || trigger.recipeTriggerId}</p>
        <p className="text-xs text-muted-foreground">
          {trigger.description}
          {!trigger.enabled && ' — off'}
        </p>
      </div>
      {trigger.missedCount > 0 && <Badge tone="warning">{trigger.missedCount} missed</Badge>}
      {trigger.type === 'WEBHOOK' && <Badge>webhook</Badge>}
      {trigger.enabled && trigger.nextRunAt && (
        <span className="text-xs tabular-nums text-muted-foreground">
          in {nextRunLabel([trigger])}
        </span>
      )}
      <button
        type="button"
        title={trigger.enabled ? 'Turn this schedule off' : 'Turn this schedule on'}
        onClick={() => onToggle(!trigger.enabled)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          trigger.enabled ? 'bg-accent' : 'bg-foreground/15',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
            trigger.enabled ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
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
          /* Same as the Home list: the rule is the row's, not the button's. */
          <div key={agent.id} className="py-0.5">
          <button
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
          </div>
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
  /** What is stored, and what is being typed. Kept apart so the row can say
   *  whether there are unsaved edits without re-reading settings on every key. */
  const [override, setOverride] = useState('');
  const [draft, setDraft] = useState('');

  const reload = useCallback(async () => {
    setProviders(await api.listKeys().catch(() => []));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        setOverride(s.modelOverride);
        setDraft(s.modelOverride);
      })
      .catch(() => {});
  }, []);

  const saveOverride = useCallback(async (next: string) => {
    setError(undefined);
    try {
      const stored = await api.setModelOverride(next);
      setOverride(stored);
      setDraft(stored);
    } catch (cause) {
      setError(humanError(cause));
    }
  }, []);

  const save = useCallback(
    async (id: string) => {
      setError(undefined);
      try {
        await api.setKey(id, field, value.trim());
        setEditing(undefined);
        setValue('');
        await reload();
      } catch (cause) {
        setError(humanError(cause));
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

      {/* Without this, the manifest is the only thing that decides, so an
          automation someone else wrote against Claude cannot be run on your own
          key or your own machine without editing their file. */}
      <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-foreground">Run everything on</span>
          {override ? (
            <span className="rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">
              {override}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">each automation&rsquo;s own model</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveOverride(draft);
              if (e.key === 'Escape') setDraft(override);
            }}
            placeholder="claude-haiku-4-5 · gpt-4o-mini · ollama/llama3.1:8b"
            className="min-w-0 flex-1 rounded-full border border-border bg-background px-3 py-1.5 font-mono text-[12px] text-foreground outline-none focus:border-accent"
          />
          <Button
            size="sm"
            variant="accent"
            disabled={draft.trim() === override}
            onClick={() => void saveOverride(draft)}
          >
            Save
          </Button>
          {override && (
            <Button size="sm" variant="ghost" onClick={() => void saveOverride('')}>
              Clear
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Overrides the model each <code className="font-mono text-[11px]">intelligence.yaml</code>{' '}
          asks for, from the next run. Leave it empty to let every automation choose its own. The id
          also picks the provider, so it is how you move a run onto your own machine:{' '}
          <code className="font-mono text-[11px]">claude…</code> and{' '}
          <code className="font-mono text-[11px]">gpt-…</code> use the keys above,{' '}
          <code className="font-mono text-[11px]">ollama/…</code> needs no key at all.
        </p>
      </div>
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
      setError(humanError(cause));
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
        title="Connections"
        subtitle="Your accounts, set once and used by every automation. Each is stored in this machine's keyring and never leaves it."
      >
        <ConnectionsSettings />
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
          endpoint</span>, then name the model — either in the automation&rsquo;s manifest, or once
          for everything in <span className="text-foreground">Run everything on</span> above. The id
          is also what routes the call, so it needs the provider&rsquo;s prefix:{' '}
          <code className="font-mono text-[11px]">openai/llama3.1:8b</code> goes to the endpoint you
          set here, and the prefix is stripped before the request is sent. A bare{' '}
          <code className="font-mono text-[11px]">llama3.1:8b</code> matches no provider and the run
          stops before it starts.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          For Ollama specifically there is nothing to configure: use{' '}
          <code className="font-mono text-[11px]">ollama/llama3.1:8b</code> and it goes to{' '}
          <code className="font-mono text-[11px]">127.0.0.1:11434/v1</code> with no key. A server
          that ignores the Authorization header needs no key either — the run precheck accepts an
          endpoint on its own.
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
  /**
   * Whether this machine has a coding agent at all.
   *
   * `undefined` until we know — the difference between "no agent" and "not
   * asked yet" matters, because rendering the warning during the first frame
   * and then removing it is worse than waiting a beat.
   */
  const [hasAgent, setHasAgent] = useState<boolean | undefined>();

  useEffect(() => {
    void api
      .agents()
      .then((found) => setHasAgent(found.length > 0))
      // A detection failure is not proof of absence, and telling someone to
      // install software they already have is worse than saying nothing.
      .catch(() => setHasAgent(true));
  }, []);

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
        {/* Said here, on the screen you land on, because without one of these
            the central loop does not work: you describe an automation and
            something writes it. Until now this was only discoverable inside the
            terminal, after creating an automation — by which point the person
            has done the work and found out it was pointless. */}
        {hasAgent === false && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-warning/10 px-4 py-3">
            <TerminalSquare className="h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-warning">
                No coding agent found on this machine
              </p>
              <p className="text-[12px] text-warning/80">
                Studio has an agent write your automations. Install Claude Code or Codex, then
                reopen Studio. Everything else works without one — you would just be writing the
                Python yourself.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 whitespace-nowrap"
              onClick={() => api.openExternal('https://claude.com/claude-code')}
            >
              Install Claude Code
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 whitespace-nowrap"
              onClick={() => api.openExternal('https://developers.openai.com/codex/cli')}
            >
              Codex
            </Button>
          </div>
        )}

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
                  /* The divider belongs to the LIST, not to the button. With
                     `divide-y` on the wrapper the line was the button's own top
                     border, so it followed the button's `rounded-xl` and lifted
                     into a curve at both ends — and `-mx-2` pushed those ends
                     past the column. The row carries the rule; the button keeps
                     its rounded hover. */
                  <div key={project.id} className="py-0.5">
                  <button
                    type="button"
                    onClick={() => onSelect(project.id)}
                    /* The hover band matches the divider exactly: same left
                       and right edge, no radius. `w-full` with a negative
                       margin does not widen an element, it offsets it — which
                       hung the band past the list on one side and short on the
                       other. */
                    className="flex w-full items-start gap-3 py-3 text-left transition-colors hover:bg-foreground/[0.04]"
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
                  </div>
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
/**
 * Every service Studio can connect, set once for the machine.
 *
 * Connecting an account is not part of building an automation. You have one
 * Slack workspace and one bot token; being asked for it again inside each
 * automation is how the same credential ends up stored five times and rotated
 * in one. So this list is the whole catalog, it writes machine-wide, and an
 * automation simply uses what is already here.
 *
 * Per-automation credentials still exist and still take precedence — the vault
 * resolves the specific over the general — they are just no longer the thing
 * you are asked for first.
 */
function ConnectionsSettings() {
  const [rows, setRows] = useState<IntegrationState[]>([]);
  const [editing, setEditing] = useState<string | undefined>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setRows(await api.allIntegrations().catch(() => []));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (row: IntegrationState) => {
      setError(undefined);
      try {
        // '*' is machine-wide. Every automation reads it.
        await api.connectIntegration('*', row.id, values);
        setEditing(undefined);
        setValues({});
        await reload();
      } catch (cause) {
        setError(humanError(cause));
      }
    },
    [values, reload],
  );

  const connectedCount = rows.filter((r) => r.connected).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border/60">
        {rows.map((row) => {
          const open = editing === row.id;
          return (
            /* `data-connector` is the handle the app check uses to open one
               specific row's form; text-matching a row picked up its ancestors. */
            <div key={row.id} data-connector={row.id} className="py-3">
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
                  ) : (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {row.fields.map((f) => f.label).join(' · ')}
                    </div>
                  )}
                </div>

                {row.connected && !open && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.disconnectIntegration('*', row.id);
                      await reload();
                    }}
                  >
                    Disconnect
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={row.connected ? 'ghost' : 'outline'}
                  onClick={() => {
                    setEditing(open ? undefined : row.id);
                    setValues({});
                    setError(undefined);
                  }}
                >
                  {open ? 'Cancel' : row.connected ? 'Replace' : 'Connect'}
                </Button>
              </div>

              {open && (
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
                  <div className="flex justify-end pt-1">
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
          );
        })}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        {connectedCount === 0
          ? 'Nothing connected yet. An automation that needs one of these will say so.'
          : `${connectedCount} connected. Every automation on this machine can use them.`}
      </p>
    </div>
  );
}

function ConnectionsBand({
  manifest,
  projectId,
  onOpenSettings,
}: {
  manifest?: Record<string, unknown>;
  projectId: string;
  onOpenSettings: () => void;
}) {
  const declared = useMemo(() => {
    const list =
      (manifest as { integrations?: Array<{ id?: string } | string> } | undefined)?.integrations ??
      [];
    return list.map((i) => (typeof i === 'string' ? i : (i.id ?? ''))).filter(Boolean);
  }, [manifest]);

  const [rows, setRows] = useState<IntegrationState[]>([]);

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

  if (declared.length === 0) {
    return (
      <EmptyState
        size="section"
        title="No outside services"
        body="This automation only uses its own tools, so there is nothing to connect."
      />
    );
  }

  const missing = rows.filter((r) => !r.connected && r.local);

  return (
    <div className="flex flex-col gap-3">
      <div className="divide-y divide-border/60">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3 py-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.06] text-[11px] font-bold uppercase text-muted-foreground">
              {row.id.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold capitalize text-foreground">{row.name}</div>
              {row.connected ? (
                <div className="flex items-center gap-1 text-[11px] text-success">
                  <Check className="h-3 w-3" strokeWidth={3} />
                  {/* Where it came from, because that is where it is changed. */}
                  {row.shared ? 'Connected in Settings' : 'Connected for this automation'}
                </div>
              ) : row.local ? (
                <div className="text-[11px] text-warning">
                  Not connected — steps that use it will be skipped
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  No connector yet — it needs a spec in
                  <span className="font-mono"> packages/connectors</span>
                </div>
              )}
            </div>

            {/* No form here. Connecting an account is an account-level act and
                lives in one place; an automation only reports what it needs.
                The one exception is a service nothing implements yet, where the
                useful action is writing the connector — and the agent that can
                is already open in this window, in this project, with the skill
                that knows the shape. */}
            {!row.connected && !row.local && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => api.writeTerminal(projectId, `${REQUEST_INTEGRATION}\r`)}
              >
                Ask Claude for it
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {missing.length > 0
            ? `${missing.length} still to connect.`
            : 'Set once, shared by every automation.'}
        </p>
        <Button
          size="sm"
          variant={missing.length > 0 ? 'accent' : 'outline'}
          className="shrink-0 whitespace-nowrap"
          onClick={onOpenSettings}
        >
          {missing.length > 0 ? 'Connect' : 'Manage'}
        </Button>
      </div>
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
/** One switch. Disabled channels say why rather than looking broken. */
function ChannelRow({
  icon,
  name,
  hint,
  on,
  available,
  unavailableHint,
  onToggle,
  children,
  testId,
}: {
  icon: React.ReactNode;
  name: string;
  hint: string;
  on: boolean;
  available: boolean;
  unavailableHint?: string;
  onToggle: () => void;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-channel={testId} className="py-3">
      <button
        type="button"
        disabled={!available}
        onClick={onToggle}
        className={cn(
          '-mx-2 flex w-full items-center gap-3 rounded-xl px-2 py-1 text-left transition-colors',
          available ? 'hover:bg-foreground/[0.03]' : 'cursor-default',
        )}
      >
        <span className={cn('shrink-0', available ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-semibold', available ? 'text-foreground' : 'text-muted-foreground')}>
            {name}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {available ? hint : (unavailableHint ?? hint)}
          </div>
        </div>
        <span
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            !available ? 'bg-foreground/10' : on ? 'bg-accent' : 'bg-foreground/15',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full transition-all',
              available ? 'bg-white' : 'bg-white/40',
              on && available ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </span>
      </button>
      {on && available && children && <div className="mt-2 flex flex-col gap-2 pl-7">{children}</div>}
    </div>
  );
}

function ChannelInput({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-[12px] outline-none focus:border-accent"
      />
    </label>
  );
}

function NotifyBand({
  projectId,
  onOpenSettings,
}: {
  projectId: string;
  onOpenSettings: () => void;
}) {
  const [state, setState] = useState<NotifyState>({
    prefs: { desktop: true },
    available: { desktop: true, slack: false, telegram: false, whatsapp: false, email: false },
    lastDelivery: [],
  });
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    const next = await api.getNotify(projectId).catch(() => undefined);
    if (next) setState(next);
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(
    async (next: NotifyPrefs) => {
      const prefs = { ...state.prefs, ...next };
      setState((prev) => ({ ...prev, prefs }));
      await api.setNotify(projectId, prefs).catch(() => undefined);
    },
    [state.prefs, projectId],
  );

  const { prefs, available } = state;
  const failed = state.lastDelivery.filter((d) => !d.ok);
  const anyChannel = Boolean(prefs.slack || prefs.telegram || prefs.whatsapp || prefs.email);

  return (
    <div className="flex flex-col gap-3">
      <div className="divide-y divide-border/60">
        <ChannelRow
          testId="desktop"
          icon={<Bell className="h-4 w-4" />}
          name="This computer"
          hint="A desktop notification when a run finishes or fails."
          unavailableHint="This system does not support desktop notifications."
          on={prefs.desktop !== false}
          available={available.desktop}
          onToggle={() => void update({ desktop: prefs.desktop === false })}
        />

        <ChannelRow
          testId="slack"
          icon={<Send className="h-4 w-4" />}
          name="Slack"
          hint="Post the result to a channel."
          unavailableHint="Connect Slack in Settings to use this."
          on={Boolean(prefs.slack)}
          available={available.slack}
          onToggle={() => void update({ slack: !prefs.slack })}
        >
          <ChannelInput
            label="Channel"
            value={prefs.slackChannel ?? ''}
            placeholder="#automations"
            onCommit={(slackChannel) => void update({ slackChannel })}
          />
        </ChannelRow>

        <ChannelRow
          testId="telegram"
          icon={<Send className="h-4 w-4" />}
          name="Telegram"
          hint="Message you from your bot."
          unavailableHint="Connect Telegram in Settings to use this."
          on={Boolean(prefs.telegram)}
          available={available.telegram}
          onToggle={() => void update({ telegram: !prefs.telegram })}
        />

        <ChannelRow
          testId="whatsapp"
          icon={<Send className="h-4 w-4" />}
          name="WhatsApp"
          hint="Message your own number, through your Meta app."
          unavailableHint="Connect WhatsApp in Settings to use this."
          on={Boolean(prefs.whatsapp)}
          available={available.whatsapp}
          onToggle={() => void update({ whatsapp: !prefs.whatsapp })}
        />

        <ChannelRow
          testId="email"
          icon={<Send className="h-4 w-4" />}
          name="Email"
          hint="Send it through Resend, with your own key."
          unavailableHint="Connect Resend in Settings to use this."
          on={Boolean(prefs.email)}
          available={available.email}
          onToggle={() => void update({ email: !prefs.email })}
        >
          <ChannelInput
            label="To"
            value={prefs.emailTo ?? ''}
            placeholder="you@example.com"
            onCommit={(emailTo) => void update({ emailTo })}
          />
          {/* Resend refuses a from-address on a domain you have not verified,
              so this is asked for rather than guessed at. */}
          <ChannelInput
            label="From (a verified Resend domain)"
            value={prefs.emailFrom ?? ''}
            placeholder="runs@yourdomain.com"
            onCommit={(emailFrom) => void update({ emailFrom })}
          />
        </ChannelRow>
      </div>

      {/* A send that failed is the one thing you must not have to go looking
          for, since not having to look was the point of the channel. */}
      {failed.length > 0 && (
        <p className="text-xs text-destructive">
          Last send failed on {failed.map((f) => f.channel).join(', ')}: {failed[0]?.error}
        </p>
      )}

      {/* The button must never be the thing that gives way. In a 380px column a
          `justify-between` row with three lines of prose starved it to 55px and
          broke "Send a test" across three lines. Short copy, and a button that
          refuses to shrink or wrap. */}
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          {available.slack || available.telegram || available.whatsapp || available.email
            ? 'A run reports through every channel switched on.'
            : 'Only this computer for now. Add a channel in Settings.'}
        </p>
        {anyChannel || available.desktop ? (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 whitespace-nowrap"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              // The same delivery path a finished run uses. A test that took a
              // different path would prove nothing about the real one.
              await api.sendTestNotify(projectId).catch(() => undefined);
              await reload();
              setSending(false);
            }}
          >
            {sending ? 'Sending…' : 'Send a test'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 whitespace-nowrap"
            onClick={onOpenSettings}
          >
            Connect one
          </Button>
        )}
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

/**
 * What you tell a run.
 *
 * `/api/workflows/{id}/execute` takes `inputs`, and the engine binds them to
 * `${inputs.x}` — so this is the only channel a person has for communicating
 * with a running automation. Studio used to send `{}` every time, which meant
 * a workflow declaring inputs could only ever run on its defaults.
 *
 * Only the keys the workflow declares. Free-form keys would let someone type a
 * name nothing binds and watch the run ignore it.
 */
function RunInputs({
  flow,
  onRun,
  onCancel,
}: {
  flow: Flow;
  onRun: (inputs: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = flow.inputs.filter((i) => i.required && !values[i.key]?.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-10 backdrop-blur-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="mt-20 w-full max-w-md rounded-3xl border border-border bg-background p-6">
        <h2 className="text-lg font-semibold tracking-tight">Run {flow.workflowId}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What this run should work with. Left empty, the workflow uses its own defaults.
        </p>

        <div className="mt-5 flex flex-col gap-3">
          {flow.inputs.map((input, i) => (
            <label key={input.key} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {input.key}
                {input.type && <span className="ml-1 opacity-60">{input.type}</span>}
                {input.required && <span className="ml-1 text-warning">required</span>}
              </span>
              <input
                autoFocus={i === 0}
                value={values[input.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [input.key]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && missing.length === 0) onRun(coerce(values));
                }}
                className="w-full rounded-full border border-border bg-background px-3.5 py-2 font-mono text-[12.5px] outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="accent" disabled={missing.length > 0} onClick={() => onRun(coerce(values))}>
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A field is text, but an input may not be. `24` bound as "24" makes a step
 * comparing numbers behave oddly for reasons nobody can see in the timeline, so
 * anything that parses as JSON is sent as JSON and everything else stays a
 * string.
 */
function coerce(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const text = raw.trim();
    if (!text) continue;
    try {
      out[key] = JSON.parse(text);
    } catch {
      out[key] = text;
    }
  }
  return out;
}
