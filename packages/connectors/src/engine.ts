/**
 * The connector engine.
 *
 * A connector tool is data, not code: a small spec saying which HTTP call to
 * make, where the credential goes, and which part of the response to keep. That
 * matters for two reasons — a new integration is a table entry rather than a
 * pull request, and there is no arbitrary code path between an automation and
 * the internet.
 *
 * Two rules are enforced here rather than left to whoever writes a spec:
 *
 * 1. **A secret can never be interpolated into a URL.** URLs end up in logs,
 *    in error messages, in referrer headers, and in the run timeline. A spec
 *    that tries it fails loudly instead of leaking quietly.
 * 2. **The target must be a public host.** No localhost, no link-local, no
 *    private ranges. Otherwise an automation that takes a URL as input becomes
 *    a way to reach the user's router or a cloud metadata endpoint.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpAuthSpec {
  /** `bearer` → Authorization: Bearer <field>; `header` → a named header;
   *  `query` → a query parameter; `basic` → base64 user:pass. */
  type: 'bearer' | 'header' | 'query' | 'basic' | 'none' | 'oauth2';
  /** `oauth2` only: where a refresh token is exchanged for an access token. */
  tokenUrl?: string;
  /** `oauth2` only: the credential fields holding the user's OWN app. */
  clientIdField?: string;
  clientSecretField?: string;
  refreshTokenField?: string;
  /** Credential field the value comes from, e.g. 'api_key'. */
  field?: string;
  /** Header or query-parameter name, for `header` / `query`. */
  name?: string;
  /** Prefix for a `header` auth, e.g. 'Token '. */
  prefix?: string;
  /** For `basic`: the credential fields holding user and password. */
  userField?: string;
  passwordField?: string;
}

export interface HttpToolSpec {
  /** Dotted id the manifest uses, e.g. 'slack.post_message'. */
  id: string;
  method: HttpMethod;
  /** May contain `{arg.x}` placeholders. Never `{creds.*}` — see above. */
  url: string;
  auth: HttpAuthSpec;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON body template. Values may contain placeholders; a value that is
   *  exactly `{arg.x}` keeps x's original type instead of becoming a string. */
  body?: Record<string, unknown>;
  /** Send this argument AS the entire body, rather than as a field within one.
   *  Templating cannot express that, and a generic webhook tool needs it. */
  bodyFrom?: string;
  /** Dotted path into the response to return. Absent → the whole body. */
  result?: string;
  /** Documentation, shown in the UI. */
  summary?: string;
}

