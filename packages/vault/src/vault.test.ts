import { describe, expect, it } from 'vitest';

import {
  EnvBackend,
  PassphraseBackend,
  SafeStorageBackend,
  Vault,
  VaultUnavailableError,
  secretKey,
  type SafeStorageLike,
  type VaultStorage,
} from './vault.js';

/** Storage that keeps ciphertext in memory, so tests can inspect what was
 *  actually written to disk-equivalent. */
class MemoryStorage implements VaultStorage {
  readonly rows = new Map<string, { ciphertext: Buffer; last4: string; createdAt: number; updatedAt: number }>();

  put(key: string, ciphertext: Buffer, last4: string) {
    const existing = this.rows.get(key);
    this.rows.set(key, {
      ciphertext,
      last4,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }
  get(key: string) {
    return this.rows.get(key)?.ciphertext;
  }
  remove(key: string) {
    this.rows.delete(key);
  }
  list() {
    return [...this.rows.entries()].map(([key, v]) => ({
      key, last4: v.last4, createdAt: v.createdAt, updatedAt: v.updatedAt,
    }));
  }
}

const fakeSafeStorage = (available: boolean): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
});

describe('storing and reading', () => {
  it('round-trips a provider key', () => {
    const storage = new MemoryStorage();
    const vault = new Vault(new PassphraseBackend('correct horse battery'), storage);

    vault.set({ kind: 'provider', id: 'anthropic', field: 'api_key' }, 'sk-ant-secret-value');

    expect(vault.get({ kind: 'provider', id: 'anthropic', field: 'api_key' })).toBe('sk-ant-secret-value');
  });

  it('never writes the plaintext to storage', () => {
    const storage = new MemoryStorage();
    const vault = new Vault(new PassphraseBackend('correct horse battery'), storage);
    vault.set({ kind: 'provider', id: 'openai', field: 'api_key' }, 'sk-plaintext-must-not-appear');

    const written = [...storage.rows.values()].map((r) => r.ciphertext.toString('utf8')).join('');
    expect(written).not.toContain('sk-plaintext-must-not-appear');
  });

  it('exposes only the last four characters as metadata', () => {
    const storage = new MemoryStorage();
    const vault = new Vault(new PassphraseBackend('correct horse battery'), storage);
    vault.set({ kind: 'provider', id: 'openai', field: 'api_key' }, 'sk-abcdefgh1234');

    const [entry] = vault.list();
    expect(entry!.last4).toBe('1234');
    expect(JSON.stringify(entry)).not.toContain('abcdefgh');
  });

  it('assembles an integration bundle in the shape the SDK expects', () => {
    const storage = new MemoryStorage();
    const vault = new Vault(new PassphraseBackend('correct horse battery'), storage);
    vault.set({ kind: 'integration', id: 'slack', field: 'bot_token' }, 'xoxb-123456789');
    vault.set({ kind: 'integration', id: 'slack', field: 'team_id' }, 'T012345');

    expect(vault.bundle('slack')).toEqual({ bot_token: 'xoxb-123456789', team_id: 'T012345' });
  });

  it('lets a project-scoped credential override the machine-wide one', () => {
    const storage = new MemoryStorage();
    const vault = new Vault(new PassphraseBackend('correct horse battery'), storage);
    vault.set({ kind: 'integration', id: 'github', field: 'token' }, 'ghp_default_token');
    vault.set({ kind: 'integration', id: 'github', field: 'token', projectId: 'p1' }, 'ghp_project_token');

    // Two automations may legitimately need different accounts for the same
    // service, so the more specific setting has to win.
    expect(vault.bundle('github', 'p1')?.token).toBe('ghp_project_token');
    expect(vault.bundle('github')?.token).toBe('ghp_default_token');
  });

  it('returns undefined rather than an empty bundle when nothing is connected', () => {
    const vault = new Vault(new PassphraseBackend('correct horse battery'), new MemoryStorage());
    // The SDK maps a missing bundle to CredentialsNotAvailable, which optional
    // integrations degrade on. An empty object would look connected.
    expect(vault.bundle('notion')).toBeUndefined();
  });

  it('forgets a removed secret', () => {
    const vault = new Vault(new PassphraseBackend('correct horse battery'), new MemoryStorage());
    const ref = { kind: 'provider', id: 'google', field: 'api_key' } as const;
    vault.set(ref, 'AIza-something');
    vault.remove(ref);
    expect(vault.get(ref)).toBeUndefined();
  });
});

