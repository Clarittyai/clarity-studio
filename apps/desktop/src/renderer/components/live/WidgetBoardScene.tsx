/**
 * WidgetBoardScene — apps running themselves.
 *
 * A four-tile board that keeps working while you watch it. Tiles LAND one by one
 * (the way a widget lands on your board), then one tile refreshes per turn: a
 * light sweeps across it, its number re-counts and flashes the delta, its bars
 * re-shape in a wave, a genuinely new line pushes into its feed, its progress
 * advances. Between turns the board still breathes — the live dot pulses, the
 * leading bar glows. That's the promise: a dashboard that keeps itself current,
 * not a screen you go and fill in.
 *
 * `variant` swaps the script, not the machinery: 'home' is a personal workspace
 * board, 'apps' is the builder's view of what their apps are doing.
 */
import { useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUp, Check } from 'lucide-react';

import { Stage } from './Stage.js';
import { EASE, useLiveGate, useTurn, useTween } from './kernel.js';

// Two rows of 92px tiles + a 12px gutter — the box the grid exactly fills.
const STAGE_W = 320;
const STAGE_H = 196;
const TURN_MS = 2200;
/** Values per tile — a tile steps to its next value only on ITS turn. */
const ROUNDS = 3;
const TILES = 4;
/** How many feed lines are visible at once (the script holds more, and rotates). */
const FEED_WINDOW = 3;

type Script = {
  /** Stat tile: label + the values it cycles through + how to render one. */
  stat: { label: string; values: number[]; prefix?: string; suffix?: string };
  /** Bars tile: label + the bar sets it cycles through (percent heights). */
  bars: { label: string; sets: number[][] };
  /** Feed tile: label + a rolling list — a new line enters, the oldest drops off. */
  list: { label: string; lines: string[] };
  /** Progress tile: label + the done-counts it cycles through, out of `total`. */
  progress: { label: string; values: number[]; total: number };
};

const SCRIPTS: Record<'home' | 'apps', Script> = {
  home: {
    stat: { label: 'Pipeline', values: [48, 51, 47], prefix: '$', suffix: 'k' },
    bars: {
      label: 'Replies this week',
      sets: [
        [38, 52, 44, 66, 58, 74, 90],
        [44, 40, 58, 52, 70, 62, 84],
        [32, 48, 62, 50, 66, 78, 88],
      ],
    },
    list: {
      label: 'Today',
      lines: [
        '2 deals need a nudge',
        'Draft ready to review',
        'Digest sent',
        'Follow-up scheduled',
        'Meeting notes filed',
      ],
    },
    progress: { label: 'Runs', values: [7, 8, 9], total: 9 },
  },
  apps: {
    stat: { label: 'Active users', values: [312, 340, 327] },
    bars: {
      label: 'Requests · 7d',
      sets: [
        [42, 58, 50, 72, 64, 80, 92],
        [50, 46, 64, 58, 76, 68, 88],
        [36, 54, 68, 56, 72, 84, 94],
      ],
    },
    list: {
      label: 'Latest',
      lines: [
        'Nightly report shipped',
        'Sync finished · 0 errors',
        'New install',
        'Widget refreshed',
        'Webhook delivered',
      ],
    },
    progress: { label: 'Healthy', values: [4, 5, 6], total: 6 },
  },
};

/** Which value a tile is showing: its index advances only on its own turn. */
function stepFor(tile: number, tick: number): number {
  return Math.floor((tick - tile + TILES) / TILES) % ROUNDS;
}

