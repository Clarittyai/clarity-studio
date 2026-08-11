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
        // Telegram accepts the token nowhere but the path, so the spec names it
        // in `pathCredentials` — an opt-in recorded here, not a hole in the rule.
        url: 'https://api.telegram.org/bot{creds.bot_token}/sendMessage',
        auth: { type: 'none' },
        pathCredentials: ['bot_token'],
        body: { chat_id: '{arg.chat_id}', text: '{arg.text}', parse_mode: '{arg.parse_mode}' },
        result: 'result.message_id',
      },
    ],
  },

  {
    id: 'whatsapp',
    name: 'WhatsApp',
    howToConnect:
      'WhatsApp needs YOUR OWN Meta app — Studio never brokers this. At https://developers.facebook.com ' +
      'create an app, add the WhatsApp product, and from its API Setup page copy the phone number id and ' +
      'a permanent access token (generate one from a System User in Business Settings; the sample token ' +
      'shown there expires in 24 hours). Message your own number from that page once, so WhatsApp will ' +
      'let the number receive messages back.',
    fields: [
      { key: 'access_token', label: 'Access token', secret: true, placeholder: 'EAA…' },
      { key: 'phone_number_id', label: 'Phone number id', secret: false, placeholder: '1234567890' },
      { key: 'to', label: 'Your number, with country code', secret: false, placeholder: '447700900000' },
    ],
    tools: [
      {
        id: 'whatsapp.send_message',
        summary: 'Send a text message.',
        method: 'POST',
        // The id belongs in the path and the token in a header — the case an
        // auth *type* could not express, and why pathCredentials is separate.
        url: 'https://graph.facebook.com/v21.0/{creds.phone_number_id}/messages',
        auth: { type: 'bearer', field: 'access_token' },
        pathCredentials: ['phone_number_id'],
        body: {
          messaging_product: 'whatsapp',
          to: '{arg.to}',
          type: 'text',
          text: { body: '{arg.text}' },
        },
        result: 'messages.0.id',
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
      'install it to your workspace, and copy the Bot User OAuth Token. Invite the bot to any channel it should post in. ' +
      'To let it RECEIVE instructions too: turn on Socket Mode, subscribe to the app_mention event, ' +
      'and generate an app-level token with connections:write. Studio dials out to Slack, so nothing needs ' +
      'a public URL and there is no webhook to expose.',
    fields: [
      { key: 'bot_token', label: 'Bot user OAuth token', secret: true, placeholder: 'xoxb-…' },
      // Optional: posting needs only the bot token. This is what lets Slack
      // reach an automation running on 127.0.0.1, which no webhook can.
      {
        key: 'app_token',
        label: 'App-level token (optional, to receive messages)',
        secret: true,
        placeholder: 'xapp-…',
      },
    ],
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
    id: 'jira',
    name: 'Jira',
    howToConnect:
      'Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens, then give your ' +
      'site (the yourcompany.atlassian.net part, no https://), the email you sign in with, and that token. ' +
      'Jira Cloud authenticates the pair as HTTP basic — there is no OAuth app to register and no admin needed.',
    fields: [
      { key: 'site', label: 'Site', secret: false, placeholder: 'yourcompany.atlassian.net' },
      { key: 'email', label: 'Account email', secret: false, placeholder: 'you@company.com' },
      { key: 'api_token', label: 'API token', secret: true },
    ],
    tools: [
      {
        id: 'jira.create_issue',
        summary: 'Create an issue.',
        method: 'POST',
        // The site is in the host, so it must be interpolated — and it is an
        // address, not a secret, which is exactly what pathCredentials is for.
        url: 'https://{creds.site}/rest/api/3/issue',
        auth: { type: 'basic', userField: 'email', passwordField: 'api_token' },
        pathCredentials: ['site'],
        body: {
          fields: {
            project: { key: '{arg.project}' },
            summary: '{arg.summary}',
            issuetype: { name: '{arg.issue_type}' },
            // Jira Cloud v3 takes rich text, not a string. A plain string is
            // accepted by the schema and rejected by the API, which is the kind
            // of failure that only shows up on someone's first real run.
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '{arg.description}' }] }],
            },
          },
        },
        result: 'key',
      },
      {
        id: 'jira.search_jql',
        summary: 'Find issues with JQL — use it to avoid filing the same thing twice.',
        method: 'GET',
        url: 'https://{creds.site}/rest/api/3/search/jql',
        auth: { type: 'basic', userField: 'email', passwordField: 'api_token' },
        pathCredentials: ['site'],
        query: { jql: '{arg.jql}', maxResults: '{arg.max_results}', fields: 'summary' },
        result: 'issues',
      },
      {
        id: 'jira.add_comment',
        summary: 'Comment on an issue.',
        method: 'POST',
        url: 'https://{creds.site}/rest/api/3/issue/{arg.issue}/comment',
        auth: { type: 'basic', userField: 'email', passwordField: 'api_token' },
        pathCredentials: ['site'],
        body: {
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '{arg.text}' }] }],
          },
        },
        result: 'id',
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
): { integration: IntegrationSpec; tool: IntegrationSpec['tools'][number] } | undefined {
  const full = toolId.includes('.') ? toolId : `${integrationId}.${toolId}`;
  const found = BY_TOOL.get(full);
  if (!found) return undefined;

  return found;
}

/** Every tool id the catalog can execute — used to tell a manifest early that
 *  it references something Studio cannot run locally. */
export function knownToolIds(): string[] {
  return [...BY_TOOL.keys()];
}
