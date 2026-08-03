/**
 * Host port allocation.
 *
 * N automations run at once, each publishing 3200. Studio hands out a distinct
 * host port per project and remembers it, so a restart doesn't shuffle every
 * bookmark the user made.
 *
 * The allocator probes before committing rather than trusting its own records:
 * something outside Studio may hold the port, and finding that out at
 * `docker compose up` time produces a far worse error than finding it out here.
 */

import { createServer } from 'node:net';

export const PORT_RANGE = { start: 33_000, end: 33_999 } as const;

export interface PortRegistry {
  /** Port already assigned to this project, if any. */
  get(projectId: string): number | undefined;
  set(projectId: string, port: number): void;
  release(projectId: string): void;
  /** Every currently assigned port. */
  taken(): Set<number>;
}

export class MemoryPortRegistry implements PortRegistry {
  private byProject = new Map<string, number>();

  get(projectId: string) {
    return this.byProject.get(projectId);
  }
  set(projectId: string, port: number) {
    this.byProject.set(projectId, port);
  }
  release(projectId: string) {
    this.byProject.delete(projectId);
  }
  taken() {
    return new Set(this.byProject.values());
  }
}

/** True when nothing is listening on the port on the loopback interface. */
export async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Allocate a stable port for a project.
 *
 * Prefers the port the project had last time — a URL the user pinned should
 * keep working across restarts — and only moves on if something else has taken
 * it in the meantime.
 */
export async function allocatePort(
  projectId: string,
  registry: PortRegistry,
  probe: (port: number) => Promise<boolean> = isFree,
): Promise<number> {
  const previous = registry.get(projectId);
  if (previous !== undefined && (await probe(previous))) return previous;

  const taken = registry.taken();
  for (let port = PORT_RANGE.start; port <= PORT_RANGE.end; port++) {
    if (taken.has(port)) continue;
    if (await probe(port)) {
      registry.set(projectId, port);
      return port;
    }
  }
  throw new Error(
    `No free host port in ${PORT_RANGE.start}–${PORT_RANGE.end}. ` +
      `Stop an automation you are not using, or widen the range in Settings.`,
  );
}
