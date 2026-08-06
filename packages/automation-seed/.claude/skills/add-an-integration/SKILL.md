---
name: add-an-integration
description: What to do when an automation needs a service that has no local connector yet — write a complete, implementable connector request in the exact shape Clarity Studio's connector engine accepts, instead of inventing a tool id that will fail at run time. Use whenever a needed integration is missing from catalog/integrations, or Studio shows "No local connector yet".
---

# When the integration you need is not there

Studio connects services **locally**, with the user's own credentials. There is
no hosted middleman to fall back on, so "this needs the cloud" is never the
answer. If a service has no connector, the answer is to write one — or, from
inside an automation, to write the request that lets someone write it in an
afternoon.

**Never invent a tool id.** `gmail.send` only works if a connector declares it.
A manifest referencing a tool nothing implements passes validation, runs, gets
skipped, and reports success — the worst possible failure, because it looks
like it worked.

## What to do instead

Write **`INTEGRATION-REQUEST.md`** in the automation's root, then tell the user
it is there and what it is for. One file per missing service.

It must contain everything below. A request missing the auth details or the
exact endpoints is not implementable, and the person picking it up will have to
do the research you already did.

```md
# <Service> connector request

## Why
Which step of this automation needs it, and what it does — one sentence.

## Auth
How a person gets the credential, in the imperative, with the real URL and the
real menu path. This becomes `howToConnect` and is shown verbatim in Studio, so
write it for someone who has never opened that dashboard:

  "Create an app at https://api.slack.com/apps, add the chat:write scope under
   OAuth & Permissions, install it to your workspace, and copy the Bot User
   OAuth Token."

Then the fields, one row each:

| key | label | secret | placeholder |
|-----|-------|--------|-------------|
| bot_token | Bot user OAuth token | yes | xoxb-… |

## Auth type
One of the engine's six, and which field carries it:

  bearer   Authorization: Bearer <field>        ← most APIs
  header   a named header, with an optional prefix
  query    a query parameter
  basic    base64 user:pass, from two fields
  oauth2   a refresh token exchanged for an access token, against the
           provider's own token endpoint, using the USER'S OWN app
  none     public API

**OAuth means the user's own app, not Studio's.** There is no Claritty client id
to fall back on: the request must say where a person creates the app, which
scopes it needs, and where the token endpoint is. Three fields, by convention
`client_id`, `client_secret`, `refresh_token`.

## If the provider only accepts a value in the URL
Some do. Telegram takes the bot token in the path; WhatsApp takes the phone
number id. Name those fields in `pathCredentials` on the tool:

  url              https://api.telegram.org/bot{creds.bot_token}/sendMessage
  pathCredentials  ['bot_token']

That is an opt-in recorded in the connector, and every named value is scrubbed
out of anything the call throws. It is separate from `auth` on purpose: WhatsApp
needs a bearer token in a header AND an id in the path, which an auth *type*
could not express. Name only the fields the provider genuinely requires there.

## Tools
One block per operation the automation actually uses. Not the whole API —
a connector with three used tools beats one with thirty untested ones.

  id       gmail.send                    ← dotted, `<integration>.<verb>`
  method   POST
  url      https://gmail.googleapis.com/gmail/v1/users/me/messages/send
  auth     bearer, field access_token
  body     { raw: "{arg.raw}" }          ← `{arg.x}` placeholders
  result   id                            ← dotted path to return, or omit
  summary  Send an email.

## Rules the engine enforces
- **A credential may not appear in a URL** unless the spec names it in
  `pathCredentials`. `{creds.*}` in a url or query is otherwise rejected
  outright — they leak into logs, error messages and run history. Use `auth`.
- **Public hosts only.** No localhost, link-local or private ranges: an
  automation that takes a URL as input must not become a way to reach the
  user's router or a cloud metadata endpoint.
- A body value that is *exactly* `{arg.x}` keeps x's type. `"{arg.x} items"`
  makes it a string.
```

## Then say so

Tell the user the file exists, which service it covers, and that dropping it
into `packages/connectors/src/catalog.ts` in the Studio repo is what turns it
into a working Connect button. The shape above is that file's shape, so the
translation is mechanical.
