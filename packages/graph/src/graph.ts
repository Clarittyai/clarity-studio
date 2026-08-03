/**
 * `intelligence.yaml` → a graph you can look at.
 *
 * The manifest is the automation, but a YAML file is a poor way to answer the
 * question people actually have: *what happens, in what order, and what does it
 * touch?* The canvas answers that, and it flows the way the automation runs —
 * triggers on the left, then workflows, agents, tools, and finally the outside
 * world on the right.
 *
 * It also renders what is **broken**. A graph that only draws valid references
 * hides exactly the bug you opened it to find: a step pointing at an agent that
 * no longer exists looks, on a tidy canvas, like nothing at all. Dangling
 * references become real nodes marked `missing`, so the hole is visible.
 */

export type NodeKind = 'trigger' | 'workflow' | 'agent' | 'tool' | 'integration';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Column, left to right, following the direction the automation runs. */
  lane: number;
  /** Set when this node is referenced but not declared. */
  missing?: boolean;
  /** Extra detail for the inspector. */
  detail?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** `fires` reads differently from `calls` and the canvas should say which. */
  kind: 'fires' | 'runs' | 'calls' | 'uses';
  label?: string;
}

export interface GraphProblem {
  severity: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export interface IntelligenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  problems: GraphProblem[];
}

/** The shape we read out of the manifest. Deliberately loose: a half-written
 *  manifest must still draw, because that is when the canvas is most useful. */
export interface ManifestLike {
  id?: string;
  integrations?: Array<{ id: string; required?: boolean }>;
  tools?: Array<{ id: string; handler?: string; source?: string }>;
  agents?: Array<{
    id: string;
    description?: string;
    tools?: string[];
    integrations?: string[];
    systemPrompt?: string;
    promptFile?: string;
    model?: string;
  }>;
  workflows?: Array<{
    id: string;
    type?: string;
    team?: string[];
    steps?: Array<{ id: string; agent?: string; tool?: string; forEach?: string }>;
  }>;
  triggers?: Array<{ id: string; type?: string; workflow?: string; agent?: string; name?: string }>;
}

const LANES: Record<NodeKind, number> = {
  trigger: 0,
  workflow: 1,
  agent: 2,
  tool: 3,
  integration: 4,
};

