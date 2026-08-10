import { describe, expect, it } from 'vitest';

import { declaredIntegrations, missingRequired } from './connections.js';

/**
 * What decides whether a run is allowed to start.
 *
 * Written after watching `client-summary` run with Gmail unconnected: it
 * reached its agent, spent 2.3k tokens over two model calls, could not do the
 * job, and answered in prose rather than the shape it had promised. The runner
 * refused to guess — correctly — the step failed, the skip strategy carried the
 * workflow on, and the run recorded SUCCESS with every declared output null.
 *
 * The gate is the only point in that sequence anyone can act on, so it is worth
 * more than a glance at the view that calls it.
 */
describe('the services an automation declares', () => {
  it('treats anything not explicitly optional as required', () => {
    // A manifest that forgot to say should fail closed. Running without a
    // credential it needs is the expensive direction to be wrong in.
    expect(declaredIntegrations({ integrations: [{ id: 'gmail' }] })).toEqual([
      { id: 'gmail', required: true },
    ]);
    expect(declaredIntegrations({ integrations: ['slack'] })).toEqual([
      { id: 'slack', required: true },
    ]);
  });

  it('keeps an explicit optional optional', () => {
    expect(
      declaredIntegrations({ integrations: [{ id: 'notion', required: false }] }),
    ).toEqual([{ id: 'notion', required: false }]);
  });

  it('reads an automation that declares none, and one with no manifest yet', () => {
    expect(declaredIntegrations({})).toEqual([]);
    expect(declaredIntegrations(undefined)).toEqual([]);
  });

  it('drops an entry with no id rather than inventing one', () => {
    expect(declaredIntegrations({ integrations: [{ required: true }] })).toEqual([]);
  });
});

describe('what stops a run', () => {
  const rows = (
    ...xs: Array<[string, boolean, boolean]>
  ): Array<{ id: string; connected: boolean; local: boolean }> =>
    xs.map(([id, connected, local]) => ({ id, connected, local }));

  it('names a required service with no credential', () => {
    expect(
      missingRequired(
        [{ id: 'gmail', required: true }],
        rows(['gmail', false, true]),
      ),
    ).toEqual(['gmail']);
  });

  it('lets an OPTIONAL one through, because degrading is what it is for', () => {
    // The runtime resolves an optional integration to null on purpose so a tool
    // can cope. Blocking here would stop an automation designed to work without
    // it — the opposite of the bug this gate exists for.
    expect(
      missingRequired(
        [{ id: 'notion', required: false }],
        rows(['notion', false, true]),
      ),
    ).toEqual([]);
  });

  it('says nothing when everything required is connected', () => {
    expect(
      missingRequired(
        [
          { id: 'gmail', required: true },
          { id: 'slack', required: true },
        ],
        rows(['gmail', true, true], ['slack', true, true]),
      ),
    ).toEqual([]);
  });

  it('does not block on a service Studio has no connector for', () => {
    // Nothing here can connect it, so blocking would leave a button the person
    // cannot satisfy. That case has its own message and its own way forward.
    expect(
      missingRequired(
        [{ id: 'sap', required: true }],
        rows(['sap', false, false]),
      ),
    ).toEqual([]);
  });

  it('names every missing one, not just the first', () => {
    expect(
      missingRequired(
        [
          { id: 'gmail', required: true },
          { id: 'slack', required: true },
          { id: 'notion', required: false },
        ],
        rows(['gmail', false, true], ['slack', false, true], ['notion', false, true]),
      ),
    ).toEqual(['gmail', 'slack']);
  });
});
