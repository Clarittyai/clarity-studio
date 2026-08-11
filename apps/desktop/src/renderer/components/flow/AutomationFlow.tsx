/**
 * The automation pipeline, in the platform's language.
 *
 * Ported from `clarity-platform/src/components/automations/AutomationFlow.tsx`:
 * a vertical rail with 34px numbered nodes, 340px step cards carrying a 3px left
 * accent bar, a Clock trigger node with an uppercase eyebrow, and provider
 * badges. Geometry and classes are kept identical so Studio and app.claritty.ai
 * read as one product.
 *
 * One simplification, and it is a data difference rather than a shortcut: the
 * platform routes orthogonal connectors because a recorder automation can fork
 * two ways. A manifest workflow is a straight sequence, so every connector is
 * vertical — which is a single rail behind the column. The platform's
 * `ring-[5px] ring-background` on each node is what punches the rail out around
 * the circles, and it does the same job here.
 *
 * Unlike the platform's page, this one can be driven by a REAL run: pass
 * `status` per step id and the pipeline lights from actual checkpoints rather
 * than from a preview.
 */

import { Ban, Check, Clock, Globe, Loader2, Sparkles, Webhook, X } from 'lucide-react';

import { cn } from '../ui.js';
import type { Flow, FlowStep, Tier } from './blocks.js';

/**
 * Includes `failed`, which the platform's union has no need for: its page is a
 * preview/approval surface, whereas a Studio run genuinely fails.
 *
 * And `blocked` — a step the engine recorded as SKIPPED but carrying an error,
 * which means it tried and could not. That is not the same as a step that has
 * not run, and drawing it as `idle` claimed the run had not reached it when in
 * fact it had reached it and stopped there. It is almost always the step that
 * does the actual work, so the diagram showed a plain numbered circle for the
 * exact failure someone opened it to find.
 *
 * Same rule as `run-verdict.ts`: a skip with NO error is a conditional gate
 * that correctly did not fire, and stays `idle`.
 */
export type StepStatus = 'idle' | 'running' | 'ok' | 'failed' | 'blocked';

/** Provider tier → the word shown on the badge. */
const TIER_WORD: Record<Tier, string> = {
  integration: 'Connect',
  vision: 'Browser',
  platform: 'Built-in',
  mcp: 'MCP',
  agent: 'Built-in',
};