export function buildGraph(manifest: ManifestLike): IntelligenceGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const problems: GraphProblem[] = [];

  const nodeId = (kind: NodeKind, id: string) => `${kind}:${id}`;

  const add = (kind: NodeKind, id: string, extra: Partial<GraphNode> = {}): string => {
    const key = nodeId(kind, id);
    const existing = nodes.get(key);
    if (existing) {
      // A node first seen as a dangling reference stops being "missing" once
      // its real declaration turns up.
      if (existing.missing && !extra.missing) delete existing.missing;
      if (extra.detail) existing.detail = extra.detail;
      return key;
    }
    nodes.set(key, { id: key, kind, label: id, lane: LANES[kind], ...extra });
    return key;
  };

  /** Reference a node that ought to exist. Records a problem if it doesn't. */
  const reference = (kind: NodeKind, id: string, from: string): string => {
    const key = nodeId(kind, id);
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, kind, label: id, lane: LANES[kind], missing: true });
      problems.push({
        severity: 'error',
        nodeId: key,
        message: `${from} references the ${kind} "${id}", which this manifest does not declare.`,
      });
    }
    return key;
  };

  // Declarations first, so references can resolve against them.
  for (const integration of manifest.integrations ?? []) {
    add('integration', integration.id, {
      detail: integration.required === false ? 'optional' : 'required',
    });
  }
  for (const tool of manifest.tools ?? []) {
    add('tool', tool.id, {
      detail: tool.source === 'catalog' || tool.handler === 'broker' ? 'catalog' : tool.handler,
    });
  }
  for (const agent of manifest.agents ?? []) {
    add('agent', agent.id, { detail: agent.description ?? agent.model });
  }
  for (const workflow of manifest.workflows ?? []) {
    add('workflow', workflow.id, {
      detail: workflow.type === 'team' ? 'team' : `${workflow.steps?.length ?? 0} steps`,
    });
  }

  // A dotted tool id belongs to an integration — that is how the manifest says
  // "this agent may use gmail.send" without declaring a tool of its own.
  const integrationOf = (toolId: string): string | undefined =>
    toolId.includes('.') ? toolId.split('.')[0] : undefined;

  for (const agent of manifest.agents ?? []) {
    const agentKey = nodeId('agent', agent.id);

    if (!agent.systemPrompt && !agent.promptFile) {
      problems.push({
        severity: 'error',
        nodeId: agentKey,
        message: `Agent "${agent.id}" has no instructions — it needs a promptFile or a systemPrompt, or it will refuse to boot.`,
      });
    }

    for (const toolId of agent.tools ?? []) {
      const declared = (manifest.tools ?? []).some((t) => t.id === toolId);
      const provider = integrationOf(toolId);

      if (declared) {
        edges.push({ from: agentKey, to: nodeId('tool', toolId), kind: 'calls' });
      } else if (provider) {
        // An integration tool: draw it, and check the integration is declared.
        const toolKey = add('tool', toolId, { detail: 'from integration' });
        edges.push({ from: agentKey, to: toolKey, kind: 'calls' });

        const declaredIntegration = (manifest.integrations ?? []).some((i) => i.id === provider);
        const integrationKey = declaredIntegration
          ? nodeId('integration', provider)
          : reference('integration', provider, `Agent "${agent.id}"`);
        edges.push({ from: toolKey, to: integrationKey, kind: 'uses' });

        if (declaredIntegration && !(agent.integrations ?? []).includes(provider)) {
          // The runtime grants tools per agent, so this is a real failure and
          // not a style note.
          problems.push({
            severity: 'warning',
            nodeId: agentKey,
            message: `Agent "${agent.id}" calls "${toolId}" but does not list "${provider}" in its own integrations.`,
          });
        }
      } else {
        edges.push({ from: agentKey, to: reference('tool', toolId, `Agent "${agent.id}"`), kind: 'calls' });
      }
    }

    for (const integrationId of agent.integrations ?? []) {
      const key = (manifest.integrations ?? []).some((i) => i.id === integrationId)
        ? nodeId('integration', integrationId)
        : reference('integration', integrationId, `Agent "${agent.id}"`);
      edges.push({ from: agentKey, to: key, kind: 'uses' });
    }
  }

  for (const workflow of manifest.workflows ?? []) {
    const workflowKey = nodeId('workflow', workflow.id);

    for (const teammate of workflow.team ?? []) {
      const key = (manifest.agents ?? []).some((a) => a.id === teammate)
        ? nodeId('agent', teammate)
        : reference('agent', teammate, `Workflow "${workflow.id}"`);
      edges.push({ from: workflowKey, to: key, kind: 'runs', label: 'team' });
    }

    for (const step of workflow.steps ?? []) {
      if (step.agent && step.tool) {
        problems.push({
          severity: 'error',
          nodeId: workflowKey,
          message: `Step "${step.id}" sets both agent and tool — it must set exactly one.`,
        });
      }
      if (!step.agent && !step.tool) {
        problems.push({
          severity: 'error',
          nodeId: workflowKey,
          message: `Step "${step.id}" runs neither an agent nor a tool.`,
        });
        continue;
      }

      const kind: NodeKind = step.agent ? 'agent' : 'tool';
      const target = (step.agent ?? step.tool)!;
      const declared =
        kind === 'agent'
          ? (manifest.agents ?? []).some((a) => a.id === target)
          : (manifest.tools ?? []).some((t) => t.id === target);

      const key = declared
        ? nodeId(kind, target)
        : integrationOf(target) && kind === 'tool'
          ? add('tool', target, { detail: 'from integration' })
          : reference(kind, target, `Workflow "${workflow.id}" step "${step.id}"`);

      edges.push({
        from: workflowKey,
        to: key,
        kind: 'runs',
        ...(step.forEach ? { label: 'for each' } : {}),
      });
    }

    if ((workflow.steps ?? []).length === 0 && (workflow.team ?? []).length === 0) {
      problems.push({
        severity: 'error',
        nodeId: workflowKey,
        message: `Workflow "${workflow.id}" has no steps and no team — there is nothing for it to do.`,
      });
    }
  }

  for (const trigger of manifest.triggers ?? []) {
    const triggerKey = add('trigger', trigger.id, { detail: trigger.type ?? 'SCHEDULE' });

    if (trigger.workflow && trigger.agent) {
      problems.push({
        severity: 'error',
        nodeId: triggerKey,
        message: `Trigger "${trigger.id}" targets both a workflow and an agent — it must fire exactly one.`,
      });
    }
    if (!trigger.workflow && !trigger.agent) {
      problems.push({
        severity: 'error',
        nodeId: triggerKey,
        message: `Trigger "${trigger.id}" fires nothing.`,
      });
      continue;
    }

    const kind: NodeKind = trigger.workflow ? 'workflow' : 'agent';
    const target = (trigger.workflow ?? trigger.agent)!;
    const declared =
      kind === 'workflow'
        ? (manifest.workflows ?? []).some((w) => w.id === target)
        : (manifest.agents ?? []).some((a) => a.id === target);

    edges.push({
      from: triggerKey,
      to: declared ? nodeId(kind, target) : reference(kind, target, `Trigger "${trigger.id}"`),
      kind: 'fires',
    });
  }

  // The hollow-automation check: something must actually be able to run. An
  // automation with agents and tools but nothing to set them off looks complete
  // and never does anything.
  const hasRunnable = (manifest.workflows ?? []).some(
    (w) => (w.steps ?? []).length > 0 || (w.team ?? []).length > 0,
  );
  const hasTrigger = (manifest.triggers ?? []).length > 0;
  if (!hasRunnable && (manifest.agents ?? []).length > 0) {
    problems.push({
      severity: 'error',
      message: 'This automation declares agents but no workflow that runs them.',
    });
  } else if (hasRunnable && !hasTrigger) {
    problems.push({
      severity: 'warning',
      message: 'Nothing fires this automation — it will only run when you press Run.',
    });
  }

  return { nodes: [...nodes.values()], edges, problems };
}

/**
 * Lay the graph out in columns.
 *
 * Deliberately simple and deterministic: nodes stack within their lane in
 * declaration order. A force-directed layout looks impressive and moves things
 * around between renders, which makes a diagram you are trying to read while
 * editing actively worse.
 */
export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
}

export function layout(
  graph: IntelligenceGraph,
  opts: { laneWidth?: number; rowHeight?: number } = {},
): { nodes: LaidOutNode[]; width: number; height: number } {
  const laneWidth = opts.laneWidth ?? 210;
  const rowHeight = opts.rowHeight ?? 64;
  const perLane = new Map<number, number>();

  const nodes = graph.nodes.map((node) => {
    const row = perLane.get(node.lane) ?? 0;
    perLane.set(node.lane, row + 1);
    return { ...node, x: node.lane * laneWidth, y: row * rowHeight };
  });

  const lanes = Math.max(1, ...graph.nodes.map((n) => n.lane + 1));
  const rows = Math.max(1, ...[...perLane.values()]);
  return { nodes, width: lanes * laneWidth, height: rows * rowHeight };
}
