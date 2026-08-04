/**
 * Clarity Studio — the window.
 *
 * Two screens for now: the Launchpad, and a project. The project screen leads
 * with the run timeline rather than with settings, because the question people
 * actually arrive with is "what did it do, and what did it cost" — not "how is
 * it configured".
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Plus, Sparkles } from 'lucide-react';

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

  const onNew = useCallback(async () => {
    setError(undefined);
    try {
      const created = await api.createProject();
      if (created) await refresh(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh]);

  const onImport = useCallback(async () => {
    setError(undefined);
    try {
      const opened = await api.importProject();
      if (opened) await refresh(opened.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh]);

  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={onNew}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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
          {selected ? (
            <ProjectView project={selected} />
          ) : (
            <EmptyState
              size="page"
              scene={<AutomationGraphScene />}
              title="No automations yet"
              body="Start one from the seed, or open a repo that already has an intelligence.yaml. Studio runs it, keeps it on schedule, and shows you what it did."
              action={
                <Button variant="accent" className="min-h-11" onClick={onNew}>
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

function TitleBar() {
  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center justify-between border-b border-border px-4',
        isMac && 'pl-[78px]',
      )}
      style={DRAG}
    >
      {/* Mark + wordmark, at the platform's own proportions. The badge opts out
          of the drag region so it stays clickable. */}
      <div className="flex items-center gap-2">
        <BrandLockup />
        {isDemo && (
          <span style={NO_DRAG}>
            <Badge tone="warning">sample data</Badge>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {/* Said plainly, and true. It is the product's main promise. */}
        <span>local only · no account</span>
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
    <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-border p-3">
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
    </aside>
  );
}

// ── project ──────────────────────────────────────────────────────────────────

function ProjectView({ project }: { project: Project }) {
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
    <div className="mx-auto flex max-w-4xl flex-col gap-8 p-8">
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

      <Band
        title="Agents"
        subtitle="The ones inside this automation — what they are allowed to touch, and what they actually cost."
      >
        <AgentsBand manifest={manifest} calls={latestCalls} />
      </Band>

      <Band
        title="Model"
        subtitle="What the agents in this automation call when it runs. Your own key, or your own endpoint."
      >
        <ModelBand />
      </Band>

      <Band
        title="Build it"
        subtitle={
          codingAgents.length > 0
            ? `${codingAgents.map((a) => a.name).join(' or ')} runs here, in this folder, with the project's own instructions already loaded.`
            : 'Write this automation with a coding agent, in the project folder.'
        }
      >
        <TerminalPanel projectId={project.id} />
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
