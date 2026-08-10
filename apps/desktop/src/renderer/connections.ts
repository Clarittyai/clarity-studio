/**
 * Which outside services an automation declares, and which of them stop a run.
 *
 * Pulled out of the view because it decides something with a cost. A run that
 * cannot possibly work is not free to start: `client-summary` with Gmail
 * unconnected reached its agent, spent 2.3k tokens over two model calls, could
 * not do the job, and said so in prose rather than returning the shape it had
 * promised. The agent runner rightly refused to guess; the step failed; the skip
 * strategy carried the workflow on; the run recorded SUCCESS and stored every
 * declared output as null.
 *
 * The only point in that sequence anyone can act on is before it starts.
 */

export interface DeclaredIntegration {
  id: string;
  /**
   * `required: false` means the runtime resolves it to null on purpose so a
   * tool can degrade — those must never block a run. Anything not explicitly
   * optional is treated as required, because a manifest that forgot to say
   * should fail closed rather than run without a credential it needs.
   */
  required: boolean;
}

/** What the manifest asks for, with the optional/required distinction kept. */
export function declaredIntegrations(
  manifest: Record<string, unknown> | undefined,
): DeclaredIntegration[] {
  const list =
    (
      manifest as
        | { integrations?: Array<{ id?: string; required?: boolean } | string> }
        | undefined
    )?.integrations ?? [];
  return list
    .map((i) =>
      typeof i === 'string'
        ? { id: i, required: true }
        : { id: i.id ?? '', required: i.required !== false },
    )
    .filter((i) => i.id);
}

/**
 * The required services this automation still has no credential for.
 *
 * `local` means Studio actually has a connector for it. A service with no
 * connector yet cannot be connected from here at all, so blocking on it would
 * leave the person with a button they cannot satisfy — that case has its own
 * message and its own way forward.
 */
export function missingRequired(
  declared: DeclaredIntegration[],
  rows: Array<{ id: string; connected: boolean; local: boolean }>,
): string[] {
  const required = new Set(declared.filter((d) => d.required).map((d) => d.id));
  return rows
    .filter((r) => required.has(r.id) && !r.connected && r.local)
    .map((r) => r.id);
}
