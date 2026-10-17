---
title: Reference
description: Every call, type, address and setting of the plugin framework on one page.
version: 0.5.0
---

## Server half

`import { definePlugin } from "@engenty/wizards/plugin"`

`import { ThreadDoor } from "@engenty/wizards/plugin/thread"`: a wizard run in a
messenger’s thread, one message at a time, for which a plugin brings the surface. See
[Runners](./runners.md#a-thread-door-from-the-sdk).

The default export is a `WizardsPluginFactory`: `(wizards: WizardsPluginApi) => void | Promise<void>`.

### `wizards`

| | Type | |
|---|---|---|
| `plugin` | `PluginManifest` | The manifest |
| `server` | `PluginServerApi` | Below |
| `config.get(key)` | `string \| undefined` | A setting of the install: a line of its `.env` |
| `features.has(name)`, `features.all()` | `Promise<boolean>`, `Promise<Record<string, boolean>>` | The tenant’s feature switches. A short name is the plugin’s own switch from its manifest (`<id>.<name>`); a full name asks for any switch. Off unless something turned it on |
| `log.info`, `log.warn`, `log.error` | `(...args) => void` | A log line with the plugin’s name |
| `resolvePath(relative)` | `string` | A file of the plugin as an absolute path |

### `wizards.server`

| Call | |
|---|---|
| `registerTool(tool: PluginTool)` | [Tools](./tools.md) |
| `registerRunner(runner: PluginRunner)` | [Runners](./runners.md). A door a wizard runs through; `page` runners answer at `/w/<token>/<id>` |
| `runs` | [Runners](./runners.md#drive-a-run). `start`, `report`, `wizards`, `answerPage`, `review`, `answerAsk`, `control`, `subscribe`, `handoffUrl`, `upload`, `transcribe`: the functions behind the MCP tools, for the plugin’s door |
| `speech.conversation()` | [Runners](./runners.md#a-call). `{ provider: "openai", apiKey, model }`: the tenant’s realtime speech model, for a call a plugin drives itself. Throws `503` / `no_model` while none is set up |
| `registerSpaceContext({ block, tools?, steps? })` | [The space](./space.md). `block(space): string \| null`; `steps`: `agent` (default), `html` (steps that write a document or a dashboard, without the tools) |
| `spaces.brand(space)` | [The space](./space.md#the-spaces-brand). `{ name, colors, fonts }` of the space, or `null` |
| `registerAssistantTool(tool: PluginAssistantTool)` | [The space](./space.md#tools-of-the-space-assistant) |
| `index.put({ space, key, title, text, link? })`, `index.remove(space, key?)` | [The space](./space.md#the-search-index) |
| `spaceData.putCategories`, `.putPage`, `.putTable`, `.putFile`, `.putDocument`, `.list`, `.readPages`, `.files`, `.readFile`, `.remove`, `.summarize` | [The space](./space.md#knowledge-a-plugin-writes). Knowledge of a space: pages, tables and files under keys of the plugin’s own, with their categories; and the space’s own pages and files to read |
| `registerHttpRoute(route: PluginRoute)` | [Routes](./routes.md) |
| `registerPublicRoute(route: PluginPublicRoute)` | [Routes](./routes.md#public-routes) |
| `publicUrl(path): Promise<string>` | The full address of a public route for the current tenant |
| `publicRef(): Promise<string>` | [Routes](./routes.md#shared-routes). The part of `publicUrl` that names the current tenant |
| `registerSharedRoute(route: PluginSharedRoute)` | [Routes](./routes.md#shared-routes). One route for every tenant; `handler({ request, path, params, query, inTenant })` |
| `sharedUrl(path): string` | The full address of a shared route, the same for every tenant |
| `claims.take(key)`, `.put(key)`, `.drop(key)`, `.holder(key)`, `.mine(key)` | [Keys across tenants](./server.md#keys-across-tenants). Each key for one tenant at a time; `holder` gives the tenant’s ref for `inTenant` |
| `channels.get()`, `.request({ userId, country, wish?, lang })`, `.withdraw()`, `.book({ kind: "sms" \| "call" \| "whatsapp", quantity, key, runId? })` | [Numbers of the Manage-App](./server.md#numbers-of-the-manage-app). `get`: `{ number, request, shared, allowed }` or `null` without a Manage-App |
| `registerMigrations(folder: string)` | [Tables](./tables.md). The folder is relative to the plugin’s |
| `on(event, listener)` | [Events](./events.md). `event`: `"run.done"`, `"run.failed"`, `"run.cancelled"`, `"space.created"`, `"space.updated"`, `"space.deleted"`, `"space.file.ready"`, `"space.file.removed"` |
| `every(name, everyMs, handler)` | [Jobs](./server.md#jobs). Per tenant that has the plugin, at most once per `everyMs` (a minute at least). `handler({ tenantId, lastRun, signal })` |
| `web.fetch(url, init?)`, `web.read(url, { signal? })` | [The web](./server.md#the-web) |
| `documents.parse({ data, name, mime }, { signal? })` | [Documents](./server.md#documents). `{ markdown, pages }` |
| `getTenantDb(): PluginDb` | The current tenant’s database, a Drizzle libSQL database |
| `generate(request): Promise<{ text, object }>` | Asks a model of the current tenant: `prompt`, `system?`, `schema?`, `model?`, `maxOutputTokens?`, `signal?`, `files?` (pictures and PDFs: `{ data, mediaType, name? }[]`). See [The server half](./server.md#asking-a-model) |
| `connections.available(ids)`, `.start({ space, connector, actions, lang? })`, `.connect({ space, connector, actions, credentials })`, `.list(space)`, `.get(id)`, `.call(id, action, input)`, `.remove(id)` | [Accounts](./connections.md). `lang`: the language of the page the person comes back to |
| `secrets.seal(value): string`, `secrets.unseal(sealed)` | [Keys of the plugin’s own](./server.md#keys-of-the-plugins-own). `unseal` gives null for a value sealed on another install |
| `registerAssistantContext({ block })` | [The space](./space.md#the-assistant-on-the-plugins-own-page). `block(space): string \| null` |
| `registerStarter(starter: PluginStarter)` | [Starters](./starters.md). Known as `<plugin id>.<starter id>` |
| `onUnload(fn)` | Runs when the plugin unloads or loads again |

### `PluginTool`

```ts
interface PluginTool<S extends z.ZodType = z.ZodType> {
  name: string;           // lower case, digits and "_"
  title?: string;         // what the editor calls it
  description: string;    // for the model
  inputSchema: S;
  execute(input: z.infer<S>, step: PluginStepContext): unknown | Promise<unknown>;
}

interface PluginStepContext {
  runId: string;
  stepId: string;
  tenantId: string;
  space: { id: string; name: string };    // the space of the step's wizard
  project: { id: string; name: string };  // the same, by its older name
  wizard: { id: string; title: string };
  mode: "test" | "live";                  // "test": a test run from the studio
  signal: AbortSignal;                    // aborted when the run is cancelled
  emit(message: string): Promise<void>;   // tells the person what the step is doing
}
```

### `PluginRunner`

```ts
interface PluginRunner {
  id: string;                          // lower case, digits and "-", at most 24 characters
  label: { de: string; en: string };
  kind: "page" | "channel";            // an address the person opens, or a channel of its own
  capabilities: {
    input: string[];                   // field kinds asked by the runner itself
    output: { shows: string[]; pictures: string[] };
    asks: ("confirm" | "login")[];
    review: ("accept" | "regenerate" | "edit")[];
    waits: boolean;
    handoff: ("screen" | "thread" | "sms" | "push")[];
  };
  page?(request: PluginRunnerRequest): Response | Promise<Response>;
  problem?(): string | PluginRunnerProblem | null | Promise<string | PluginRunnerProblem | null>;  // why not usable in this tenant right now
  address?(wizard: { id: string; title: string; token: string }):
    | PluginRunnerAddress | null | Promise<PluginRunnerAddress | null>;  // where a person reaches the wizard
}

interface PluginRunnerProblem {
  text: string;                           // in the owner's words
  kind?: "setup" | "waiting" | "plan";    // default "setup"
  note?: { de: string; en: string };      // what the share dialog's row says instead
  plan?: string;                          // "plan": the plan that has it
}

interface PluginRunnerAddress {
  number?: string | null;   // the number people write to or call, with the country code
  keyword?: string | null;  // the word that picks this wizard on that number
  link?: string | null;     // opens the channel with the keyword written: copied, and as a QR code
}

interface PluginRunnerRequest {
  request: Request;
  tenantId: string;
  wizard: { id: string; token: string; title: string };
  path: string;                        // below /w/<token>/<id>
  query: URLSearchParams;
}
```

### `PluginRuns`

```ts
interface PluginRuns {
  start(input: ({ token: string } | { wizardId: string }) & {
    person: { channel: string; id: string };
    answers?: Record<string, unknown>;
    runner?: string;
  }): Promise<{ runId: string; ticket: string; refused: { field: string; message: string }[] | null }>;
  report(runId: string, options?: { waitSeconds?: number; draft?: Record<string, unknown> }): Promise<PluginRunReport>;
  wizards(runner: string): Promise<{ wizardId: string; token: string; title: string; lang: "de" | "en" }[]>;
  answerPage(runId: string, stepId: string, values: Record<string, unknown>): Promise<void>;
  review(runId: string, stepId: string, action: PluginReviewAction): Promise<void>;
  answerAsk(runId: string, askId: string, answer: "allow" | "skip"): Promise<void>;
  control(runId: string, action: "back" | "retry" | "cancel"): Promise<void>;
  subscribe(runId: string, listener: (signal: PluginRunSignal) => void): () => void;
  handoffUrl(runId: string): Promise<string>;
  upload(runId: string, file: { data: Uint8Array | ArrayBuffer; mime: string; name: string }): Promise<{ assetId: string }>;
  transcribe(runId: string, file: { data: Uint8Array | ArrayBuffer; mime: string }): Promise<{ text: string }>;
}
```

`waitSeconds` is at most 45. `draft`: the answers a door has so far for the page shown, so a
field’s `shown` follows them. `wizards(runner)`: the published wizards that switched the runner
on. `transcribe`: a recording of the person written down, charged to the run.

`PluginRunReport` is what `get_run` gives an MCP client: status, the step, `waitingFor` (a
page with its fields shown, a review, a question), outputs with signed links, cost,
`browserUrl`. The types carry the fields.

### `PluginRoute`

```ts
interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                 // "/", "/items", "/items/:id"
  role?: "member" | "admin";    // "admin": owners and admins only
  handler(request: PluginRequest): unknown | Promise<unknown>;
}

interface PluginRequest {
  request: Request;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  user: { id: string; tenantId: string; role: "owner" | "admin" | "member"; name: string; email: string };
  json<T = unknown>(): Promise<T>;
}
```

### `PluginAssistantTool`

```ts
interface PluginAssistantTool<S extends z.ZodType = z.ZodType> {
  name: string;           // lower case, digits and "_"
  description: string;    // for the model
  inputSchema: S;
  card?: boolean;         // the result also goes to the chat, for the studio half's card
  execute(input: z.infer<S>, turn: PluginAssistantContext): unknown | Promise<unknown>;
}

interface PluginAssistantContext {
  tenantId: string;
  space: { id: string; name: string };
  userId: string;
  signal: AbortSignal;
  emit(message: string): void;   // the line the chat shows
  changed(): void;               // the space page draws again
}
```

### `PluginPublicRoute`

```ts
interface PluginPublicRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler(request: PluginPublicRequest): unknown | Promise<unknown>;
}

interface PluginPublicRequest {
  request: Request;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  tenantId: string;    // the tenant of the address; nobody is signed in
  json<T = unknown>(): Promise<T>;
}
```

### `PluginStarter`

```ts
interface PluginStarter {
  id: string;                    // lower case, digits and "-"
  title: string;
  description: string;           // what it makes, in one or two sentences
  language?: "de" | "en";        // the language of its texts; default "en"
  definition: unknown;           // a complete wizard definition, checked when it is registered
  files?: Record<string, string | Uint8Array>;  // workspace files by path; a string is UTF-8
}
```

### `PluginRunEvent`

```ts
interface PluginRunEvent {
  run: { id: string; wizardId: string; mode: "test" | "live"; status: "done" | "failed" | "cancelled" };
  wizard: { id: string; title: string; projectId: string };
  values: Record<string, unknown>;   // what the person answered, by field id
}
```

## Studio half

`import { defineStudioPlugin } from "@engenty/wizards/plugin/studio"`

The default export is a `StudioPlugin`: `(studio: StudioPluginContext) => void`.

| | |
|---|---|
| `studio.plugin` | `{ id, name, version }` |
| `studio.registerPage({ path, component, wide? })` | A page at `/studio<path>` |
| `studio.registerNav({ to, label, icon })` | An icon in the app bar. `label: () => string` |
| `studio.registerSettingsSection({ id, label, icon, component, menu? })` | A section at `/studio/settings/<id>` |
| `studio.registerShareSection({ runner, component })` | [Runners](./runners.md#the-runners-part-of-the-share-dialog). The runner’s own settings for a wizard (a keyword), under the share dialog’s gear once it is switched on and set up. `component` gets `{ wizard: { id, title } }` |
| `studio.registerShareSetup({ runner, title, component, notice? })` | [Runners](./runners.md#setting-up-inside-the-dialog). What “Set up” in the runner’s row opens inside the share dialog. `component` gets `{ wizard, Actions, done(banner?) }`, `notice` `{ wizard, open }` |
| `studio.registerAssistantCard({ tool, component })` | Draws a tool’s result in the space assistant’s chat. `component` gets `{ data, send }` |
| `studio.registerSpaceSection({ id, group?, label, hint?, component })` | A section of a part of the space page at `/studio/space/<group>#<id>`; `group`: `info`, `knowledge` (default), `data` or `results` |
| `studio.registerSpacePart({ id, label, icon, after?, component })` | [A part of the plugin’s own](./studio.md#a-part-of-the-plugins-own) at `/studio/space/<id>`, after `info`, `knowledge` or `data` (default) in the menu |
| `studio.useSpaceMenu(entries)` | A hook in a plugin’s part: its menu, `{ id, label, icon? }[]`, each jumping to the element with that id |
| `studio.useCrumbs(items)` | A hook: the trail in the top bar for the page shown, `{ label, to? }[]`, instead of a heading of the page’s own |
| `studio.Assistant` | Tells the studio’s assistant what to say on a page of the plugin: `title?`, `hello?`, `placeholder?`, `suggestions?: { label, message?, fill? }[]`, `onChanged?`. Draws nothing |
| `studio.useAssistantPage(page)` | A hook: what the page shows, for the assistant: `open?: { kind, id?, label }`, `selection?`, `summary?`, `fields?: { id, label, value }[]`, `compact?`, and the words of `studio.Assistant` |
| `studio.useAssistantTool(name, { description, parameters? }, run)` | A hook: a tool the assistant runs in the page while it is shown, as `<plugin>_<name>`. `parameters`: JSON Schema; `run(args)` returns what the assistant learns |
| `studio.useSpace()` | A hook: `{ id, name, readOnly, brand }` of the space the studio shows, or `null`; `brand` is `{ name, colors, fonts }` |
| `studio.i18n.register({ de, en })` | Gives `t(key, vars?)`. A key missing in the language shown falls back to `de` |
| `studio.i18n.lang()` | `"de"` or `"en"` |
| `studio.api.get`, `.post`, `.put`, `.patch`, `.del` | The plugin’s own routes |
| `studio.me()` | `{ user: { id, name, email }, tenant: { id, role }, mode: "managed" \| "local" }` |
| `studio.onUnload(fn)` | Runs when the studio half loads again |

## Ids and names

| | Rule | Example |
|---|---|---|
| Plugin id | Lower case, digits and `-`, starting with a letter, at most 40 characters | `run-log` |
| Tool name | Lower case, digits and `_`, starting with a letter, at most 40 characters | `recent` |
| Tool id in a wizard | `<plugin id>.<tool name>` | `run-log.recent` |
| Tool name for the model | The id with `_` for `.` and `-` | `run_log_recent` |
| Starter id | Lower case, digits and `-`, starting with a letter, at most 40 characters | `book` |
| Starter id in a list of templates | `<plugin id>.<starter id>` | `contacts.follow-up` |
| Table name | Begins with the plugin’s id | `run_log_entry` |
| Runner id | Lower case, digits and `-`, starting with a letter, at most 24 characters; not a built-in runner (`steps`, `chat`, `talk`, `video`) or a sub-path of a wizard’s address (`runs`, `icons`) | `kiosk` |
| Element around what a plugin draws | `data-plugin="<plugin id>"` | |

## Addresses

All below `/api/studio/plugins`, all signed in:

| Address | | Who |
|---|---|---|
| `GET /` | The tenant’s plugins: id, name, version, description, tools, where the built files are, why a server half did not load; and what looked like a plugin and is none | Everyone; what is none: owners and admins, alone |
| `ALL /<id>/…` | The plugin’s own routes | Members of a tenant that has the plugin; `role: "admin"` routes owners and admins |
| `GET /-/assets/<id>/client.js`, `/client.css` | The built studio half | Members of a tenant that has the plugin |
| `GET /-/events` | A stream that says when a plugin loaded again | Everyone, alone |
| `POST /-/reload` | Loads every plugin again | Owners and admins, alone |
| `POST /-/reload/<id>` | Loads one plugin again | Owners and admins, alone |

“Alone”: where the runtime runs on its own, not as the runtime of engenty.ai.

For programs, with an API key or an access token:

| Address | | Who |
|---|---|---|
| `ALL /api/v1/plugins/<id>/…` | The plugin’s own routes, as the key’s person. [With a key](./routes.md#with-a-key) | `GET` with `wizards:read`, the rest with `wizards:write`; `403` `plugin` where the account lacks the plugin |

And public, nobody signed in:

| Address | |
|---|---|
| `ALL /api/public/plugins/<id>/<ref>/…` | A plugin’s public routes; `<ref>` names the tenant. `server.publicUrl` gives the full address |
| `ALL /api/public/plugins/<id>/shared/…` | A plugin’s shared routes, one address for every tenant. `server.sharedUrl` gives the full address |
| `/w/<token>/<runner>` | A plugin’s page runner for a wizard that switched it on (built; from source `/api/public/wizards/<token>/runners/<runner>`) |

The studio’s addresses of a plugin: `/studio<path>` for its pages, `/studio/settings/<id>` for a
settings section, `/studio/space/<group>#<id>` for a section of the space page and
`/studio/space/<id>` for a part of it.

## Settings

In the install’s `.env`:

| Setting | | Default |
|---|---|---|
| `PLUGINS_DIR` | Folders to look for plugins in, comma-separated, besides the runtime’s `modules/` | Installed app: `~/.engenty/wizards/plugins`. Checkout: none |
| `PLUGINS_WATCH` | `0`: plugins do not load again when their files change. A runtime of engenty.ai never reloads them | `1` |
| `PLUGINS_DEFAULT` | On engenty.ai: the ids of the plugins every tenant has, comma-separated | none |
| `PLUGIN_JOBS` | `0`: this runtime runs no jobs (`server.every`), for one whose jobs another process runs | `1` |

## Files

| File | |
|---|---|
| `engenty.plugin.json` | The manifest: [Files and manifest](./layout.md#the-manifest) |
| `src/plugin.ts` | The server half |
| `migrations/*.sql` | Tables, where the server half registers the folder |
| `ui/plugin.tsx` | The studio half’s source |
| `dist/client.js`, `dist/client.css` | The studio half, built by `node scripts/build-plugin.mjs <folder>` |

## In the repository

| | |
|---|---|
| `packages/wizards/src/plugin/` | The types, with their comments |
| `apps/runtime/src/plugins/` | Finding, loading, tables, events |
| `apps/runtime/src/routes/plugins.ts` | The addresses above; `apps/runtime/src/routes/api.ts` the ones for programs |
| `apps/web/src/plugins/` | The studio’s side |
| `scripts/build-plugin.mjs` | The build of a studio half |
| `apps/runtime/test/plugins.test.ts` | Loading, routes, tools, tables per tenant, reloading |
