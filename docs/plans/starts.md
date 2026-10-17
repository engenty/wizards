# Plan: starts — a wizard that runs by itself

Status: plan, written on 2026-10-10 against v0.2.36. Nothing built.
Mockups: https://claude.ai/artifact/BzXoiszVueToEYnAZWiQb3 (eight screens, studio look, German UI). Prompted by a look at
Attio's workflows (record change, schedule, webhook, manual run; every run logged; pause and
rerun): engenty wizards has only the manual start today, over the link or from an AI app.

A **start** is what begins a run without a person opening the link: a clock, an address another
service calls, a row that appears or changes in a table, another wizard that finished. The wizard
does not change; a start sits beside the link in the share dialog, like the channels of
`wizard-channels.md` (pattern 5, headless) and the per-install settings `shareEnabled` and
`dailyRunLimit`.

Scope: the four kinds of start, how a run goes on when nobody is there, where its result lands,
the share dialog's "Starts by itself" section, the assistant and MCP, the ticker and the hooks.
Not in scope: a mail-in address (later, needs the cloud), plan gating (open), Flows and channels
(their own plan).

## Decisions

| | Decision | Why |
|---|---|---|
| Where a start lives | On the wizard row (`wizard.starts`), not in the definition | A `.wizard` file is portable; a schedule, a webhook secret and a table id are this install's. Same as sharing |
| What the person writes | A sentence of choices, never a cron line or a JSON path | "Every Monday at 8:00", "When a row is added to Leads", "When Invoice reader finishes" |
| Pages in a headless run | Filled from what started the run, the rest asked of the owner | The run waits like any run; the owner gets a notification with the link and continues it. No new page kind, no "headless only" wizard |
| Writes into connected services | One switch per start: "May change connected services on its own" | The author decides once; the run never hangs on a confirm nobody sees |
| Where the result goes | The space's Results, and a notification to the owner | Nothing to configure. What the wizard writes into lists, pages and services it writes anyway |
| Where it runs | The runtime the start was set on | A local install runs starts while it runs, as plugin jobs do; the cloud copy runs its own. No sync of starts in v1 |
| Loops | A run started by a row never starts the same wizard from rows it writes itself | The obvious endless loop, closed by rule, not by a guard the author sets |
| Failing starts | Three failed runs in a row pause the start and tell the owner | A broken wizard must not spend credits every hour |

## The four kinds

| Kind | The sentence | Brings into the run |
|---|---|---|
| Schedule | Every hour · Every day at 8:00 · Every Monday at 8:00 · On the 1st of each month at 8:00 | The time. Nothing else |
| Webhook | When something arrives at `https://…/api/public/starts/<token>` | The body (JSON or a form), the headers' content type |
| Record | When a row is added to *Leads* · changes in *Leads* · in *Leads* the column *Status* becomes *won* | The row's cells, and for "changes" the cells before |
| Wizard | When *Invoice reader* finishes | That run's answers and outputs |

Record sources are the space's tables (a wizard's shared lists are tables too, `SpaceTableInfo.list`)
and what plugins register: contacts (`contacts:person`), appointments (`appointments:booking`),
shop (`shop:order`). Mail arriving in a connected mailbox is a later source, through the
connection's own polling; not in this plan.

## What a start fills in

A wizard's first page asks things. A start answers them from what it brings:

| The field | A schedule | A webhook | A record | A wizard |
|---|---|---|---|---|
| Has a value in the start | Typed once when the start is made ("Region: Styria") | A key of the body | A column | A field or an output of the other wizard |
| Has no value | Asked of the owner | Asked of the owner | Asked of the owner | Asked of the owner |

The mapping is proposed once, when the start is made, by the classifier class reading the field
labels and the sample (the first webhook call, the table's columns, the other wizard's
definition). The author sees one chip per field — "from: Company" — and changes it or clears it.
Later pages are not mapped: a page the run reaches that still has unanswered required fields
makes the run wait, as any run does, and the owner is told.

