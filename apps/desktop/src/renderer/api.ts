/**
 * The renderer's view of the app.
 *
 * Everything real — the store, Docker, the control plane — lives in the main
 * process. The renderer only ever sees plain data across `contextBridge`, which
 * is what keeps `nodeIntegration` off and means a compromised renderer cannot
 * reach the filesystem or a secret.
 *
 * When `window.studio` is absent we are running in a browser (Vite dev, or a
 * screenshot test), so the fixtures below stand in. They are obviously fake on
 * sight — nobody should mistake seeded data for their own.
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting';
  runtime: 'docker' | 'native';
  hostPort?: number | null;
  lastError?: string | null;
}

export interface Run {
  id: string;
  projectId: string;
  workflowId?: string | null;
  status: 'success' | 'failed' | 'running' | 'skipped';
  triggeredBy: string;
  startedAt: number;
  endedAt?: number | null;
  costMicros: number;
  promptTokens: number;
  completionTokens: number;
  outputs?: unknown;
  error?: string | null;
}

export interface Step {
  runId: string;
  stepId: string;
  status: string;
  startedAt: number;
  endedAt?: number | null;
  output?: unknown;
  error?: string | null;
}

export interface Trigger {
  id: string;
  recipeTriggerId: string;
  type: string;
  enabled: boolean;
  description: string;
  nextRunAt?: number | null;
  lastStatus?: string | null;
  missedCount: number;
}

/** One model call an automation's agent made during a run.
 *  Shape mirrors `Store.getLlmCalls` exactly — no invented fields. */
export interface LlmCall {
  runId: string;
  agentId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  latencyMs: number;
  at: number;
}

/** A model provider, and whether this machine has a key for it. */
export interface ProviderKey {
  id: string;
  hasKey: boolean;
  last4?: string;
  /** Set to point a provider at your own endpoint (an OpenAI-compatible server). */
  baseUrl?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
}