/** Provider tier → badge tone. Semantic and dark-aware, as upstream. */
const TIER_TONE: Record<Tier, string> = {
  integration: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  vision: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  platform: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  mcp: 'bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  agent: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

export function AutomationFlow({
  flow,
  status = {},
}: {
  flow: Flow;
  /** Keyed by step id. Absent ids read as `idle`. */
  status?: Record<string, StepStatus>;
}) {
  return (
    <div className="relative flex flex-col items-center">
      {/* The rail. Behind everything; the nodes' background rings hide it where
          it would otherwise cross a circle. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-4 top-4 z-0 w-px bg-border"
      />

      {flow.trigger && (
        <>
          <Node ring="accent">
            {flow.trigger.kind === 'WEBHOOK' ? (
              <Webhook className="h-4 w-4" />
            ) : (
              <Clock className="h-4 w-4" />
            )}
          </Node>
          <Gap />
          {/* `bg-background` under the tint, not the tint alone: the rail runs
              behind the column, and a translucent card let it show straight
              through the middle of the text. Upstream connects anchor to anchor
              so nothing ever crosses a card; an opaque base gets the same
              result without the routing. */}
          <div className="relative z-[1] w-full max-w-[340px] overflow-hidden rounded-2xl border border-accent/25 bg-background py-3 pl-4 pr-3.5">
            <span aria-hidden className="absolute inset-0 bg-accent/[0.05]" />
            <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
            <div className="relative text-[10px] font-bold uppercase tracking-[0.09em] text-accent">
              Trigger
            </div>
            <div className="relative text-sm font-semibold text-foreground">
              {flow.trigger.label}
            </div>
          </div>
        </>
      )}

      {flow.steps.map((step, i) => (
        <div key={step.id} className="flex w-full flex-col items-center">
          <Gap />
          <Node status={status[step.id] ?? 'idle'}>{i + 1}</Node>
          <Gap />
          <div className="w-full max-w-[340px]">
            <StepCard step={step} status={status[step.id] ?? 'idle'} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The 14px breathing room between rail elements, as upstream. */
function Gap() {
  return <div className="h-3.5" />;
}

function Node({
  children,
  status = 'idle',
  ring,
}: {
  children: React.ReactNode;
  status?: StepStatus;
  ring?: 'accent';
}) {
  return (
    <div
      className={cn(
        'relative z-[1] grid h-[34px] w-[34px] place-items-center rounded-full text-[13px] font-bold tabular-nums ring-[5px] ring-background transition-colors',
        ring === 'accent' && 'border-[1.5px] border-accent/40 bg-accent/10 text-accent',
        !ring && status === 'ok' && 'bg-accent text-accent-foreground',
        !ring && status === 'running' && 'bg-accent/15 text-accent',
        !ring && status === 'failed' && 'bg-destructive text-white',
        // Amber, not red: the step did not fail, it never got to run. Red would
        // send someone hunting for a bug inside a step that never executed.
        !ring && status === 'blocked' && 'bg-amber-500 text-white',
        !ring && status === 'idle' && 'border border-border bg-background text-muted-foreground',
      )}
    >
      {status === 'ok' ? (
        <Check className="h-4 w-4" strokeWidth={3} />
      ) : status === 'running' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : status === 'failed' ? (
        <X className="h-4 w-4" strokeWidth={3} />
      ) : status === 'blocked' ? (
        <Ban className="h-4 w-4" strokeWidth={2.5} />
      ) : (
        children
      )}
    </div>
  );
}

function StepCard({ step, status }: { step: FlowStep; status: StepStatus }) {
  const violet = step.isAgent;
  return (
    <div
      className={cn(
        // Opaque base so the rail cannot show through the card. The tint is a
        // layer on top of it rather than the background itself.
        'relative z-[1] w-full overflow-hidden rounded-2xl border bg-background py-3 pl-4 pr-3.5 transition-colors',
        status === 'failed'
          ? 'border-destructive/40'
          : status === 'blocked'
            ? 'border-amber-500/40'
            : violet
              ? 'border-violet-500/25'
              : 'border-border',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0',
          status === 'failed'
            ? 'bg-destructive/[0.06]'
            : status === 'blocked'
              ? 'bg-amber-500/[0.06]'
              : violet
                ? 'bg-violet-500/[0.05]'
                : 'bg-foreground/[0.02]',
        )}
      />
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[3px]',
          status === 'failed'
            ? 'bg-destructive'
            : status === 'blocked'
              ? 'bg-amber-500'
              : violet
                ? 'bg-violet-500'
                : 'bg-accent',
        )}
      />

      <div className="relative flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-sm font-semibold text-foreground">{step.action}</span>

        {/* This step runs once per item. The single most important thing about a
            loop, and a flow that omits it makes 50 messages look like one. */}
        {step.forEach && (
          <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            once per {step.forEach}
            {step.maxIterations ? <span className="opacity-60"> · max {step.maxIterations}</span> : null}
          </span>
        )}

        {/* WHERE it runs, on the step that runs there. */}
        {step.site && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Globe className="h-3 w-3" />
            {step.site}
          </span>
        )}

        {step.detail && <span className="text-[12.5px] text-muted-foreground">{step.detail}</span>}

        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold',
            TIER_TONE[step.tier],
          )}
        >
          {step.provider ?? (step.isAgent ? 'AI' : 'Tool')}
          <span className="font-normal opacity-60">· {TIER_WORD[step.tier]}</span>
        </span>

        {/* It changes something outside the automation. */}
        {step.writes && (
          <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Write
          </span>
        )}

        {/* Where Claritty decides on the data, or reasons over it. */}
        {step.intelligence && (
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-violet-700 dark:text-violet-300">
            <Sparkles className="h-3 w-3" strokeWidth={2.4} />
            {step.intelligence.kind === 'decides' ? 'Claritty decides' : 'Claritty reasons'}
          </span>
        )}
      </div>

      {/* The target itself — a URL is worth its own line, not a truncated chip. */}
      {step.target && (
        <p className="relative mt-1.5 truncate font-mono text-[12px] text-muted-foreground/90" data-selectable>
          {step.target}
        </p>
      )}

      {/* The "why it is intelligent": what it actually decides, in plain words. */}
      {step.intelligence?.explains && (
        <p className="relative mt-1.5 flex items-start gap-1.5 text-[12.5px] text-violet-700/90 dark:text-violet-300/90">
          <Sparkles className="mt-[1px] h-3 w-3 shrink-0 opacity-80" strokeWidth={2.2} />
          {step.intelligence.explains}
        </p>
      )}

      {/* Only the manifest's own words — never a generated sentence. */}
      {step.purpose && (
        <p className="relative mt-1.5 text-[12.5px] italic text-muted-foreground/90">
          {step.purpose}
        </p>
      )}
    </div>
  );
}