describe('refusing to store insecurely', () => {
  it('throws rather than writing plaintext when the keyring is unavailable', () => {
    const vault = new Vault(new SafeStorageBackend(fakeSafeStorage(false)), new MemoryStorage());

    // The whole point: a user who believes their key is encrypted, and later
    // finds it in a file, has been lied to.
    expect(() => vault.set({ kind: 'provider', id: 'anthropic', field: 'api_key' }, 'sk-x')).toThrow(
      VaultUnavailableError,
    );
    expect(vault.canStore).toBe(false);
  });

  it('says something the user can act on', () => {
    const backend = new SafeStorageBackend(fakeSafeStorage(false));
    expect(backend.unavailableReason).toMatch(/gnome-keyring|kwallet/);
    expect(backend.unavailableReason).toMatch(/will not store keys in plaintext/);
  });

  it('treats the env backend as read-only', () => {
    const vault = new Vault(new EnvBackend(), new MemoryStorage());
    expect(vault.canStore).toBe(false);
    expect(() => vault.set({ kind: 'provider', id: 'openai', field: 'api_key' }, 'sk-x')).toThrow();
  });

  it('refuses an empty secret', () => {
    const vault = new Vault(new PassphraseBackend('correct horse battery'), new MemoryStorage());
    expect(() => vault.set({ kind: 'provider', id: 'openai', field: 'api_key' }, '')).toThrow();
  });

  it('refuses a passphrase too short to be worth deriving from', () => {
    expect(() => new PassphraseBackend('short')).toThrow(/at least 8/);
  });
});

describe('encryption properties', () => {
  it('produces different ciphertext for the same value each time', () => {
    const backend = new PassphraseBackend('correct horse battery');
    const a = backend.encrypt('same-value').toString('base64');
    const b = backend.encrypt('same-value').toString('base64');
    // A fresh salt and IV per write: identical ciphertext would leak that two
    // integrations share a credential.
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext instead of returning garbage', () => {
    const backend = new PassphraseBackend('correct horse battery');
    const ciphertext = backend.encrypt('authentic');
    ciphertext[ciphertext.length - 1] ^= 0xff;
    // GCM authenticates: a flipped bit is detected rather than decrypted.
    expect(() => backend.decrypt(ciphertext)).toThrow();
  });

  it('cannot be read with the wrong passphrase', () => {
    const ciphertext = new PassphraseBackend('correct horse battery').encrypt('secret');
    expect(() => new PassphraseBackend('wrong passphrase').decrypt(ciphertext)).toThrow();
  });

  it('skips unreadable rows rather than failing to start', () => {
    const storage = new MemoryStorage();
    new Vault(new PassphraseBackend('first passphrase'), storage).set(
      { kind: 'provider', id: 'openai', field: 'api_key' },
      'sk-old',
    );
    const reopened = new Vault(new PassphraseBackend('second passphrase'), storage);

    // Changing the passphrase should not brick the app; the old row is simply
    // unreadable until it is re-entered.
    expect(reopened.allValues()).toEqual([]);
  });
});

describe('key layout', () => {
  it('scopes integration credentials by project and providers globally', () => {
    expect(secretKey({ kind: 'provider', id: 'anthropic', field: 'api_key' })).toBe(
      'provider:*:anthropic:api_key',
    );
    expect(secretKey({ kind: 'integration', id: 'slack', field: 'bot_token', projectId: 'p1' })).toBe(
      'integration:p1:slack:bot_token',
    );
  });
});
