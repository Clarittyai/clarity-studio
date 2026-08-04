/**
 * Manifest → pipeline blocks.
 *
 * The platform's automation page renders a *recorder* automation: a list of
 * actions, each with a provider and a tier. Studio renders a *manifest*
 * automation: workflow steps that call an agent or a tool. The visual language
 * is the same; the data is not. This is the translation, kept apart from the
 * rendering so the geometry stays a straight port.
 *
 * Nothing here invents detail. A step shows what the manifest actually declares
 * — if there is no description, the card simply has no purpose line, rather than
 * a generated sentence that reads like fact.
 */

/** Which badge a step's work carries. Mirrors the platform's tiers. */
export type Tier = 'integration' | 'platform' | 'mcp' | 'agent';

export interface FlowStep {
  /** The step's own id — the bold word on the card. */
  id: string;
  /** What it runs: an agent id or a tool id. */
  action: string;
  /** Reads as a sentence after the action. */
  detail?: string;
  tier: Tier;
  /** The integration a tool belongs to (`gmail.send` → `gmail`). */
  provider?: string;
  /** An agent step is where the model decides — the violet chip. */
  isAgent: boolean;
  /** Present when the step repeats over a collection. */
  forEach?: string;
  /** Only ever the manifest's own words. */
  purpose?: string;
}

export interface Flow {
  workflowId: string;
  /** The schedule or event that starts it, if a trigger declares one. */
  trigger?: { label: string; kind: string };
  steps: FlowStep[];
}

interface ManifestLike {
  integrations?: Array<{ id?: string } | string>;
  tools?: Array<{ id?: string; handler?: string; description?: string }>;
  agents?: Array<{ id?: string; description?: string }>;
  workflows?: Array<{
    id?: string;
    steps?: Array<{
      id?: string;
      agent?: string;
      tool?: string;
      forEach?: string;
      for_each?: string;
      description?: string;
    }>;
  }>;
  triggers?: Array<{
    id?: string;
    type?: string;
    workflow?: string;
    name?: string;
    schedule?: { time?: string; timezone?: string; mode?: string; everyMinutes?: number };
  }>;
}

const idOf = (v: { id?: string } | string | undefined): string | undefined =>
  typeof v === 'string' ? v : v?.id;

/**
 * Read the flow for one workflow. Defaults to the first, which is what the
 * project screen shows — most automations declare exactly one.
 */
export function toFlow(manifest: unknown, workflowId?: string): Flow | undefined {
  const m = manifest as ManifestLike | undefined;
  const workflows = m?.workflows ?? [];
  const workflow = workflowId ? workflows.find((w) => w.id === workflowId) : workflows[0];
  if (!workflow?.id) return undefined;

  const integrations = new Set(
    (m?.integrations ?? []).map((i) => idOf(i)).filter((v): v is string => Boolean(v)),
  );
  const toolById = new Map((m?.tools ?? []).map((t) => [t.id ?? '', t]));
  const agentById = new Map((m?.agents ?? []).map((a) => [a.id ?? '', a]));

  const trigger = (m?.triggers ?? []).find((t) => t.workflow === workflow.id);

  const steps: FlowStep[] = (workflow.steps ?? []).map((step, i) => {
    const forEach = step.forEach ?? step.for_each;
    if (step.agent) {
      const agent = agentById.get(step.agent);
      return {
        id: step.id ?? `step-${i + 1}`,
        action: step.agent,
        detail: 'decides what to do',
        tier: 'agent',
        isAgent: true,
        forEach,
        purpose: step.description ?? agent?.description,
      };
    }

    const toolId = step.tool ?? '';
    const tool = toolById.get(toolId);
    // `gmail.send` → provider `gmail`, but only when the manifest actually
    // declares that integration. Otherwise it is just a namespaced local tool.
    const prefix = toolId.includes('.') ? toolId.slice(0, toolId.indexOf('.')) : undefined;
    const provider = prefix && integrations.has(prefix) ? prefix : undefined;
    const tier: Tier = provider ? 'integration' : tool?.handler === 'mcp' ? 'mcp' : 'platform';

    return {
      id: step.id ?? `step-${i + 1}`,
      action: toolId ? (provider ? toolId.slice(toolId.indexOf('.') + 1) : toolId) : (step.id ?? ''),
      detail: undefined,
      tier,
      provider,
      isAgent: false,
      forEach,
      purpose: step.description ?? tool?.description,
    };
  });

  return { workflowId: workflow.id, trigger: triggerLabel(trigger), steps };
}

type ManifestTrigger = NonNullable<ManifestLike['triggers']>[number];

function triggerLabel(trigger: ManifestTrigger | undefined): Flow['trigger'] {
  if (!trigger) return undefined;
  const kind = (trigger.type ?? 'SCHEDULE').toUpperCase();
  if (kind === 'WEBHOOK') return { label: trigger.name ?? 'When a webhook arrives', kind };

  const s = trigger.schedule;
  if (s?.mode === 'INTERVAL' && s.everyMinutes) {
    return { label: `Every ${s.everyMinutes} minutes`, kind };
  }
  if (s?.time) {
    return { label: `Every day at ${s.time}${s.timezone ? ` ${s.timezone}` : ''}`, kind };
  }
  return { label: trigger.name ?? trigger.id ?? 'On a schedule', kind };
}
