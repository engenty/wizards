# Plan: Fähigkeiten, one place for skills and connectors

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x), revised
after review on 2026-10-30 and 2026-10-31. The runtime comes first (part A below), the places
after (part B). Behind a new switch `capabilities`, off by default. Mockups: the artifact
“Fähigkeiten in the Studio” (claude.ai/artifact/SLU1E9iwxQ8SjNAeHVg5qT). The connection model,
the three allowances, fixed steps and the broker come from the connections plan (artifact
“Verbindungen in Quellen”, claude.ai/artifact/GUtiTfPMVvoe1EcgRes3fh); this plan gives them
their place.

## In short

- **Fähigkeiten / Capabilities**, a place in the Studio's app bar after Quellen. Renamed from
  „Werkzeuge“ on review. The glossary gets a row for the place; „Fähigkeit“ stays ruled out as
  a word for one skill.
- Only the Studio shows it; Client shows none. A space can open the Studio to all its members,
  with less: they build, write skills and add knowledge, but set up no connection.
- It holds **Skills** and **Connectors**, each with „Im Space“ and „Entdecken“. An MCP server is
  a kind of connector.
- Built-in connectors (Gmail, Drive, Slack, GitHub …) show as a quiet list of names until
  someone connects one.
- Connectors hold the space's **connections**. Admins set them up and choose how each signs in:
  as the space, or each person for themselves. A person's own sign-ins sit in their menu.
- Settings › Connectors moves here. Plugins move later (roadmap).
- Held calls stay where they wait today: the bell in Work, the run's page in a wizard.
- Before any of these places: the broker, fixed steps and the guest sandbox rule (part A). The
  review of 2026-10-31 says why.
- On a phone Fähigkeiten sits in the „⋯“ menu, as Skills does now.
- A skill's page keeps today's two columns (instructions left, settings right). Dateien moves
  to the top of the right column, above „Wann gilt er“ and „Skripte“.

## Connections

A connection belongs to the **space**. Admins set it up in Fähigkeiten, and the page records who
did („eingerichtet von Matthias, 12. Okt.“). Nobody owns it: admins change its rules, sign it in
again or remove it, and it survives the person who set it up leaving. Members with the Studio use
connections but set none up.

When an admin sets one up, they choose how it signs in:

| | As the space | Each person signs in | Through the company sign-in (later) |
|---|---|---|---|
| Identity | an API key, an app token, or a team login (bestellung@) | each member's own account | each member, through the organization's SSO |
| Sign-in | once, by the admin | each person once, in their menu under „Verbindungen“ | none: the company grants access |
| Acts as | the space | the person | the person |
| Runs with nobody watching | yes | no | no |
| Used by | wizard steps, Work chats | that person's chats, runs and Goose | the same |
| Writes | fixed steps or confirmed actions, „Mit Freigabe“ asks the admins | asks that person | asks that person |
| Plans | every plan | Team | Enterprise, with SSO |

The third way is MCP's Enterprise-Managed Authorization: the company's identity provider grants an
MCP server to a person (an ID-JAG), with no sign-in per server, and the company revokes it there.
It needs SSO and servers that support the extension, so it stays on the roadmap.

Several connections per service in one space are fine (Gmail · Bestellungen, Gmail · Support).

**A person's own page.** Their menu › „Verbindungen“ lists their sign-ins: on top the ones only
for their Goose, in no space; then each of their spaces, where they sign in or out of connections
in which each person signs in, and see the ones that sign in as the space.

**Per space, not per organization.** Spaces keep data apart, e.g. one space per client of an
agency. A later admin action may offer one connection to several spaces („Auch in: …“). With one
space on your computer the question doesn't come up.

Today a sign-in belongs to one wizard and one person (`store_secret`, slot `connection:<id>`);
plugins keep N per space (`plugin_connection`). Connections take `plugin_connection`'s table; a
person's sign-in becomes one per person and connection. Existing rows move once by command.

How others do it: Claude Team/Enterprise and ChatGPT Enterprise let an owner or admin add a
connector for everyone, and each member signs in; Copilot Studio asks per tool for the end user's
or the maker's credentials and warns that the maker's overshare; Zapier Enterprise has managed
connections the company owns; Slack and GitHub install an app that acts as itself.

## The rules (from the connections plan)

A call goes through only when three allowances say yes:

