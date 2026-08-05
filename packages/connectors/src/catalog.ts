/**
 * The connector catalog.
 *
 * Data, not code. Adding an integration is a table entry, and the values here
 * are public API documentation restated in a machine-readable shape — the value
 * of a connector was never the URL, it was managing the credential.
 *
 * These are the API-key tier: services where a user can get a working
 * credential in under a minute without registering an OAuth application. That
 * constraint is the whole selection criterion, because an integration you can't
 * connect in a minute is one most people never connect at all.
 */

import type { IntegrationSpec } from './engine.js';

/**
 * Google's token endpoint, with the user's own app.
 *
 * Shared by every Google connector: the fields are theirs, so a person who has
 * registered one Cloud project can reuse it across Gmail, Calendar and Drive.
 */
const GOOGLE_OAUTH = {
  type: 'oauth2' as const,
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientIdField: 'client_id',
  clientSecretField: 'client_secret',
  refreshTokenField: 'refresh_token',
};

export const CATALOG: IntegrationSpec[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    howToConnect:
      'Message @BotFather in Telegram, send /newbot, and copy the token it gives you. ' +
      'Then message your new bot once and open https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat id.',
    fields: [
      { key: 'bot_token', label: 'Bot token', secret: true, placeholder: '123456:ABC-DEF…' },
      { key: 'chat_id', label: 'Default chat id', secret: false, placeholder: '123456789' },
    ],
    tools: [
      {
        id: 'telegram.send_message',
        summary: 'Send a message to a chat.',
        method: 'POST',
        // Telegram accepts the token nowhere but the path, which is why this
        // spec declares `path` auth rather than smuggling it into a header.
        url: 'https://api.telegram.org/bot{creds.bot_token}/sendMessage',
        auth: { type: 'path', field: 'bot_token' },
        body: { chat_id: '{arg.chat_id}', text: '{arg.text}', parse_mode: '{arg.parse_mode}' },
        result: 'result.message_id',
      },
    ],
  },

  {
    id: 'resend',
    name: 'Email (Resend)',
    howToConnect:
      'Create an API key at https://resend.com/api-keys and verify the domain you want to send from. ' +
      'The free tier covers a few thousand emails a month, which is more than an automation needs.',
    fields: [{ key: 'api_key', label: 'API key', secret: true, placeholder: 're_…' }],
    tools: [
      {
        id: 'resend.send',
        summary: 'Send an email.',
        method: 'POST',
        url: 'https://api.resend.com/emails',
        auth: { type: 'bearer', field: 'api_key' },
        body: {
          from: '{arg.from}',
          to: '{arg.to}',
          subject: '{arg.subject}',
          text: '{arg.text}',
          html: '{arg.html}',
        },
        result: 'id',
      },
    ],
  },

  {
    id: 'gmail',
    name: 'Gmail',
    howToConnect:
      'Gmail needs YOUR OWN Google app — Studio never uses a Claritty one, so nothing here depends on an app we control. ' +
      'At https://console.cloud.google.com/apis/credentials create an OAuth client (type: Desktop app), enable the Gmail API, ' +
      'and add the https://www.googleapis.com/auth/gmail.modify scope. ' +
      'Then get a refresh token for it — https://developers.google.com/oauthplayground with "Use your own OAuth credentials" ticked is the quickest way. ' +
      'Paste the client id, client secret and refresh token below; the access token is derived and never stored.',
    fields: [
      { key: 'client_id', label: 'OAuth client id', secret: false, placeholder: '…apps.googleusercontent.com' },
      { key: 'client_secret', label: 'OAuth client secret', secret: true, placeholder: 'GOCSPX-…' },
      { key: 'refresh_token', label: 'Refresh token', secret: true, placeholder: '1//0…' },
    ],
    tools: [
      {
        id: 'gmail.search',
        summary: 'Find messages. Returns ids only — hydrate each with gmail.get_message.',
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages',
        auth: GOOGLE_OAUTH,
        query: { q: '{arg.query}', maxResults: '{arg.limit}' },
        result: 'messages',
      },
      {
        id: 'gmail.get_message',
        summary: 'The full message, so a step can read who sent it and what it says.',
        method: 'GET',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/{arg.message_id}',
        auth: GOOGLE_OAUTH,
        query: { format: 'full' },
      },
      {
        id: 'gmail.send',
        summary: 'Send an email. `raw` is the base64url-encoded RFC 2822 message.',
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        auth: GOOGLE_OAUTH,
        body: { raw: '{arg.raw}', threadId: '{arg.threadId}' },
        result: 'id',
      },
    ],
  },

  {
    id: 'brave-search',
    name: 'Brave Search',
    howToConnect:
      'Create a free key at https://api-dashboard.search.brave.com/ (the free tier allows 2,000 queries a month).',
    fields: [{ key: 'api_key', label: 'API key', secret: true, placeholder: 'BSA…' }],
    tools: [
      {
        id: 'brave-search.web',
        summary: 'Search the web and return the top results.',
        method: 'GET',
        url: 'https://api.search.brave.com/res/v1/web/search',
        auth: { type: 'header', name: 'X-Subscription-Token', field: 'api_key' },
        query: { q: '{arg.query}', count: '{arg.count}' },
        result: 'web.results',
      },
    ],
  },

  {
    id: 'slack',
    name: 'Slack',
    howToConnect:
      'Create an app at https://api.slack.com/apps, add the chat:write scope under OAuth & Permissions, ' +
      'install it to your workspace, and copy the Bot User OAuth Token. Invite the bot to any channel it should post in.',
    fields: [{ key: 'bot_token', label: 'Bot user OAuth token', secret: true, placeholder: 'xoxb-…' }],
    tools: [
      {
        id: 'slack.post_message',
        summary: 'Post a message to a channel.',
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        auth: { type: 'bearer', field: 'bot_token' },
        body: { channel: '{arg.channel}', text: '{arg.text}', thread_ts: '{arg.thread_ts}' },
        result: 'ts',
      },
    ],
  },

  {
    id: 'github',
    name: 'GitHub',
    howToConnect:
      'Create a fine-grained personal access token at https://github.com/settings/tokens with access to ' +
      'the repositories this automation should touch.',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, placeholder: 'github_pat_…' }],
    tools: [
      {
        id: 'github.create_issue',
        summary: 'Open an issue.',
        method: 'POST',
        url: 'https://api.github.com/repos/{arg.owner}/{arg.repo}/issues',
        auth: { type: 'bearer', field: 'token' },
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        body: { title: '{arg.title}', body: '{arg.body}', labels: '{arg.labels}' },
        result: 'html_url',
      },
      {
        id: 'github.list_issues',
        summary: 'List open issues on a repository.',
        method: 'GET',
        url: 'https://api.github.com/repos/{arg.owner}/{arg.repo}/issues',
        auth: { type: 'bearer', field: 'token' },
        query: { state: '{arg.state}', per_page: '{arg.limit}' },
      },
      {
        id: 'github.comment',
        summary: 'Comment on an issue or pull request.',
        method: 'POST',
        url: 'https://api.github.com/repos/{arg.owner}/{arg.repo}/issues/{arg.number}/comments',
        auth: { type: 'bearer', field: 'token' },
        body: { body: '{arg.body}' },
        result: 'html_url',
      },
    ],
  },

  {
    id: 'notion',
    name: 'Notion',
    howToConnect:
      'Create an integration at https://www.notion.so/my-integrations, copy the Internal Integration Secret, ' +
      'then share the target page or database with it from Notion’s ⋯ menu — otherwise it sees nothing.',
    fields: [{ key: 'token', label: 'Internal integration secret', secret: true, placeholder: 'ntn_…' }],
    tools: [
      {
        id: 'notion.create_page',
        summary: 'Add a page to a database.',
        method: 'POST',
        url: 'https://api.notion.com/v1/pages',
        auth: { type: 'bearer', field: 'token' },
        headers: { 'Notion-Version': '2022-06-28' },
        body: { parent: { database_id: '{arg.database_id}' }, properties: '{arg.properties}' },
        result: 'url',
      },
      {
        id: 'notion.query_database',
        summary: 'Query a database.',
        method: 'POST',
        url: 'https://api.notion.com/v1/databases/{arg.database_id}/query',
        auth: { type: 'bearer', field: 'token' },
        headers: { 'Notion-Version': '2022-06-28' },
        body: { page_size: '{arg.limit}' },
        result: 'results',
      },
    ],
  },

  {
    id: 'linear',
    name: 'Linear',
    howToConnect: 'Create a personal API key in Linear under Settings → Security & access → Personal API keys.',
    fields: [{ key: 'api_key', label: 'API key', secret: true, placeholder: 'lin_api_…' }],
    tools: [
      {
        id: 'linear.create_issue',
        summary: 'Create an issue.',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        // Linear expects the key bare, without a Bearer prefix.
        auth: { type: 'header', name: 'Authorization', field: 'api_key' },
        body: {
          query:
            'mutation($teamId:String!,$title:String!,$description:String){issueCreate(input:{teamId:$teamId,title:$title,description:$description}){issue{identifier url}}}',
          variables: { teamId: '{arg.team_id}', title: '{arg.title}', description: '{arg.description}' },
        },
        result: 'data.issueCreate.issue',
      },
    ],
  },

  {
    id: 'stripe',
    name: 'Stripe',
    howToConnect:
      'Copy a restricted key from https://dashboard.stripe.com/apikeys. Give it read access only unless the ' +
      'automation genuinely needs to move money.',
    fields: [{ key: 'api_key', label: 'Secret or restricted key', secret: true, placeholder: 'rk_live_…' }],
    tools: [
      {
        id: 'stripe.list_invoices',
        summary: 'List invoices, newest first.',
        method: 'GET',
        url: 'https://api.stripe.com/v1/invoices',
        auth: { type: 'bearer', field: 'api_key' },
        query: { status: '{arg.status}', limit: '{arg.limit}' },
        result: 'data',
      },
    ],
  },

  {
    id: 'airtable',
    name: 'Airtable',
    howToConnect:
      'Create a personal access token at https://airtable.com/create/tokens with the data.records:read and ' +
      'data.records:write scopes, and grant it access to the base.',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, placeholder: 'pat…' }],
    tools: [
      {
        id: 'airtable.list_records',
        summary: 'List records in a table.',
        method: 'GET',
        url: 'https://api.airtable.com/v0/{arg.base_id}/{arg.table}',
        auth: { type: 'bearer', field: 'token' },
        query: { maxRecords: '{arg.limit}', view: '{arg.view}' },
        result: 'records',
      },
      {
        id: 'airtable.create_record',
        summary: 'Add a record.',
        method: 'POST',
        url: 'https://api.airtable.com/v0/{arg.base_id}/{arg.table}',
        auth: { type: 'bearer', field: 'token' },
        body: { fields: '{arg.fields}' },
        result: 'id',
      },
    ],
  },


  {
    id: 'outbound-webhook',
    name: 'Outbound webhook',
    howToConnect:
      'No credential needed. Give the automation a URL and it will POST JSON to it — useful for Zapier, ' +
      'Make, n8n, or anything you already run.',
    fields: [],
    tools: [
      {
        id: 'outbound-webhook.post',
        summary: 'POST a JSON payload to a URL.',
        method: 'POST',
        url: '{arg.url}',
        auth: { type: 'none' },
        // The payload IS the body — not a field inside one.
        bodyFrom: 'payload',
      },
    ],
  },
];