export interface IntegrationSpec {
  id: string;
  name: string;
  /** How the user gets a credential, shown verbatim in the connect dialog. */
  howToConnect: string;
  /** Fields the user must supply. */
  fields: Array<{ key: string; label: string; secret: boolean; placeholder?: string }>;
  tools: HttpToolSpec[];
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly reason: 'spec' | 'credentials' | 'http' | 'ssrf',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

// ── templating ───────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{(arg|creds)\.([a-zA-Z0-9_]+)\}/g;

/** Substitute `{arg.x}` and `{creds.y}` in a string. */
function fill(
  template: string,
  args: Record<string, unknown>,
  creds: Record<string, string>,
  opts: { allowCreds: boolean; what: string },
): string {
  return template.replace(PLACEHOLDER, (_match, source: string, key: string) => {
    if (source === 'creds') {
      if (!opts.allowCreds) {
        throw new ConnectorError(
          `Spec error: ${opts.what} interpolates {creds.${key}}. Credentials must never appear ` +
            `in a URL — they leak into logs, error messages and run history. Use auth instead.`,
          'spec',
        );
      }
      const value = creds[key];
      if (value === undefined) {
        throw new ConnectorError(`Missing credential field "${key}".`, 'credentials');
      }
      return value;
    }
    const value = args[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Fill a body template, preserving types where a value is a bare placeholder. */
function fillValue(
  value: unknown,
  args: Record<string, unknown>,
  creds: Record<string, string>,
  what: string,
): unknown {
  if (typeof value === 'string') {
    // A whole-value placeholder keeps the argument's real type — an array of
    // recipients must not arrive as the string "[object Object]".
    const whole = /^\{(arg|creds)\.([a-zA-Z0-9_]+)\}$/.exec(value);
    if (whole) {
      return whole[1] === 'creds'
        ? creds[whole[2]!]
        : args[whole[2]!];
    }
    return fill(value, args, creds, { allowCreds: true, what });
  }
  if (Array.isArray(value)) return value.map((v) => fillValue(v, args, creds, what));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const filled = fillValue(v, args, creds, what);
      // Drop keys whose argument wasn't supplied, rather than sending nulls a
      // provider may reject.
      if (filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return value;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'metadata.google.internal']);

/**
 * Reject anything that is not a public host over HTTPS.
 *
 * An automation whose URL is partly argument-driven is otherwise a way to
 * probe the user's own network, or to read a cloud metadata endpoint — the
 * classic SSRF, and worth blocking even though Studio runs on a laptop.
 */
export function assertPublicUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError(`"${raw}" is not a valid URL.`, 'spec');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectorError(`Refusing to call a ${url.protocol} URL.`, 'ssrf');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // The escape hatch exists for one real case: people who self-host the thing
  // they want to automate — Home Assistant, n8n, a NAS. A local-first tool that
  // cannot reach your own network is worse than one that can, PROVIDED it is an
  // explicit setting. It is never settable from a spec or a tool argument, so
  // an automation cannot turn it on for itself.
  if (allowPrivate) return url;
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new ConnectorError(`Refusing to call ${host} — connectors reach public hosts only.`, 'ssrf');
  }
  if (isPrivateAddress(host)) {
    throw new ConnectorError(
      `Refusing to call ${host}: it is a private address. A connector that could reach ` +
        `your local network would be a way for an automation to probe it.`,
      'ssrf',
    );
  }
  return url;
}

function isPrivateAddress(host: string): boolean {
  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 0) return true;
    return false;
  }
  // IPv6 loopback / unique-local / link-local
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  // `.local` mDNS names resolve on the LAN.
  return host.endsWith('.local') || host.endsWith('.internal');
}

// ── execution ────────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  spec: HttpToolSpec;
  args: Record<string, unknown>;
  credentials: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Permit private and loopback addresses. Off by default; see
   *  {@link assertPublicUrl} for why it exists at all. */
  allowPrivateHosts?: boolean;
}

export async function executeTool(opts: ExecuteOptions): Promise<unknown> {
  const { spec, args, credentials } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  // Credentials are explicitly disallowed in the URL.
  const urlString = fill(spec.url, args, credentials, { allowCreds: false, what: `${spec.id} url` });
  const url = assertPublicUrl(urlString, opts.allowPrivateHosts ?? false);

  for (const [key, template] of Object.entries(spec.query ?? {})) {
    const value = fill(template, args, credentials, { allowCreds: false, what: `${spec.id} query.${key}` });
    if (value !== '') url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [key, template] of Object.entries(spec.headers ?? {})) {
    headers[key.toLowerCase()] = fill(template, args, credentials, {
      allowCreds: true,
      what: `${spec.id} header ${key}`,
    });
  }

  // OAuth resolves to a bearer token first: applyAuth is synchronous, and the
  // exchange is a network call.
  if (spec.auth.type === 'oauth2') {
    const token = await accessTokenFor(spec.auth, credentials, spec.id);
    applyAuth({ type: 'bearer', field: '__access_token' }, { __access_token: token }, headers, url, spec.id);
  } else {
    applyAuth(spec.auth, credentials, headers, url, spec.id);
  }

  let body: string | undefined;
  const sendsBody = spec.method !== 'GET' && spec.method !== 'DELETE';
  if (sendsBody && spec.bodyFrom) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(args[spec.bodyFrom] ?? {});
  } else if (sendsBody && spec.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(fillValue(spec.body, args, credentials, `${spec.id} body`));
  }

  const response = await doFetch(url.toString(), {
    method: spec.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new ConnectorError(
      `${spec.id} failed: HTTP ${response.status} ${summarise(parsed, text)}`,
      'http',
      response.status,
    );
  }

  // Some APIs answer 200 with `{ok: false}`. Treating that as success is how an
  // automation reports "sent" for a message nobody received.
  if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
    throw new ConnectorError(`${spec.id} failed: ${summarise(parsed, text)}`, 'http', response.status);
  }

  return spec.result ? pluck(parsed, spec.result) : parsed;
}

