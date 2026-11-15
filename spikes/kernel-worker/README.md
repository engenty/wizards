# Spike: one wizard as a Cloudflare Worker

One wizard of version 0.3.0, built with the kernel into one Worker. Each run is a Durable Object (`runObject` from `packages/kernel/src/edge.ts`). The step files are imported into the bundle and run as plain code. No QuickJS: the bundle has none of it, and none is needed for one wizard on infrastructure of its own. A sandbox only matters where strangers' wizards share one host.

Local only (`wrangler dev`, and `workerd serve` below); nothing was deployed.

```bash
pnpm install --ignore-workspace     # this folder is not in the workspace
pnpm dev                            # build.mjs + wrangler dev on :8787; WIZARD=wizards/x-post-image pnpm dev for the other one
pnpm flow                           # start, first page, review twice, read the run
```

## What is here

| File | What it does |
|---|---|
| `build.mjs` | Takes one wizard folder (`wizard.json` + `steps/*.ts`) and bundles it with the kernel into `dist/worker.js`. Refuses a wizard whose `requires.tools`, `connections` or `requires.roles` this Worker can't give. |
| `src/worker.ts` | `GET /` (the wizard), `POST /runs`, `GET /runs/<id>`, `POST /runs/<id>/answer`, `/rewind`, `/judge`. The run id is the Durable Object's name. |
| `src/batteries.ts` | `agent`: one chat completion over `fetch` to an OpenAI-compatible endpoint (`MODEL_BASE_URL`, secret `MODEL_API_KEY`, `MODELS` maps each model class to a model). Echoes without a key. `form`, `review`, `approval`, `wait`, `signal` wait for HTTP. Every other ask type fails at once: `This Worker has no battery for "<type>" asks.` |
| `wizards/x-post` | The converted marketplace wizard "X-Post mit Bild (0.3.0)" without its image step: `post` (model `low`) and `check` (review). Step files unchanged. |
| `wizards/x-post-image` | The same wizard whole, to show an ask without a battery failing. |
| `stub-model.mjs` | A local OpenAI-compatible stand-in, to run the `fetch` path without an account. |

Files in R2: not built. Nothing in these wizards writes a file, and the image is what would need it (see below).

## What ran

`pnpm dev` + `pnpm flow`, with `.dev.vars` pointing the agent battery at `stub-model.mjs`:

```
# POST /runs (no input: the first page waits)
HTTP 200 · run 1b22f64b-… · status waiting · at post
  0 input form waiting
# answer the first page
  1 post agent(low) done   2 post left → check   3 check review waiting
  post: "Freitag 17 Uhr: Unser Yoga-Studio in Wien öffnet – die erste Stunde ist gratis. (gpt-4.1-mini)\n\nhttps://example.com/eroeffnung"
# review: a new text, please
  4 check left → post   5 post agent(low) done   6 post left → check   7 check review waiting
# review: approved with an edit
HTTP 200 · status done · at the end   8 check left → end
  output: {"post":"Freitag, 17 Uhr: unser Yoga-Studio in Wien öffnet. Erste Stunde gratis 🧘\n\nhttps://example.com/eroeffnung"}

stub: POST /v1/chat/completions model=gpt-4.1-mini auth=yes prompt=883 chars
stub: POST /v1/chat/completions model=gpt-4.1-mini auth=yes prompt=1121 chars   (the new version, with the old one in the prompt)
```

The same flow without a key: the post is `Echo (low): Post schreiben` with the link appended by the step's code; the run ends the same way.

`WIZARD=wizards/x-post-image pnpm dev`, `POST /runs` with input:

```
status failed | error: This Worker has no battery for "generate" asks.
  0 post agent(low) done   1 post left → visual   2 visual agent(low) done
  3 visual generate failed: This Worker has no battery for "generate" asks.
```

`node build.mjs <Recherche-Briefing (0.3.0)>`: `This Worker cannot run "Recherche-Briefing (0.3.0)". It lacks the tool "web_fetch", the tool "web_search".` (exit 1)

Size: 15.5 KiB minified for the kernel, the Worker and two steps; 17.4 KiB with three. Build: ~15 ms. Requests to `wrangler dev` answer in ~8 ms. Cold start on Cloudflare is not measured (no deploy); a script this small is far below anything that slows an isolate's start.

## What the format lacks to be self-contained

