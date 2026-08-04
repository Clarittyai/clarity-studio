/**
 * Where the CLI gets its secrets.
 *
 * The vault first, environment variables second. That order matters: a key you
 * deliberately stored should not be silently overridden by a stale shell
 * export, but CI has no keyring and needs the env path to work.
 */

import { Store } from '@clarity-studio/db';
import type { SecretSource } from '@clarity-studio/control-plane';
import { EnvSecretSource } from '@clarity-studio/control-plane';
import {
  EnvBackend,
  PassphraseBackend,
  Vault,
  type VaultStorage,
} from '@clarity-studio/vault';

/** Bridges the vault's storage interface onto the SQLite store. */
export function vaultStorage(store: Store): VaultStorage {
  return {
    put: (key, ciphertext, last4) => store.putSecret(key, ciphertext, last4),
    get: (key) => store.getSecret(key),
    remove: (key) => store.removeSecret(key),
    list: () => store.listSecrets(),
  };
}

/**
 * Open the vault for a headless session.
 *
 * With `STUDIO_VAULT_PASSPHRASE` set, secrets can be stored and read. Without
 * it the vault is read-only and Studio says so rather than pretending it saved
 * something — the desktop app uses the OS keyring instead and needs no
 * passphrase at all.
 */
export function openVault(store: Store): Vault {
  const passphrase = process.env.STUDIO_VAULT_PASSPHRASE;
  const backend = passphrase ? new PassphraseBackend(passphrase) : new EnvBackend();
  return new Vault(backend, vaultStorage(store));
}

/**
 * A SecretSource the control plane can use, reading the vault and falling back
 * to the environment.
 */
export class VaultSecretSource implements SecretSource {
  private readonly env = new EnvSecretSource();

  constructor(private readonly vault: Vault) {}

  async providerKey(providerId: string): Promise<string | undefined> {
    const stored = this.vault.get({ kind: 'provider', id: providerId, field: 'api_key' });
    if (stored) return stored;
    return this.env.providerKey(providerId);
  }

  async providerBaseUrl(providerId: string): Promise<string | undefined> {
    return (
      this.vault.get({ kind: 'provider', id: providerId, field: 'base_url' }) ??
      (await this.env.providerBaseUrl?.(providerId))
    );
  }

  async integrationCredentials(
    projectId: string,
    integrationId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const bundle = this.vault.bundle(integrationId, projectId);
    if (bundle) return bundle;
    return this.env.integrationCredentials(projectId, integrationId);
  }

  async allSecretValues(): Promise<string[]> {
    // Both sources, because the redactor must know about every secret that
    // could appear in output — including ones it cannot itself write.
    return [...this.vault.allValues(), ...(await this.env.allSecretValues())];
  }
}
