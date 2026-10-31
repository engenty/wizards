# Plan: one tool surface for every client

Status: plan, nothing built; open questions decided on 2026-10-31. Written on 2026-10-31 against main `f5d7b224` (v0.13.x with Work
mode). Page with both diagrams: the artifact “Modular Wizards Plan”
(claude.ai/artifact/BRLfib42d2m3Nq6mXG5s7s). It extends the architecture page
(`docs/content/dev/architecture.md`).

Studio makes the elements of a space: wizards, skills, connections and data. Everything else uses
them through one tool surface and one broker. Work becomes any agent client (our own chat, Claude,
Codex), and a published wizard becomes a durable agent that other systems can call.

## Why

Two directions from 2026-10-31:

- **Published wizards run on their own and plug into other systems.** Today a published wizard
  runs when someone opens its link, a chat or a channel. It should also start by itself, wait for
  days, ask a person and go on, and be callable from Claude, apps and sites.
- **Work can be Claude or Codex.** A person who works in Claude Code or Codex should reach the
  same space as our Work chat: its wizards, skills, connections and data, under the same rules.

Both need the same thing underneath: the space's elements as tools any caller can use, with the
broker deciding every call. Today each caller has its own tool set, and the broker decides only
connector calls and reads and writes of documents, tables and pages.

## Today and target

The system, top to bottom:

- **Entry points:** Studio and Work (split per person by `allowedModes`) on the signed-in side,
  Published Wizards on the guest side.
- **Roles (`RUNTIME_ROLE`):** `studio` (`/api/studio`), a new `api` role for MCP and the API
  (one tool surface), `doors` (`/w/…`, plus embeds), `runner` (runs, plus waits).

One instance:

- The roles reach the **engine** and the **broker**.
- The broker guards **every element** (wizards, skills, connections and MCPs, knowledge and
  tables) and every call to a **connected service**.
- The engine uses **models**; it reaches data only through the broker and the elements.
- **Data:** the control database (one per runtime), a libSQL database per tenant, files under
  `t/<tenant>/` (unchanged).

## Rules

1. **Studio makes, everyone else uses.** An element is made and changed in Studio (or by the
   studio assistant). Clients use elements; they do not get the studio's write routes.
2. **One tool catalogue.** The tools an agent gets come from one place that turns a space's
   elements into tools. Wizard steps, our Work chat, Goose and outside clients all read it; none
   keeps its own list.
3. **The broker decides every element call.** Running a wizard, loading or running a skill, a
   connection's action, reading or writing data: one call through `broker/call`, one decision,
   one log line. No caller reaches the tenant database for an element directly.
4. **A call always acts as someone.** A person (signed in, scoped token), a guest of a published
   wizard, or the runtime itself for a start. The broker already knows `guest`, `person`,
   `admin`, `goose`, `plugin`, `step` (`broker/call.ts`); outside clients add none, they act as
   the person who signed them in.
5. **Secrets never leave the broker.** Claude or Codex can use a connection; they never see its
   token.
