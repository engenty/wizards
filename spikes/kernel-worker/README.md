# Spike: one wizard as a Cloudflare Worker

One wizard of version 0.3.0, built with the kernel into one Worker. Each run is a Durable Object (`runObject` from `packages/kernel/src/edge.ts`). The step files are imported into the bundle and run as plain code. No QuickJS: the bundle has none of it, and none is needed for one wizard on infrastructure of its own. A sandbox only matters where strangers' wizards share one host.

This is an option, not the way wizards run. In the hosted studio and the local install a wizard stays `wizard.json` + `steps/` and runs on that runtime's kernel. For a server of one's own, the CLI makes a **deploy package** from it: the wizard as it is, plus the pin to its runner, the build and the Worker's config. `deploy.mjs` stands in for that command (`wizards deploy <path> --worker`, next to `wizards validate <path…>`), and takes the same paths: a wizard folder or a `.wizard` package exported from the studio.

Local only (`wrangler dev`, and `workerd serve` below); nothing was deployed.

```bash
pnpm install --ignore-workspace          # this folder is not in the workspace
node deploy.mjs wizards/x-post           # → deploy/x-post/ and deploy/x-post.zip
cd deploy/x-post && pnpm install --ignore-workspace
pnpm dev                                 # build.mjs + wrangler dev on :8787
node ../../flow.mjs                      # start, first page, review twice, read the run
```

Open `http://127.0.0.1:8787/` for the run page (below). `GET /wizard` describes the wizard.

## What is here

| File | What it does |
|---|---|
| `deploy.mjs` | A wizard folder or `.wizard` package → `deploy/<name>/` and `deploy/<name>.zip`: `wizard.json`, `steps/`, `package.json` with the pin, `build.mjs`, `wrangler.toml` and `workerd.capnp` written from `requires`. Refuses a wizard whose `requires.tools`, `connections` or `requires.roles` a Worker can't give. |
| `template-build.mjs` | The deploy package's `build.mjs`: bundles `wizard.json` and the steps with the kernel and the edge package from the package's own `node_modules` into `dist/worker.js`. |
| `edge/` | `@engenty/wizards-edge`: the Worker and its batteries as a package. It names the kernel it runs on as a peer dependency, so the deploy package's pin chooses the kernel. |
| `edge/worker.ts` | `GET /` (the wizard), `POST /runs`, `GET /runs/<id>`, `POST /runs/<id>/answer`, `/rewind`, `/judge`. The run id is the Durable Object's name. |
| `edge/view.ts`, `edge/page.tsx` | The run page: `viewOf` turns the kernel's rows into the `RunView` the runner draws (ported from the runtime's `kernelPage` + the parts of `runView` it needs); `page.tsx` is `@engenty/wizards-runner`'s `RunnerBody` with this Worker as its `RunSource`. |
| `edge/batteries.ts` | `agent`: one chat completion over `fetch` to an OpenAI-compatible endpoint (`MODEL_BASE_URL`, secret `MODEL_API_KEY`, `MODELS` maps each model class to a model). Echoes without a key. `form`, `review`, `approval`, `wait`, `signal` wait for HTTP. Every other ask type fails at once: `This Worker has no battery for "<type>" asks.` |
| `wizards/x-post` | The converted marketplace wizard "X-Post mit Bild (0.3.0)" without its image step: `post` (model `low`) and `check` (review). Step files unchanged. Plain: no `package.json`. |
| `wizards/x-post-image` | The same wizard whole, to show an ask without a battery failing. |
| `stub-model.mjs` | A local OpenAI-compatible stand-in, to run the `fetch` path without an account. |

Files in R2: not built. Nothing in these wizards writes a file, and the image is what would need it (see below).

## What ran

In `deploy/x-post`: `pnpm dev` + `node ../../flow.mjs`, with `.dev.vars` pointing the agent battery at `stub-model.mjs`:

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

`deploy/x-post-image`, `pnpm dev`, `POST /runs` with input:

```
status failed | error: This Worker has no battery for "generate" asks.
  0 post agent(low) done   1 post left → visual   2 visual agent(low) done
  3 visual generate failed: This Worker has no battery for "generate" asks.
```

`node deploy.mjs recherche-briefing-0.3.0.wizard`: `"Recherche-Briefing (0.3.0)" cannot run as a Worker. It lacks the tool "web_fetch", the tool "web_search".` (exit 1)