What started the run is also on the run's state as `values.start`: `{ kind, at, body?, row?,
before?, run? }`. AI steps see it in their context like every answer (`answersAsText`), and
templates read it with `{{start.row.Company}}`. So a wizard with no page at all works from the
event alone: "When a row is added to Leads → research the company → write the briefing into the
row".

## A run nobody watches

| The run reaches | A visitor's run | A started run |
|---|---|---|
| A page with everything answered | shows it | passes it, like `startRun` with `answers` today |
| A page with a missing required field | waits | waits, status `waiting_input`; the owner is notified: "Weekly report needs you" with the link |
| An AI step | runs | runs |
| A confirm ask (a write into a service) | asks | answered "done" when the start allows changes; otherwise the run is cancelled with the note "needed permission to change *Google Sheets*; switch it on in the start" |
| A login ask (the browser met a sign-in) | asks | waits and notifies, like a page |
| A review | waits | passes with "Looks good" when the start says so (default), else waits and notifies |
| The result | shows downloads | lands in the space's Results; the owner is notified with the link |

A started run is a live run: it spends like one, counts against `dailyRunLimit`, keeps lists and
pages for the owner (the store is keyed to the owner, not a visitor), and appears in the runs panel
with "Started by: every Monday at 8:00" / "row *Acme* in Leads" / "a call at 9:12".

Notifications: the studio has none today; `engine/push.ts` pushes to the visitor's device per
run. Phase 1 adds owner notifications the simplest way — a bell in the studio's top bar with the
open items (needs you · finished · paused), and the same by mail through the account where one
is linked. The PWA push comes with the bell for free on an installed studio.

## The share dialog

Under the link and the channels, above Settings: **Starts by itself**.

```
Starts by itself                                     + Add
─────────────────────────────────────────────────────────
⏰ Every Monday at 8:00                     last: Mon 8:00 ✓   [on]
🔗 When something arrives                  waiting for a call  [on]
   https://…/api/public/starts/k7Qm…   Copy
