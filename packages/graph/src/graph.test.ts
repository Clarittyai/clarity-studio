import { describe, expect, it } from 'vitest';

import { buildGraph, layout, type ManifestLike } from './graph.js';

const healthy: ManifestLike = {
  id: 'chaser',
  integrations: [{ id: 'gmail', required: true }],
  tools: [{ id: 'app.list_overdue', handler: 'backend.tools.list:run' }],
  agents: [
    { id: 'chaser', promptFile: 'backend/agents/chaser.md', tools: ['app.list_overdue', 'gmail.send'], integrations: ['gmail'] },
  ],
  workflows: [{ id: 'chase', steps: [{ id: 'run', agent: 'chaser' }] }],
  triggers: [{ id: 'weekday', type: 'SCHEDULE', workflow: 'chase' }],
};

const find = (g: ReturnType<typeof buildGraph>, id: string) => g.nodes.find((n) => n.id === id);

describe('a healthy manifest', () => {
  it('draws every primitive, in the order it runs', () => {
    const g = buildGraph(healthy);
    expect(find(g, 'trigger:weekday')!.lane).toBe(0);
    expect(find(g, 'workflow:chase')!.lane).toBe(1);
    expect(find(g, 'agent:chaser')!.lane).toBe(2);
    expect(find(g, 'tool:app.list_overdue')!.lane).toBe(3);
    expect(find(g, 'integration:gmail')!.lane).toBe(4);
  });

  it('connects trigger → workflow → agent → tool → integration', () => {
    const g = buildGraph(healthy);
    expect(g.edges).toContainEqual({ from: 'trigger:weekday', to: 'workflow:chase', kind: 'fires' });
    expect(g.edges).toContainEqual({ from: 'workflow:chase', to: 'agent:chaser', kind: 'runs' });
    expect(g.edges).toContainEqual({ from: 'agent:chaser', to: 'tool:gmail.send', kind: 'calls' });
    expect(g.edges).toContainEqual({ from: 'tool:gmail.send', to: 'integration:gmail', kind: 'uses' });
  });

  it('reports no problems', () => {
    expect(buildGraph(healthy).problems).toEqual([]);
  });
});

describe('drawing what is broken', () => {
  it('shows a dangling agent reference as a missing node rather than hiding it', () => {
    const g = buildGraph({
      ...healthy,
      workflows: [{ id: 'chase', steps: [{ id: 'run', agent: 'deleted-agent' }] }],
    });
    // A tidy canvas that silently omits the broken reference hides exactly the
    // bug you opened it to find.
    expect(find(g, 'agent:deleted-agent')?.missing).toBe(true);
    expect(g.problems.some((p) => p.message.includes('deleted-agent'))).toBe(true);
  });

  it('flags an agent with no instructions', () => {
    const g = buildGraph({ ...healthy, agents: [{ id: 'chaser', tools: [] }] });
    expect(g.problems.some((p) => /no instructions/.test(p.message))).toBe(true);
  });

  it('flags an agent using an integration tool it did not grant itself', () => {
    const g = buildGraph({
      ...healthy,
      agents: [{ id: 'chaser', promptFile: 'p.md', tools: ['gmail.send'], integrations: [] }],
    });
    // The runtime grants tools per agent, so this is a real failure at run time
    // rather than a style note.
    expect(g.problems.some((p) => /does not list "gmail"/.test(p.message))).toBe(true);
  });

  it('flags a step that runs both an agent and a tool', () => {
    const g = buildGraph({
      ...healthy,
      workflows: [{ id: 'chase', steps: [{ id: 'run', agent: 'chaser', tool: 'app.list_overdue' }] }],
    });
    expect(g.problems.some((p) => /exactly one/.test(p.message))).toBe(true);
  });

  it('flags a trigger that fires both, and one that fires nothing', () => {
    expect(
      buildGraph({ ...healthy, triggers: [{ id: 't', workflow: 'chase', agent: 'chaser' }] })
        .problems.some((p) => /fire exactly one/.test(p.message)),
    ).toBe(true);
    expect(
      buildGraph({ ...healthy, triggers: [{ id: 't' }] })
        .problems.some((p) => /fires nothing/.test(p.message)),
    ).toBe(true);
  });

  it('flags an empty workflow', () => {
    const g = buildGraph({ ...healthy, workflows: [{ id: 'chase', steps: [] }] });
    expect(g.problems.some((p) => /no steps and no team/.test(p.message))).toBe(true);
  });

  it('warns when nothing fires the automation', () => {
    const g = buildGraph({ ...healthy, triggers: [] });
    // Not an error: running by hand is legitimate while building. But an
    // automation nobody starts is worth saying out loud.
    const problem = g.problems.find((p) => /Nothing fires/.test(p.message));
    expect(problem?.severity).toBe('warning');
  });

  it('flags agents that no workflow runs', () => {
    const g = buildGraph({ ...healthy, workflows: [] });
    expect(g.problems.some((p) => /no workflow that runs them/.test(p.message))).toBe(true);
  });

  it('stops marking a node missing once its declaration appears', () => {
    const g = buildGraph(healthy);
    expect(find(g, 'agent:chaser')?.missing).toBeUndefined();
  });
});

describe('team workflows and fan-out', () => {
  it('draws a team roster', () => {
    const g = buildGraph({
      ...healthy,
      workflows: [{ id: 'chase', type: 'team', team: ['chaser'] }],
    });
    expect(g.edges).toContainEqual({ from: 'workflow:chase', to: 'agent:chaser', kind: 'runs', label: 'team' });
    expect(find(g, 'workflow:chase')!.detail).toBe('team');
  });

  it('labels a fan-out step', () => {
    const g = buildGraph({
      ...healthy,
      workflows: [{ id: 'chase', steps: [{ id: 'run', tool: 'app.list_overdue', forEach: '${steps.a.output.items}' }] }],
    });
    // Two edges point at this tool — the agent calls it and the workflow runs
    // it. Only the workflow's carries the fan-out label.
    const fromWorkflow = g.edges.find(
      (e) => e.from === 'workflow:chase' && e.to === 'tool:app.list_overdue',
    );
    expect(fromWorkflow?.label).toBe('for each');
  });
});

describe('layout', () => {
  it('is deterministic across renders', () => {
    const g = buildGraph(healthy);
    // A layout that shifts between renders makes a diagram you are reading
    // while editing actively harder to follow.
    expect(layout(g).nodes).toEqual(layout(g).nodes);
  });

  it('stacks nodes within their lane', () => {
    const g = buildGraph({
      ...healthy,
      agents: [
        { id: 'a', promptFile: 'p.md' },
        { id: 'b', promptFile: 'p.md' },
      ],
      workflows: [{ id: 'chase', steps: [{ id: 's1', agent: 'a' }, { id: 's2', agent: 'b' }] }],
    });
    const laid = layout(g).nodes;
    const [a, b] = [laid.find((n) => n.id === 'agent:a')!, laid.find((n) => n.id === 'agent:b')!];
    expect(a.x).toBe(b.x);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it('handles an empty manifest without dividing by zero', () => {
    const { width, height, nodes } = layout(buildGraph({}));
    expect(nodes).toEqual([]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
