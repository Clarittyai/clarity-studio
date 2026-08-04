/**
 * Stage — a fixed-geometry scene that SCALES to its container instead of
 * clipping. Ported from `clarity-platform/src/components/live/Stage.tsx`.
 *
 * Scenes are authored in a comfortable coordinate space with absolutely
 * positioned figures. When the container is narrower than that space, Stage
 * measures the real width and scales the whole composition down so nothing is
 * cut off. It never scales UP past `maxScale` — a small composition blown up to
 * fill a desktop column looks like clip-art.
 */
import type { ReactNode } from 'react';

import { useMeasuredWidth } from './kernel.js';

export function Stage({
  width,
  height,
  maxScale = 1,
  className,
  children,
}: {
  /** Design-space width the children are positioned in. */
  width: number;
  /** Design-space height. */
  height: number;
  maxScale?: number;
  className?: string;
  children: ReactNode;
}) {
  const [ref, measured] = useMeasuredWidth();

  // Before the first measurement, assume we fit — avoids a scale-in flash.
  const scale = measured > 0 ? Math.min(maxScale, measured / width) : Math.min(maxScale, 1);

  return (
    <div
      ref={ref}
      aria-hidden
      // `overflow-hidden` is load-bearing: until the ResizeObserver's first
      // measurement lands the inner box renders unscaled, and a box wider than
      // its column would widen the document.
      className={`relative mx-auto w-full overflow-hidden ${className ?? ''}`}
      // Reserve exactly the scaled height so the scene never shifts layout.
      style={{ height: height * scale }}
    >
      <div
        className="absolute left-1/2 top-0"
        style={{
          width,
          height,
          transform: `translateX(-50%) scale(${scale})`,
          transformOrigin: 'top center',
        }}
      >
        {children}
      </div>
    </div>
  );
}
