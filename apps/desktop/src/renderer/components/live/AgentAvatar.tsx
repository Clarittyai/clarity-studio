import type { FC } from 'react';
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';

/**
 * Deterministic illustrated avatars for the AI team (agents / teammates /
 * coordinator) — so the Intelligence canvas reads as a TEAM of people, not a
 * grid of flat icons. Free + offline (DiceBear, MIT); each avatar is a pure
 * function of its seed (the agent id), so it's stable across renders/reloads.
 *
 * House style: `notionists` (clean, on-brand illustrated people). Swapping to
 * `bottts` / `personas` / `lorelei` is a one-line change to STYLE below.
 * Integration cards keep their real brand logos; tool-only automations keep
 * the wrench glyph — neither is a "team member".
 */
const STYLE = notionists;

// A vibrant, deterministic palette — DiceBear picks one per seed, so each
// teammate gets its own colour (stable across renders) and the team grid reads
// lively instead of a wall of grey discs. Tuned to sit well on light + dark.
const BG_PALETTE = [
  'ff8a80', // coral
  'ffb300', // amber
  'ffd54f', // gold
  '4dd0e1', // cyan
  '4fc3f7', // sky
  '7e9bff', // periwinkle
  'b388ff', // violet
  'f48fb1', // pink
  '80cbc4', // teal
  'aed581', // lime
];

// Avatars are pure(seed) → cache the data-uri so re-renders don't re-render SVG.
const cache = new Map<string, string>();

export function agentAvatarDataUri(seed: string): string {
  const key = (seed || 'agent').trim() || 'agent';
  const hit = cache.get(key);
  if (hit) return hit;
  const uri = createAvatar(STYLE, {
    seed: key,
    // Colourful disc — a gradient or solid fill chosen deterministically per seed.
    backgroundColor: BG_PALETTE,
    backgroundType: ['gradientLinear', 'solid'],
    radius: 50,
  }).toDataUri();
  cache.set(key, uri);
  return uri;
}

export interface AgentAvatarProps {
  /** Stable identity the avatar is derived from (agent id). */
  seed: string;
  /** Square pixel size of the rendered image (default 36). */
  size?: number;
  /** Extra classes on the disc wrapper. */
  className?: string;
}

/**
 * Illustrated avatar in a tinted disc that reads on both light + dark. Sized to
 * drop into the existing icon-disc slots without changing layout.
 */
export const AgentAvatar: FC<AgentAvatarProps> = ({
  seed,
  size = 36,
  className = '',
}) => {
  const src = agentAvatarDataUri(seed);
  return (
    <span
      className={
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ' +
        className
      }
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        draggable={false}
      />
    </span>
  );
};
