/**
 * Live-scene kernel — ported from `clarity-platform/src/components/live/kernel.tsx`
 * so Studio's animated empty states obey the same three rules the platform's do:
 *
 *   1. Motion is GATED — a loop runs only when the user hasn't asked for reduced
 *      motion, the scene is on screen, and the window is visible. A CSS
 *      `prefers-reduced-motion` rule cannot stop a JS timer, so we check it here.
 *   2. Reduced motion still renders a COMPOSED FINAL FRAME — never a blank box.
 *   3. No requestAnimationFrame, no canvas, no network assets — timers driving
 *      React state. In a desktop app that also means an idle window costs nothing.
 *
 * Only the helpers Studio actually uses are ported; the platform file has more.
 */
import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

/** The house entry curve. */
export const EASE = [0.25, 0.46, 0.45, 0.94] as const;

/**
 * True only while the scene should actually be animating — not when the user
 * prefers reduced motion, not when it is scrolled out of view, and not when the
 * window is hidden. An unfocused Electron window should not burn a core on a
 * decorative loop.
 */
export function useLiveGate(ref: React.RefObject<HTMLElement | null>): boolean {
  const reduce = useReducedMotion() ?? false;
  const [inView, setInView] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { threshold: 0.25 },
    );
    io.observe(el);

    const onVisibility = () => setHidden(document.hidden);
    setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ref]);

  return !reduce && inView && !hidden;
}

/**
 * Advance a looping script one step every `intervalMs`, but only while `active`.
 * Returns the current turn index — the whole "what happens next" of a scene.
 */
export function useTurn(length: number, active: boolean, intervalMs: number): number {
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    if (!active || length <= 0) return;
    const id = window.setTimeout(() => setTurn((t) => (t + 1) % length), intervalMs);
    return () => window.clearTimeout(id);
  }, [turn, active, length, intervalMs]);

  return length > 0 ? turn % length : 0;
}

/**
 * Count a number up to `target` while `active`. Stepped on a timer, never rAF,
 * and settles exactly on `target`. Reduced motion or off-screen shows the end
 * state rather than a zero that never animates.
 */
export function useTween(target: number, active: boolean, durationMs = 900): number {
  const [value, setValue] = useState(target);

  useEffect(() => {
    if (!active) {
      setValue(target);
      return;
    }
    const steps = 24;
    const stepMs = Math.max(16, durationMs / steps);
    let i = 0;
    setValue(0);
    const id = window.setInterval(() => {
      i += 1;
      const t = Math.min(1, i / steps);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(i >= steps ? target : Math.round(target * eased));
      if (i >= steps) window.clearInterval(id);
    }, stepMs);
    return () => window.clearInterval(id);
  }, [target, active, durationMs]);

  return value;
}

export type SceneNode = {
  seed: string;
  role: string;
  size: number;
  /** Center of the avatar, in stage coordinates. */
  x: number;
  y: number;
  /** Sits behind the front row — rendered slightly faded and smaller-drifting. */
  back?: boolean;
};

/**
 * A curve between two figures, bowed away from the cluster's center and TRIMMED
 * at each rim so a line never pierces a face.
 */
export function edgePath(
  a: SceneNode,
  b: SceneNode,
  stageWidth: number,
  centerY: number,
): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx + (mx - stageWidth / 2) * 0.16;
  const cy = my + (my - centerY) * 0.3;

  const trim = (p: SceneNode) => {
    const dx = cx - p.x;
    const dy = cy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const r = p.size / 2 + 4;
    return { x: p.x + (dx / len) * r, y: p.y + (dy / len) * r };
  };

  const from = trim(a);
  const to = trim(b);
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
}

/** Anchor a speech bubble so figures near an edge don't push it off the stage. */
export function bubbleAnchor(node: SceneNode, stageWidth: number): string {
  if (node.x < stageWidth * 0.33) return 'left-0 rounded-bl-sm';
  if (node.x > stageWidth * 0.67) return 'right-0 rounded-br-sm';
  return 'left-1/2 -translate-x-1/2 rounded-b-2xl';
}

/** The idle float every figure does, desynced by index so a cluster breathes. */
export function floatLoop(index: number, back: boolean | undefined, active: boolean) {
  if (!active) return {};
  return {
    animate: { y: [0, back ? -2.5 : -4, 0] },
    transition: {
      duration: 3 + index * 0.45,
      repeat: Infinity,
      ease: 'easeInOut' as const,
      delay: index * 0.35,
    },
  };
}

/** Measure an element's width — the basis for scaling a fixed-geometry stage. */
export function useMeasuredWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
