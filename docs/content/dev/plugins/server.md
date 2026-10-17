---
title: The server half
description: The function a plugin exports, what it is handed, and the rules it runs under.
version: 0.5.0
---

The server half is a file whose default export is a function. The runtime calls it once when the
plugin loads and hands it `wizards`. The function registers what the plugin adds.

```ts
import { definePlugin } from "@engenty/wizards/plugin";

export default definePlugin((wizards) => {
  const { server } = wizards;

  server.registerMigrations("migrations");
  server.registerHttpRoute({ method: "GET", path: "/", handler: async () => ({ ok: true }) });
  server.registerTool({ /* … */ });
  server.on("run.done", async (event) => { /* … */ });
});
```

`definePlugin` only types the function. The function may be `async`.

## What it is handed

| | |
|---|---|
| `wizards.server` | Registers tools, routes, tables and listeners. See the table below |
| `wizards.plugin` | The manifest: `id`, `name`, `version` and whatever else it holds |
| `wizards.config.get(key)` | A setting of the install: a line of its `.env`. Empty and missing are both `undefined` |
| `wizards.features.has(name)`, `.all()` | The feature switches of the tenant at hand. See [Feature switches](#feature-switches) |
| `wizards.log.info`, `.warn`, `.error` | A log line with the plugin’s name in front |
| `wizards.resolvePath(relative)` | A file of the plugin as an absolute path |

| `wizards.server.` | Does | Page |
|---|---|---|
| `registerTool(tool)` | A tool for AI steps | [Tools](./tools.md) |
| `registerSpaceContext(context)` | A block and tools for every AI step of a space | [The space](./space.md) |
| `registerAssistantTool(tool)` | A tool of the space assistant | [The space](./space.md#tools-of-the-space-assistant) |
| `registerAssistantContext(context)` | What the space assistant is told on the plugin’s own page | [The space](./space.md#the-assistant-on-the-plugins-own-page) |
| `spaceData.putPage(input)`, `putTable`, `putFile`, `putDocument`, `putCategories`, … | Knowledge of a space: pages, tables, files and categories | [The space](./space.md#knowledge-a-plugin-writes) |
| `spaces.brand(space)` | The space’s look: its title, colours and fonts | [The space](./space.md#the-spaces-brand) |
| `index.put(entry)`, `index.remove(space, key?)` | Texts in the space’s search index | [The space](./space.md#the-search-index) |
| `registerHttpRoute(route)` | A route below `/api/studio/plugins/<id>` | [Routes](./routes.md) |
| `registerPublicRoute(route)`, `publicUrl(path)` | A route anyone may call, and its address | [Routes](./routes.md#public-routes) |
| `registerSharedRoute(route)`, `sharedUrl(path)`, `publicRef()` | One route for every tenant, and the ref that names one | [Routes](./routes.md#shared-routes) |
| `channels.get()`, `request`, `withdraw`, `book` | The numbers the Manage-App gives the tenant | below |
| `claims.take(key)`, `put`, `drop`, `holder`, `mine` | Keys held across tenants, one tenant each | below |
| `registerRunner(runner)` | A door a wizard runs through, beside the page and the chat | [Runners](./runners.md) |
| `runs.start(…)`, `report`, `answerPage`, … | Drives runs from the plugin’s own door | [Runners](./runners.md#drive-a-run) |
| `speech.conversation()` | The tenant’s realtime speech model, for a call | [Runners](./runners.md#a-call) |
| `registerMigrations(folder)` | `.sql` files with the plugin’s tables | [Tables](./tables.md) |
| `on(event, listener)` | Called when a run ends or a space changes | [Events](./events.md) |
| `connections.available(…)`, `start`, `connect`, `list`, `call`, … | Accounts of a space, through the built-in connectors | [Accounts](./connections.md) |
| `registerStarter(starter)` | A wizard the plugin brings as a template | [Starters](./starters.md) |
| `every(name, everyMs, handler)` | A job, again and again | below |
| `web.fetch(url, init?)`, `web.read(url)` | Requests to the web, guarded | below |
| `documents.parse(file)` | A file as Markdown | below |
| `secrets.seal(value)`, `secrets.unseal(sealed)` | Keys of the plugin’s own, sealed for a table | below |
| `getTenantDb()` | The database of the tenant the current request, step or event belongs to | [Tables](./tables.md) |
| `generate(request)` | Asks a model of the current tenant | below |
| `onUnload(fn)` | Something to undo when the plugin unloads | below |

## Settings

Name a plugin’s settings after the plugin and read them when the plugin loads:

```ts
const url = wizards.config.get("NOTIFY_URL");
if (!url) {
  wizards.log.warn("NOTIFY_URL is not set: nothing will be sent.");
  return;
}
```

The person sets them in the install’s `.env` and restarts engenty wizards. A plugin doesn’t get
a settings page for free: a plugin that wants one adds a [settings section](./studio.md) and
keeps the values in a [table](./tables.md).

## Feature switches

A plugin declares its own switches in its manifest under `features`
([Files and manifest](./layout.md#the-manifest)). Everywhere else each one is known as
`<plugin id>.<name>`: in `wizards features`, in the install’s `.features` file and in the
`FEATURES` setting.

```ts
if (await wizards.features.has("leadScoring")) {
  server.registerTool(scoreLead);
}
```

- `has(name)` with a short name asks for the plugin’s own switch (`contacts.leadScoring`); a
  full name asks for any switch, the runtime’s own included.
- `all()` gives every switch of the tenant at hand, by its full name.
- A switch is off unless something turned it on.

## Tenants

A runtime serves one tenant on a person’s computer and many on engenty.ai. Either way, a plugin
never names a tenant:

- A route, a tool and a listener each run inside one tenant.
- `server.getTenantDb()` is that tenant’s database. Call it where you use it, not once at load
  time: at load time there is no tenant.
- State kept in a variable of the module is shared by all tenants. Keep per-tenant state in a
  table.

## Numbers of the Manage-App

On engenty.ai a team gets its number for texts and calls from engenty: it asks for one, an
admin assigns it. `server.channels` reads it for the current tenant and books what it carries;
the prices are the Manage-App’s ([manage contract](https://github.com/engenty/wizards/blob/main/docs/manage-contract.md#numbers-of-a-tenant)).

```ts
const channels = await server.channels.get();
// { number: { number: "+43…", country: "AT", kinds: ["sms", "call"], providerRef: "PN…" } | null,
//   request: { id, country, wish, createdAt } | null,
//   shared: [{ number, country, kinds }],
//   allowed: true }   // false: the plan has no number of its own (Free)

await server.channels.request({ userId: request.user.id, country: "AT", lang: "de" });
await server.channels.book({ kind: "sms", quantity: segments, key: messageSid, runId });
```

- `get` is kept for a minute; `request` and `withdraw` forget it.
- `request` throws `403` / `plan` on a plan without a number and `409` / `has_number` when
  the team has one. Asking again gives the open request.
- `book`: `sms` by segment, sent or received, `call` by started minute, `whatsapp` by
  message sent. The same `key` books once.
- A runtime without a Manage-App has no numbers: `get` gives `null`, `request` and `withdraw`
  throw `404` / `not_managed`, `book` books nothing.

## Keys across tenants

What a [shared route](./routes.md#shared-routes) needs to find its tenant: a keyword on a number
every tenant shares, who last wrote to it, a number a tenant connected. `server.claims` holds
such keys, each for one tenant at a time, in the runtime’s own database:

```ts
// In the tenant: the keyword is this tenant's, unless another one has it.
if (!(await server.claims.take(`kw:${keyword.toLowerCase()}`))) {
  throw Object.assign(new Error("Taken."), { status: 409, code: "keyword_taken" });
}
await server.claims.put(`sender:${waId}`); // the last tenant they wrote to has them

// In the shared route: whose is it?
const ref = await server.claims.holder(`kw:${text.toLowerCase()}`);
if (ref) {
  await inTenant(ref, () => handle(message));
}
```

| | |
|---|---|
| `take(key)` | The current tenant takes the key; `false` when another tenant holds it |
| `put(key)` | The current tenant gets the key, whoever held it |
| `drop(key)` | The current tenant gives the key up; a key another tenant holds stays |
| `holder(key)` | The ref of the tenant that holds the key, for `inTenant`; `null` for none. Also outside a tenant |
| `mine(key)` | Whether the current tenant holds the key |

Keys are 1 to 200 characters and the plugin’s own: another plugin’s key of the same name is
another key. They stay when a tenant loses the plugin; `inTenant` then answers `404`.

## Asking a model

`server.generate` asks one of the tenant’s models, the same ones its wizards run on, and is paid
like any other of its calls. With a `schema` the answer is an object of that shape:

```ts
const { object } = await server.generate({
  model: "classifier",
  system: "You sort support mails.",
  prompt: `Which team does this mail go to?\n\n${mail}`,
  schema: z.object({ team: z.enum(["sales", "support", "billing"]) }),
});
```

| Field | | Default |
|---|---|---|
| `prompt` | What the model is asked | required |
| `system` | How it should answer | |
| `schema` | A zod schema: `object` is the answer in that shape | text only |
| `model` | `classifier` (fast, cheap), `standard`, `high`, `highest` | `standard` |
| `maxOutputTokens` | A limit on the answer | the model’s |
| `signal` | Aborts the call | two minutes |
| `files` | Pictures (PNG, JPEG, WebP, GIF) and PDFs the model looks at with the prompt: `{ data, mediaType, name? }[]`, `data` a `Uint8Array` | none |

It answers `{ text, object }`. Without a model set up it throws an error with the status `503`
and the code `no_model`: a route that lets it through answers just that, and the studio half
says it in the person’s language.

## Jobs

```ts
server.every("refresh", 60 * 60_000, async ({ tenantId, lastRun, signal }) => {
  for (const source of await dueSources()) {
    await refresh(source, signal);
  }
});
```

- The handler runs for every tenant that has the plugin, inside that tenant, at most once per
  `everyMs`. The shortest interval is a minute.
- A job’s name is lower case, digits and `_`, once per plugin.
- The runtime keeps when a job ran, so a restart does not start the count again. A runtime that
  was off runs a due job once when it starts, not once per turn it missed. On a person’s computer,
  jobs run while engenty wizards runs.
- One turn per tenant at a time. A turn that throws is logged and counts as run.
- `lastRun` is when the turn before started; `null` the first time. `signal` is aborted
  when the plugin unloads.
- `PLUGIN_JOBS=0` keeps a runtime from running jobs, for one whose jobs another process runs.

## The web

```ts
const page = await server.web.read("https://example.com/preise");
// { url, status, etag, lastModified, title, description, text, links, jsonld }

const res = await server.web.fetch(`${origin}/sitemap.xml`, {
  headers: { "if-none-match": source.etag ?? "" },
});
```

- Both refuse addresses of the computer the runtime runs on and of its local network, after a
  redirect too, as the runtime’s own requests do.
- `read` gives the page’s text as Markdown and its links, absolute and each once (up to
  2,000). A page with hardly any text without its scripts is drawn in a browser first. `etag`
  and `lastModified` are what the server sent, for asking later whether the page changed. `jsonld`
  is the page’s structured data (its `application/ld+json` blocks, parsed): a shop’s product
  page says title, price, availability and image there exactly, without a model.
- `fetch` is `fetch` behind the guard: for a sitemap, `robots.txt`, a question with
  `if-none-match`.

## Keys of the plugin’s own

A plugin that talks to a shop or a service with keys the person typed keeps them sealed, as the
runtime seals a connection’s tokens:

```ts
await db().update(store).set({ credentials: server.secrets.seal({ token }) });
const keys = server.secrets.unseal<{ token: string }>(row.credentials);
```

`unseal` answers null for a value sealed on another install: ask for the keys again.

## Documents

```ts
const { markdown, pages } = await server.documents.parse({ data, name: "preise.pdf", mime });
```

PDF and Word files are read by their own text, scans and photos by a vision model, and
spreadsheets and CSV files as tables. What was read is kept by content, so the same bytes are
read, and paid for, only once.

## Undo on unload

A plugin can load again while the runtime runs. What it registered through `wizards.server` is
taken back for it. Anything else it started, it undoes itself:

```ts
const timer = setInterval(sync, 60_000);
server.onUnload(() => clearInterval(timer));
```

The functions run last-first when the plugin unloads or loads again.

## When loading fails

A plugin whose function throws keeps nothing of what it registered before the error, so there
are no half-loaded plugins. Settings → Plugins shows the error, and the plugin’s routes answer
`404` until you fix its file.

## Imports

`@engenty/wizards/plugin` (and `@engenty/wizards/plugin/thread`), `zod`, `drizzle-orm` and
`drizzle-orm/sqlite-core` come from the runtime’s own copies, so a schema or a table a plugin
makes is one the runtime understands. See [Files and manifest](./layout.md#dependencies) for
everything else.
