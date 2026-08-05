/**
 * AutomationGraphScene — the first-run scene for "no automations yet".
 *
 * It is the intelligence canvas, alive: the same vocabulary `Canvas.tsx` draws
 * for a real automation — rounded nodes, bezier edges, lanes reading left to
 * right — with a run travelling through it. So the empty state is a preview of
 * the actual artefact, not decoration invented for the occasion.
 *
 * The script: a trigger fires, the run moves along each edge, each node lights
 * as it executes and keeps a quiet check when it is done, and then it loops.
 * The loop is the point — an automation is a rhythm, not an event.
 *
 * Geometry is authored in a fixed 340×186 space and scaled by `Stage`, so the
 * composition can never clip the way a hand-positioned one does. Nodes are
 * always present and change state rather than popping in, which keeps the
 * silhouette stable while the run moves.
 */
import { useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { Stage } from './Stage.js';
import { EASE, useLiveGate, useTurn } from './kernel.js';

const STAGE_W = 340;
// Shared showcase height — see CloudShowcase. Was 186.
const STAGE_H = 210;
const TURN_MS = 1500;

const NODE_W = 92;
const NODE_H = 34;
const ROW_Y = 44;

/** The canonical shape of an automation, in the order a run walks it. */
const NODES = [
  { label: 'Every Mon', detail: '09:00', x: 6, y: ROW_Y },
  { label: 'collect', detail: 'tool', x: 124, y: ROW_Y },
  { label: 'summarise', detail: 'agent', x: 242, y: ROW_Y },
  { label: 'send', detail: 'gmail', x: 124, y: ROW_Y + 66 },
];

/** from → to, as indices into NODES. */
const EDGES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
];

const rightOf = (i: number) => ({ x: NODES[i]!.x + NODE_W, y: NODES[i]!.y + NODE_H / 2 });
const leftOf = (i: number) => ({ x: NODES[i]!.x, y: NODES[i]!.y + NODE_H / 2 });

function edgePath(from: number, to: number): string {
  const a = rightOf(from);
  const b = leftOf(to);
  // The last hop drops to the row below, so leave from the bottom instead of
  // the side — a side exit would double back across the node it just left.
  if (NODES[to]!.y !== NODES[from]!.y) {
    const start = { x: NODES[from]!.x + NODE_W / 2, y: NODES[from]!.y + NODE_H };
    const end = { x: NODES[to]!.x + NODE_W, y: NODES[to]!.y + NODE_H / 2 };
    return `M ${start.x} ${start.y} C ${start.x} ${start.y + 34}, ${end.x + 40} ${end.y}, ${end.x} ${end.y}`;
  }
  const mid = a.x + (b.x - a.x) / 2;
  return `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
}

export function AutomationGraphScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useLiveGate(rootRef);
  const reduce = useReducedMotion() ?? false;

  // One turn per node, plus a beat at the end where the whole run reads as done.
  const turn = useTurn(NODES.length + 1, live, TURN_MS);
  // Frozen frame: settle with most of the run complete, so a still scene still
  // reads as "this thing works", not as an unstarted diagram.
  const step = live ? turn : NODES.length;

  return (
    <div ref={rootRef} aria-hidden>
      <Stage width={STAGE_W} height={STAGE_H}>
        <svg
          className="absolute inset-0"
          width={STAGE_W}
          height={STAGE_H}
          viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
          fill="none"
        >
          {/* The run itself. Drawn FIRST so it sits behind the nodes — painted
              on top it washed out the labels it was meant to highlight. */}
          {step < NODES.length && (
            <motion.circle
              r={13}
              className="fill-accent/25"
              initial={false}
              animate={{
                cx: NODES[step]!.x + NODE_W / 2,
                cy: NODES[step]!.y + NODE_H / 2,
                opacity: live ? [0.55, 0.15, 0.55] : 0.3,
              }}
              transition={{
                cx: { duration: 0.45, ease: EASE },
                cy: { duration: 0.45, ease: EASE },
                opacity: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' },
              }}
            />
          )}

          {/* Edges first, so nodes sit on top of them. */}
          {EDGES.map(([from, to], i) => {
            const travelled = step > to;
            return (
              <g key={`e${i}`}>
                <path d={edgePath(from, to)} className="stroke-border stroke-[1.5]" fill="none" />
                {/* The travelled part of the path, drawn in accent. */}
                <motion.path
                  d={edgePath(from, to)}
                  className="stroke-accent stroke-[1.5]"
                  fill="none"
                  initial={false}
                  animate={{ pathLength: travelled ? 1 : 0 }}
                  transition={{ duration: reduce ? 0 : 0.45, ease: EASE }}
                />
              </g>
            );
          })}

          {NODES.map((node, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <g key={node.label} transform={`translate(${node.x}, ${node.y})`}>
                <motion.rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  className={
                    active
                      ? 'fill-accent/15 stroke-accent'
                      : done
                        ? 'fill-accent/[0.06] stroke-accent/40'
                        : 'fill-foreground/[0.03] stroke-border'
                  }
                  strokeWidth={1.5}
                  initial={false}
                  animate={{ scale: active && !reduce ? 1.04 : 1 }}
                  style={{ transformOrigin: `${NODE_W / 2}px ${NODE_H / 2}px` }}
                  transition={{ duration: 0.3, ease: EASE }}
                />
                <text x={10} y={15} className="fill-foreground text-[10px] font-medium">
                  {node.label}
                </text>
                <text x={10} y={26} className="fill-muted-foreground text-[8px]">
                  {node.detail}
                </text>
                {/* The check lands only once the run has moved past this node. */}
                <motion.g
                  initial={false}
                  animate={{ opacity: done ? 1 : 0, scale: done ? 1 : 0.6 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  style={{ transformOrigin: `${NODE_W - 14}px 17px` }}
                >
                  <circle cx={NODE_W - 14} cy={17} r={6} className="fill-accent/20" />
                  <path
                    d={`M ${NODE_W - 17} 17 l 2 2 l 4 -4.5`}
                    className="stroke-accent"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </motion.g>
              </g>
            );
          })}

        </svg>

        {/* Said once, quietly, under the graph. */}
        <div className="absolute inset-x-0 bottom-0 text-center text-[10px] text-accent">
          {step >= NODES.length ? 'digest sent · $0.004' : 'runs on its own'}
        </div>
      </Stage>
    </div>
  );
}
