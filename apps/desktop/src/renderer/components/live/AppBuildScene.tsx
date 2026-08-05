/**
 * AppBuildScene — you describe it, Claritty builds it.
 *
 * A prompt types itself, the build steps tick through, and an app card assembles
 * and goes live. Loops.
 *
 * This exists because Home and Apps were showing the SAME scene (a board of live
 * widgets) with different numbers, so the two pages read as identical. They're
 * telling different stories: Home is "your board runs itself" — the widgets are
 * already there, working. Apps is "describe what you need and it gets made" —
 * which is exactly what that page's own copy promises. So Apps gets the making,
 * Home keeps the running.
 *
 * Ported verbatim from the platform (live/scenes/AppBuildScene.tsx) — geometry,
 * timings and classes unchanged, only the import paths rewritten.
 *
 * Kernel rules: `aria-hidden`, gated by `useLiveGate` (reduced motion /
 * off-screen / hidden tab freeze it on a composed final frame), timers only (no
 * rAF, no canvas, no network assets), inside `<Stage>` so it scales at 360px.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Loader2, Sparkles } from 'lucide-react';

import { Stage } from './Stage.js';
import { EASE, useLiveGate } from './kernel.js';

const STAGE_W = 340;
// Shared showcase height — see CloudShowcase. Was 176.
const STAGE_H = 210;

const PROMPT = 'Track my competitors weekly';
const STEPS = ['Designing', 'Building', 'Deploying'];

/** ms per phase: typing → steps → the finished app → hold → loop. */
const TYPE_MS = 55;
const STEP_MS = 620;
const HOLD_MS = 1500;

type Phase = 'typing' | 'building' | 'live';

export function AppBuildScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const reduce = useReducedMotion() ?? false;

  const [typed, setTyped] = useState(PROMPT.length);
  const [step, setStep] = useState(STEPS.length);
  const [phase, setPhase] = useState<Phase>('live');

  // One self-restarting cycle. Every timer is cleared on unmount and the whole
  // loop only runs while the gate is open.
  useEffect(() => {
    if (!live) {
      // Frozen frame: the finished app, fully composed.
      setTyped(PROMPT.length);
      setStep(STEPS.length);
      setPhase('live');
      return;
    }

    const timers: number[] = [];
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      setTyped(0);
      setStep(0);
      setPhase('typing');

      // Type the prompt one character at a time.
      for (let i = 1; i <= PROMPT.length; i += 1) {
        timers.push(window.setTimeout(() => setTyped(i), i * TYPE_MS));
      }
      const afterType = PROMPT.length * TYPE_MS + 320;
      timers.push(window.setTimeout(() => setPhase('building'), afterType));

      // Tick the build steps.
      for (let s = 1; s <= STEPS.length; s += 1) {
        timers.push(
          window.setTimeout(() => setStep(s), afterType + s * STEP_MS),
        );
      }

      const afterBuild = afterType + STEPS.length * STEP_MS + 200;
      timers.push(window.setTimeout(() => setPhase('live'), afterBuild));
      timers.push(window.setTimeout(run, afterBuild + HOLD_MS));
    };

    run();
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [live]);

  return (
    <div ref={rootRef} aria-hidden>
      <Stage width={STAGE_W} height={STAGE_H}>
        {/* What you asked for. */}
        <div className="absolute inset-x-0 top-0 flex justify-center">
          <div className="flex w-[280px] items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="truncate text-[11px] text-foreground">
              {PROMPT.slice(0, typed)}
              {live && phase === 'typing' ? (
                <motion.span
                  className="ml-px inline-block h-3 w-px translate-y-0.5 bg-accent"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity }}
                />
              ) : null}
            </span>
          </div>
        </div>

        {/* What it's doing about it. */}
        <div
          className="absolute inset-x-0 flex justify-center gap-1.5"
          style={{ top: 52 }}
        >
          {STEPS.map((label, i) => {
            const done = i < step;
            const running = i === step && phase === 'building';
            return (
              <span
                key={label}
                className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors duration-300 ${
                  done
                    ? 'bg-accent/10 text-accent'
                    : running
                      ? 'bg-muted text-foreground'
                      : 'bg-muted/50 text-muted-foreground/60'
                }`}
              >
                {done ? (
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                ) : running ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <span className="h-1 w-1 rounded-full bg-current opacity-50" />
                )}
                {label}
              </span>
            );
          })}
        </div>

        {/* What you get — the app lands, and it's already running. */}
        <div
          className="absolute inset-x-0 flex justify-center"
          style={{ top: 92 }}
        >
          <AnimatePresence>
            {phase === 'live' ? (
              <motion.div
                key="app"
                initial={reduce ? false : { opacity: 0, y: 14, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.5, ease: EASE }}
                className="flex w-[168px] flex-col gap-2 rounded-2xl border border-accent/30 bg-background p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/12 text-accent">
                    <Sparkles className="h-3 w-3" />
                  </span>
                  <span className="truncate text-[11px] font-semibold text-foreground">
                    Competitor watch
                  </span>
                </div>
                {/* A live widget, not a screenshot of one. */}
                <div className="flex h-8 items-end gap-1">
                  {[46, 68, 54, 80, 62, 92].map((h, i) => (
                    <motion.span
                      key={i}
                      className={`w-full rounded-sm ${i === 5 ? 'bg-accent' : 'bg-accent/30'}`}
                      initial={reduce ? false : { height: 0 }}
                      animate={{ height: `${h}%` }}
                      transition={{
                        duration: 0.45,
                        delay: reduce ? 0 : 0.15 + i * 0.05,
                        ease: EASE,
                      }}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-1 text-[9px] font-semibold text-accent">
                  <motion.span
                    className="h-1 w-1 rounded-full bg-accent"
                    animate={live ? { opacity: [1, 0.25, 1] } : {}}
                    transition={{ duration: 1.6, repeat: Infinity }}
                  />
                  live
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </Stage>
    </div>
  );
}
