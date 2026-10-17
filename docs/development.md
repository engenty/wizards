# Developing engenty wizards

For working on the code. To install and use engenty wizards, see the [README](../README.md) and
the user guide in [content/user](content/user/index.md).

## Two ways to run it

| | Alone | Managed |
|---|---|---|
| What | one person, one tenant, on this machine: the local install (`wizards`), `pnpm dev`, your own server | the runtime of a Manage-App (`MANAGE_URL`): many tenants |
| Sign-in | a one-time link at start (the command line opens it itself); an account is optional | at the Manage-App (OAuth 2.1 / OIDC); the token names user, tenant and role |
| Database | `DATA_DIR/tenants/local.db` + `DATA_DIR/control.db` | one libSQL database per tenant + a control database (Turso) |
| Models | an AI client installed on the machine, on its own subscription (Claude Code, Codex, Antigravity, Cursor Agent), own keys (AI Gateway, OpenAI, Anthropic), a local model (Ollama), or a linked account's credits | the Manage-App's model-gateway; the runtime holds no model keys |
| Studio chat | a model of class `highest`, or the admin's own Claude subscription (the installed Claude Code runs headless) | a model of class `highest` |
| Files | `DATA_DIR/objects` | an S3-compatible bucket (R2) |

The Manage-App (accounts, tenants, credits, the model-gateway) is a separate, closed app. What
the two speak is in [manage-contract.md](manage-contract.md).

