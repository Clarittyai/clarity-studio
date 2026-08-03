/**
 * The small set of primitives every screen is built from.
 *
 * House rules, from the Clarity design principles, enforced here so a screen
 * cannot casually break them:
 *
 * - Every button is a pill. There is no `radius` prop.
 * - One `accent` button per view. It is the primary action; everything else is
 *   `outline` or `ghost`.
 * - Nothing moves on hover — hover changes colour, press changes scale. Motion
 *   on hover makes a dense list feel like it is squirming.
 * - Floating surfaces are glass, never a flat opaque fill.
 */

import type { ReactNode } from 'react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ── button ───────────────────────────────────────────────────────────────────

type Variant = 'accent' | 'outline' | 'ghost' | 'destructive';

const VARIANTS: Record<Variant, string> = {
  accent:
    'bg-accent/90 text-white ring-1 ring-inset ring-white/20 backdrop-blur-xl ' +
    'hover:bg-accent active:bg-accent active:brightness-95',
  outline:
    'bg-transparent text-foreground ring-1 ring-inset ring-border ' +
    'hover:bg-foreground/[0.04] active:bg-foreground/[0.07]',
  ghost: 'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
  destructive:
    'bg-destructive/90 text-white ring-1 ring-inset ring-white/20 hover:bg-destructive',
};

export function Button({
  children,
  variant = 'outline',
  size = 'md',
  onClick,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  variant?: Variant;
  size?: 'sm' | 'md';
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // rounded-full is not overridable on purpose.
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium',
        'transition-colors duration-150 active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── surfaces ─────────────────────────────────────────────────────────────────

export function Card({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'glass-card rounded-2xl',
        onClick && 'cursor-pointer transition-colors hover:bg-foreground/[0.03]',
        selected && 'ring-2 ring-inset ring-accent/50',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── status ───────────────────────────────────────────────────────────────────

export type Status = 'success' | 'failed' | 'running' | 'stopped' | 'crashed' | 'starting' | 'skipped';

const DOT: Record<Status, string> = {
  success: 'bg-success',
  running: 'bg-status-running animate-pulseDot',
  starting: 'bg-status-running animate-pulseDot',
  failed: 'bg-destructive',
  crashed: 'bg-destructive',
  skipped: 'bg-warning',
  stopped: 'bg-muted-foreground/50',
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT[status], className)} />;
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'warning' }) {
  const tones = {
    muted: 'bg-foreground/[0.06] text-muted-foreground ring-border',
    accent: 'bg-accent/10 text-accent ring-accent/30',
    warning: 'bg-warning/15 text-warning ring-warning/30',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

// ── empty state ──────────────────────────────────────────────────────────────

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-8 py-14 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {/* Never invent a false CTA: if there is nothing useful to do here, the
          empty state says so rather than offering a dead button. */}
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

// ── formatting ───────────────────────────────────────────────────────────────

export function formatUsd(micros: number): string {
  const usd = micros / 1e6;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(from: number, to?: number | null): string {
  if (!to) return '—';
  const ms = to - from;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