6. **Guests stay on their side.** A published wizard's guest reaches only what that wizard's
   grant names (A3: a run's grant, fixed at start). Where the cloud runs `doors` apart, the guest
   boundary is a process boundary.
7. **No fallback code.** Unreleased, so routes and settings change outright; local data converts
   once by command.

## What would need to change

| Area | Today (main) | Change |
|---|---|---|
| Tool sets | Separate lists: step tools (`tools/index.ts` `buildStepTools`), Work chat (`services/work-ai.ts`: `search_space`, `run_command`, `show_view`, skill tools), Goose (`agents/space-agent.ts`), MCP (`mcp/tools.ts`) | One catalogue: elements → tools, each with its broker resource and action (r / w / x). The four callers build from it with their own filter (a step's `tools`, a chat's switches, a token's scopes). |
| MCP | `/api/mcp` exposes authoring: `create_wizard`, `edit_wizard`, `run_wizard`, `start_test_run`, `list_files`, `read_file`, `write_file`, `find_connectors` and more. Scopes `wizards:read\|write\|publish`, `runs:test\|read` | A second tool set for using a space: run a wizard, list and load skills, run a skill script, call a connection's action, search knowledge, read and write tables. New scopes `elements:read`, `elements:run`, `data:read`, `data:write`. Authoring tools stay behind their scopes. |
| API | `/api/v1`: wizards, runs, spaces, sync (`routes/api.ts`). `x-wizards-client` built; client registry and attestation not built (`api-clients.md`) | The same element calls as REST under `/api/v1/spaces/:id/…`, generated from the catalogue so MCP and API never drift. |
| Runtime roles | `studio`, `doors`, `web`, `runner`, `all` (`env.ts`) | New role `api` serving `/api/mcp` and `/api/v1`, so outside clients scale and fail apart from the studio. `all` keeps serving everything on a local install. |
| Broker | Decides connector calls (A2) and RWX on documents, tables and pages (A0, on by default since B8). Work chats and Goose call it (A7) | Resources for wizards (run = x), skills (read = r, script = x) and data rows (r / w). The log names the client (`x-wizards-client`, the MCP client's name). |
| Sign-in | MCP OAuth through the Manage-App consent page (`mcp/auth.ts`); a local install uses its access key | Every outside call carries a person and a space. A local install needs a token per client (today one key opens everything). |
| Skills | Stored per space; steps and Work chats read them and run scripts in a sandbox (`tools/skills.ts`, `services/work-sandbox.ts`) | Offered to outside clients as tools (load, run a script in our sandbox) and as a download in the `SKILL.md` layout Claude and Codex read, without the scripts' secrets. |
| Work chat | Own routes `/api/studio/work` and its own agent (`work-ai.ts`) | Our chat becomes a client of the catalogue like Claude; its UI stays. The sandbox per chat moves from memory to something that survives a restart. |
| Published wizards | Run from the link, the chat runner, channels, embeds (OpenUI component, WordPress plugin). Starts: phase 1 on a branch behind `startTriggers`, not merged | Each published wizard is also an MCP tool and an API endpoint with its own grant; starts land; the guests' sandbox engine is decided (`SANDBOX_GUESTS`). |
| Runner | Own process since 2026-10-10; takes runs in line (`runner-process.md`) | Holds durable runs: waits, signals, a person's step, resume after restart (`durable-agents.md`, switch `durableRuns`). |
| Claude and Codex | Used the other way round: harnesses we call for thinking (`harness/claude.ts`, `codex.ts`); the Claude Code plugin `wizards` talks to `wizards mcp` (authoring) | Also clients: one MCP entry gives them the space. The plugin gains the element tools; Codex gets the same server entry. |

## Phases

Each phase is a few small PRs behind one switch, on by default once its last PR is in.

1. **One tool catalogue.** Elements → tools in one module with their broker resource. Step
   tools, Work chat and Goose build from it; behaviour stays the same. Wizards, skills and data
   rows become broker resources. Done when the three callers share one list, every element call
   writes a broker log line, and existing tests pass unchanged.
2. **The `mcp · api` surface.** Element tools on `/api/mcp` with the new scopes, the same calls
   on `/api/v1`, the `api` role, tokens per client on a local install. Done when an MCP client
   signed in as a member sees exactly what the Work chat shows that member, and is refused the
   same things.
3. **Claude and Codex as Work.** The Claude Code plugin and a Codex config entry point at the
   surface; skills offered as tools and as `SKILL.md` downloads; connection approvals reach the
   person in their client and in the bell. Done when, from Claude Code, a person runs a space's
   wizard, uses a skill with a script and calls a connection that needs approval, and the
   Protokoll shows all three.
4. **Published wizards as endpoints.** A published wizard as MCP tool, API endpoint and embed
   with its grant; starts merged; the guests' sandbox engine set. Done when another system starts
   a published wizard by API or webhook and gets its result without anyone opening the link.
5. **Durable runs.** `durable-agents.md` on the runner: `wait` steps, signals, a person's step
   with timeout and reminders, resume after restart, sandboxes that come back. Done when a run
   waits three days for an answer, survives a deploy, and goes on.

## Decided

Decided on 2026-10-31 (roadmap page: claude.ai/artifact/LhdF8LKeqC2gcL3zNA9qC6).

1. **No client that is not a person, for now.** Every outside call acts as a person or as a
   published wizard's guest; the broker already knows both.
2. **Credits:** a run Claude or Codex starts is paid by the person's organization, as a run from
   the Work chat. A published wizard called by another system charges its publisher, as guest runs
   do today.
3. **Skills reach Claude and Codex as tools first.** Scripts stay in our sandbox and behind the
   broker. A download in the `SKILL.md` layout comes later, for skills without scripts.
4. **Our Work chat stays the default Work client.** It becomes one client of the catalogue;
   Claude and Codex are added, not swapped in.
5. **One MCP server per person, the space as a parameter.** One sign-in per client; the tool list
   stays the same across spaces.
6. **The new role is `api`.** It serves `/api/mcp` and `/api/v1`; `doors` stays the guests' side.
7. **A local install needs no linked account.** It gives a token per client, which can be revoked
   alone (today one access key opens everything).

## Measured against the goal

The goal (2026-10-31): Studio creates (skills, tools, knowledge, wizards and agents); Work and
Client use it. Everything is isolated by tenant, space and customer, served through the broker,
safe against the LLMs and agents that use it, and built from parts that can be swapped (Claude
Code instead of our Work) or reused (wizards in other apps). Diagrams of the target (parts and
contracts, isolation, trust boundary): the artifact “Modular Wizards Roadmap”
(claude.ai/artifact/LhdF8LKeqC2gcL3zNA9qC6).

| Goal | Plan above | Gap | Added |
|---|---|---|---|
| Studio creates, others use | Rule 1, one catalogue | Client pages are not in it; Goose writes space settings with tools no broker sees | B1, B4 |
| Tenant isolation | Database per tenant, `inTenant()`, files per tenant | None | – |
| Space isolation | RWX per space, grants | The space a client names (decision 5) must be checked against its token | I2 |
| Customer isolation | Not in the plan | No client subject, no client space | B2, decision 8 |
| Served via the broker | Phase 1 | Authoring and pages stay outside | B1, B4 |
| LLMs can't breach it | Rules 3–6 | No stated invariants; Claude Code runs tools itself and skips the agent framework's approvals (`work-chats-spike.md`) | B3 |
| Swap parts | MCP for Claude and Codex | No contract per part, no test that our own Work keeps to it | B1 |
| Wizards in other apps | Phases 4 and 5 | The run protocol has no asks and answers from outside | B1 |

### B1: a contract per part

- **Studio API** (`/api/studio`): authoring, testing, publishing. Only Studio uses it.
- **Element protocol** (MCP and `/api/v1`, from the catalogue): Work. Our Work chat, Claude Code
  and Codex all speak it.
- **Run protocol**: start, events, asks, answers, result. Client pages, embeds and other apps use
  it. It gains asks and answers from outside, so a person in another app can answer a durable
  run.
- **Wizard format** (MIT, JSON Schema): definitions move between installs and apps.

A part is swappable when it reaches the core only through its contract. Test: our Work chat calls
only the element protocol, Client pages only the run protocol.

### B2: client spaces

A space kind `client`, one level under a space, cloud only. A broker subject `client` for the
customer who signs in. Reads: the client space plus what the parent marks for clients. Writes:
only the client space. An agent working for a client reaches the narrower of itself and that
client. Rejected on 2026-10-29: a copied space per client (drift), a client tag on rows (leaks).

### B3: invariants

1. **I1** The caller comes from the session or token, never from a tool's arguments.
2. **I2** A space argument is checked against the token and pinned per session.
3. **I3** A run's grant is fixed at its start (A3).
4. **I4** Approvals are held in the broker, not in the agent framework.
5. **I5** Secrets never reach a model or a client.
6. **I6** One log line per call, with the client's name.

### B4: Studio's own writes

Goose is an LLM with write tools on the space (`set_colors`, `set_facts`, `save_file` and more in
`agents/studio-assistant.ts`). They become broker calls with `w` on the space's setup. People in
Studio keep their direct routes.

### Phase changes

- Phase 1 gains a sixth PR (B4) and tests for I1, I5 and I6.
- Phase 2 is done also when a space argument outside the token is refused (I2) and our Work chat
  calls only the element protocol (B1).
- New phase 2b, **client spaces** (B2): done when a customer signed in to their client space sees
  their own results and the shared knowledge, and nothing of another client or of the space's
  setup, from the page, the run protocol and MCP alike.
- Open: decision 8, client spaces as B2 describes them (proposal: yes, one level, cloud only).

## Risks

- **Two lists again.** If phase 1 leaves one caller on its own tools, the broker misses its
  calls. Phase 1 is done only when all three share the catalogue.
- **Prompt injection from outside clients.** Claude reading a page can ask a connection to send
  mail. The broker's ask rules and approvals carry this; they must hold for clients we do not run.
- **Guest runs with a sandbox.** Autonomous published wizards make guest runs common;
  `SANDBOX_GUESTS` off is safe but limits what they can do.
- **Durable state in memory.** The chat sandbox and parts of a run live in memory today; phase 5
  depends on moving them.

## Builds on

- `broker.md`, `capabilities.md`: the broker, RWX, grants, connections of the space (built; A8
  isolated instances open)
- `durable-agents.md`: durable runs (nothing built)
- `starts.md`: runs that start by themselves
- `api-clients.md`: clients of the API (phase 1 built)
- `runner-process.md`: the runner as its own process
- `work-chats.md`: Work chats on Mastra