- **The wizard**, frozen at publishing: what its AI steps may read, what its fixed steps do.
- **The connection**, set by the space's admins: per action *Erlaubt / Mit Freigabe / Nie*, and
  who may use it (*Admins / Mitglieder / alle*).
- **The person's role** in the organization.

On a connection that signs in as the space, the AI only reads. Writing (sending, creating, saving) is a fixed step, or in
a Work chat an action the AI fills in and the person confirms; with „Mit Freigabe“ it then waits
for an admin of the space. Every call goes through the broker, which logs it (planned; today see
„The gatekeeper“).

## The gatekeeper

Planned: every tool call and every read or write of a connected service goes through one path in
the runtime, the broker (its own plan: `docs/plans/broker.md`; first named in the connections plan). Nothing else holds a token, a key or a folder path.
Today there is no such path: five places call connectors, and `http_request`, mail tools, share
targets and a sandbox with internet go out past any gate (see the review).

- **Who calls:** an AI step of a wizard (reads only on a space connection), a fixed step (the
  writes), a Work chat (reads; writes as a confirmed action), Goose (its person's own sign-ins),
  a plugin (`server.connections.call`), a script in the sandbox (planned: the broker only; today
  open internet on Docker, registries on agentOS), an AI app over `/api/mcp` (as the signed-in
  person), and `http_request` and the mail tools once they go through it too.
- **What it checks:** `call(who, run, connection, action, input)` against the run's grant (what
  the wizard, chat or Goose may reach), the connection's rules (*Erlaubt / Mit Freigabe / Nie*
  per action, audience) and the person (role, their own sign-in). It answers *allow / ask /
  deny* with a reason; on any failure it denies.
- **What it does:** takes the secret from the vault, signs in the way the connection says (as
  the space, as the person, later through the company sign-in, or a folder path), runs the
  action, returns the result and logs the call („Letzte Nutzung“). *Ask* goes to Freigaben: the
  bell in Work or the run's page, for the space's admins or the person.

Model calls take a separate path, the model gateway (model tiers, masking). In phase 1 the broker
is a function in the runtime with plain rules; later it can read Cedar policies or run as its own
process with agentgateway in front.

### Runner and broker

Two things. The **runner** runs a wizard: its steps, model calls, pages and waiting
(`engine/runner.ts`, its own process role). The **broker** decides whether a tool or data call may
go through, holds the secrets and runs the call. The runner asks; the broker decides. Work chats
and Goose run in the studio process and ask the same broker.

### How guests' and the team's work runs

Today on `feat/work-mode`, with the broker as planned. Model calls never pass the broker.

**Guests** (a wizard at its link, the chat runner, voice, WhatsApp, SMS):

- Who: a visitor id (cookie `wz_vid`, or a hash of the channel id); signed in or not, a visitor.
  No role, no space.
- doors process: finds the tenant from the link, checks Turnstile, 6 runs per hour, the wizard's
  daily limit and the organization's guest budget, creates the run (`live`, holder
  `v:<visitor>`). It never runs a step.
- runner process: `drive()` runs the steps. AI steps read, with content checks on the guest's
  text; fixed steps write (planned); a sandbox per run for skill scripts (Docker: open internet;
  agentOS: registries only; cloud: none). Today a connector's ask goes to the guest, and
  `http_request`, mail and share links are ways out.
- Model: the step's class (Low, Standard, High) on the organization's own way (installed client,
  own API key, local model) or on credits through the model gateway (tier, masking).
- Broker, guest instance: the grant is fixed at start from the published wizard. It opens
  connections for „alle“ and the guest's own sign-in („Wer den Wizard nutzt“), never members'
  connections or a team member's sign-in. „Mit Freigabe“ goes to the space's admins, never to the
  guest.

**The team** (Work chats, Goose, test runs):

- Who: a signed-in person (holder `u:<user>`) with a role: owner, admin or member; the Studio
  if the space opens it to members.
- studio process: Work chat turns (the space's AI, a Mastra agent per tenant, skills, a sandbox
  per chat with the same engine rules as a run's, held calls in `chat_approval`), Goose (its person only, reads skills, runs no
  scripts), test runs and wizards from Work (created here, run by the runner without guest
  checks).
