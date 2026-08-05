/**
 * CloudShowcase — what the hosted product is, shown running.
 *
 * Built like an App Store feature card rather than a list of links: one big
 * surface, one idea at a time, each slide carrying its own colour, and the live
 * art doing the explaining. The structure is the platform's
 * `login/LoginShowcase.tsx` — scenes cross-faded on a timer with the headline
 * changing WITH the scene as one unit, because a headline that outlives its
 * picture reads as a caption for the wrong thing.
 *
 * Colour is per slide and used sparingly: a wash behind the art and the eyebrow,
 * nothing else. Six tinted panels would be a rainbow; one is a mood.
 *
 * Everything is bundled. Nothing is fetched, so this renders identically with
 * the network off — the condition on which `cloud-links.ts` is the single file
 * the no-phone-home check exempts. Links open a browser only when clicked.
 *
 * Gated by `useLiveGate`: an unfocused window or reduced motion freezes it on a
 * composed frame instead of looping at nobody.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';

import { api } from '../api.js';
import { AppBuildScene } from './live/AppBuildScene.js';
import { AutomationGraphScene } from './live/AutomationGraphScene.js';
import { WidgetBoardScene } from './live/WidgetBoardScene.js';
import { EASE, useLiveGate } from './live/kernel.js';
import { CLOUD_LINKS } from './cloud-links.js';
import { cn } from './ui.js';

const byId = (id: string) => CLOUD_LINKS.find((l) => l.id === id);

/**
 * One slide per thing the hosted product does. `glow` is the slide's colour,
 * as a raw rgba so it can sit behind the art at very low alpha without needing
 * a token per hue.
 */
const SLIDES = [
  {
    key: 'automations',
    eyebrow: 'Automations',
    title: 'Work that keeps happening without you.',
    sub: 'An automation is a rhythm, not an event. It runs on its schedule, does the work, and tells you what it did.',
    Component: AutomationGraphScene,
    glow: 'rgba(91,127,255,0.20)',
    accent: 'text-accent',
    link: byId('cloud'),
  },
  {
    key: 'apps',
    eyebrow: 'Agentic apps',
    title: 'Describe it, and it gets built.',
    sub: 'Apps assemble themselves from what you asked for, then go live with their own widgets and their own data.',
    Component: AppBuildScene,
    glow: 'rgba(175,82,222,0.20)',
    accent: 'text-violet-400',
    link: byId('marketplace'),
  },
  {
    key: 'widgets',
    eyebrow: 'Your board',
    title: 'A dashboard that keeps itself current.',
    sub: 'Widgets update themselves as the work happens, so the answer is already on screen when you look.',
    Component: WidgetBoardScene,
    glow: 'rgba(52,199,89,0.18)',
    accent: 'text-emerald-400',
    link: byId('cloud'),
  },
  {
    key: 'teams',
    eyebrow: 'Teams',
    title: 'A standing team, not a fixed script.',
    sub: 'Agents take the goal, decide the steps, do the work, and report back — with a room where you can watch.',
    Component: AutomationGraphScene,
    glow: 'rgba(255,149,0,0.18)',
    accent: 'text-amber-400',
    link: byId('teams'),
  },
] as const;

const CYCLE_MS = 9000;

export function CloudShowcase() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const [phase, setPhase] = useState(0);
  /** Which way the slide came from, so the motion reads as travel. */
  const [dir, setDir] = useState(1);

  const go = useCallback((next: number, direction: number) => {
    setDir(direction);
    setPhase((p) => (next + SLIDES.length) % SLIDES.length);
  }, []);

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => go(phase + 1, 1), CYCLE_MS);
    return () => window.clearInterval(t);
  }, [live, phase, go]);

  const slide = SLIDES[phase]!;
  const Scene = slide.Component;

  return (
    <div
      ref={rootRef}
      className="relative overflow-hidden rounded-3xl border border-border bg-[#0C0C0E]"
    >
      {/* The slide's colour: one soft wash, swapped with the slide. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`glow-${slide.key}`}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: EASE }}
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 90% at 78% 12%, ${slide.glow} 0%, transparent 62%)`,
          }}
        />
      </AnimatePresence>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 160px rgba(0,0,0,0.6)' }}
      />

      <div className="relative z-10 grid items-center gap-8 p-9 md:grid-cols-[minmax(0,1fr)_360px]">
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div
            key={`copy-${slide.key}`}
            custom={dir}
            initial={{ opacity: 0, x: dir * 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: dir * -24 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="min-w-0"
          >
            <p
              className={cn(
                'text-[11px] font-semibold uppercase tracking-[0.22em]',
                slide.accent,
              )}
            >
              {slide.eyebrow}
            </p>
            <h2 className="mt-3 text-[28px] font-bold leading-[1.15] tracking-tight text-white">
              {slide.title}
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">{slide.sub}</p>
            {slide.link && (
              <button
                type="button"
                onClick={() => api.openExternal(slide.link!.href)}
                className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-4 py-2 text-[13px] font-semibold text-black transition-colors hover:bg-white"
              >
                {slide.link.cta}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </motion.div>
        </AnimatePresence>

        {/* The art. Scoped `.dark` so every scene renders on its intended
            canvas regardless of the app's theme, exactly as the platform's
            showcase does. */}
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div
            key={`scene-${slide.key}`}
            custom={dir}
            initial={{ opacity: 0, x: dir * 28, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: dir * -28, scale: 0.98 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="dark"
          >
            <Scene />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Where you are, and a way to move. Arrows stay quiet until hovered. */}
      <div className="relative z-10 flex items-center gap-3 px-9 pb-7">
        <div className="flex items-center gap-1.5">
          {SLIDES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              onClick={() => go(i, i > phase ? 1 : -1)}
              aria-label={s.eyebrow}
              className={cn(
                'h-1 rounded-full transition-all duration-300',
                i === phase ? 'w-7 bg-white/80' : 'w-2 bg-white/20 hover:bg-white/40',
              )}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(phase - 1, -1)}
            aria-label="Previous"
            className="grid h-7 w-7 place-items-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => go(phase + 1, 1)}
            aria-label="Next"
            className="grid h-7 w-7 place-items-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
