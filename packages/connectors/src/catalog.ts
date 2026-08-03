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

export const CATALOG: IntegrationSpec[] = [
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
    id: 'telegram',
    name: 'Telegram',
    howToConnect:
      'Message @BotFather on Telegram, run /newbot, and copy the token. Then message your bot once so it ' +
      'can reply to you, and use @userinfobot to find your chat id.',
    fields: [{ key: 'bot_token', label: 'Bot token', secret: true, placeholder: '123456:ABC-…' }],
    tools: [
      {
        id: 'telegram.send_message',
        summary: 'Send a message.',
        method: 'POST',
        // The token belongs in the path for Telegram, which is why this one is
        // special-cased below rather than templated: see the note in resolve().
        url: 'https://api.telegram.org/bot/sendMessage',
        auth: { type: 'none' },
        body: { chat_id: '{arg.chat_id}', text: '{arg.text}', parse_mode: '{arg.parse_mode}' },
        result: 'result.message_id',
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
