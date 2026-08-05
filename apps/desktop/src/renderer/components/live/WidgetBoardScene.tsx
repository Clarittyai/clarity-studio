/**
 * WidgetBoardScene — a board that keeps itself current.
 *
 * The widgets are drawn at the REAL size system, not as four equal boxes. The
 * platform's grid (see `clarity-platform/src/lib/widget-sizes.ts`) is Apple's
 * three-size standard on a 170px column pitch with a 20px gap:
 *
 *   small   1 col × 1 row  → 170 × 170   (square)
 *   medium  2 cols × 1 row → 360 × 170   (170 + 20 + 170)
 *   large   2 cols × 2 rows → 360 × 360
 *
 * Those proportions are the whole visual signature of a Claritty board — a
 * medium is visibly twice a small and never square. Drawing them all the same
 * size, as this scene used to, describes a dashboard nobody has.
 *
 * Authored here at PITCH 92 / GAP 11, which is the same 8.5:1 ratio scaled to
 * fit the stage, so the shapes stay honest.
 *
 * Kernel rules: `aria-hidden`, gated by `useLiveGate` — reduced motion, an
 * off-screen scene or a hidden window freezes it on a composed final frame —
 * and timers only, no rAF and no network assets.
 */
import { useRef } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';

import { Stage } from './Stage.js';
import { EASE, useLiveGate, useTurn, useTween } from './kernel.js';

const STAGE_W = 340;
const STAGE_H = 210;

/** The real grid, scaled: 170/20 ≈ 8.5, and 92/11 ≈ 8.4. */
const PITCH = 92;
const GAP = 11;
const MEDIUM_W = PITCH * 2 + GAP; // a medium spans two columns and the gap
const BOARD_W = PITCH * 3 + GAP * 2;
const BOARD_H = PITCH * 2 + GAP;
const OX = Math.round((STAGE_W - BOARD_W) / 2);
const OY = Math.round((STAGE_H - BOARD_H) / 2) - 6;

const BARS = [46, 62, 54, 78, 66, 92];

/** One widget shell — 24px outer radius, as the toolkit enforces. */
function Widget({
  x,
  y,
  w,
  h,
  children,
  delay,
  live,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  children: React.ReactNode;
  delay: number;
  live: boolean;
}) {
  return (
    <motion.div
      className="absolute overflow-hidden rounded-[14px] border border-border bg-background p-2.5"
      style={{ left: OX + x, top: OY + y, width: w, height: h }}
      initial={live ? { opacity: 0, y: 6, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, delay: live ? delay : 0, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[8px] font-medium text-muted-foreground">{children}</div>;
}

export function WidgetBoardScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);

  // The number the board is actually reporting, counting up when it lands.
  const pipeline = useTween(51, live, 1100);
  // Which row of the list is newest — the board changing under you.
  const turn = useTurn(3, live, 2400);

  return (
    <div ref={rootRef} aria-hidden>
      <Stage width={STAGE_W} height={STAGE_H}>
        {/* MEDIUM — two columns wide, half as tall. The signature shape. */}
        <Widget x={0} y={0} w={MEDIUM_W} h={PITCH} delay={0} live={live}>
          <Label>Pipeline</Label>
          <div className="mt-0.5 text-[22px] font-bold leading-none tabular-nums text-foreground">
            ${pipeline}k
          </div>
          <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[7.5px] font-semibold text-accent">
            <motion.span
              className="h-1 w-1 rounded-full bg-accent"
              animate={live ? { opacity: [1, 0.25, 1] } : {}}
              transition={{ duration: 1.6, repeat: Infinity }}
            />
            live
          </div>
        </Widget>

        {/* SMALL — square, one column. */}
        <Widget x={MEDIUM_W + GAP} y={0} w={PITCH} h={PITCH} delay={0.08} live={live}>
          <Label>Runs</Label>
          <div className="mt-1 flex items-center gap-1">
            <Check className="h-3 w-3 text-accent" strokeWidth={3} />
            <span className="text-[13px] font-bold tabular-nums text-foreground">7/9</span>
          </div>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={live ? { width: 0 } : false}
              animate={{ width: '78%' }}
              transition={{ duration: 0.8, delay: live ? 0.35 : 0, ease: EASE }}
            />
          </div>
        </Widget>

        {/* SMALL — square again, so the row reads as 1 + 2 columns. */}
        <Widget x={0} y={PITCH + GAP} w={PITCH} h={PITCH} delay={0.16} live={live}>
          <Label>Today</Label>
          <div className="mt-1 flex flex-col gap-1">
            {['Draft ready', 'Digest sent', 'Follow-up'].map((item, i) => (
              <div key={item} className="flex items-center gap-1">
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${i === turn ? 'bg-accent' : 'bg-foreground/20'}`}
                />
                <span
                  className={`truncate text-[8px] ${i === turn ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {item}
                </span>
              </div>
            ))}
          </div>
        </Widget>

        {/* MEDIUM — the wide shape again, this time carrying a chart. */}
        <Widget x={PITCH + GAP} y={PITCH + GAP} w={MEDIUM_W} h={PITCH} delay={0.24} live={live}>
          <Label>Replies this week</Label>
          <div className="mt-2 flex h-[46px] items-end gap-[5px]">
            {BARS.map((value, i) => (
              <motion.span
                key={i}
                className={`w-full rounded-[2px] ${i === BARS.length - 1 ? 'bg-accent' : 'bg-accent/30'}`}
                initial={live ? { height: 0 } : false}
                animate={{ height: `${value}%` }}
                transition={{ duration: 0.5, delay: live ? 0.3 + i * 0.05 : 0, ease: EASE }}
              />
            ))}
          </div>
        </Widget>
      </Stage>
    </div>
  );
}
