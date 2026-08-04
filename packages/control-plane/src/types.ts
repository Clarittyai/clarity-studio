/** Shared shapes for the local control plane. */

/** A project registered with Studio. One automation, one container. */
export interface ProjectIdentity {
  /** Stable id. Becomes CLARITY_APP_ID inside the container. */
  id: string;
  /** Per-project bearer for /api/v1/*. Not a provider key, not an account token. */
  authToken: string;
  /** Per-project shared secret for /internal/*. */
  internalSecret: string;
  /** HMAC(masterKey, projectId) — proves which project is calling. */
  appSecret: string;
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  /** May be null — the SDK passes through whatever the agent declared, and an
   *  agent that declares no model sends nothing. We substitute the default. */
  model?: string | null;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  thinking?: { type?: string; budget_tokens?: number };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** What a provider adapter must implement. Adapters translate to and from each
 *  vendor's native shape; everything upstream of them speaks OpenAI. */
export interface Provider {
  readonly id: string;
  /** True when this adapter handles the given model id. */
  handles(model: string): boolean;
  complete(
    req: ChatCompletionRequest,
    ctx: { apiKey: string; baseUrl?: string; signal?: AbortSignal },
  ): Promise<ChatCompletionResponse>;
}

/** Where secrets come from. Backed by the OS keychain in the desktop app; by an
 *  env-var reader in the CLI; by a fixture in tests. */
export interface SecretSource {
  /** Provider API key, e.g. providerKey('anthropic'). */
  providerKey(providerId: string): Promise<string | undefined>;
  /** Decrypted credential bundle for an integration, scoped to a user. */
  integrationCredentials(
    projectId: string,
    integrationId: string,
    userId: string,
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Where to send this provider's calls, when it is not the vendor's own API —
   * a local model, or a gateway. Optional: a source that does not implement it
   * simply has no custom endpoints.
   */
  providerBaseUrl?(providerId: string): Promise<string | undefined>;
  /** Every literal secret value currently held, for exact-match redaction. */
  allSecretValues(): Promise<string[]>;
}

export interface StepCheckpoint {
  runId: string;
  stepId: string;
  status: string;
  output?: unknown;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

export interface RunCompletion {
  runId: string;
  status: string;
  outputs?: unknown;
  error?: string | null;
}

export interface LlmCallRecord {
  runId?: string;
  agentId?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  latencyMs: number;
  at: number;
}

/** Everything the control plane persists. The desktop app backs this with
 *  SQLite; the M0 spike backs it with memory. */
export interface RunStore {
  checkpointStep(cp: StepCheckpoint): void;
  completeRun(rc: RunCompletion): void;
  recordLlmCall(rec: LlmCallRecord): void;
  getRun(runId: string): { status: string; outputs?: unknown; error?: string | null } | undefined;
  getSteps(runId: string): StepCheckpoint[];
  getLlmCalls(runId: string): LlmCallRecord[];
}