`node deploy.mjs x-post-0.3.0.wizard`, the studio's export as it is: `deploy/x-post-0-3-0/` with all three steps, `models {"image":…,"low":…}`.

Size: 15.5 KiB minified for the kernel, the Worker and two steps; 17.4 KiB with three. Build: ~15 ms. Requests to `wrangler dev` answer in ~8 ms. Cold start on Cloudflare is not measured (no deploy); a script this small is far below anything that slows an isolate's start.

## What the format lacks to be self-contained

**A pin to its runner, in the deploy package only.** `wizard.json` says `version: "0.3.0"`, the format; nothing in it says which kernel and batteries a bundle was built against. The format doesn't need that: the studio and the local install run a wizard on their own kernel. A Worker does, and the deploy package carries it:

```json
{
  "name": "@wizards/x-post",
  "scripts": { "build": "node build.mjs", "dev": "wrangler dev", "workerd": "…workerd serve workerd.capnp --experimental" },
  "dependencies": {
    "@engenty/wizards-edge": "link:../../edge",
    "@engenty/wizards-kernel": "link:../../../../packages/kernel"
  },
  "devDependencies": { "esbuild": "0.28.2", "workerd": "1.20261023.1", "wrangler": "4.156.0" },
  "wizards": { "kernel": "0.0.0", "edge": "0.1.0", "format": "0.3.0" }
}
```

The CLI writes the pin from the kernel and edge package it runs itself. `link:` stands in for published versions: neither package is on npm, and a zip with `link:` paths only installs inside this repository. A released CLI writes `"0.3.0"` and the zip installs anywhere. The package's `build.mjs` takes the kernel and edge package only from its own `node_modules`, and refuses:

```
"X-Post (0.3.0, nur Text)" pins no @engenty/wizards-kernel, @engenty/wizards-edge in its package.json.
@engenty/wizards-kernel is not installed in …/noinstall. Run pnpm install there.
@engenty/wizards-edge runs on kernel 0.1.0; the package pins 0.0.0.
```

and says what it built from: `X-Post (0.3.0, nur Text): kernel 0.0.0, edge 0.1.0, 2 steps, models ["low"], 15.5 KiB`. For this, `packages/kernel` exports `./edge`.

Open: the kernel is `0.0.0` and private. Publishing it and the edge package with versions is what makes the pin mean anything outside this repository. A kernel should also say which format versions it runs, so the CLI can refuse a `wizard.json` it doesn't know.

**`requires` → bindings.** It maps, but only by a convention nobody has written down:

| `requires` | Worker |
|---|---|
| `models` | a var naming a model per class (`MODELS`) + a secret key per endpoint |
| `tools` | a battery for each tool in the bundle; the build refuses the wizard without it (done here for all tools) |
| `connections` | a secret per connection. OAuth tokens that expire need a refresh somewhere; that is a service, not a binding |
| `roles` | someone who answers over HTTP: auth per role is missing (below) |
| `hosts` | a check in the `http.request` battery; a Worker can't limit its own outbound fetches |
| files | an R2 binding + a battery that writes there and keeps the key in the row |

`deploy.mjs` writes `wrangler.toml` and `workerd.capnp` from `requires`: the Durable Object binding, one `MODELS` entry per model class (to be set to a model of the endpoint), the secret names. Tools, connections and roles are refused, since no battery for them exists yet.

**Imports in steps.** esbuild bundles whatever a step imports: a helper file next to it, or an npm package. Where the package comes from is open: the wizard would have to name it, and the deploy package's `package.json` would carry it. Checking stays `tsc` against the kernel's `Step` type plus `kernelIssues`. One rule the format must state, since nothing enforces it without a sandbox: a step runs again from its top on every answer, so it reaches the world only through `ask`; imported code that fetches or writes on its own runs again each time. On infrastructure of one's own, that is a lint rule, not a sandbox. Node built-ins need `nodejs_compat`; packages that need native code or a filesystem don't run in a Worker at all, and the build is where that shows.

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

Keep the wizard format as it is and drop QuickJS from this path. Deploying one wizard to a server of one's own is an option of the CLI: `wizards deploy <path> --worker` takes a wizard folder or a `.wizard` package, refuses what a Worker can't give, and writes a deploy package (folder and zip) that pins the kernel and edge batteries it was made with and carries the Worker's config from `requires`. `pnpm install && pnpm build` makes a ~16 KiB `dist/worker.js` that runs on Cloudflare, or on plain `workerd` with a config of 30 lines and a folder of SQLite files.

