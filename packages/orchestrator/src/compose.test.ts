import { describe, expect, it } from 'vitest';

import { buildComposeOverride, composeArgs, composeSupportsListOverride } from './compose.js';
import { allocatePort, MemoryPortRegistry, PORT_RANGE } from './ports.js';

const baseOpts = {
  hostPort: 33001,
  projectId: 'proj-1',
  environment: {
    CLARITTY_PLATFORM_URL: 'http://host.docker.internal:4319',
    CLARITTY_AUTH_TOKEN: 'stk_abc123',
    ENABLE_DEBUG: 'false',
  },
};

describe('compose override', () => {
  it('binds the published port to loopback only', () => {
    // Binding 0.0.0.0 would expose someone's automation — and its webhook
    // endpoints — to their whole coffee-shop network.
    const yaml = buildComposeOverride(baseOpts);
    expect(yaml).toContain('"127.0.0.1:33001:3200"');
    expect(yaml).not.toContain('"33001:3200"');
  });

  it('replaces the automation\'s port list instead of adding to it', () => {
    // The test above asserts what Studio WRITES; this one is about what Compose
    // then DOES with it. Compose appends list values, so without `!override` the
    // automation's own `3200:3200` survived next to ours, and three things broke
    // at once: only one automation could run at a time (every automation ships
    // that same portable compose file, so the second collided), the failure named
    // a port Studio never chose, and the inherited mapping published on 0.0.0.0 —
    // undoing the loopback binding the test above is there to protect.
    expect(buildComposeOverride(baseOpts)).toContain('ports: !override');
  });

  it('disables Docker restart so a crash is visible instead of a loop', () => {
    expect(buildComposeOverride(baseOpts)).toContain('restart: "no"');
  });

  it('adds host-gateway so Linux containers can reach the control plane', () => {
    expect(buildComposeOverride(baseOpts)).toContain('host.docker.internal:host-gateway');
  });

  it('passes the environment through verbatim', () => {
    const yaml = buildComposeOverride(baseOpts);
    expect(yaml).toContain('CLARITTY_AUTH_TOKEN: stk_abc123');
    expect(yaml).toContain('ENABLE_DEBUG: "false"');
  });

  it('applies limits only when asked', () => {
    expect(buildComposeOverride(baseOpts)).not.toContain('mem_limit');
    const limited = buildComposeOverride({ ...baseOpts, memory: '1g', cpus: 2 });
    expect(limited).toContain('mem_limit: 1g');
    expect(limited).toContain('cpus: 2');
  });

  it('cuts off egress in strict mode', () => {
    const yaml = buildComposeOverride({ ...baseOpts, strictEgress: true });
    expect(yaml).toContain('internal: true');
  });

  it('namespaces the compose project so two automations never collide', () => {
    expect(composeArgs({ projectId: 'p', composeFile: 'a.yml', overrideFile: 'b.yml' })).toEqual([
      'compose', '-p', 'studio-p', '-f', 'a.yml', '-f', 'b.yml',
    ]);
  });
});

describe('port allocation', () => {
  it('keeps a project on the same port across restarts', async () => {
    const reg = new MemoryPortRegistry();
    const free = async () => true;
    const first = await allocatePort('p1', reg, free);
    const second = await allocatePort('p1', reg, free);
    expect(second).toBe(first);
  });

  it('moves the project when something else took its port', async () => {
    const reg = new MemoryPortRegistry();
    reg.set('p1', PORT_RANGE.start);
    const busy = new Set<number>([PORT_RANGE.start]);
    const port = await allocatePort('p1', reg, async (p) => !busy.has(p));
    expect(port).toBe(PORT_RANGE.start + 1);
  });

  it('never hands the same port to two projects', async () => {
    const reg = new MemoryPortRegistry();
    const free = async () => true;
    const a = await allocatePort('a', reg, free);
    const b = await allocatePort('b', reg, free);
    expect(a).not.toBe(b);
  });

  it('fails with an actionable message when the range is exhausted', async () => {
    const reg = new MemoryPortRegistry();
    await expect(allocatePort('p', reg, async () => false)).rejects.toThrow(/No free host port/);
  });
});

describe('the Compose version gate', () => {
  // `!override` is not ignored by an old Compose — it fails to parse the file,
  // so every start dies with a YAML error that says nothing about ports or
  // versions. `doctor` names the real requirement instead.
  it('accepts the versions that understand the tag', () => {
    expect(composeSupportsListOverride('2.24.0')).toBe(true);
    expect(composeSupportsListOverride('v2.40.2-desktop.1')).toBe(true);
    expect(composeSupportsListOverride('v3.0.0')).toBe(true);
    expect(composeSupportsListOverride('2.24.1')).toBe(true);
  });

  it('rejects the versions that do not', () => {
    expect(composeSupportsListOverride('2.23.3')).toBe(false);
    expect(composeSupportsListOverride('v2.5.0')).toBe(false);
    expect(composeSupportsListOverride('1.29.2')).toBe(false);
  });

  it('does not block on a version string it cannot read', () => {
    // Some distributions print something unexpected here. Refusing to run on an
    // unparseable string would break more people than the bug it guards against.
    expect(composeSupportsListOverride('')).toBe(true);
    expect(composeSupportsListOverride('unknown')).toBe(true);
  });
});
