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
import { motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';

/**
 * What went wrong, without the plumbing.
 *
 * Electron wraps anything thrown in a main-process handler, so a message
 * written for a person — "pick another name" — reaches the window as
 * `Error invoking remote method 'project:create': Error: … pick another name`.
 * The useful sentence is at the end, behind two layers of machinery nobody
 * outside this codebase should ever see.
 */
export function humanError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError):\s*/, '')
    .trim();
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ── button ───────────────────────────────────────────────────────────────────

type Variant = 'accent' | 'outline' | 'ghost' | 'destructive';

const VARIANTS: Record<Variant, string> = {
  // `glass-material`, not a hand-written blur: the recipe is synced from the
  // platform (packages/design/src/glass.css) so Studio's accent button is the
  // same material as the platform's, and cannot drift from it.
  accent:
    'bg-accent/90 text-white ring-1 ring-inset ring-white/20 glass-material ' +
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

/**
 * Ported from the platform's `ui/empty-state.tsx`, including the rule that
 * matters most: **no border, no card, no dashed box.** An empty state is open
 * space with something living in it, not a plate. (Studio's first version was a
 * dashed rectangle, which is exactly what the platform removed ~35 of.)
 *
 * Three sizes:
 *   page    — a first-run moment. Full-bleed, centered, usually with a `scene`.
 *   section — a block inside a populated screen. Quieter.
 *   inline  — one line (an empty sub-list). No scene, no CTA.
 *
 * Pass `scene` for first-run surfaces, `icon` everywhere else — never both.
 */
export function EmptyState({
  size = 'section',
  scene,
  icon: Icon,
  title,
  body,
  action,
  secondary,
  className,
}: {
  size?: 'page' | 'section' | 'inline';
  scene?: ReactNode;
  icon?: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;

  // An empty sub-list doesn't deserve a stage and a headline — just say it.
  if (size === 'inline') {
    return (
      <p className={cn('py-3 text-center text-xs text-muted-foreground', className)}>
        {title}
        {body ? <span className="mt-0.5 block">{body}</span> : null}
      </p>
    );
  }

  const isPage = size === 'page';

  return (
    <div
      className={cn(
        'relative flex flex-col items-center text-center',
        // `min-h-full` rather than a viewport fraction: a first-run moment should
        // sit in the middle of the space it actually has, and in a desktop window
        // that space is the pane, not the viewport.
        isPage ? 'min-h-full flex-1 justify-center px-6 py-10' : 'px-6 py-12',
        className,
      )}
    >
      {scene ? (
        <div className="relative mb-6 w-full max-w-sm">
          {/* Soft spotlight — the scene sits in light, not on a plate. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-4 h-40 w-72 -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
          />
          <div className="relative">{scene}</div>
        </div>
      ) : Icon ? (
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent"
        >
          <Icon className="h-7 w-7" />
        </motion.div>
      ) : null}

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: scene ? 0.35 : 0.1, duration: 0.45 }}
        className="relative flex flex-col items-center"
      >
        <h3 className={cn('font-semibold text-foreground', isPage ? 'text-lg' : 'text-base')}>
          {title}
        </h3>

        {/* Never invent a false CTA: if there is nothing useful to do here, the
            empty state says so rather than offering a dead button. */}
        {body ? (
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
        ) : null}

        {action ? <div className="mt-6">{action}</div> : null}
        {secondary ? <div className="mt-3 text-xs text-muted-foreground">{secondary}</div> : null}
      </motion.div>
    </div>
  );
}

// ── formatting ───────────────────────────────────────────────────────────────

/**
 * Tokens, at a glance. What a run actually consumed is the number people can
 * act on — a dollar figure derived from a price list is a guess about someone
 * else's billing, wrong the moment a rate changes or a local model does the
 * work for nothing.
 */
export function formatTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(micros: number): string {
  const usd = micros / 1e6;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * A path as a person would write it: `~/Automations/x`, never
 * `/Users/their-name/Automations/x`.
 *
 * Not only cosmetic. Every screenshot of this app leaked a username, and a
 * support thread or a README image is exactly where an absolute home path
 * should not appear. Done by pattern rather than by asking main for the home
 * directory, so it needs no IPC and works the same on macOS and Linux.
 */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** The mirror of timeAgo, for something that has not happened yet. */
export function timeUntil(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'due';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86_400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86_400)}d`;
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
