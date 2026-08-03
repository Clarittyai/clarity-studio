/**
 * Secret redaction.
 *
 * Studio holds the literal secret values, so it can do something a regex never
 * can: exact-substring matching. A regex for "looks like a token" misses a
 * Postgres password and fires on a git SHA. Matching the actual strings in the
 * vault has neither problem.
 *
 * The regex pass is kept as a second layer for values Studio never saw — a key
 * the automation minted at runtime, or one the user pasted into a prompt.
 */

/** Patterns for well-known key shapes, as a backstop for unknown secrets. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-…'],
  [/\bsk-[A-Za-z0-9]{32,}/g, 'sk-…'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh?_…'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox?-…'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza…'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA…'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"']*:[^\s"'@]+@/gi, '$&'],
];

/** Keys whose values are always dropped, whatever they look like. */
const SECRET_KEYS = new Set([
  'access_token', 'refresh_token', 'api_key', 'apikey', 'client_secret',
  'secret', 'token', 'authorization', 'password', 'passphrase',
  'private_key', 'webhook_secret', 'credentials',
]);

export class Redactor {
  private literals: string[] = [];

  /** Replace the known-secret set. Values under 8 chars are ignored: redacting
   *  a short string turns ordinary prose into unreadable soup. */
  setSecrets(values: Iterable<string>): void {
    this.literals = [...new Set([...values])]
      .filter((v) => typeof v === 'string' && v.length >= 8)
      // Longest first, so a token that contains another is masked whole.
      .sort((a, b) => b.length - a.length);
  }

  /** Mask every known secret and every recognised key shape in a string. */
  text(input: string): string {
    if (!input) return input;
    let out = input;
    for (const secret of this.literals) {
      if (out.includes(secret)) out = out.split(secret).join(mask(secret));
    }
    for (const [re, replacement] of PATTERNS) {
      out = out.replace(re, (m) => (replacement === '$&' ? maskUrlPassword(m) : replacement));
    }
    return out;
  }

  /** Deep-redact a JSON-ish value: secret-named keys are dropped entirely,
   *  every string is passed through {@link text}. */
  value<T>(input: T, depth = 0): T {
    if (depth > 12) return '<max depth>' as unknown as T;
    if (typeof input === 'string') return this.text(input) as unknown as T;
    if (Array.isArray(input)) return input.map((v) => this.value(v, depth + 1)) as unknown as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '<redacted>' : this.value(v, depth + 1);
      }
      return out as unknown as T;
    }
    return input;
  }

  /** True when a payload about to leave for a third-party model contains a
   *  secret. The caller decides whether to block or warn. */
  findEgress(input: unknown): string[] {
    if (this.literals.length === 0) return [];
    const hay = typeof input === 'string' ? input : safeStringify(input);
    return this.literals.filter((s) => hay.includes(s));
  }
}

function mask(secret: string): string {
  const tail = secret.slice(-4);
  return `<redacted:…${tail}>`;
}

function maskUrlPassword(url: string): string {
  return url.replace(/:\/\/([^:/\s]+):[^@\s]+@/, '://$1:<redacted>@');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

export const redactor = new Redactor();