/**
 * OAuth, with the user's own app.
 *
 * Studio never ships a Claritty OAuth client. Every integration that needs
 * OAuth is connected with credentials the user registered themselves — their
 * client id, their secret, their refresh token — so nothing about a local run
 * depends on an app we control, and revoking us is not a thing they have to
 * think about because there is nothing of ours to revoke.
 *
 * Access tokens are short-lived, so the refresh token is the stored credential
 * and the access token is derived. Cached in memory only: it expires anyway,
 * and writing it to disk would add a second secret to protect for no gain.
 */
interface CachedToken {
  token: string;
  /** Epoch ms. Refreshed early, because a token that expires mid-flight reads
   *  as an auth bug rather than as a clock. */
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

async function accessTokenFor(
  auth: HttpAuthSpec,
  creds: Record<string, string>,
  toolId: string,
): Promise<string> {
  const need = (field: string | undefined, what: string): string => {
    const value = field ? creds[field] : undefined;
    if (!value) {
      throw new ConnectorError(
        `Not connected: this needs your ${what}. Add it in Studio → Connections.`,
        'credentials',
      );
    }
    return value;
  };
  if (!auth.tokenUrl) {
    throw new ConnectorError(`Spec error: ${toolId} oauth2 auth has no tokenUrl.`, 'spec');
  }
  const clientId = need(auth.clientIdField ?? 'client_id', 'OAuth client id');
  const clientSecret = need(auth.clientSecretField ?? 'client_secret', 'OAuth client secret');
  const refreshToken = need(auth.refreshTokenField ?? 'refresh_token', 'refresh token');

  const key = `${auth.tokenUrl}|${clientId}|${refreshToken.slice(-12)}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // The provider's own words: "invalid_grant" means the refresh token was
    // revoked or expired, and paraphrasing that helps nobody reconnect.
    throw new ConnectorError(
      `Could not refresh access: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`,
      'credentials',
      res.status,
    );
  }
  // 60s early, so a long request cannot start on a token that dies mid-flight.
  const ttl = Math.max(30, (body.expires_in ?? 3600) - 60);
  tokenCache.set(key, { token: body.access_token, expiresAt: Date.now() + ttl * 1000 });
  return body.access_token;
}

function applyAuth(
  auth: HttpAuthSpec,
  creds: Record<string, string>,
  headers: Record<string, string>,
  url: URL,
  toolId: string,
): void {
  const need = (field: string | undefined): string => {
    if (!field) throw new ConnectorError(`Spec error: ${toolId} auth has no field.`, 'spec');
    const value = creds[field];
    if (!value) {
      throw new ConnectorError(
        `Not connected: this needs the "${field}" credential. Add it in Studio → Integrations.`,
        'credentials',
      );
    }
    return value;
  };

  switch (auth.type) {
    case 'none':
      return;
    case 'bearer':
      headers.authorization = `Bearer ${need(auth.field)}`;
      return;
    case 'header':
      if (!auth.name) throw new ConnectorError(`Spec error: ${toolId} header auth has no name.`, 'spec');
      headers[auth.name.toLowerCase()] = `${auth.prefix ?? ''}${need(auth.field)}`;
      return;
    case 'query':
      if (!auth.name) throw new ConnectorError(`Spec error: ${toolId} query auth has no name.`, 'spec');
      // Least-preferred: a key in a query string ends up in server logs. Kept
      // because some providers offer nothing else.
      url.searchParams.set(auth.name, need(auth.field));
      return;
    case 'oauth2':
      // Resolved before this call — see executeTool.
      throw new ConnectorError(`Spec error: ${toolId} oauth2 reached applyAuth.`, 'spec');
    case 'basic': {
      const user = need(auth.userField);
      const password = auth.passwordField ? (creds[auth.passwordField] ?? '') : '';
      headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
      return;
    }
  }
}

/** `a.b.0.c` into a parsed body. */
function pluck(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

/** A short, useful description of a failure — providers put the reason in
 *  wildly different places, so try the common ones before falling back. */
function summarise(parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const key of ['error', 'message', 'error_description', 'detail']) {
      const value = o[key];
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string') return nested;
      }
    }
  }
  return raw.slice(0, 200);
}