**A pin to its runner.** `wizard.json` says `version: "0.3.0"`, the format. Nothing says which kernel and which batteries the folder was written and tested against. Yes: the folder should carry a `package.json` that pins them, e.g. `@engenty/wizards-kernel` and an `@engenty/wizards-edge` (this spike's `worker.ts` + `batteries.ts`), plus the npm packages its steps import. Then `pnpm install && wizards build` makes the same bundle anywhere. `wizard.json` stays the place for what the wizard requires; `package.json` is only how it is built.

**`requires` → bindings.** It maps, but only by a convention nobody has written down:

| `requires` | Worker |
|---|---|
| `models` | a var naming a model per class (`MODELS`) + a secret key per endpoint |
| `tools` | a battery for each tool in the bundle; the build refuses the wizard without it (done here for all tools) |
| `connections` | a secret per connection. OAuth tokens that expire need a refresh somewhere; that is a service, not a binding |
| `roles` | someone who answers over HTTP: auth per role is missing (below) |
| `hosts` | a check in the `http.request` battery; a Worker can't limit its own outbound fetches |
| files | an R2 binding + a battery that writes there and keeps the key in the row |

A build could write `wrangler.toml` from `wizard.json` (bindings, vars, the secret names to set) instead of the hand-written one here.

**Imports in steps.** esbuild bundles whatever a step imports: a helper file next to it, an npm package from the folder's `package.json`. Checking stays `tsc` against the kernel's `Step` type plus `kernelIssues`. One rule the format must state, since nothing enforces it without a sandbox: a step runs again from its top on every answer, so it reaches the world only through `ask`; imported code that fetches or writes on its own runs again each time. On infrastructure of one's own, that is a lint rule, not a sandbox. Node built-ins need `nodejs_compat`; packages that need native code or a filesystem don't run in a Worker at all, and the build is where that shows.

**Long runs and Durable Object limits.**
- The whole run is one stored value (`storage.put("run", …)`). A SQLite-backed object takes values up to 2 MB; a long run with large model answers reaches that. Rows should go one per key or into the object's SQL table.
- A model call is made inside the `/answer` request: the caller waits until every battery answered. A slow agent turn holds the request. Better: answer at once with the run as it stands, move it on in the object (`ctx.waitUntil`, or an alarm), and let the page follow.
- Waiting costs nothing: between requests the object is evicted, and `wakeAt` is its one alarm. A run that waits for days is fine.
- CPU time per request is 30 s by default (up to 5 min); waiting on `fetch` does not count.

**What a studio or run page needs from such a Worker.**
- Auth: today anyone with the URL and a run id can answer any row, as any role. A token per run (and per role) is the least.
- CORS, if the page is served elsewhere.
- Progress: a page sees rows only by polling `GET /runs/<id>`. The object could hold a WebSocket and push each row.
- The run page today talks to the runtime's run API, not to kernel rows. Either the page learns rows (the studio's 0.3.0 view already reads them) or the Worker serves the runtime's API shape.
- Files and downloads (`result.downloads`): need the R2 battery and a `GET /runs/<id>/files/<key>`.

## Recommendation

Make the wizard folder a package and drop QuickJS from this path. A folder = `wizard.json` + `steps/` + a `package.json` that pins the kernel and the edge batteries. `wizards build` checks it (`tsc`, `kernelIssues`, `requires` against the batteries the package brings), bundles it with esbuild, and writes the Worker's config from `requires`. That makes one wizard one deployable unit for private infrastructure, at ~16 KiB: on Cloudflare, or on plain `workerd` with a config of 30 lines and a folder of SQLite files.

Before it is more than a spike: rows out of the single stored value, model calls moved out of the request, a token per run, and an R2 battery for files. All of those sit in `edge.ts` and the batteries; the format itself needs only the `package.json` pin and the written rule that steps reach the world only through `ask`.

## On self-hosted workerd

The same `dist/worker.js` runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, with no account and no wrangler: [`workerd.capnp`](workerd.capnp) is the whole config.

```bash
pnpm workerd                                   # node build.mjs + workerd serve on :8788
MODEL_API_KEY=… MODEL_BASE_URL=… pnpm workerd  # secrets from the environment
node flow.mjs http://127.0.0.1:8788
```

- **The flow:** the same as under wrangler, with the echo battery and with the local stand-in model (two `POST /v1/chat/completions`, `auth=yes`). It ends `done` with the same output.
- **Storage:** `durableObjectStorage = (localDisk = …)`. Each run is one SQLite file in `.workerd/runs/<uniqueKey>/`. A run read after a restart is the same run: 9 rows, `done`, its output.
- **Alarms:** a wizard that waits 3 s (`ask({ type: "wait", timeout: "3s" })`):
  - While workerd runs, the object's WAL is written at start + 3 s with no request coming in; the run is `done`, `woke: true`.
  - With workerd stopped while the run waits and started again after the time has passed, the overdue alarm fires at startup (WAL written at the restart, 21:02:21, before the first request at 21:02:25).
- **Outbound:** `fetch` goes through a `network` service. `allow = ["public", "private", "local"]` is needed to reach a model on the same machine or network; leaving `private`/`local` out limits the Worker to the internet.
- **Secrets:** `fromEnvironment` bindings. There is no secret store; the process environment is it.
- **Needs `--experimental`**, for SQLite-backed Durable Objects on local disk.

What self-hosting does not give: one process on one machine. Every Durable Object lives in that process; there is no placement across machines, no replication of `.workerd/runs` (back it up like any SQLite files), no TLS (put a proxy in front), and no limits on CPU or memory per request. For one wizard on one server, that is what it should be.
