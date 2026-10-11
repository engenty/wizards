---
title: The API
description: What a program may rely on when it talks to a runtime, and what is private.
---

A runtime answers HTTP under `/api`. Three parts are a contract: they are versioned, documented
and change with notice. Everything else is the studio's own and changes without notice.

## What a program may rely on

| Part | For | Signed in as |
|---|---|---|
| `/api/v1/…` | programs that build and publish wizards: the spaces of a local install, importing a wizard | an access token of the account, with scopes (`wizards:read`, `wizards:write`, `wizards:publish`, `runs:test`); see [the Manage-App contract](https://github.com/engenty/engenty-wizards/blob/main/docs/manage-contract.md) |
| `/api/mcp` | AI apps: every tool of [the MCP server](../user/ai-apps.md) | the same tokens, or the local ticket `wizards mcp` carries |
| The public run API: `/api/public/wizards/:token`, `/api/public/wizards/:token/runs`, `/api/public/codes/:code`, `/api/runs/:id/…` | running a published wizard by its link: what the runner in a browser does | nobody; a visitor cookie, or the `x-wizards-visitor` header where a cookie does not survive |

## Private

`/api/studio/…`, `/api/auth/…` and `/api/internal/…` belong to the studio, the sign-in and the
Manage-App. They change with every release and are not meant for other programs. A program that
needs something only they have asks for it on `/api/v1`.

## Who you are: `x-wizards-client`

Every start of a run over the public API names the client that starts it, in the
`x-wizards-client` header: `web` is the runner in a browser, `app` the mobile app, `cli` the
command line. A client of your own sends its own id: lower-case letters, digits and hyphens.
The run keeps the id.

The id is no secret and proves nothing. It carries the terms a client runs under:

| Runtime | Does with the id |
|---|---|
| One that runs alone (your computer, your server) | Keeps it on the run. Nothing is refused: the API is yours |
| engenty.ai | Asks its list of clients: a registered id runs under its limits, an unknown one under the public limits, a revoked one not at all. The [terms of the hosted API](https://engenty.ai/api-terms) say how a client registers and what it may do |

An answer of `403` with `code: "client_refused"` means the id may not start runs there;
`429` with `code: "client_limit"` means it started too many this hour.
