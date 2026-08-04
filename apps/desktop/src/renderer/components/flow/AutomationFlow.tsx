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

import { Check, Clock, Loader2, Repeat, Sparkles, Webhook, X } from 'lucide-react';

import { cn } from '../ui.js';
import type { Flow, FlowStep, Tier } from './blocks.js';

/** Includes `failed`, which the platform's union has no need for: its page is a
 *  preview/approval surface, whereas a Studio run genuinely fails. */
export type StepStatus = 'idle' | 'running' | 'ok' | 'failed';

/** Provider tier → the word shown on the badge. */
const TIER_WORD: Record<Tier, string> = {
  integration: 'Connect',
  platform: 'Built-in',
  mcp: 'MCP',
  agent: 'Built-in',
};

/** Provider tier → badge tone. Semantic and dark-aware, as upstream. */
const TIER_TONE: Record<Tier, string> = {
  integration: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
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
          <div className="relative z-[1] w-full max-w-[340px] overflow-hidden rounded-2xl border border-accent/25 bg-accent/[0.05] py-3 pl-4 pr-3.5">
            <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
            <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-accent">
              Trigger
            </div>
            <div className="text-sm font-semibold text-foreground">{flow.trigger.label}</div>
          </div>
        </>
      )}

      {flow.steps.map((step, i) => (
        <div key={step.id} className="flex w-full flex-col items-center">
          <Gap />
          {step.forEach && (
            <>
              <Chip icon={Repeat}>For each {step.forEach}</Chip>
              <Gap />
            </>
          )}
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
        !ring && status === 'idle' && 'border border-border bg-background text-muted-foreground',
      )}
    >
      {status === 'ok' ? (
        <Check className="h-4 w-4" strokeWidth={3} />
      ) : status === 'running' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : status === 'failed' ? (
        <X className="h-4 w-4" strokeWidth={3} />
      ) : (
        children
      )}
    </div>
  );
}

function Chip({ icon: Icon, children }: { icon: typeof Repeat; children: React.ReactNode }) {
  return (
    <div className="relative z-[1] inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] font-semibold text-muted-foreground">
      <Icon className="h-3 w-3" strokeWidth={2.6} />
      {children}
    </div>
  );
}

function StepCard({ step, status }: { step: FlowStep; status: StepStatus }) {
  const violet = step.isAgent;
  return (
    <div
      className={cn(
        'relative z-[1] w-full overflow-hidden rounded-2xl border py-3 pl-4 pr-3.5 transition-colors',
        status === 'failed'
          ? 'border-destructive/40 bg-destructive/[0.06]'
          : violet
            ? 'border-violet-500/25 bg-violet-500/[0.05]'
            : 'border-border bg-foreground/[0.02]',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[3px]',
          status === 'failed' ? 'bg-destructive' : violet ? 'bg-violet-500' : 'bg-accent',
        )}
      />

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-sm font-semibold text-foreground">{step.action}</span>
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

        {step.isAgent && (
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-violet-700 dark:text-violet-300">
            <Sparkles className="h-3 w-3" strokeWidth={2.4} />
            Claritty decides
          </span>
        )}
      </div>

      {/* Only the manifest's own words — never a generated sentence. */}
      {step.purpose && (
        <p className="mt-1.5 text-[12.5px] italic text-muted-foreground/90">{step.purpose}</p>
      )}
    </div>
  );
}
