/**
 * TeamsScene — the talking cluster.
 *
 * Five DiceBear teammates in a composed cluster (lead front-center, a pair
 * flanking, a pair behind), wired by the team's structure. One speech bubble at
 * a time POPS above whoever is speaking, then hands off around the group — so a
 * user with no teams still SEES what a team is: a conversation that does work.
 *
 * Geometry + script only. The heading, the CTA and the spotlight belong to
 * <EmptyState>; this renders the stage and nothing else.
 */
import { useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

import { AgentAvatar } from './AgentAvatar.js';
import { Stage } from './Stage.js';
import {
  EASE,
  bubbleAnchor,
  edgePath,
  floatLoop,
  useLiveGate,
  useTurn,
  type SceneNode,
} from './kernel.js';

const STAGE_W = 360;
const STAGE_H = 210;
/** The cluster's optical center — what the edges bow away from. */
const CENTER_Y = 140;
const TURN_MS = 2600;

const TEAM: SceneNode[] = [
  { seed: 'recruit-lead', role: 'Lead', size: 64, x: 180, y: 130 },
  { seed: 'recruit-researcher', role: 'Researcher', size: 52, x: 104, y: 162 },
  { seed: 'recruit-writer', role: 'Writer', size: 52, x: 256, y: 162 },
  { seed: 'recruit-analyst', role: 'Analyst', size: 44, x: 52, y: 116, back: true },
  { seed: 'recruit-publisher', role: 'Publisher', size: 44, x: 308, y: 116, back: true },
];

/** The conversation — one line pops above each speaker, around the group. */
const SCRIPT: Array<{ member: number; text: string }> = [
  { member: 1, text: 'Found 3 leads worth a look' },
  { member: 0, text: 'Draft outreach for them?' },
  { member: 2, text: 'Copy’s ready to go ✓' },
  { member: 4, text: 'Scheduled for 9am' },
  { member: 3, text: 'Replies up 12% this week' },
  { member: 0, text: 'Nice — summary on the way' },
];

/** Hub spokes from the lead + the two side friendships. */
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 3],
  [2, 4],
];

export function TeamsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const reduce = useReducedMotion() ?? false;
  const turn = useTurn(SCRIPT.length, live, TURN_MS);

  // Gated (reduced motion / off-screen / hidden tab) → the turn simply stops
  // advancing, so the scene HOLDS a composed frame: the cluster, wired, with one
  // line up. It is never blank, and for a reduced-motion user it never moves.
  const active = SCRIPT[turn] ?? SCRIPT[0]!;
  const speakerIdx = active.member;

  return (
    <div ref={rootRef} aria-hidden>
      <Stage width={STAGE_W} height={STAGE_H}>
        {/* The team's structure. Edges touching the speaker warm to accent. */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={STAGE_W}
          height={STAGE_H}
          viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
          fill="none"
        >
          {EDGES.map(([i, j]) => {
            const hot = i === speakerIdx || j === speakerIdx;
            return (
              <path
                key={`${i}-${j}`}
                d={edgePath(TEAM[i]!, TEAM[j]!, STAGE_W, CENTER_Y)}
                stroke="currentColor"
                strokeWidth={hot ? 1.75 : 1.5}
                strokeLinecap="round"
                className={`transition-all duration-500 ${
                  hot ? 'text-accent opacity-60' : 'text-border opacity-50'
                }`}
              />
            );
          })}
        </svg>

        {TEAM.map((m, i) => {
          const speaking = speakerIdx === i;
          return (
            <motion.div
              key={m.seed}
              className="absolute"
              style={{
                left: m.x - m.size / 2,
                top: m.y - m.size / 2,
                width: m.size,
                zIndex: speaking ? 4 : m.back ? 1 : 2,
              }}
              initial={reduce ? false : { opacity: 0, scale: 0.8, y: 10 }}
              animate={{ opacity: m.back ? 0.92 : 1, scale: 1, y: 0 }}
              transition={{ duration: 0.45, delay: i * 0.09, ease: EASE }}
            >
              <motion.div className="relative" {...floatLoop(i, m.back, live)}>
                {/* Bare avatar disc — speaking = a gentle lean-in, nothing else. */}
                <motion.span
                  className="block rounded-full"
                  animate={{ scale: speaking ? 1.06 : 1 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  <AgentAvatar seed={m.seed} size={m.size} />
                </motion.span>

                {/* The message — pops above the speaker's head. */}
                <AnimatePresence>
                  {speaking && (
                    <motion.div
                      key={live ? `bubble-${turn}` : 'static'}
                      initial={live ? { opacity: 0, scale: 0.75, y: 6 } : false}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.18 } }}
                      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                      className={`absolute bottom-full mb-2 w-max max-w-[180px] rounded-2xl border border-border/70 bg-background px-3 py-2 text-left ${bubbleAnchor(
                        m,
                        STAGE_W,
                      )}`}
                    >
                      <div className="mb-0.5 text-[10px] font-semibold leading-none text-accent">
                        {m.role}
                      </div>
                      <div className="text-xs leading-snug text-foreground">
                        {active.text}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </motion.div>
          );
        })}
      </Stage>
    </div>
  );
}
