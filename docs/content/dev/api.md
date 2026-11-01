---
title: The API
description: What a program may rely on when it talks to a runtime, and what is private.
version: 0.15.0
---

A runtime answers HTTP under `/api`. Three parts are a contract: they are versioned, documented
and change with notice. Everything else is the studio’s own and changes without notice.

## What a program may rely on

| Part | For | Signed in as |
|---|---|---|
| `/api/v1/…` | programs that build and publish wizards: the spaces of a local install, importing a wizard | an access token of the account, with scopes (`wizards:read`, `wizards:write`, `wizards:publish`, `runs:test`); see [the Manage-App contract](https://github.com/engenty/engenty-wizards/blob/main/docs/manage-contract.md) |
| `/api/v1/spaces/:spaceId/elements` | programs that use a space: search its knowledge, read its skills, call its connections, run its wizards (see below) | the same tokens, with `data:read`, `elements:read`, `elements:run` |
| `/api/v1/client/…` | apps for a firm’s clients, like the client portal: their client spaces, what waits for them, chats, files, results, the wizards opened to them (see below) | a token of a person with the role `client`, with `data:read`, `elements:read`, `elements:run` |
| `/api/mcp` | AI apps: every tool of [the MCP server](../user-guide/ai-apps.md), the space’s elements among them | the same tokens, or the local ticket `wizards mcp` carries |
| The public run API: `/api/public/wizards/:token`, `/api/public/wizards/:token/runs`, `/api/public/codes/:code`, `/api/runs/:id/…` | running a published wizard by its link: what the runner in a browser does | nobody; a visitor cookie, or the `x-wizards-visitor` header where a cookie does not survive |

## A space’s elements

What Studio makes in a space – its knowledge, skills, connections and published wizards – is open
to programs and AI apps the way a Work chat uses it, as the person the token belongs to.
`GET /api/v1/spaces/:spaceId/elements` lists the calls the token may make, each with its scope
and its input as JSON Schema. `POST /api/v1/spaces/:spaceId/elements/:name` with
`{ "input": { … } }` makes one and answers `{ "result": … }`, or an error with why. The MCP
server has the same calls as tools, each with a `spaceId`.

| Call | Scope | Does |
|---|---|---|
| `space_search`, `space_list`, `page_read`, `table_read`, `space_document` | `data:read` | Search and read the space’s knowledge |
| `skill_list`, `skill_load`, `skill_read` | `elements:read` | Read the space’s skills |
| `connection_list`, `wizard_list` | `elements:read` | Name the connections' actions and the published wizards |
| `connection_call`, `wizard_run`, `run_command` | `elements:run` | Call an action, run a wizard, run a skill’s scripts in a sandbox of the space |

The space’s rules decide every call, and each is a line of the broker’s log with the client’s
name (`x-wizards-client`, or the MCP client’s). A space outside the token’s organization is
refused. A write, a send or a delete on a connection runs only where the space allows it without a
person’s yes.

## A client’s client spaces

A firm works for its clients in client spaces under its space. A client of the organization signs
in with an account of their own and reaches only the client spaces they are in. The client
portal (`<team>.wizards.page/portal`) is built on these calls alone, so another app can offer the
same. `GET /api/v1/client` lists them with their inputs as JSON Schema. A call is
`POST /api/v1/client/:name`, or `POST /api/v1/client/spaces/:spaceId/:name` for one client space,
with `{ "input": { … } }`; it answers `{ "result": … }`, or an error with why.

| Call | Scope | Gives |
|---|---|---|
| `me`, `spaces` | `data:read` | Who you are, your organization, your client spaces with their address (`slug`) and the firm’s brand |
| `for_you` | `data:read` | Your runs waiting on a page or an answer, the results the firm shared, the wizards you can start |
| `wizards`, `wizard_start` | `elements:read`, `elements:run` | The firm’s wizards opened to clients, each with its engenty (`avatar`) and its number of steps; a start runs it in your client space |
| `results`, `run_open` | `data:read` | Your finished runs and those the firm shared; a ticket for one run’s own routes (`/api/runs/:id/…?rt=…`) |
| `chats`, `chat_messages` | `data:read` | Your chats in the client space and their messages: each message’s `parts` in the order they were written, its text and the views and runs of the firm’s AI as cards |
| `chat_post` | `elements:run` | Writes in one of your chats, or starts one. The firm’s AI answers every message as you, with the client space’s Knowledge, the wizards opened to you and views; the firm’s people read the chat too |
| `files` | `data:read` | The client space’s files. One file’s bytes: `GET /api/v1/client/spaces/:spaceId/files/:fileId` |

Only a person with the role `client` gets an answer (`403 clients_only` otherwise). A space that is
not one of yours answers `404`. The firm’s Knowledge and wizards reach you only where the firm
opened them to clients, and a run the firm makes in your client space only once it is shared with
you. The calls need the organization’s `clientSpaces` switch.

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
