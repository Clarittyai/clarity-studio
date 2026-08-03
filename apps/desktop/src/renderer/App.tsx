/**
 * Claritty Studio — the window.
 *
 * Two screens for now: the Launchpad, and a project. The project screen leads
 * with the run timeline rather than with settings, because the question people
 * actually arrive with is "what did it do, and what did it cost" — not "how is
 * it configured".
 */

import { useEffect, useMemo, useState } from 'react';

import { api, isDemo, type Project, type Run, type Step, type Trigger } from './api.js';
import {
  Badge,
  Button,
  Card,
  duration,
  EmptyState,
  formatUsd,
  Section,
  StatusDot,
  timeAgo,
  cn,
  type Status,
} from './components/ui.js';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  useEffect(() => {
    void api.listProjects().then((p) => {
      setProjects(p);
      setSelectedId((current) => current ?? p[0]?.id);
    });
  }, []);

  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full flex-col bg-background">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar projects={projects} selectedId={selectedId} onSelect={setSelectedId} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <ProjectView project={selected} />
          ) : (
            <div className="p-10">
              <EmptyState
                title="No automations yet"
                body="Create one from the seed, or import a repo that already has an intelligence.yaml. Studio will run it, schedule it, and show you what it did."
                action={<Button variant="accent">New automation</Button>}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────

function TitleBar() {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
        <span className="text-[13px] font-semibold tracking-tight">Claritty Studio</span>
        {isDemo && <Badge tone="warning">sample data</Badge>}
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
}: {
  projects: Project[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-1 border-r border-border p-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Automations
        </span>
        <Button size="sm" variant="ghost" title="New automation">
          +
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

  useEffect(() => {
    void api.listRuns(project.id).then((r) => {
      setRuns(r);
      setOpenRunId(r[0]?.id);
    });
    void api.listTriggers(project.id).then(setTriggers);
    void api.spend(project.id, Date.now() - 7 * 86_400_000).then(setSpend);
  }, [project.id]);

  const running = project.status === 'running';

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
          <Button variant="outline">{running ? 'Stop' : 'Start'}</Button>
          {/* The single accent action on this screen. */}
          <Button variant="accent">Run now</Button>
        </div>
      </header>

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

      <Section title="Triggers">
        {triggers.length === 0 ? (
          <EmptyState
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
      </Section>

      <Section title="Runs">
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" body="Press Run now to see what this automation does." />
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
      </Section>
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