function Tile({
  label,
  hot,
  index,
  live,
  reduce,
  children,
}: {
  label: string;
  /** The tile currently refreshing. */
  hot: boolean;
  index: number;
  live: boolean;
  reduce: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      // Each tile LANDS — the same gesture a real widget makes when it arrives.
      initial={reduce ? false : { opacity: 0, y: 12, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, delay: index * 0.09, ease: EASE }}
      className="relative"
    >
      <motion.div
        // A gentle pop when this tile becomes the one refreshing.
        animate={live && hot ? { scale: [1, 1.025, 1] } : { scale: 1 }}
        transition={{ duration: 0.5, ease: EASE }}
        // Same canonical widget surface as the real Home widgets
        // (.glass-card-marketplace → rounded-3xl liquid glass + inset ring +
        // hairline top edge) so the teaser reads as the product, not a mock.
        // The refreshing tile just brightens its border/ring to accent.
        className={`glass-card-marketplace relative flex h-[92px] flex-col overflow-hidden px-3 py-2.5 ${
          hot ? '!border-accent/40 !ring-accent/25' : ''
        }`}
      >
        {/* The refresh sweep — a light passing across the tile that just updated. */}
        <AnimatePresence>
          {live && hot ? (
            <motion.div
              key="sweep"
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-accent/10 to-transparent"
              initial={{ x: '-120%' }}
              animate={{ x: '120%' }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, ease: 'easeInOut' }}
            />
          ) : null}
        </AnimatePresence>

        <div className="relative mb-1 flex items-center justify-between">
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
          <motion.span
            className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-500 ${
              hot ? 'bg-accent' : 'bg-border'
            }`}
            animate={live && hot ? { opacity: [1, 0.3, 1], scale: [1, 1.4, 1] } : {}}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
        <div className="relative flex flex-1 flex-col">{children}</div>
      </motion.div>
    </motion.div>
  );
}

export function WidgetBoardScene({ variant = 'home' }: { variant?: 'home' | 'apps' }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const reduce = useReducedMotion() ?? false;
  const script = SCRIPTS[variant];

  // One tick per turn; the active tile is `tick % TILES`, and each tile reads
  // its own value off the tick — so exactly one tile changes at a time.
  const tick = useTurn(TILES * ROUNDS, live, TURN_MS);
  const hot = tick % TILES;

  const statStep = stepFor(0, tick);
  const statTarget = script.stat.values[statStep]!;
  const stat = useTween(statTarget, live, 900);
  // The change the stat just made — flashed as a chip, so the number means something.
  const statPrev = script.stat.values[(statStep - 1 + ROUNDS) % ROUNDS]!;
  const statDelta = statTarget - statPrev;

  const bars = script.bars.sets[stepFor(1, tick)]!;

  // The feed rolls: a new line enters at the top and the oldest falls off.
  const feedStep = stepFor(2, tick);
  const feed = Array.from(
    { length: FEED_WINDOW },
    (_, i) => script.list.lines[(feedStep + i) % script.list.lines.length]!,
  );

  const done = script.progress.values[stepFor(3, tick)]!;
  const { total } = script.progress;

  return (
    <div ref={rootRef} aria-hidden>
      <Stage width={STAGE_W} height={STAGE_H}>
        <div className="grid grid-cols-2 gap-3">
          {/* Stat — re-counts in place, then flashes what changed. */}
          <Tile label={script.stat.label} hot={hot === 0} index={0} live={live} reduce={reduce}>
            <div className="mt-auto flex items-end gap-1.5">
              <span className="text-2xl font-bold leading-none tabular-nums text-foreground">
                {script.stat.prefix ?? ''}
                {stat}
                {script.stat.suffix ?? ''}
              </span>
              <AnimatePresence mode="wait">
                {live && hot === 0 && statDelta !== 0 ? (
                  <motion.span
                    key={statStep}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3, delay: 0.5 }}
                    className="mb-0.5 inline-flex items-center text-[10px] font-semibold text-accent"
                  >
                    <ArrowUp
                      className={`h-2.5 w-2.5 ${statDelta < 0 ? 'rotate-180' : ''}`}
                      strokeWidth={3}
                    />
                    {Math.abs(statDelta)}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </div>
            <div className="mt-1.5 inline-flex w-max items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              <motion.span
                className="h-1 w-1 rounded-full bg-accent"
                animate={live ? { opacity: [1, 0.25, 1] } : {}}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              />
              live
            </div>
          </Tile>

          {/* Bars — re-shape in a left-to-right wave; the leading bar keeps glowing. */}
          <Tile label={script.bars.label} hot={hot === 1} index={1} live={live} reduce={reduce}>
            <div className="mt-auto flex h-11 items-end gap-1">
              {bars.map((h, i) => {
                const leading = i === bars.length - 1;
                return (
                  <motion.span
                    key={i}
                    className={`w-full rounded-sm ${leading ? 'bg-accent' : 'bg-accent/30'}`}
                    initial={false}
                    animate={{
                      height: `${h}%`,
                      opacity: live && leading ? [1, 0.6, 1] : 1,
                    }}
                    transition={
                      live
                        ? {
                            height: { duration: 0.7, delay: i * 0.045, ease: EASE },
                            opacity: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
                          }
                        : { duration: 0 }
                    }
                  />
                );
              })}
            </div>
          </Tile>

          {/* Feed — a new line pushes in at the top, the oldest drops off. */}
          <Tile label={script.list.label} hot={hot === 2} index={2} live={live} reduce={reduce}>
            <div className="mt-auto space-y-1.5">
              <AnimatePresence initial={false} mode="popLayout">
                {feed.map((line, i) => (
                  <motion.div
                    key={line}
                    layout
                    initial={reduce ? false : { opacity: 0, y: -8 }}
                    animate={{ opacity: i === 0 ? 1 : 0.65, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.35, ease: EASE }}
                    className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground"
                  >
                    <span
                      className={`h-1 w-1 shrink-0 rounded-full ${
                        i === 0 ? 'bg-accent' : 'bg-border'
                      }`}
                    />
                    <span className="truncate">{line}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </Tile>

          {/* Progress — advances on its turn. */}
          <Tile
            label={script.progress.label}
            hot={hot === 3}
            index={3}
            live={live}
            reduce={reduce}
          >
            <div className="mt-auto flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <motion.span
                animate={live && hot === 3 ? { scale: [1, 1.25, 1] } : { scale: 1 }}
                transition={{ duration: 0.45, ease: EASE }}
              >
                <Check className="h-4 w-4 text-accent" strokeWidth={2.5} />
              </motion.span>
              <span className="tabular-nums">
                {done}/{total} done
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full rounded-full bg-accent"
                initial={false}
                animate={{ width: `${(done / total) * 100}%` }}
                transition={live ? { duration: 0.7, ease: EASE } : { duration: 0 }}
              />
            </div>
          </Tile>
        </div>
      </Stage>
    </div>
  );
}
