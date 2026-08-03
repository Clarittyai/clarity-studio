/**
 * Environment-backed {@link SecretSource} for the CLI and for tests.
 *
 * The desktop app uses the OS keychain instead. This one exists so a headless
 * run — CI, a server, `claritty-studio run` over SSH — has a way to supply keys
 * without a keyring, and it is deliberately the *only* place in Studio that
 * reads a provider key out of the environment.
 *
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY
 *   STUDIO_CREDS_<INTEGRATION_ID>   JSON blob, e.g. {"api_key":"..."}
 *
 * Integration ids are normalised for the env-var name: `google-calendar`
 * becomes `STUDIO_CREDS_GOOGLE_CALENDAR`. (The SDK's own escape hatch uses the
 * raw id, which produces `..._GOOGLE-CALENDAR` — a name most shells cannot set.
 * Not repeating that.)
 */

import type { SecretSource } from './types.js';

const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  simulator: 'STUDIO_SIMULATOR_KEY',
};

export function envVarForIntegration(integrationId: string): string {
  return `STUDIO_CREDS_${integrationId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export class EnvSecretSource implements SecretSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async providerKey(providerId: string): Promise<string | undefined> {
    const name = PROVIDER_ENV[providerId];
    if (!name) return undefined;
    return this.env[name] || undefined;
  }

  async integrationCredentials(
    _projectId: string,
    integrationId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const raw = this.env[envVarForIntegration(integrationId)];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${envVarForIntegration(integrationId)} is not valid JSON. ` +
          `Expected something like {"api_key":"..."}.`,
      );
    }
  }

  async allSecretValues(): Promise<string[]> {
    const values: string[] = [];
    for (const name of Object.values(PROVIDER_ENV)) {
      const v = this.env[name];
      if (v) values.push(v);
    }
    for (const [key, value] of Object.entries(this.env)) {
      if (!key.startsWith('STUDIO_CREDS_') || !value) continue;
      try {
        collectStrings(JSON.parse(value), values);
      } catch {
        values.push(value);
      }
    }
    return values;
  }
}

function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, into, depth + 1));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, into, depth + 1));
  }
}