export interface StudioApi {
  /** The project's parsed intelligence.yaml, for the canvas. */
  manifest(projectId: string): Promise<Record<string, unknown> | undefined>;
  /** Coding agents installed on this machine. */
  agents(): Promise<AgentInfo[]>;
  listProjects(): Promise<Project[]>;
  listRuns(projectId: string): Promise<Run[]>;
  listSteps(runId: string): Promise<Step[]>;
  listTriggers(projectId: string): Promise<Trigger[]>;
  spend(projectId: string, sinceMs: number): Promise<{ costMicros: number; calls: number }>;
  /** Start (or reuse) a coding-agent session in the project folder. */
  openTerminal(
    projectId: string,
    request?: string,
    agentId?: string,
  ): Promise<{ agent?: { id: string; name: string }; shell: string }>;
  writeTerminal(projectId: string, data: string): void;
  resizeTerminal(projectId: string, cols: number, rows: number): void;
  closeTerminal(projectId: string): void;
  /** Both return an unsubscribe function. */
  onTerminalData(handler: (projectId: string, data: string) => void): () => void;
  onTerminalExit(handler: (projectId: string, code: number) => void): () => void;
  openExternal(url: string): void;
  /** Providers and whether a key is stored — never the key itself. */
  listKeys(): Promise<ProviderKey[]>;
  setKey(providerId: string, field: 'api_key' | 'base_url', value: string): Promise<void>;
  removeKey(providerId: string, field: 'api_key' | 'base_url'): Promise<void>;
  /** Live-update this project's screen while it is open. */
  watchProject(projectId: string): Promise<void>;
  unwatchProject(projectId: string): void;
  onProjectChanged(handler: (projectId: string, file: string) => void): () => void;
  /** What the automation's own agents actually asked the model, per run. */
  llmCalls(runId: string): Promise<LlmCall[]>;
  /**
   * Scaffold from the seed. `request` is what the person says it should do; it
   * is handed to the coding agent as its opening instruction.
   * Resolves undefined if they cancel the location dialog.
   */
  createProject(
    name: string,
    request?: string,
    dir?: string,
  ): Promise<{ id: string; request?: string } | undefined>;
  /** Only used when someone explicitly changes where automations live. */
  chooseFolder(): Promise<string | undefined>;
  /** The running build, so "am I on an old version" is answerable. */
  appVersion(): Promise<string>;
  /** Window preferences — currently just where new automations go. */
  getSettings(): Promise<{ automationsRoot: string }>;
  chooseAutomationsRoot(): Promise<string | undefined>;
  /** Forget an automation, and optionally erase it. Confirmed in the main process. */
  deleteProject(projectId: string): Promise<{ removed: boolean; deletedFiles?: boolean }>;
  /** Adopt a folder that already has an intelligence.yaml. */
  importProject(): Promise<{ id: string } | undefined>;
  start(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  runWorkflow(projectId: string, workflowId?: string): Promise<void>;
}

declare global {
  interface Window {
    studio?: StudioApi;
  }
}

// ── fixtures, for running the renderer outside Electron ──────────────────────

const now = Date.now();

const demoProjects: Project[] = [
  {
    id: 'demo-1',
    name: 'invoice-chaser',
    path: '~/Automations/invoice-chaser',
    status: 'running',
    runtime: 'docker',
    hostPort: 33001,
  },
  {
    id: 'demo-2',
    name: 'standup-digest',
    path: '~/Automations/standup-digest',
    status: 'stopped',
    runtime: 'native',
    hostPort: 33002,
  },
  {
    id: 'demo-3',
    name: 'churn-watch',
    path: '~/Automations/churn-watch',
    status: 'crashed',
    runtime: 'docker',
    hostPort: 33003,
    lastError: "boot validation failed: agent 'watcher' has no system_prompt or prompt_file",
  },
];

const demoRuns: Run[] = [
  {
    id: 'wfr_3c006cd2_20260803T090000Z',
    projectId: 'demo-1',
    workflowId: 'chase-overdue',
    status: 'success',
    triggeredBy: 'schedule',
    startedAt: now - 42 * 60_000,
    endedAt: now - 42 * 60_000 + 8_400,
    costMicros: 41_200,
    promptTokens: 12_480,
    completionTokens: 1_130,
    outputs: { chased: 3, skipped: 1 },
  },
  {
    id: 'wfr_3c006cd2_20260802T090000Z',
    projectId: 'demo-1',
    workflowId: 'chase-overdue',
    status: 'failed',
    triggeredBy: 'schedule',
    startedAt: now - 26 * 3_600_000,
    endedAt: now - 26 * 3_600_000 + 3_100,
    costMicros: 8_900,
    promptTokens: 3_010,
    completionTokens: 210,
    error: 'gmail.send: integration not connected',
  },
  {
    id: 'wfr_b0597bdf_manual',
    projectId: 'demo-1',
    workflowId: 'chase-overdue',
    status: 'success',
    triggeredBy: 'webhook',
    startedAt: now - 3 * 86_400_000,
    endedAt: now - 3 * 86_400_000 + 9_900,
    costMicros: 39_000,
    promptTokens: 11_900,
    completionTokens: 1_050,
    outputs: { chased: 2 },
  },
];

const demoSteps: Record<string, Step[]> = {
  'wfr_3c006cd2_20260803T090000Z': [
    {
      runId: 'wfr_3c006cd2_20260803T090000Z',
      stepId: 'collect',
      status: 'success',
      startedAt: now - 42 * 60_000,
      endedAt: now - 42 * 60_000 + 1_200,
      output: { invoices: 4 },
    },
    {
      runId: 'wfr_3c006cd2_20260803T090000Z',
      stepId: 'decide',
      status: 'success',
      startedAt: now - 42 * 60_000 + 1_200,
      endedAt: now - 42 * 60_000 + 6_800,
      output: { chase: 3, skip: 1 },
    },
    {
      runId: 'wfr_3c006cd2_20260803T090000Z',
      stepId: 'send',
      status: 'success',
      startedAt: now - 42 * 60_000 + 6_800,
      endedAt: now - 42 * 60_000 + 8_400,
      output: { sent: 3 },
    },
  ],
  'wfr_3c006cd2_20260802T090000Z': [
    {
      runId: 'wfr_3c006cd2_20260802T090000Z',
      stepId: 'collect',
      status: 'success',
      startedAt: now - 26 * 3_600_000,
      endedAt: now - 26 * 3_600_000 + 900,
      output: { invoices: 2 },
    },
    {
      runId: 'wfr_3c006cd2_20260802T090000Z',
      stepId: 'decide',
      status: 'failed',
      startedAt: now - 26 * 3_600_000 + 900,
      endedAt: now - 26 * 3_600_000 + 3_100,
      error: 'gmail.send: integration not connected',
    },
  ],
};

const demoTriggers: Trigger[] = [
  {
    id: '3c006cd2-1111-2222-3333-444455556666',
    recipeTriggerId: 'weekday-morning',
    type: 'SCHEDULE',
    enabled: true,
    description: 'daily at 09:00 Europe/London',
    nextRunAt: now + 18 * 3_600_000,
    lastStatus: 'success',
    missedCount: 0,
  },
  {
    id: '9a1b2c3d-5555-6666-7777-888899990000',
    recipeTriggerId: 'on-invoice-paid',
    type: 'WEBHOOK',
    enabled: true,
    description: 'on webhook',
    lastStatus: 'success',
    missedCount: 0,
  },
];

const demoManifest = {
  id: 'invoice-chaser',
  integrations: [{ id: 'gmail', required: true }, { id: 'stripe', required: true }],
  tools: [{ id: 'app.list_overdue', handler: 'backend.tools.list_overdue:run' }],
  agents: [
    {
      id: 'chaser',
      description: 'Decides which invoices to chase',
      promptFile: 'backend/agents/chaser.md',
      tools: ['app.list_overdue', 'stripe.list_invoices', 'gmail.send'],
      integrations: ['stripe'],
    },
  ],
  workflows: [
    { id: 'chase-overdue', steps: [{ id: 'collect', tool: 'app.list_overdue' }, { id: 'decide', agent: 'chaser' }] },
  ],
  triggers: [
    { id: 'weekday-morning', type: 'SCHEDULE', workflow: 'chase-overdue' },
    { id: 'on-invoice-paid', type: 'WEBHOOK', workflow: 'chase-overdue' },
  ],
};

const fixtures: StudioApi = {
  async manifest() {
    return demoManifest;
  },
  async agents() {
    return [
      { id: 'claude', name: 'Claude Code', version: '2.1.4' },
      { id: 'codex', name: 'Codex', version: '0.9.2' },
    ];
  },
  async listProjects() {
    return demoProjects;
  },
  async listRuns(projectId) {
    return demoRuns.filter((r) => r.projectId === projectId);
  },
  async listSteps(runId) {
    return demoSteps[runId] ?? [];
  },
  async listTriggers(projectId) {
    return projectId === 'demo-1' ? demoTriggers : [];
  },
  async spend() {
    return { costMicros: 89_100, calls: 12 };
  },
  async openTerminal() {
    return { agent: { id: 'claude', name: 'Claude Code' }, shell: 'demo' };
  },
  writeTerminal() {},
  resizeTerminal() {},
  closeTerminal() {},
  onTerminalData() {
    return () => {};
  },
  onTerminalExit() {
    return () => {};
  },
  openExternal() {},
  async listKeys() {
    return [
      { id: 'anthropic', hasKey: true, last4: '7f3a' },
      { id: 'openai', hasKey: false },
    ];
  },
  async setKey() {},
  async removeKey() {},
  async watchProject() {},
  unwatchProject() {},
  onProjectChanged() {
    return () => {};
  },
  async llmCalls() {
    return [];
  },
  async createProject() {
    return undefined;
  },
  async chooseFolder() {
    return undefined;
  },
  async appVersion() {
    return 'demo';
  },
  async getSettings() {
    return { automationsRoot: '~/Automations' };
  },
  async chooseAutomationsRoot() {
    return undefined;
  },
  async deleteProject() {
    return { removed: false };
  },
  async importProject() {
    return undefined;
  },
  async start() {},
  async stop() {},
  async runWorkflow() {},
};

export const api: StudioApi = typeof window !== 'undefined' && window.studio ? window.studio : fixtures;

/** True when we are showing seeded data rather than the user's own. */
export const isDemo = !(typeof window !== 'undefined' && window.studio);
