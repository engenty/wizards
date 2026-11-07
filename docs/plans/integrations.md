# Plan: connecting a service without an OAuth client of your own

Status: planned on 2026-11-07, nothing decided and nothing built. Checked against `main` at
`f3c65789` (v0.17.2 plus #530–#536). Follows `docs/plans/capabilities-next.md`, whose pieces 1 to 4
built the import side.

## In short

Finding a service is solved, and a server that registers its own client connects in one click.
Every other OAuth service needs a client someone registered at the vendor, and today that someone
is the person connecting.

| | Step | Where | Who |
|---|---|---|---|
| 1 | Manage's connect proxy serves any vendor, not only Google | Manage repo | Agent |
| 2 | engenty holds one OAuth client per vendor | Vendor consoles, Coolify | Matthias |
| 3 | The cloud runtime reaches those clients | Manage repo, Coolify | Agent, Matthias |
| 4 | A hit in Entdecken says how you sign in, before you import | This repo | Agent |
| 5 | engenty.ai says what it offers, so integrations.sh lists it | Manage repo | Agent |

## What is built

- **Finding.** Entdecken searches integrations.sh (`registry-client.ts`, payload version 3). The
  registry is contacted only during an admin's search, preview or import.
  `ENGENTY_INTEGRATIONS_REGISTRY_URL` points at another one.
- **Importing.** An OpenAPI description or an MCP server becomes a Connector (`import-service.ts`),
  from a hit or from „Per Adresse“ (`ConnectorByAddress.tsx`). A plugin brings its Skills along.
- **Signing in.** `importer/map-auth.ts` maps a source to `none`, an authorization-code OAuth app
  (self-registering, or a client of your own), or one key in a header or query parameter.
- **Asking the server.** Where the registry gives an MCP server no OAuth facts, the import reads the
  server's own documents (`probeOAuth`). A registration endpoint there means no client is needed.
  Notion's MCP server goes this way: the preview says `needsOAuthClient: false` (2026-11-07).
- **Built-in Connectors.** Google, Microsoft, Slack and GitHub use OAuth and read
  `<VENDOR>_OAUTH_CLIENT_ID`/`_SECRET` (`connectors/builtin.ts`). Google and Microsoft fall back to
  `<VENDOR>_CLIENT_ID`. HubSpot, S3 and SMTP take a key.

## Where it stops

`usable()` lets a person connect an OAuth Connector in three cases: it registers its own client, the
runtime has a client, or Google goes through the linked account.

| Setup | Google | Microsoft, Slack, GitHub | Imported OAuth without self-registration |
|---|---|---|---|
| Cloud runtime | No client set | No client set | Admin brings a client |
| Your computer, account linked | Through Manage, off today | The person sets env vars | Admin brings a client |
| Your computer, own client | Works | Works | Admin brings a client |

- Manage's proxy (`apps/server/src/routes/connect.ts` in Manage, `docs/manage-contract.md` here) is
  Google only. It stays off until `GOOGLE_CONNECT_CLIENT_ID`/`_SECRET` are set on Coolify.
- `needsOAuthClient` is known only at preview. A person finds that out after choosing the hit.

## 1. The proxy for any vendor

`/v1/connect/google/*` becomes `/v1/connect/:vendor/*`, with the same start, callback, redeem and
refresh. Each vendor gets its endpoints, its scope allow-list and its callback address
`<MANAGE_URL>/connect/:vendor/callback`.

- Manage keeps no token, as today. The install stores them and marks the connection `via: "account"`.
- Every call still goes through the broker. The proxy only runs the consent and the token exchange.
- `viaAccount()` in `builtin.ts` stops naming `GOOGLE_OAUTH2` and asks for the Connector's vendor.
- `GET /v1/connect` lists the vendors that have a client.

## 2. The clients

Matthias registers one app per vendor and sets `<VENDOR>_CONNECT_CLIENT_ID`/`_SECRET` on Coolify
manage. Order: Google (only the env is missing), then Microsoft, Slack, GitHub.

Google reviews an app that asks for Gmail or Drive scopes before more than 100 people can use it.
That review has its own lead time.

## 3. The cloud runtime

It has no vendor client today, and `viaAccount()` is off where the runtime is `managed`. See open
question 1.

## 4. The sign-in on a hit

A hit in `DiscoverSection.tsx` says how you sign in, in one short line. It needs the facts the
preview reads now, or a cheaper form of them from the registry's `surface` call.

| The source | The hit says |
|---|---|
| Needs no sign-in | No sign-in |
| Registers its own client, or engenty holds one | Sign in with one click |
| Asks for a key | API Key |
| OAuth, no client anywhere | You need your own OAuth client |

The labels are drafts. They follow `docs/copy-style.md` when they are built.

The source's row needs the same fix. It shows „Eigener OAuth-Client“ as a button beside
„Importieren“ on every source (`Connectors.tsx:284`), also on Notion's MCP server, which needs none.
It reads as a requirement. The button moves behind the case that needs a client.

## 5. engenty.ai in the registry

integrations.sh reads `/.well-known/integrations.json` (v3), `/.well-known/mcp/server-card.json`
and `/llms.txt`. engenty.ai publishes the MCP endpoint `<APP_URL>/api/mcp` with its OAuth sign-in.
In Manage, `manage-app.ts` hands `/.well-known/*` to `auth.handler`, so these routes go before it.

## Open questions

1. **The cloud runtime: through the proxy, or its own env vars?** Recommendation: through the proxy.
   Each vendor then has one callback address, and one client to review and rotate.
2. **`GET /v1/connect` answers `{ google }` today.** Released installs read that key. Recommendation:
   answer `{ google, vendors }` until no supported release reads `google`.
3. **Who pays the vendor's terms?** A client held by engenty puts engenty's name on the consent page
   and makes engenty responsible for the vendor's terms. Matthias decides per vendor.
4. **HubSpot** takes a key today. OAuth needs one more app. Recommendation: leave it for now.
5. **Client ID Metadata Documents.** A server can accept a client that names itself by a public URL,
   with nothing to register (`client_id_metadata_document_supported`). The runtime doesn't read that
   field, so a server offering only this shows as needing a client of your own. Notion offers both,
   so it connects today. Recommendation: build it once a server offers only this. Your computer has
   no public URL, so engenty.ai would host the document.

## Not in this plan

- **A hosted broker** (Nango, Composio and the like). Tokens and calls would pass another company,
  which the model tiers' sub-processor lists and the broker's log don't cover.
- **A registry of our own.** integrations.sh stays the source, and the env var stays the way out.
- **2c** („Mit Freigabe“ waits in a run). It belongs to `capabilities-next.md` and the durable branch.

## Seen on the way

- „Einrichten“ on a hit in Entdecken opens the page on an empty „Verbindung hinzufügen“ form. The
  service's card sits below it, out of view. The form opens whenever `?setup=` is set
  (`ConnectorsSection.tsx:383`), also when `resolveSetup` finds a service to import, not a Connector.
- A service's credentials show as plain text with their markdown (`##`, `**`), and its summary with
  its backticks (`Connectors.tsx`). Both come from the registry, in the provider's language.
- A source without a description says „paste a spec URL on the Manual URL tab“, in English
  (`registry-client.ts:327`). The studio calls that tab „Per Adresse“.