The two ways meet in an account: a runtime that runs alone and is linked to one sends what it
publishes to the account's cloud runtime, which shows the project read-only and runs its wizards
(the contract's "Spaces of a local install"). Building stays on the install; a tenant builds on
the cloud runtime only when the Manage-App says so (`limits.build`).

A runtime takes **plugins**: tools for agent steps, routes with tables of their own, pages in the
studio, loaded from their files at start and again while it runs. How they are found, written
and built is in the developer docs: [content/dev/plugins](content/dev/plugins/index.md).

A step names a **model class** — `classifier`, `standard`, `high`, `highest`, plus `image`,
`video`, `audio` (listens to voice notes), `speech` (reads a voice-over aloud) — and an optional
effort hint, never a model. Which model serves a class is
bound outside the wizard: in the model-gateway, or under Settings → "Modelle & Konto".

## Layout

A pnpm workspace:

| | |
|---|---|
| `apps/runtime/` | the server: API, step runner, databases, models (`src/`), its tests (`test/`) |
| `apps/web/` | the SPA: studio, public runner, share page |
| `apps/runtime/src/cli/` | the `wizards` command of a local install: start, guided setup, status, update |
| `apps/web/public/install.sh` | the installer, served by every runtime at `/install.sh` |
| `bin/` | the entry of the `wizards` command, and the launcher `npx wizards` runs |
| `scripts/` | `npm-package.mjs` (the npm packages: the runtime and the launcher) |
| `packages/shared/` | types and schemas the server and the SPA both use |
| `packages/wizards/` | `@engenty/wizards`, the one package code outside this repo imports: `/plugin` (a plugin’s server half), `/plugin/studio`, `/plugin/thread`, `/openui` (wizards in OpenUI chats), `/openui/server` |
| `modules/` | plugins that ship with the runtime |
| `examples/plugins/` | example plugins; loaded with `PLUGINS_DIR=examples/plugins` |
| `scripts/build-plugin.mjs` | builds a plugin's studio half |
| `plugin/` | the Claude Code plugin template |
| `deploy/` | the Chromium container of the cloud runtime |
| `apps/docs/` | the documentation site (Next.js + Fumadocs); not part of the product's build |
| `docs/content/` | its pages: `user/` (the user guide), `dev/` (the developer docs: plugins) |

### Package names

| Name | What it is |
|---|---|
| `wizards` | The launcher people run with `npx wizards`: it installs the runtime and hands over. Built by `scripts/npm-package.mjs` |
| `@engenty/wizards-runtime` | The runtime the installer and the updates install. Built by `scripts/npm-package.mjs` beside the launcher |
| `@engenty/wizards` | What code outside this repo imports, one subpath per use: `/plugin`, `/openui`. Inside the repo the runtime and the studio import it by the same name |
| `@engenty-wizards/*` | The workspace’s own parts (`runtime`, `web`, `docs`, `shared`, `runner`). They are never published |

A new thing for outside code goes into `packages/wizards/` as a subpath, not into a package of
its own. `@engenty/wizards` is not on npm yet: it stays `private` until it is published.

`.env.local` and the data folder (`data/`) stay in the repo root; `pnpm dev` and `pnpm start`
run from there.

## Run locally

```bash
pnpm install
cp .env.example .env.local   # set AI_GATEWAY_API_KEY (or another key); DEV_LOGIN=1
pnpm dev                     # web on :5181, API on :24368
```

With Portless: `portless alias wizards 5181`, set `APP_URL=https://wizards.localhost`, open
https://wizards.localhost. "Dev-Login" lets you in (local only); without `DEV_LOGIN` the server
prints a one-time link at start.

Local Chrome renders PDFs/PNGs (`CHROME_PATH`), ffmpeg encodes widget animations to MP4
(`FFMPEG_PATH`) and cuts films: a widget step with `video: true` draws clips and stills frame by
frame and gets voice-over and clip sound mixed in. The shell/code tool runs in a sandbox per run, chosen with `SANDBOX`:
`docker` needs Docker and the `engenty-sandbox` image; `agentos` runs an
[agentOS](https://rivet.dev/agentos/) VM per run in a helper process (macOS and glibc Linux, no
Docker): bash, coreutils, curl, git, jq, sqlite3, node, npm, and Python as Pyodide with numpy and
pandas, but no native programs; `off` removes the tool. agentOS is not a dependency:
`pnpm sandbox:add agentos` (or `wizards sandbox add`) installs it into `SANDBOX_ENGINES_DIR`, and
an image gets it with `--build-arg SANDBOX_ENGINES=agentos` ([plan](plans/agentos-sandbox.md)).
Unset, `SANDBOX` is the first engine that is ready: `docker` when the image is on the machine,
else `agentos` when it is installed, else `off`. The agent is told what the chosen sandbox runs.

Each engine is a `SandboxEngine` in `apps/runtime/src/sandbox/index.ts`. One of Mastra's sandboxes
(`@mastra/docker`, `@mastra/e2b`, `@mastra/daytona`) becomes one through `MastraRunSandbox`
(`mastra.ts`), as Docker does. An engine whose package is not a dependency of the runtime lists
it in `ENGINE_PACKAGES` (`install.ts`): `wizards sandbox add <name>` installs it into
`engines/<name>`, and the engine loads it from there with `importFromEngine`.

`APP_URL` defaults to `http://localhost:5181` from source (the Vite dev server) and to
`http://localhost:<API_PORT>` when built (`pnpm start` serves the pages itself).

Addresses: the studio is `/studio/…` (`/studio/new`, `/studio/edit/<id>`, `/studio/settings`),
built with its files below it (`/studio/assets`, `/studio/icons`). A wizard's link is
`/w/<token>`, a shared result `/s/<token>`, the API `/api/…`. Of the root the server serves only
`/install.sh`, `/embed.js` and `/sw.js`, and sends `/` to `/studio/`; on engenty.ai the root is
the landing page and `/wizards/` the marketplace.

`.env.local` and `data/` in the repo root belong to `pnpm dev` and `pnpm start`. The installed
command (`pnpm wizards`, `wizards`) uses `~/.engenty/wizards` instead: see
[Local install](#local-install).

A data folder from before tenants (`DATA_DIR/wizards.db`) is taken over into the local tenant at
the first start; the old file stays.

## Documentation

The site is `apps/docs`, the same system as in the engenty repo: Next.js with
[Fumadocs](https://fumadocs.dev). Its pages are Markdown in `docs/content`.

```bash
pnpm dev:docs     # http://localhost:5184/docs
pnpm build:docs   # what CI runs; `pnpm build` leaves the site out
```

- **Sections.** A folder whose `meta.json` says `"root": true` is a section of the sidebar's
  chooser and a card on the first page: `user`, `dev`. `pages` in a `meta.json` is the order of
  its sidebar; `---Title---` is a heading there.
- **A page** is a `.md` file with `title` and `description` in its frontmatter and no `#`
  heading of its own. Links to other pages are relative file paths (`./install.md`,
  `../dev/plugins/index.md`); pictures come from `docs/assets` the same way.
- **Which release a page describes.** `version` in its frontmatter (`version: 0.2.48`) is the
  release whose code the page was last checked against; a page without one does not build. Check
  a page against the code and the commits since that release, then set `version` to the current
  one. The page shows it beside its buttons, the first page the oldest and newest.
  `pnpm docs:check` fails on a missing or too new `version` and lists the pages behind the
  current release with the number of code commits since theirs.
- **Public.** The site and the studio assistant show these pages to everyone: the open product
  and the plugin SDK only. The Manage-App's side, Pro modules and engenty's closed plugins are
  documented outside `docs/content` (`docs/manage-contract.md`, `docs/pro-modules.md`).
- **Diagrams** are fenced `mermaid` blocks.
- **Below `/docs`.** The site's pages, files and search all live below that path (`basePath` in
  `apps/docs/next.config.mjs`), so a proxy can send `/docs` to it and the rest of a host
  elsewhere. `NEXT_PUBLIC_DOCS_SITE_URL` is the address it is published at, for link previews.
- **For AI clients.** Every page's address with `.mdx` gives its Markdown, and
  `/docs/llms-full.txt` all pages in one file.
- `pnpm-workspace.yaml` pins `mdast-util-to-markdown` for `fumadocs-core`: with the newer one a
  page with bold text does not build.

The image of the runtime leaves the site out (`.dockerignore`), and so do the npm package and
the app's open-source credits. The site has an image of its own, `apps/docs/Dockerfile`: one
Next.js server on port 8896, built from the repo's root with its own ignore file beside it
(`Dockerfile.dockerignore`). How engenty's own is deployed: [Deploy](#deploy).

```bash
docker build -f apps/docs/Dockerfile --build-arg NEXT_PUBLIC_DOCS_SITE_URL=https://engenty.ai -t docs .
docker run -p 8896:8896 docs   # http://localhost:8896/docs
```

## AI media and the AI Act

Media a model made or changed says so in two ways (Art. 50): in the file and on the page.

- **In the file** (`apps/runtime/src/media/marking.ts`): the IPTC Digital Source Type in the XMP
  of PNG, JPEG and MP4 files, ID3 tags on a voice-over. A file that arrives marked — image models
  sign their output with C2PA Content Credentials — is kept byte for byte, since changing it would
  break the signature. A film is re-encoded when it is cut, so it gets its own marking.
- **On the page**: the asset's reference carries `ai: "generated" | "edited"`, and every view shows
  a label over such media. Nothing is drawn into an image. A film shows one line in the picture,
  because it is published as a file, away from these pages.

Not done here: signing our own Content Credentials (needs a certificate), and the EU's common icon.

## Checks

```bash
pnpm fix && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm build:docs
node scripts/e2e-starter.mjs invoice '<answers json>'   # drive a starter end to end via the API
# { "$file": "path" } as a value uploads that file; API=http://127.0.0.1:<port> names another server
```

**Copy.** Every word a person reads follows [copy-style.md](copy-style.md): the voice, a
glossary in English and German, and the mechanics of each language. `pnpm copy:check` lists the
strings that break its mechanical rules (`--strict` fails on them; CI runs it so).

`apps/runtime/test/tenants.test.ts` is the leak test: two tenants, two databases, nothing of one
visible to the other. `apps/runtime/test/managed.test.ts` runs the runtime against a stand-in
Manage-App.

GitHub runs lint and typecheck, test, build and the docs' build side by side on every push to
`main`, every pull request and every release tag (`.github/workflows/ci.yml`).

The packages type-check and compile with TypeScript 7. Two stay on TypeScript 6, because a
tool there calls the compiler's JavaScript API, which TypeScript 7 no longer has: `apps/docs`
(Next.js checks types in its build) and `packages/runner` (`vite-plugin-dts` writes its
declaration files).

## Releases and changelog

The version is the `version` of the root `package.json`; a release is the tag `vX.Y.Z` on `main`.
Before `1.0` a **minor** bump is a notable or breaking change, a **patch** is fixes and small
features. The version says which release this is; the commit says which build.

Commits follow [Conventional Commits](https://www.conventionalcommits.org). The type decides the
group in the changelog, a scope (`fix(runner): …`) shows in brackets, `!` marks a breaking change:

| Type | Group |
|---|---|
| `feat` | Added |
| `fix` | Fixed |
| `perf` | Performance |
| `refactor` | Changed |
| `deploy` | Deploy |
| `docs` | Docs |
| `chore`, `ci`, `test`, `build`, `style`, merges | left out |
| anything else | Other |

```bash
pnpm release               # shows the changes, asks patch / minor / major, lets you edit the entry,
                           # then writes the files below, bumps package.json, commits and tags — locally
pnpm release --changelog   # only refreshes the files; commits since the last tag stay under "Unreleased"
pnpm about:data            # only the app's copies: changelog and open-source credits
git push origin main --follow-tags
```

`RELEASE_BUMP=patch|minor|major|current` skips the questions; `current` releases the version
`package.json` already has, as long as it has no tag (the first release). The format and the
groups are in `cliff.toml` ([git-cliff](https://git-cliff.org)), the steps in `scripts/release.mjs`.

| File | What it is |
|---|---|
| `CHANGELOG.md` | the changelog to read, one block per release |
| `changelog.json` | the same as data: git-cliff's context |
| `apps/web/src/about/changelog.json` | what the app shows, cut down from `changelog.json` |
| `apps/web/src/about/oss-credits.json` | the direct dependencies of the workspace with version and license (`pnpm licenses list`), shared ones first, then per app |
| `apps/web/src/about/product-credits.ts` | written by hand: the product and what it is mainly built with |

None of them is edited by hand except `product-credits.ts`. In the app, the studio's footer shows
the version and opens the changelog and the open-source credits (`apps/web/src/about/`). The
credits list what `package.json` files name.

The tag is what ships: it deploys the cloud runtime and the documentation (see
[Deploy](#deploy)) and publishes the
local install (see [Local install](#local-install)). A push to `main` without a tag runs the
checks and nothing else, so the cloud runtime and a fresh local install are the same release.
Always tag through `pnpm release`: a tag set by hand leaves the changelog files as they were.

## Deploy

Alone, on your own server: see [Run it on a server](../README.md#run-it-on-a-server) in the
README. One container: API + built SPA + Chromium, data on the `/data` volume.

Managed (the cloud runtime): `compose.cloud.yaml` runs the app and a separate Chromium
container that holds no secrets and reaches no database. On engenty.ai the proxy sends the
runtime only its own paths — `/studio`, `/api`, `/w/`, `/s/`, `/.well-known`, `/install.sh`,
`/embed.js`, `/sw.js` — and the rest of the host to the site (landing page, marketplace pages)
and the marketplace's API. `/w/` and `/s/` keep their slash: a proxy prefix `/w` would also take
`/wizards/…`. Set the `MANAGE_*` block, `GATEWAY_URL`,
`APP_SECRET`, the Turso and R2 variables. After a release every tenant database is migrated at
start; a new one migrates when it is first opened.

engenty's own cloud runtime deploys from the branch `deploy/runtime`, and the server builds
nothing: a release tag `v<version>` on `main` runs the checks and, beside them, builds the two
images on GitHub's runners (`ghcr.io/engenty/engenty-wizards-runtime` and `-browser`, tagged
with the version; the layers come from the registry's cache, so a release rebuilds only what
changed). When both are green the same workflow (`.github/workflows/ci.yml`) tags the images
`latest` and moves the branch to the tag's commit; the server deploys what the branch points at
by pulling them (`compose.cloud.yaml`). A push to `main` without a tag deploys nothing. To deploy
a tag again, run the workflow by hand on that tag. To go back to an older release: set
`IMAGE_TAG=v<version>` on the Coolify resource and redeploy; remove it to follow `latest` again.

The documentation at `engenty.ai/docs` deploys the same way from the branch `deploy/docs`
(Coolify resource `docs`): its image (`ghcr.io/engenty/engenty-wizards-docs`, built from
`apps/docs/Dockerfile`) is built beside the runtime's, and the server builds
`deploy/Dockerfile.docs`, which only pulls it. A green release tag moves the branch when the
site's app or its pages changed, so the published docs describe the released version. The proxy
sends `/docs` to it with the path kept (no prefix stripping: the site itself lives below
`/docs`). Pages change with a release; `IMAGE_TAG=v<version>` on the resource goes back to an
older one.

## Local install

What people install is the runtime, built like an npm package: the built runtime, the built
SPA, the plugin template and the `wizards` command, with the shared package inside it. It is on
npm as `@engenty/wizards-runtime`, and the same tarball is attached to the GitHub release
`v<version>`: the installer has npm install it from that address, the updates
(`apps/runtime/src/cli/autoupdate.ts`) from npm. It gets onto a machine through the installer,
which keeps their data in `~/.engenty/wizards/data` (`ENGENTY_HOME` moves `~/.engenty`):

| | Code | Node |
|---|---|---|
| `curl -fsSL https://engenty.ai/install.sh \| bash` | `~/.engenty/wizards/runtime` | its own, pinned, in `~/.engenty/wizards/tools` |

`npx wizards` is a second way to the same install. The npm package `wizards` is only the
launcher: `bin/wizards.mjs` and `install.sh`, no dependencies, a few dozen KB. It runs the
installer for the runtime of its own version and hands every command but `--version` to the
installed `wizards`. Up to 0.7.4 `wizards` was the runtime itself; an update of such an install
fetches the launcher into its version folder, and the launcher, started there, brings the runtime
of its version with the installer and hands over (the installer also links
`node_modules/wizards` to the runtime, for the commands of then).

```bash
pnpm package                       # node scripts/npm-package.mjs → dist/npm/*.tgz, both packages
pnpm wizards status                # the command from the checkout (node bin/wizards.mjs)
```

`scripts/npm-package.mjs` stages `apps/runtime/dist`, `apps/web/dist`, `plugin/` and `bin/` in the
checkout's layout and writes the package.json: the runtime's dependencies at the exact versions
of the root lockfile, the shared package bundled. Dependencies of dependencies are resolved by
npm at install time. Beside it, it stages the launcher. The release publishes the runtime first,
then the launcher.

`apps/web/public/install.sh` is the installer (bash 3.2, `shellcheck` clean). It downloads the
pinned Node from nodejs.org and checks it against `SHASUMS256.txt`, asks GitHub for the newest
release, installs that release's tarball with that Node's npm
(`--ignore-scripts --legacy-peer-deps`), writes the command to
`~/.engenty/wizards/bin` and links it into `~/.local/bin`, then hands over to
`wizards setup`. The setup (`apps/runtime/src/cli/setup.ts`) asks; the script does not.
It lives in the SPA's `public/` folder, so every runtime serves it — `engenty.ai` included.

To try the installer against a checkout, without npm and without touching `~/.engenty`:

```bash
pnpm package
ENGENTY_HOME=/tmp/engenty-try ENGENTY_WIZARDS_PACKAGE=$PWD/dist/npm/engenty-wizards-runtime-<version>.tgz \
  bash apps/web/public/install.sh --no-link
```

How the pieces share one install:

- The runtime leaves `running.json` in its data folder while it runs (`apps/runtime/src/running.ts`).
  The command line looks there before starting one, and open the running one
  instead: two runtimes would write the same databases.
- Entering a runtime that already runs needs no restart: `wizards open` signs a ticket
  for `/api/local/enter` with the data folder's secret (`apps/runtime/src/auth/local-ticket.ts`),
  good for a minute and for one use. Who can read that secret can already make the studio's cookie.
- The command line starts the runtime with a short list of the terminal's variables
  (`apps/runtime/src/cli/environment.ts`); everything else comes from `~/.engenty/wizards/.env`.
  A key or a database address the shell exports for another project does not reach it.
- AI clients the setup installs from npm go into `~/.engenty/wizards/clients`; its `bin` and the
  install's Node are first on the runtime's PATH.

A release is a tag `v<version>` (the version of the root package.json):
`.github/workflows/release.yml` packs the package, runs the installer with it on Linux and
macOS, and attaches the tarball to the GitHub release.
With the repository variable `PUBLISH_NPM=true` and the secret `NPM_TOKEN` it also publishes to
npm. The same tag deploys the cloud runtime, which puts the current `install.sh` on
`engenty.ai`. On a pull request the same workflow builds and tests everything and publishes
nothing.

## Desktop app

There is none in this repo. The studio is a web app with a manifest
(`apps/web/public/manifest.webmanifest`); Chrome and Edge install it as an app, and the studio
offers that in a banner (`apps/web/src/studio/InstallBanner.tsx`). The runtime still serves a
native window as a client: a page in such a window finds `window.engentyDesktop` and opens
links and the sign-in in the system browser (`apps/web/src/studio/LocalRuntime.tsx`,
`SignInPage.tsx`).

## Accounts people connect

A wizard can ask the person running it to connect their mailbox; steps then read it (never write).
IMAP works without any setup. For "Gmail" and "Outlook" buttons, give the OAuth client you already
use for sign-in one more redirect URI, `<APP_URL>/api/connect/callback`, and

- Google: enable the Gmail API and add the scope `gmail.readonly` to the consent screen
- Microsoft: add the delegated permission `Mail.Read`

Connected accounts, kept sign-ins, lists and collected files belong to one wizard and one person,
are encrypted where secret (`STORE_ENC_KEY`), and go when unused for `STORE_TTL_DAYS`.

## Connectors

Built in, as engenty ships them: Gmail, Google Drive, Calendar and Contacts, Outlook, OneDrive,
Slack, GitHub (sign-in with OAuth — set the client in `.env`, see `.env.example`), HubSpot and S3
(the person enters a token or keys). The settings show which are set up. Google needs the APIs
enabled and the scopes on the consent screen; a connection asks only for what the wizard's
actions need.

For everything else: in the project settings, search a service (Notion, Stripe, GitHub …) in the
[integrations.sh](https://integrations.sh) registry and import it — from its OpenAPI spec or its
MCP server. The architect and MCP clients can do the same (`find_connectors`, `import_connector`).
A wizard declares a connection to it; the person running the wizard connects their own account
(OAuth, with the client registered on the fly where the server allows it, or an API key). Steps
get the connector's actions as tools: reading is allowed, anything that changes the account asks
the person first, deleting always. `ENGENTY_INTEGRATIONS_REGISTRY_URL` points at another registry.

## Marketplace

The wizards a person can start from on "new" are entries of the marketplace. The marketplace is
an app of its own (the entries, their search, the public gallery at `/wizards/` and each
entry's page); this runtime is one of its clients. What both sides implement is
[`docs/marketplace-contract.md`](marketplace-contract.md); `MARKETPLACE_URL` names the
marketplace (default `https://engenty.ai/wizards`, `off` = none).

- **Search**: the "new" page asks `GET /api/studio/marketplace`, and the runtime asks the
  marketplace live (`/api/v1/entries`) — words, use case, industry, result, one page at a time,
  with the filters' counts. The scoring is BM25 with prefixes and inflections, the scoring of
  engenty's `search-index` package (`packages/shared/src/marketplace-search.ts`, copied by
  `scripts/sync-engenty.mjs`); the marketplace answers with it, and so does the runtime when the
  marketplace does not answer within 5 s.
- **Offline**: the runtime keeps the marketplace's starters and the entries a person starred
  (`marketplace_cache` in the control database; stars are `marketplace_star` in the tenant's).
  At start and then hourly it asks `/api/v1/sync` for their hashes and fetches only what changed;
  a star is kept at once. Without a connection the "new" page searches what is kept and says so.
- **One entry**: the dialog asks `GET /api/studio/marketplace/:id`. The runtime reads the wizard
  with its own schema: the steps, what a run hands over and what it costs in credits (the
  formula of `credits/estimate.ts` at the gateway's prices, else at list prices).
- **Older apps**: an entry written in a newer definition version, or with anything this app's
  schema would drop, is listed as "needs a newer app" and cannot be started from.
- **Starting from an entry** (`/studio/new?starter=<id>`): the wizard and its workspace files come from the
  marketplace, else from what is kept. The wizard is a copy: `wizard.starter` and
  `wizard.starter_revision` say where it came from, later revisions of the entry do not touch it.
  The marketplace counts it.
- **MCP**: `list_starters` searches the marketplace (without a query: its starters),
  `get_starter` hands over an entry's wizard. The authoring guide's example is the runtime's own
  (`apps/runtime/src/authoring/example.ts`).

## Build wizards from your own AI client

Admins can author wizards in Claude Code, Codex, Cursor, claude.ai or Claude Desktop, on their own
subscription. The MCP endpoint is `<APP_URL>/api/mcp`. Managed, clients sign in with OAuth 2.1 at
the Manage-App (discovery, dynamic registration or a client metadata document, consent there);
connected apps and API keys are managed in the account. Alone, Settings → "Mit Claude Code & Co.
bauen" issues API keys.

```bash
# Claude Code: plugin with the /wizard command (needs a public https APP_URL)
claude plugin marketplace add <APP_URL>/api/claude-plugin/marketplace.json
claude plugin install engenty-wizards@engenty
# or just the server
claude mcp add --transport http --scope user engenty-wizards <APP_URL>/api/mcp
# Codex
codex mcp add engenty-wizards --url <APP_URL>/api/mcp && codex mcp login engenty-wizards
```

The plugin is built from `plugin/` with this deployment's `APP_URL` filled in
(`apps/runtime/src/plugin.ts`): the `/wizard` command and the skills `build-wizard` and
`use-wizard`.
Test runs that a client starts spend the tenant's credits. Writes from a client show up live in an
open editor.

## Use wizards in AI apps

The same MCP server runs published wizards for the person, in the chat (`apps/runtime/src/mcp/tools.ts`,
`apps/runtime/src/services/runs.ts`): `show_wizard` (the flow), `run_wizard` (a live run that is
the caller's, no visitor, no Turnstile), then what `waitingFor` names — `answer_page`,
`review_step`, `answer_ask` (allow or skip a change in a connected account), `get_run` with
`waitSeconds`, `control_run` (back, retry, cancel). Fields a chat cannot fill (files, recordings,
signatures, line items) say `inChat: false`; the run page at `browserUrl` (`/w/<token>/<runId>`)
takes them. These tools need the scope `runs:test`, like test runs: both spend credits.

**The flow widget (MCP Apps).** `show_wizard`, `run_wizard` and `start_test_run` carry
`_meta.ui.resourceUri = ui://engenty-wizards/flow-<hash>.html` (the hash of the build, so hosts drop a cached old widget). Hosts that render MCP Apps (Claude
Desktop, Cursor, VS Code, Goose, ChatGPT) show the wizard as its diagram, and a run on it: the step
it stands on, the page as a form, the review, the downloads. The widget is `apps/web/src/mcp-app/`
and draws with the studio's `FlowCanvas`; `vite.mcp-app.config.ts` builds it into one HTML file,
`apps/web/dist/mcp/flow.html` (part of `pnpm build`), which the runtime serves as the resource
(`apps/runtime/src/mcp/flow-app.ts`). The definition reaches the widget in the result's
`_meta["engenty/flow"]`, not in `structuredContent`, which hosts hand the model. A run shows the
runner itself, which talks to the runtime with the run's ticket (`?rt=`, `apps/runtime/src/app.ts`;
the resource's CSP allows the runtime's origin). Where the host keeps the widget off the network,
or the runner breaks, the widget falls back to the diagram and a panel whose buttons call the
server's tools through the host. The widget is never less than 360px tall from its first paint on,
so a host that sizes the frame once still shows a usable page. Cursor folds a finished turn's tool
calls, the widget among them, into its collapsed "Worked for …" group: the widget is still there
when that group is opened (a known Cursor bug, not the widget). Hosts without MCP Apps (Claude
Code, Codex, Antigravity, Windsurf, OpenClaw) get the same tools as text.

**On the person's computer.** AI apps start MCP servers as commands, so a local install offers
itself as one: `wizards mcp` (`apps/runtime/src/cli/mcp.ts`) speaks MCP over stdio and
passes every message on to the running runtime's `/api/mcp`, signed with the data folder's secret
(`x-engenty-local`, a ticket good for a minute, `apps/runtime/src/auth/local-ticket.ts`). No key
in any app's config, no port either; when nothing runs, it starts the runtime in the background
(log: `~/.engenty/wizards/logs/runtime.log`).

```bash
wizards connect              # every AI app found on this computer
wizards connect cursor codex # or these
wizards disconnect cursor
```

`connect` (`apps/runtime/src/cli/connect.ts`) writes the entry into each app's own config and
keeps the file before it as `<file>.before-engenty`:

| App | Where | Widget |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | yes |
| Claude Code | `claude mcp add --scope user` | no |
| Codex · ChatGPT app | `~/.codex/config.toml` (`CODEX_HOME`) | no |
| Cursor | `~/.cursor/mcp.json` | yes |
| VS Code (Copilot) | user `mcp.json` | yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | no |
| Antigravity | `~/.gemini/config/mcp_config.json` (app and `agy`) | no |
| Goose | `~/.config/goose/config.yaml` | yes |
| OpenClaw | `openclaw mcp set`, else `~/.openclaw/openclaw.json` | no |
| LM Studio | `~/.lmstudio/mcp.json` | no |

A file that is not plain JSON (comments) is left alone; the command prints the entry to paste.
Claude Desktop writes its config from memory while it runs, so a change made meanwhile is lost:
while its process runs (macOS, Windows), `connect` writes nothing and asks to quit it first.
The setup offers the apps it finds, and Settings → "Einbinden" does the same with one click per
app (`/api/studio/local/apps`). Its test waits until the app has checked in, called a tool and
fetched the widget: the MCP endpoint notes that per app, in memory (`/api/studio/integrations/seen`,
`apps/runtime/src/mcp/seen.ts`). The web chats (chatgpt.com, claude.ai)
reach only servers on the internet: for them a wizard runs on engenty.ai, not on the computer.

## How it is built

| Part | Where |
|---|---|
| Wizard definition (zod) + validator | `packages/shared/src/definition.ts` |
| Step runner (cursor over the definition, pages / back / regenerate / branches) | `apps/runtime/src/engine/runner.ts` |
| Agent + generate steps (Mastra Agent, AI SDK media) | `apps/runtime/src/engine/steps.ts` |
| Agent tools: web search/fetch, sandbox, HTTP, image, MCP | `apps/runtime/src/tools/index.ts` |
| Sandbox engines (Docker, agentOS), what each runs, the installer of the engines outside the package | `apps/runtime/src/sandbox/` |
| Browser tools: open/click/type, screenshot, sign-in handed to the person, downloads | `apps/runtime/src/tools/browser.ts`, `apps/runtime/src/engine/asks.ts` |
| What a wizard keeps per person: lists, files, connected accounts, sign-ins | `packages/shared/src/store.ts`, `apps/runtime/src/store/`, `apps/runtime/src/tools/store.ts` |
| Mail connectors (Gmail, Outlook, IMAP) in engenty's connector format | `apps/runtime/src/connectors/`, `apps/runtime/src/tools/mail.ts` |
| engenty's built-in connectors (Google, Microsoft, Slack, GitHub, HubSpot, S3), copied unchanged | `apps/runtime/src/engenty/connections-*`, `apps/runtime/src/connectors/builtin.ts` |
| Imported connectors: any service from the integrations.sh registry, by its OpenAPI spec or MCP server | `apps/runtime/src/connectors/external.ts`, `apps/runtime/src/tools/connector.ts`, `apps/web/src/studio/Connectors.tsx` |
| Document reading (PDF, scans and photos, Word, Excel, CSV, mails) and invoice fields | `apps/runtime/src/documents/parse.ts` |
| engenty framework code, copied unchanged (`node scripts/sync-engenty.mjs`) | `apps/runtime/src/engenty/`, `packages/shared/src/engenty/` |
| Architect (prompt → wizard, self-repairing) | `apps/runtime/src/agents/architect.ts` |
| Widgets: bundle (code + data → one HTML), `window.wizard` runtime, PNG/PDF/MP4 export | `apps/runtime/src/widgets/` |
| Workspace files (content-addressed blobs, snapshots per version and run) | `apps/runtime/src/services/files.ts`, `apps/runtime/src/files/blobs.ts` |
| Shared results, link previews, 7-day retention | `apps/runtime/src/services/shares.ts`, `apps/runtime/src/link-preview.ts` |
| Marketplace client: search, one entry, stars, what is kept offline | `docs/marketplace-contract.md`, `packages/shared/src/{marketplace,marketplace-search,marketplace-entry}.ts`, `apps/runtime/src/services/marketplace.ts`, `apps/runtime/src/routes/marketplace.ts`, `apps/web/src/studio/Marketplace.tsx` |
| Tenants: context, one database each, the control database | `apps/runtime/src/tenants/tenant.ts`, `apps/runtime/src/db/client.ts`, `apps/runtime/src/tenants/control.ts` |
| Sign-in: the one-time link alone, the Manage-App's tokens when managed; the linked account | `apps/runtime/src/auth/`, `apps/runtime/src/manage.ts` |
| Model classes: gateway, own keys, local model | `apps/runtime/src/models.ts` |
| Installed AI clients as models (Claude Code, Codex, Antigravity, Cursor Agent): headless calls, tools over MCP, sign-in in an inline terminal; first-start setup | `apps/runtime/src/harness/`, `apps/runtime/src/mcp/bridge.ts`, `apps/web/src/studio/{SetupPage,Harness,Terminal}.tsx` |
| Credits: balance, reservation, cost per step; estimate before a run | `apps/runtime/src/credits/credits.ts`, `apps/runtime/src/credits/estimate.ts` |
| Studio chat on the Claude subscription | `apps/runtime/src/agents/subscription.ts` |
| A local install's project in the cloud: what is sent on publish (alone), what takes it and runs it (managed), the import API | `docs/manage-contract.md` ("Spaces of a local install"), `apps/runtime/src/services/cloud.ts`, `apps/runtime/src/services/spaces.ts`, `apps/runtime/src/routes/api.ts` |
| Who may change what: a synced project is read-only, a tenant without `limits.build` builds nothing | `apps/runtime/src/services/access.ts`, `apps/web/src/studio/ReadOnly.tsx` |
| Files in the data folder or a bucket, per tenant | `apps/runtime/src/files/objects.ts` |
| Studio (editor, diagram, chat, inspector) | `apps/web/src/studio/` |
| Public runner | `apps/web/src/runner/` |
| Phone inputs: camera and clips, code scan, location, voice note, signature; wake lock, notify, install | `apps/web/src/runner/{camera,scan,location,voice,signature,device}.*`, `apps/web/public/{sw.js,manifest.webmanifest}` |
| Voice notes to text before a step reads them; address of a position (`GEOCODER_URL`) | `apps/runtime/src/media/transcribe.ts`, `apps/runtime/src/engine/prepare.ts`, `apps/runtime/src/geocode.ts` |
| MCP server for authoring (tools, token/API-key gate) | `apps/runtime/src/mcp/` |
| Live editor (SSE stream, merge of concurrent edits) | `apps/runtime/src/routes/wizard-stream.ts`, `apps/web/src/studio/live.tsx` |
| Claude Code plugin template | `plugin/`, `apps/runtime/src/plugin.ts` |
| Share sheet and shared result page | `apps/web/src/share/` |
| Changelog and open-source credits: generated from the commits and the dependencies, shown in the studio's footer | `cliff.toml`, `scripts/release.mjs`, `scripts/write-about-data.mjs`, `apps/web/src/about/` |
