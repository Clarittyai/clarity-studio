import type { KeyboardEvent, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { LiquidGlass } from './liquid-glass.js';
import { cn } from './ui.js';

/**
 * The modal shell: a scrim, the ten-layer glass panel, and the transition.
 *
 * All three of Studio's modals used to appear instantly — no entrance, no exit.
 * On a desktop app that reads as a glitch rather than a window opening, and the
 * glass makes it worse: a translucent panel that pops into place looks like a
 * render bug, where the same panel easing in reads as a material.
 *
 * The motion lives HERE rather than at each call site on purpose. Three copies
 * of a hand-tuned curve is three chances to drift, and the platform has already
 * paid for that lesson with its glass recipe.
 *
 * Exit needs an `<AnimatePresence>` around the conditional mount in the parent —
 * framer cannot animate a component that React has already unmounted.
 */

/** Decelerate-out: quick off the mark, settles without a bounce. */
const EASE = [0.22, 1, 0.36, 1] as const;
const DURATION = 0.22;

export interface GlassModalProps {
  /** Fired on Escape. Kept as a prop so each modal decides whether to guard it. */
  onEscape?: () => void;
  /** Scrim extras — padding, mostly. The wash and layout are already set. */
  scrimClassName?: string;
  /** The panel box: width, max-width, top offset, shadow. */
  panelClassName?: string;
  /** The content box: fill, border, radius, scroll. */
  contentClassName?: string;
  /**
   * Corner radius in px, and it MUST match the `rounded-*` in
   * `contentClassName` — the material and the content box are separate
   * elements, so a mismatch leaves fill in a corner the blur never reaches.
   * Studio's scale: rounded-lg 8 · xl 16 · 2xl 24 · 3xl 32.
   */
  radius?: number;
  children: ReactNode;
}

export function GlassModal({
  onEscape,
  scrimClassName,
  panelClassName,
  contentClassName,
  radius = 32,
  children,
}: GlassModalProps) {
  // Someone who asked the OS for less motion gets the state change, not the
  // journey: still a crossfade, no travel and no scale.
  const reduce = useReducedMotion() ?? false;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onEscape?.();
  };

  return (
    <motion.div
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center bg-background/40',
        scrimClassName,
      )}
      onKeyDown={handleKeyDown}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: DURATION, ease: EASE }}
    >
      <motion.div
        className={panelClassName}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99 }}
        transition={{ duration: DURATION, ease: EASE }}
      >
        <LiquidGlass radius={radius} className="block w-full" contentClassName={contentClassName}>
          {children}
        </LiquidGlass>
      </motion.div>
    </motion.div>
  );
}
