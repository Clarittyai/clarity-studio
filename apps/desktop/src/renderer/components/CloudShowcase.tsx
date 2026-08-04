/**
 * CloudShowcase — what Claritty is, shown running.
 *
 * The structure is the platform's `login/LoginShowcase.tsx`: a set of live
 * scenes cross-faded on a timer, with the headline and subline changing WITH the
 * scene as one unit. A headline that outlives its scene reads as a caption for
 * the wrong picture, which is the mistake that pattern exists to avoid.
 *
 * Everything is bundled. Nothing is fetched, so this renders identically with
 * the network off — which is what lets `cloud-links.ts` be the one file the
 * no-phone-home check exempts. The links open a browser only when clicked.
 *
 * Gated by `useLiveGate`: an unfocused window, a hidden tab or reduced motion
 * freezes it on a composed frame instead of burning a core on a loop nobody is
 * watching.
 */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

import { api } from '../api.js';
import { AppBuildScene } from './live/AppBuildScene.js';
import { AutomationGraphScene } from './live/AutomationGraphScene.js';
import { EASE, useLiveGate } from './live/kernel.js';
import { CLOUD_LINKS } from './cloud-links.js';
import { cn } from './ui.js';

const byId = (id: string) => CLOUD_LINKS.find((l) => l.id === id);

const SCENES = [
  {
    key: 'automations',
    title: 'Work that keeps happening without you.',
    sub: 'An automation is a rhythm, not an event — it runs on its schedule and tells you what it did.',
    Component: AutomationGraphScene,
    link: byId('cloud'),
  },
  {
    key: 'apps',
    title: 'Describe it, and it gets built.',
    sub: 'Agentic apps assemble themselves from what you asked for, then go live with their own widgets.',
    Component: AppBuildScene,
    link: byId('marketplace'),
  },
  {
    key: 'teams',
    title: 'A standing team, not a fixed script.',
    sub: 'Agents take the goal, decide the steps, do the work and report back.',
    Component: AutomationGraphScene,
    link: byId('teams'),
  },
] as const;

const CYCLE_MS = 8500;

export function CloudShowcase() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setPhase((p) => (p + 1) % SCENES.length), CYCLE_MS);
    return () => window.clearInterval(t);
  }, [live]);

  const scene = SCENES[phase]!;
  const Scene = scene.Component;

  return (
    <div
      ref={rootRef}
      className="relative overflow-hidden rounded-3xl border border-border bg-background"
    >
      {/* One soft accent glow, and a vignette for depth. Colour, not a rainbow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-40%] h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-accent/12 blur-[110px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 140px rgba(0,0,0,0.45)' }}
      />

      <div className="relative z-10 grid items-center gap-6 p-8 md:grid-cols-[minmax(0,1fr)_340px]">
        {/* Headline and scene cross-fade together, as one unit. */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`copy-${scene.key}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="min-w-0"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/70">
              There is a hosted version
            </p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-foreground">
              {scene.title}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {scene.sub}
            </p>
            {scene.link && (
              <button
                type="button"
                onClick={() => api.openExternal(scene.link!.href)}
                className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-accent/90 px-4 py-2 text-[13px] font-medium text-white ring-1 ring-inset ring-white/20 transition-colors hover:bg-accent"
              >
                {scene.link.cta}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence mode="wait">
          <motion.div
            key={`scene-${scene.key}`}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <Scene />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Which beat you are on, and a way to skip ahead. */}
      <div className="relative z-10 flex items-center gap-1.5 px-8 pb-6">
        {SCENES.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setPhase(i)}
            aria-label={s.title}
            className={cn(
              'h-1 rounded-full transition-all',
              i === phase ? 'w-6 bg-accent' : 'w-2 bg-border hover:bg-muted-foreground/50',
            )}
          />
        ))}
      </div>
    </div>
  );
}