- Model: chats and Goose on the Agent-Chat way (installed client, own API key, or credits; in
  the cloud the organization's classes); test runs on model classes, as guests' runs.
- Broker, team instance: opens connections for „Mitglieder“ and „alle“ and the person's own
  sign-ins; Goose only its person's own. „Mit Freigabe“ asks the space's admins under the bell;
  an own sign-in asks the person before a write.

### Guests and the team

Open question: do guests' runs (the public link, chat, voice, WhatsApp, SMS) and the team's work
(test runs, Work chats, Goose) go through the same broker?

What the code does today is in the review below: one runner process for guest and test runs, one
database per tenant on a shared volume, five call sites and no gate.

The proposal on the table, in two steps:

1. **One library, logical separation.** The broker library runs in every process. Each call
   carries who calls (visitor, member, admin, Goose) and the run's grant, fixed at start. This
   replaces the five call sites and closes today's gaps, but every process can still open every
   secret.
2. **Isolated instances.** Guest runs move to runner processes of their own; secrets live only
   with the broker, in its own process; the guest side gets its own broker instance that opens
   only connections with the audience „alle“, never a person's own sign-in. This is the
   connections plan's appliance phase.

## Review: guests and the team on this setup (2026-10-31)

Against the code on `feat/work-mode`. The direction holds; little is impossible by design yet.

**The shape** is right: processes by audience, one queue in a database, one database per
organization, secrets sealed, the model path apart from the tool path. Three gaps:

- The split is by door, not by trust. Guest steps and team test runs share the runner process,
  its keys and its reach into every organization's database; a guest differs only by the run's
  row and `if guest` checks in `drive()` (`runner.ts:857`).
- No gate: five places call connectors; only `tools/connector.ts` asks anyone; plugin
  connections don't know who calls.
- The rules live only in code (`connector.ts:109`): nobody sees or sets them, and a wizard's
  `connection.policy` overrides them.

**Scripts.** A shell reaches an AI step only when its author listed `sandbox` in `step.tools`;
a Work chat always (members only); skill scripts only with `run_scripts` on. Code Mode
(`tools/code.ts`, QuickJS in WebAssembly, no I/O but the step's tools) is safe.

| Engine | Isolation | Network | Packages |
|---|---|---|---|
| Docker (`sandbox/docker.ts`) | a container per run, `capDrop ALL`, `no-new-privileges`, 1 GiB, 256 pids, nothing from `/data` | open internet, Docker's default bridge | anything |
| agentOS (`sandbox/agentos.ts`) | a VM per run | npm and PyPI only, plus `SANDBOX_ALLOW_HOSTS`; loopback and private refused | registries |
| off (the cloud compose) | no shell | – | – |

On Docker a guest's step can install and send anything; the host's published ports are
probably reachable from the bridge (not verified). On agentOS it reaches the registries and
nothing else.

**Data and tools.** Organizations are apart by a request context (`withTenant`); a bug in a
shared process crosses it, and the three containers share one sealing key. Outbound HTTP
(`tools/net-guard.ts`) refuses private addresses and re-checks DNS and redirects: it stops
reaching in, not sending out. Mail tools, share targets and plugin connections ask nobody;
Goose holds nothing. A connector's ask goes to the person running the wizard, for a guest the
attacker.

| Attack | Today | By design? |
|---|---|---|
| Prompt injection in a guest's answers | a prompt line (`prompts/step.md:17`), no detection; content guards check abuse, not injection | no; planned: AI steps read only on space connections, writes in fixed steps, results kept in the space |
| Exfiltrating what a step read | `http_request` to any public URL, mail from our address, a Docker sandbox with internet, share links | open; rules 5 and 7 of the connections plan |
| Another client's data | only through a bug in a shared process | mitigated; isolated instances make it structural |
| Network or `/data` from a script | Docker: host likely reachable, `/data` not mounted; agentOS: refused; cloud: no scripts | mitigated on agentOS only |
| Installing packages | Docker: anything; agentOS: registries | supply chain open, contained to the sandbox |
| Approving one's own write | the guest answers the ask | open; „Mit Freigabe“ to admins |
| Exhausting resources | Turnstile, 6 runs/h, daily limit, guest budget, concurrency, 15 min ask timeout | mitigated |

**In order:** part A of „Order of work“: the guest sandbox rule, one broker path, the run's
grant, fixed steps, connections of the space, ways out, then isolated instances.

## Who sees what

| | Wizard step | Work chat | Goose |
|---|---|---|---|
| Skills | by mode; scripts in the run's sandbox | by mode; scripts in the chat's sandbox | reads, runs no scripts |
| As the space | read in AI steps, write in fixed steps | **new:** read; write as a confirmed action | no |
| Each person signs in | as the person running it | **new:** as the person; asks before a write | **new:** as its person; asks before a write |

Goose is a personal copilot: it works with its person's own sign-ins and the space's skills,
never with a connection that signs in as the space.

## Who sees the place

One rule **per space**, set by an admin: „Mitglieder dürfen ins Studio“. It counts for all
members of the space; there is no switch per person.

| | Owner, admin | Member with Studio | Member without |
|---|---|---|---|
| Studio | yes | yes, in spaces that open it to members | no, Work only |
| Wizards | build, publish | build, test | run |
| Skills, Wissen, Daten | add, change | add, change | none |
| Connections | set up, choose how they sign in, set rules and audience | use the ones open to members; rules locked | their chats use them |
| Own sign-ins | in their menu | in their menu | in their menu |

A member with Studio can't set up a connection or change its rules. Freigaben go to the space's
admins.

## Addresses

`/capabilities`, `/capabilities/skills`, `/capabilities/connectors`, an item with `?show=`.
`/skills` and `/settings/connectors` redirect.

## Order of work

### Part A: the runtime first

Before any new place in the studio. Each PR is small, behind a switch where it changes
behaviour, and testable with the API and the existing pages. Nothing here needs a frontend.

0. `feat(runtime): RWX` — **built** (#356) — one table of permissions per space (`subject × resource × R W X`),
   deny by default, *verboten* wins, one reader per resource kind (documents, tables,
   connections, mail, hosts, the sandbox), search filtered by R, the deny test suite
   (`docs/plans/broker.md`, „First: RWX“).
1. `fix(runtime): guest runs never get the Docker sandbox` — **built** (#354): a guest run (and a
   channel's) gets agentOS or no sandbox; `SANDBOX_GUESTS=off|agentos`, default `off`; one place
   decides (`runSandboxEngine`, `engine/resources.ts`); a step without the sandbox says so in the
   run's log. Members keep what the server has. Closes: install and send anything from a guest's
   step.
2. `feat(runtime): one broker path for every connector call` (engenty/wizards#355) — `broker.call(who, where,
   connection, action, input)` in the runtime (`docs/plans/broker.md`); the five call sites (`tools/connector.ts`,
   `tools/mail.ts`, `sharing/targets/*`, `plugin-connections.ts`, `engine/resources.ts`) move
   onto it. `who` is visitor, member, admin, Goose or plugin. Rules as in code today (read
   allowed, write asks, delete always asks), `broker_log`, „Letzte Nutzung“ from it; a test
   fails on a tool without a broker action. Plugin
   connections from a guest run: reads only, logged. Closes: plugin connections with no ask and
   no holder; nobody knowing who called.
3. `feat(runtime): a run's grant, fixed at start` — **built** (#358): `grantOf(definition)`
   in `broker/grant.ts` — the steps' connections with the actions they may use (read only
   without a list), the steps' tools, hosts empty until A6 — computed in `createRun` from the
   published definition (a test run: the draft), kept as `run.grant`, so an edit never widens a
   run under way; `brokerCall` refuses a wizard's connection or action outside it before any rule
   (`not_in_grant`, logged as critical); an older run gets its grant from its definition on first
   use; the run's log opens with what it may do („Dieser Lauf darf: …“). A share target's
   connection and a plugin's are not bound (A5, A7). Closes: the AI steering a step to another
   action.
4. `feat(runtime): fixed steps write, AI steps on space connections read` — **built** (#360):
   `step.call` takes a connection's action (`{ connection, action, input }`) with fixed fields
   from the run's values, run through the broker as `step` (carrying the run's holder for the
   audience), in the grant; an AI step on a connection that signs in as the space gets read
   actions only, in its tools list and in the broker (`ai_step_writes`, logged critical, whatever
   `policy` says); a write there never asks the person running (denied until „Mit Freigabe“
   exists). The person's own connection keeps today's ask, in fixed steps too. The architect's
   guide says so and lists the space's connections; `checkDraft` and `validate_wizard` refuse an
   AI step with a write action on such a connection. Closes: a guest approving their own write;
   injected text becoming a write.
5. `feat(runtime): connections belong to the space` — **built** (#359) — `space_connection`
   replaces `plugin_connection` (migration 0034 moves the rows: as the space, open to everyone,
   default rules): name, how it signs in (space, person), audience (*Admins / Mitglieder /
   alle*), rules per kind of action; a person's sign-in per connection in
   `space_connection_sign_in`; a wizard reaches one through a connection with `spaceConnection`;
   API under `/api/studio/spaces/:id/connections`, admins only. „Mit Freigabe“ on a `space`
   sign-in is a deny (`needs_approval`) until A7 holds the call for the admins (the bell,
   `chat_approval`). `store_secret` rows stay the person's own sign-in per wizard. The rules
   left the code.
6. `feat(runtime): ways out for guests` — **built** (#362) — a step lists `hosts`,
   `grantOf` collects them, `http_request` goes through the broker (`broker/host.ts`, a `host:`
   resource of kind `send`): a guest's run reaches only the hosts in its grant, a member's any
   public host until the `broker` switch is on; a guest's send (the email share target, a
   connection's send action) goes only to the address a page field of kind `email` collected
   (nothing confirms one yet) or to the space's `mailDomains` (admin API, `PATCH /spaces/:id`),
   3 per run and `wizard.dailyMailLimit` (default 50) per day (`broker/send.ts`); what a step
   of a guest's run read from a space connection whose audience is not „alle“ stays in the space
   (`broker/kept.ts`, from `broker_log.step_id`): the guest's page and share link show a note
   (`resultKeptInSpace`), Ergebnisse shows it; every refusal is logged as critical (rules 5 and
   7 of the connections plan). A guest still never reads outside the audience (A5): the rule
   covers a connection narrowed after the read, and whatever A7 lets through later.
7. `feat(work): Work chats and Goose call the broker` — **built** (#361) — a Work chat's
   tools are the space's connections open to the person's role (`tools/connections.ts`,
   `services/work-connections.ts`): reads run through `brokerCall` as the person in the chat; a
   write, a send or a delete is a confirmed action the gate holds for the person
   (`chat_approval`), and once confirmed the broker decides by the rules: *Erlaubt* runs, *Mit
   Freigabe* on a `space` sign-in is an `ask` of the admins (`needs_approval`) that the chat holds
   again (`held_for: admins`, the bell; owners and admins decide, the asker only as one), *Nie*
   fails the call with the reason. Goose (`agents/goose-connections.ts`) gets the `person`
   sign-in connections its person signed in to, within their audience, as `who` goose; a write
   asks them on a card in Goose's chat (the browser's `confirm_action`), with no hold for the
   admins; never a connection that signs in as the space. Every call is in `broker_log` with the
   chat. A run still gets the `needs_approval` refusal.
7a. `feat(runtime): the broker is heard` — critical kinds, the bell, the hourly mail to admins,
   the Manage-App's report, „Was darf …?“ (broker plan, phase 2).
8. Later, when the cloud needs it: `feat(runtime): isolated instances` — `RUNTIME_ROLE`
   `runner-guests`, the broker as its own process holding the sealing key, a guest instance
   that opens only connections for „alle“.

After 1–5 the review's open rows read: injection mitigated structurally, own-write approval
closed, plugin connections closed, scripts contained; exfiltration closes with 6; cross-tenant
reach becomes structural with 8.

### Part B: the places

All behind `capabilities`, off by default. They show what part A built.

1. `feat(studio): Fähigkeiten in the app bar` — Skills move in, `/skills` redirects.
2. `feat(studio): connectors move to Fähigkeiten` — list, page with sign-in kind, audience and
   rules (from A5), built-ins as names; `/settings/connectors` redirects.
3. `feat(studio): each person signs in` — the person's menu › „Verbindungen“.
4. `feat(studio): members in the Studio per space` — one rule per space, the reduced set.
5. `feat(studio): Fähigkeiten › Protokoll` — the broker's log per space, filters, „Was darf …?“.
6. `feat(studio): Entdecken` — one search over skills.sh and integrations.sh.
7. `feat: Fähigkeiten on by default` — switch, docs, glossary.

## Roadmap

- Plugins move to Fähigkeiten, with their settings; `/settings/plugins` redirects.
- One connection offered to several spaces.
- Through the company sign-in: MCP Enterprise-Managed Authorization, for Enterprise with SSO.

## Open

- Does a member in Work ever need to see the space's connections and rules, or is the menu enough?
- Later: may a member with Studio publish a wizard to people outside the space, or only an admin?
- Guests and the team on one broker: logical separation only, or isolated instances (see „Guests
  and the team“)?