Before it is more than a spike: rows out of the single stored value, model calls moved out of the request, a token per run, and an R2 battery for files. All of those sit in `edge.ts` and the edge package; the format itself needs only the written rule that steps reach the world only through `ask`.

## On self-hosted workerd

The same `dist/worker.js` runs on [workerd](https://github.com/cloudflare/workerd), Cloudflare's open-source runtime, with no account and no wrangler: the deploy package's `workerd.capnp` is the whole config. In `deploy/x-post`:

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

## Connected: the broker battery

A Worker on its own can do form + model wizards. Everything else a wizard reaches (the agent loop with tools, Wissen, Daten, connections) stays at the organization's runtime, behind the broker. A connected deployment sends every ask there.

```bash
node deploy.mjs wizards/team-note --home http://127.0.0.1:8791   # without --home: refused, it lacks the connection "slack"
node home.mjs wizards/team-note                                  # the stand-in home on :8791
cd deploy/team-note && pnpm install --ignore-workspace && echo DEPLOY_KEY=dev-deploy-key > .dev.vars && pnpm dev
node ../../flow-connected.mjs
```

**Contract.** `POST <HOME_URL>/v1/asks`, `Authorization: Bearer <DEPLOY_KEY>`, body `{ run: { id, wizard, input }, row }`. Home answers `200 { answer }`, `409 { needsLeave: true }` (the Worker's kernel then asks the user, as a row), or `4xx/5xx { error }` (the ask fails with that sentence). The Worker holds no model key and no connection secret; `HOME_URL` and `DEPLOY_KEY` are its only bindings. In connected mode every ask type no person answers goes home (`edge/batteries.ts`).

**Home.** `home.mjs` is a stand-in for the route the runtime would serve; `apps/` was not touched. In the runtime the route hands the row to `kernelBatteries` (`apps/runtime/src/kernel/batteries.ts`), which already answers 0.3.0 asks with the step executors and sends connector calls through `brokerCall`. The stand-in makes the same decisions in a few lines: the deploy key names the deployment (space, wizard); home decides with **its own** copy of `wizard.json` (`grantOf`, `outside`, `needsLeave` from the kernel), not the Worker's; the model key and the Slack stand-in are only there; every call is logged.

What ran (`wrangler dev` + `home.mjs` + `stub-model.mjs` behind home), Team-Notiz: draft with model `low`, then `slack.chat.postMessage`, set to `ask`:

```
# POST /runs                      status waiting · at send
  0 draft agent done   1 draft left → send
  2 send tool slack.chat.postMessage waiting   3 send approval slack.chat.postMessage waiting
# the user allows the post        status done
  output: {"note":"…","sent":{"ok":true,"channel":"#team","ts":"1794775195.687"}}
# second run, the user refuses     error: The user did not allow "slack.chat.postMessage". · at send

# home: GET /v1/log
  allow draft model low
  hold  send slack.chat.postMessage (asks the user first)
  allow send slack.chat.postMessage  leave given
  allow draft model low
  #team: [{"channel":"#team","text":"…"}]        one post: the refused run never reached home
stub model: 2× POST /v1/chat/completions, from home, not from the Worker
```

**Found on the way.**
- **A tool row could be answered over HTTP.** The kernel's `record` took an answer for any waiting row. The Slack post's own row waits while its approval row waits, and `POST /runs/<id>/answer` on the tool row was taken as the tool's answer: the run went on with `sent: {allow: true}`, and home never saw the call. Fixed in the kernel on `feat/kernel` (f83fc252): a row that waits for the user's leave takes no answer, and no value on rewind, until the user gave it. On the Worker now: `{"error":"Row 2 waits for the user's leave. Answer row 3."}` for both; answering row 3 posts once. `check()` had relied on the hole (it answered the first waiting row, the action, with the case's `allow`); it now answers the question before its action.
- **Home trusts the Worker for the user's leave.** The approval row lives in the run on the Worker; home sees only `row.asksLeave`. For "ask the user" that is the user's own run, which is acceptable. An admin's approval („Mit Freigabe“) must be held at home, by the broker, not in the run.
- The row reaching home has `role` set to its type by the kernel; `outside()` reads that as a role. Home checks the ask as the step made it.
- `edge.ts` now takes the run's id on `/start` (the Durable Object's name), and exports `NeedsLeave`; `edge.test.ts` passes.

**Not done.** A token per run instead of one deploy key; registering the run at home (so the studio sees it, and its costs land on the space); the route itself in the runtime, as a role of its own (the broker's phase 3).

### Compared with executor.sh

executor.sh is the same split, for tools: an agent calls one endpoint (MCP at `/mcp`, or the CLI), and executor holds the accounts, adds the credential inside, and asks for approval where a tool says so. The agent never sees a secret. It runs hosted (Executor Cloud), local (`executor` CLI on the machine, keys in the OS keychain) or self-hosted (one Docker container with its own database, OAuth callbacks on its own URL). So it does need *a* connection service, but not a hosted one: the self-hosted container is that service, on your own server. Our home is the same thing for a deployed wizard: the organization's runtime, hosted or on the local install. The kernel already has `executorBatteries` (`packages/kernel/src/executor.ts`), so an executor can stand where home stands here, for tools; Wissen, Daten and the run's place in the studio are ours.

## The run page

The deploy package also pins `@engenty/wizards-runner`, the components the studio, the client portal and the WordPress plugin draw runs with. `build.mjs` bundles `edge/page.tsx` with it (and the runner's `dist/runner.css`, scoped to `.engenty-runner`) into the Worker, which serves it:

| Route | |
|---|---|
| `GET /` | a new run, then the page moves to `/r/<id>` |
| `GET /r/<id>` | that run's page |
| `GET /runs/<id>/page` | the run as a `RunView` |
| `POST /runs/<id>/page/pages/<step>` `{ values }` | the form it waits at (the run's input is the step `input`) |
| `POST /runs/<id>/page/reviews/<step>` `{ type, edits?, note?, target? }` | a review: `accept` / `decline` / `regenerate`; on the leave for an action `accept`/`decline` → `{ allow }`. As the runtime's `reviewStep`. |
| `POST /runs/<id>/page/retry` | the failed ask, asked again |

Walked in the browser (`wrangler dev`):
- **x-post, on its own:** the first page (intro, the textarea with its help, the tone as chips, "Post schreiben") → the review "Passt der Post?" with the post, Bearbeiten, Text kopieren, a note and "Neu erstellen" → a new version (rows: `check review done {"approved":false,"regenerate":"post","note":"Kürzer bitte."}`, `post` again) → edited in the review, "Passt so" → the result page with the edited text and "Nochmal".
- **team-note, connected:** the first page → the leave for `slack.chat.postMessage`, its input as JSON, "Ablehnen" / "Freigeben" → Freigeben → home posts → the result with the note and Slack's answer.

Not there: step back (`canBack` is false), downloads (the result's formats are left out: the runner would ask a server for the PDF; standalone it can write one in the browser, not wired), files and photos, the brand and the engenty (`Mascot` draws nothing), a live stream (the page reads the run again every 2 s while it works or sleeps), a sign-in for whoever opens the URL.

Size: the runner already loads pdfmake with `import()` on the first PDF (`packages/runner/src/pdf.ts`); the page build splits it off (`splitting: true`), and the Worker serves each file under `/page/`, the hashed chunks as immutable. A page load fetches `page.js` 280 KB gzipped (zod, react-dom, the runner, shared, marked), `page.css` 11 KB, and a 1 KB chunk; pdfmake 295 KB and its fonts 457 KB gzipped come only with a PDF, the QR scanner (15 KB) only with a scan. Before the split it was one 1 MB gzipped file. The kernel, the Worker and the wizard are 45 KB beside it.

The page is not in the Worker's script: `build.mjs` writes it to `dist/assets/page/`, and the Worker's script is 21 KiB again (the kernel, the Worker, the wizard, `viewOf`).
- **Cloudflare / `wrangler dev`:** `[assets] directory = "dist/assets"` in `wrangler.toml`. Cloudflare answers `/page/<file>` itself before the Worker is asked, with an ETag and its cache (`CF-Cache-Status: HIT` locally); a file that isn't there is a 404. Assets don't count against the Worker's script size and their requests aren't billed as the Worker's.
- **workerd:** there are no assets, so `workerd.capnp` has a disk service on `dist/assets`, bound as `ASSETS`, and the Worker hands `/page/*` to it. The disk says `application/octet-stream` for every file, which a browser refuses for a module script and a stylesheet, so the Worker sets the type from the name, and `immutable` on the hashed chunks.
Both walked in the browser: first page → review, no errors.
