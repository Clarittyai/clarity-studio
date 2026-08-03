/**
 * The intelligence canvas.
 *
 * Drawn as plain SVG rather than a graph library: the layout is deterministic
 * columns, which is a few lines of arithmetic, and pulling in a full graph
 * engine to draw a hundred boxes would cost more than it gives.
 *
 * The thing this must get right is showing what is **broken**. A canvas that
 * only draws valid references is at its least useful exactly when you need it
 * most — a step pointing at a deleted agent should look wrong, not look like
 * nothing.
 */

import { useMemo } from 'react';

import { buildGraph, layout, type GraphEdge, type LaidOutNode, type ManifestLike } from '@claritty-studio/graph';

import { Badge, cn } from './ui.js';

const NODE_WIDTH = 168;
const NODE_HEIGHT = 40;
const LANE_WIDTH = 210;
const ROW_HEIGHT = 64;

const LANE_LABELS = ['Triggers', 'Workflows', 'Agents', 'Tools', 'Integrations'];

const KIND_STYLE: Record<string, string> = {
  trigger: 'fill-warning/15 stroke-warning/40',
  workflow: 'fill-accent/15 stroke-accent/40',
  agent: 'fill-success/15 stroke-success/40',
  tool: 'fill-foreground/[0.06] stroke-border',
  integration: 'fill-info/15 stroke-info/40',
};

export function Canvas({ manifest }: { manifest: ManifestLike }) {
  const { graph, laid, width, height } = useMemo(() => {
    const g = buildGraph(manifest);
    const l = layout(g, { laneWidth: LANE_WIDTH, rowHeight: ROW_HEIGHT });
    return { graph: g, laid: l.nodes, width: l.width, height: l.height };
  }, [manifest]);

  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);
  const errors = graph.problems.filter((p) => p.severity === 'error');
  const warnings = graph.problems.filter((p) => p.severity === 'warning');

  if (laid.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-8 py-12 text-center text-sm text-muted-foreground">
        This automation declares nothing yet.
      </div>
    );
  }

  const padding = 24;
  const lanesUsed = Math.max(...laid.map((n) => n.lane)) + 1;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-2xl glass-card p-4">
        <svg
          width={width + padding * 2}
          height={height + padding * 2 + 24}
          className="min-w-full"
          role="img"
          aria-label="Automation structure"
        >
          {/* Lane headings, so the direction of flow is stated rather than
              inferred from the arrows. */}
          {LANE_LABELS.slice(0, lanesUsed).map((label, lane) => (
            <text
              key={label}
              x={padding + lane * LANE_WIDTH}
              y={14}
              className="fill-muted-foreground text-[10px] uppercase tracking-wider"
            >
              {label}
            </text>
          ))}

          <g transform={`translate(${padding}, ${padding + 12})`}>
            {graph.edges.map((edge, i) => (
              <Edge key={i} edge={edge} from={byId.get(edge.from)} to={byId.get(edge.to)} />
            ))}
            {laid.map((node) => (
              <Node key={node.id} node={node} />
            ))}
          </g>
        </svg>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1.5">
          {errors.map((p, i) => (
            <p key={`e${i}`} className="text-xs text-destructive">
              {p.message}
            </p>
          ))}
          {warnings.map((p, i) => (
            <p key={`w${i}`} className="text-xs text-warning">
              {p.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Node({ node }: { node: LaidOutNode }) {
  return (
    <g transform={`translate(${node.x}, ${node.y})`}>
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={10}
        className={cn(
          'stroke-[1.5]',
          node.missing ? 'fill-destructive/15 stroke-destructive' : KIND_STYLE[node.kind],
        )}
        // A dashed outline reads as "this is not really here", which is exactly
        // what a dangling reference is.
        strokeDasharray={node.missing ? '4 3' : undefined}
      />
      <text x={12} y={17} className="fill-foreground text-[11px] font-medium">
        {truncate(node.label, 20)}
      </text>
      <text x={12} y={30} className="fill-muted-foreground text-[9px]">
        {node.missing ? 'not declared' : truncate(node.detail ?? node.kind, 26)}
      </text>
    </g>
  );
}

function Edge({ edge, from, to }: { edge: GraphEdge; from?: LaidOutNode; to?: LaidOutNode }) {
  if (!from || !to) return null;

  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const mid = x1 + (x2 - x1) / 2;

  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
        fill="none"
        className={cn('stroke-[1.5]', edge.kind === 'fires' ? 'stroke-warning/50' : 'stroke-border')}
      />
      {edge.label && (
        <text x={mid} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-muted-foreground text-[8px]">
          {edge.label}
        </text>
      )}
    </g>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export { Badge };
