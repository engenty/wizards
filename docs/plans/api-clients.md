# Plan: clients of the API

Status: phase 1 built on 2026-10-10 in this repository: the `x-wizards-client` header on the
public run API, the client list a managed runtime fetches from its Manage-App, the `client`
column on a run, the runner and the mobile app naming themselves, and the page
[The API](../content/dev/api.md) that says what a program may rely on. Not built: the Manage-App's
side (the client registry, `GET /v1/clients`, the terms page) and phase 2 (attestation). Written
after the licence discussion of the same day; checked against v0.2.37.

Scope: how the API of engenty wizards is protected against a client that competes with ours —
a third-party app, a foreign CLI, a service built on our runtime's endpoints — without hindering
the clients we want: the runner in a browser, the mobile app, `wizards mcp`, the plugins, and
`wizards run` once it exists.

## What the licence does and does not cover

The runtime is FSL-1.1-MIT (`LICENSE`): use it for yourself and your company, run it, change
it; not as a competing commercial product or service; MIT two years after each release.

| | Covered |
|---|---|
| Building a competing app or service from the code | No, until the release is two years old |
| A clean-room client against the API, with none of our code | Yes. The licence covers the Software, not the protocol |
| Using the names "engenty" and "wizards" | No (Trademarks clause) |
| The closed parts: accounts, credits, the cloud runtime, the marketplace, Pro modules, the gateway | Not FSL; they never convert |

So the protocol is open by law, and the local runtime's API is open by design.

## Why the local API stays open

| Fact | Consequence |
|---|---|
| The runtime is FSL and runs on the person's machine; any lock is in open code | A competitor removes it in a fork; only our own users are hindered |
| Our own clients need it: the CLI, `wizards mcp`, the mobile app (a WebView on `/w/<token>?app=1`), the plugins | Every lock hits them first |
| FSL permits internal use | A company's own client against its own runtime is allowed anyway |

Obfuscation, signed requests in the open runtime, hidden routes: not done. All of it is in the
repository.

## What is protected, and how

The hosted service: the cloud runtime at engenty.ai and the account behind it. Three levers, in
the order they are pulled.

| Lever | Where | Does |
|---|---|---|
| A client names itself | the public run API: `x-wizards-client` | Every start of a run carries a client id: `web` (the runner in a browser), `app` (the mobile app), `cli` (`wizards run`, once it exists), or the id of a client registered at the Manage-App. The id is no secret; it carries the terms, the limits and the revocation of a client, not its proof. The run keeps it (`run.client`) |
| The Manage-App keeps the clients | `GET /v1/clients`, fetched by a managed runtime at the start and hourly | Which ids may start runs, how many an hour across all visitors, what an unknown id gets. A runtime that runs alone fetches nothing and refuses nothing. Without a list, every client may start runs: the Manage-App being down must not close the wizards |
| Terms for the hosted API | a page at engenty.ai, linked from the account | A client of the hosted API needs a registered id; no client that substitutes for ours; the limits; an id can be revoked. The licence already bars our names |
| The supported surface is declared | [The API](../content/dev/api.md) | `/api/v1` and the public run API are the contract; `/api/studio`, `/api/internal` and `/api/auth` are private and change without notice. That is what a clean-room client can rely on, and it is small |
| The value stays behind the account | already so | A foreign client without an account reaches one machine's wizards; with an account it buys our credits. Then it is a sales channel, not a competitor |

### Phase 2: attestation

The official mobile app proves itself to the cloud: App Attest on iOS, Play Integrity on
Android. The cloud runtime verifies the attestation on the start of a run (and on the code
lookup) and treats `app` without one like an unknown client. Attested clients get the app's
limits, the rest the public floor. Only on the cloud; a local runtime verifies nothing. Built
with the app's release, not before.

## Built in this repository

| What | Where |
|---|---|
| The header, the client list, the checks | `apps/runtime/src/clients.ts` |
| The check on the start of a run, the id on the run | `apps/runtime/src/routes/runs.ts`, `engine/runner.ts` (`createRun`), `db/schema.ts` (`run.client`), migration `0011_run_client` |
| The managed runtime fetches the list at the start and hourly | `apps/runtime/src/index.ts` |
| The runner sends `web`, or `app` inside the mobile app | `apps/web/src/lib/api.ts` |
| The mobile app's own requests send `app` | `apps/mobile/src/data/runtime.ts` |
| The contract: `GET /v1/clients` | `docs/manage-contract.md` |
| The page for programs | `docs/content/dev/api.md` |
| Tests | `apps/runtime/test/clients.test.ts` |

## For the Manage-App (closed repository)

| What | Spec |
|---|---|
| The client registry | A table of clients: `id` (`[a-z0-9-]`, 64 at most), `name`, `runsPerHour` (null = no cap), `revoked`, who registered it, when. `web` and `app` are rows too, so they can be capped or revoked like any other |
| `GET /v1/clients` | `Authorization: Bearer <service key of the runtime>` → `{ clients: [{ id, name, runsPerHour, revoked }], unknown: { allow, runsPerHour } }`. `unknown` is what an id not in the list gets: allowed with a cap, or refused |
| The terms page | engenty.ai/api-terms, linked from the account's settings and from [The API](../content/dev/api.md): a registered id per client; no client that substitutes for ours; the limits; revocation; the names |
| Registration | Under the account: a form that gives an id and shows the terms. Later a partner program with its own limits |
| The cost per client | Runs and credits by `run.client`, in the account's usage |

## Later

- `wizards run` sends `cli`; a run it starts on a foreign runtime over the public API carries
  it too.
- An unattested `app` on the cloud falls back to the unknown client's limits once phase 2 is in.
- The embed (the runner in a frame on another website) stays `web`: it is our runner.