const BY_TOOL = new Map<string, { integration: IntegrationSpec; tool: IntegrationSpec['tools'][number] }>();
for (const integration of CATALOG) {
  for (const tool of integration.tools) BY_TOOL.set(tool.id, { integration, tool });
}

export function findIntegration(id: string): IntegrationSpec | undefined {
  return CATALOG.find((i) => i.id === id);
}

/**
 * Resolve `<integration>.<tool>` to a spec.
 *
 * Telegram is the awkward one: its token goes in the URL path, which the engine
 * refuses on principle. Rather than weaken that rule for everyone, the token is
 * substituted here, at resolve time, where it is the integration's own id
 * rather than a user-supplied template — and it never touches the placeholder
 * machinery the guard protects.
 */
export function resolveTool(
  integrationId: string,
  toolId: string,
  credentials: Record<string, string>,
): { integration: IntegrationSpec; tool: IntegrationSpec['tools'][number] } | undefined {
  const full = toolId.includes('.') ? toolId : `${integrationId}.${toolId}`;
  const found = BY_TOOL.get(full);
  if (!found) return undefined;

  if (integrationId === 'telegram' && credentials.bot_token) {
    return {
      integration: found.integration,
      tool: {
        ...found.tool,
        url: found.tool.url.replace('/bot/', `/bot${credentials.bot_token}/`),
      },
    };
  }
  return found;
}

/** Every tool id the catalog can execute — used to tell a manifest early that
 *  it references something Studio cannot run locally. */
export function knownToolIds(): string[] {
  return [...BY_TOOL.keys()];
}