⊞  When a row is added to Leads             3 runs this week   [on]
```

"+ Add" opens one sheet with four cards (clock, address, table, wizard). The next screen is the
sentence with its selects inline, then "What it fills in" (the chips), then — only when the
wizard has writes — the one switch. "Add" closes it. Three screens at most, no form with labels.

The webhook card waits: after "Add" the row says "waiting for a call"; the first call that arrives
fills in the mapping proposal and the row flips to its first run. No pasting a sample.

The flow diagram's first node gets a small badge per kind of start, so the editor shows that the
wizard runs by itself. The runs panel filters by "started by".

## The assistant and MCP

- The editor's conversation adds and changes starts: "run this every Monday morning" →
  the architect calls `set_starts` and the dialog's row appears. The architect also reads the
  starts, so "make this run without me" can propose the edits a headless run needs (a page's
  values from the row, a review passed by default).
- MCP tools `list_starts`, `set_starts` beside `set_sharing`; `get_run` reports `startedBy`.
- A plugin's server half can start a wizard: `server.runs.start({ wizardId, start: { kind:
  "plugin", body } })`, the function behind the webhook; `runs.start` of `runners-and-voice.md`
  takes the same `start` once that branch merges.

## Data

`packages/shared/src/starts.ts`:

```ts
interface WizardStart {
  id: string;
  kind: "schedule" | "webhook" | "record" | "wizard";
  on: boolean;
  schedule?: { every: "hour" | "day" | "week" | "month"; weekday?: 0–6; day?: 1–28; time: "08:00"; tz: string };
  webhook?: { tokenHash: string };            // the address shows the token once; the hash stays
  record?: { source: string; event: "added" | "changed" | "became"; column?: string; value?: unknown };
  wizard?: { id: string };
  answers: Record<string, unknown | { from: string }>;   // field id → literal, or a path into the event
  allowChanges: boolean;                      // confirm asks answered "done"
  passReviews: boolean;                       // default true
  lastRunAt?: string; failures: number; pausedReason?: string;
}
```

| Table or column | Holds |
|---|---|
| `wizard.starts` (JSON) | The starts of a wizard; checked against the published definition on publish, a start whose field is gone is shown as needing attention |
| `run.started_by` (JSON) | `{ kind, startId, ref }`: `ref` is the row id, the other run's id, nothing for a schedule or a call |
| `wizard_start_seen` | `(start_id, ref, at)`: a row or a run that already started this start, so a row is not run twice and a redone run does not run its follower again |

`values.start` lives in `RunState.values` under the reserved id `start`; `fieldSchema` refuses a
field with that id.

## The engine

| Piece | Where | Does |
|---|---|---|
| Ticker | `engine/starts.ts`, started from `index.ts` like `startJobs` | Once a minute per tenant: every schedule whose next time passed starts a run; one run at a time per start; a missed schedule runs once when the runtime starts, not once per turn it missed — the rule `plugins/jobs.ts` already has |
| Record watch | `services/space-data.ts` `rowChanged`, `store/shared-lists.ts` `saveSharedRows`, plugin hook `server.records.changed(source, { id, cells, before })` | Emits `record.changed` on the bus in `engine/events.ts`; the watcher matches starts of the tenant, skips rows the running run's own wizard wrote, inserts into `wizard_start_seen`, starts the run |
| Wizard start | `run.done` of `events.ts` | The same watcher, source = the finished wizard |
| Webhook | `routes/starts.ts`, `POST /api/public/starts/:token`, no sign-in | Token → tenant and start (hash, like plugin public routes); body up to 4 MB; answers `202 { runId }`; `429` past the day's limit |
| Start a run | `engine/runner.ts` `createRun({ startedBy, answers })` | `answers` fills any page whose fields are all answered, not only the first (`startRun` today); `userId` = the owner; `values.start` set before the first step |
| Asks and reviews | `engine/asks.ts`, `runner.ts` | A started run reads its start's `allowChanges` and `passReviews` before raising an ask or waiting at a review |
| Waiting and done | `runner.ts` where status becomes `waiting_input` / `done` / `failed` | Notifies the owner; three `failed` in a row set `pausedReason` and `on: false` |
| Mapping proposal | `services/starts.ts` | Classifier class, one call, from field labels and the sample; falls back to name matching when no model is bound |

## Phases

| Phase | Builds | Why first |
|---|---|---|
| 1 | Schedules; `wizard.starts`, `run.started_by`; headless rules (fill, ask, review, result); owner notifications (bell, mail); the share dialog section with the clock card; `set_starts` for the architect and MCP; runs panel "started by" | Needs no inbound address, works on every local install, and brings the rules every other kind reuses |
| 2 | Records: tables and lists, the plugin hook, contacts as the first plugin source; "when a wizard finishes"; "Run again with the same data" in the runs panel; loop rule and `wizard_start_seen` | The CRM shape of Attio's page; the loop rule is the hard part |
| 3 | Webhooks: the public route, waiting for the first call, the mapping from it; later the cloud as relay for a local install without a public address (`manage-contract.md` "Manage-App → runtime") | Needs the install to be reachable; local installs mostly are not |

## Files

| File | Change |
|---|---|
| `packages/shared/src/starts.ts` | `WizardStart`, `startSchema`, `nextRunAt(schedule, after)`, `describeStart` for the one sentence |
| `packages/shared/src/run.ts` | `startedBy` on `RunView`; `start` in `RunState.values` |
| `apps/runtime/src/db/schema.ts`, migration | `wizard.starts`, `run.started_by`, `wizard_start_seen` |
| `apps/runtime/src/engine/starts.ts` | Ticker, watcher, `startFrom(start, event)` |
| `apps/runtime/src/engine/runner.ts`, `asks.ts` | `createRun` answers for any page; the start's switches at asks and reviews; notify on wait, done, failed |
| `apps/runtime/src/engine/notify.ts` | Owner notifications: bell rows, mail through the account, PWA push |
| `apps/runtime/src/routes/starts.ts`, `app.ts` | The public webhook route |
| `apps/runtime/src/routes/studio.ts` | `GET/PUT /api/studio/wizards/:id/starts`, `POST …/starts/:startId/test` (runs once now), notifications routes |
| `apps/runtime/src/services/starts.ts` | Validation against the published definition, mapping proposal, token minting |
| `apps/runtime/src/services/space-data.ts`, `store/shared-lists.ts` | Emit `record.changed` |
| `apps/runtime/src/plugins/host.ts`, `packages/plugin-sdk` | `server.records.register(source, { label, columns })`, `server.records.changed(...)`, `server.runs.start` |
| `apps/runtime/src/mcp/tools.ts`, `agents/architect` | `list_starts`, `set_starts`; the architect's tool and prompt lines |
| `apps/web/src/studio/editor/ShareDialog.tsx`, `editor/StartsSection.tsx` | The section, the four cards, the sentence, the chips, the switch |
| `apps/web/src/studio/editor/FlowDiagram.tsx`, `RunsPanel.tsx` | Badge on the first node; "started by" line and filter; "Run again" |
| `apps/web/src/studio/AppFrame.tsx` | The bell |
| `docs/content/user/test-and-share.md`, `steps.md`, `docs/content/dev/plugins/events.md`, `server.md` | "Starts by itself"; `values.start`; `records` hooks |
| `apps/runtime/test/starts.test.ts` | Schedule arithmetic across DST, a missed schedule after a restart, a row that starts a run once, the loop rule, a webhook body filling a page, the three-failures pause |

## Open

- The word: "Starts" in the UI and the docs (de: "Startet von selbst"); the code says `start`.
  "Trigger" nowhere, same as "workflow".
- Plan gating: schedules on Free (how many), records and webhooks Pro? Not decided; the data
  model does not care.
- The least interval: every hour in v1. Every 15 minutes once there is a reason.
- A start on a wizard whose cloud copy also runs: both would run. v1 shows the start only on the
  runtime it was set on; a later phase syncs starts with `pushSharing`.
