# Plan: wizards as durable runs with a person in the loop

Status: built, behind the switch `durableRuns` (off by default), except PR 0, which needs no switch.
Rewritten on 2026-11-06 to what was built. PRs 0 and 1 are on main. PRs 2 to 11 went to main together on
2026-11-08 from `claude/durable-runs-combined`, PR 3 with them ([#498](https://github.com/engenty/wizards/pull/498)
closed), after Manage's `feat/run-mail`
([engenty-wizards-manage#191](https://github.com/engenty/engenty-wizards-manage/pull/191)). Starts have their own
plan (`starts.md`, behind `startTriggers`). "Before the switch flips" below holds what is left.

Scope: a run that lasts hours or days. It follows its steps, branches and waits, survives restarts of
every process, and stops for a person where it needs one, then goes on.

Not in scope: pages moving without waiting on the server (`fast-creation.md`), parallel branches (one
cursor per run stays), Engenties as chat members (`work-chats.md`, "After step 3").

## Rules

1. **The flow stays ours, Mastra works inside a turn.** See "Who owns what".
2. **One drive per wake.** A runner takes a run, does steps until the run waits, then gives it back.
   Nothing waits in a process's memory.
3. **The clock is outside the run.** A waiting run has a wake time in a column. One statement a minute
   wakes what is due.
4. **Signals are rows.** Whatever arrives is written first, then matched. A signal that comes before
   its run waits is not lost.
5. **The live view reads the database**, so it does not matter which process moved the run.
6. **Additive format.** Every addition to the definition is optional. `DEFINITION_VERSION` stays 2.
7. **A person's step is never answered by the AI or by a signal.** A timeout can move the run past it,
   as the author wrote. Nobody's answer is invented.

## Who owns what

| Layer | Owner | Why |
|---|---|---|
| Flow between steps | ours: `drive()`, `run.cursor`, `run.state` | `goBack` works from done and failed, `reviewStep` jumps to any shown step with a note, `next` rules jump anywhere. A Mastra graph runs its entries in order, with no jump |
| Line and takeover | ours: `run_index` | One line over all tenants with a limit per tenant; a process without a runner tells a runner directly to take a run it hands on (`POST /api/peer/runs/:id/take`), the 2 s look stays as the fallback. Mastra recovers at boot only, per instance, with no limit on concurrent runs |
| Clock and signals | ours: rows and one sweep | Mastra's sleep is a timer in memory: a 31-day sleep ran at once, and a restart started a 20 s sleep over. `waitForEvent` was removed from Mastra |
| Inside an agent turn | Mastra `DurableAgent` | Checkpoints per model step, claims with fenced writes on libSQL, stops a superseded owner |
| Outside actions once | ours: `run_effect` | Mastra repeats an interrupted tool call by design. Its stable `toolCallId` gives us the key |

We look at this again when Mastra's timed waits survive a restart, recovery works while other
processes run, its default engine's writes are fenced and dynamic workflows are out of beta. Inngest
would replace the line, the sweep and retries, the cheap part, and needs a server beside every runtime.
A local install is one process with no server (`runner-process.md`).

## The run's statuses

| Status (code) | Means | Wake time |
|---|---|---|
| `running` | A runner works on a step | none |
| `waiting_input` | A page, a review or a question waits for a person | the timeout, if any |
| `sleeping` | A `wait` for a time, a retry, or a wait for credits or a sign-in (`state.pause`) | the time |
| `waiting_signal` | A `wait` for a signal | the timeout, if any |
| `done`, `failed`, `cancelled` | Over. A failed run can be tried again. The UI says "stopped" for `cancelled` | none |

The UI never says "sleeping" or "signal": it says "waits until Tuesday 8:00" and "Events" / „Ereignisse“.

## What the definition gains

The format's page is `docs/content/dev/wizard-format/runs-that-last.md`, and the authoring guide's
section is `prompts/authoring.md`, `durable`, which the guide leaves out while the switch is off.

| Where | Key | PR |
|---|---|---|
| `wait` step | `for`, `until`, `signal: { name, key, timeout?, fields? }`. Outputs `waited`, or `came`, `timedOut`, `data.<field>` | 1, 5 |
| `agent` | `durable` | 4 |
| `page`, `review` | `timeout`, `remind`, `timedOut`, `who` | 8, 10 |
| `review` | `approve`: `approved`, `note` | 8, 10 |
| Any step | `onFail` | 11 |
| Wizard | `label` | 2 |
| `email` field | `notify`: the visitor's own address, mailed at a wait and at the end | 9 |

Validator: a `wait` has one of `for`, `until`, `signal`. `timeout` and `remind` are at most 31 days, and
`remind` is shorter than `timeout`. A review with `approve` has a branch on `approved`. `onFail` names
another step. `durable` refuses `browser` and `sandbox`, and says it does nothing with `each` or `call`.

## Data

| Table | Adds | PR |
|---|---|---|
| `run_index` (control) | `generation`, `wake_at`, `woken_at`, `viewed_at` | 0, 1, 9 |
| `run` | `claim`, `rev`, `wake_at`, `label`, `driving` | 0, 1, 2, 4 |
| `run_effect` | `id, run_id, step_id, tool, state, output, at` | 3 |
| `run_signal` | `id, space_id, scope, name, key, delivery, data, source, runs, at`; unique on the delivery. Kept 30 days | 5 |
| `run_wait` | `run_id, wizard_id, space_id, name, key, fields, since` | 5 |
| `mail_cursor` | Per connection: `cursor, since, next_at, read_at, error, failures` | 6 |
| `notice` | The outbox, widened to any run | 7, 9 |
| `chat_approval` → `approval` | `chat_id` nullable, `run_id`, `step_id`, `held_for` also `team` | 10 |
| `wizard` | `answerers`, `signal_token`, `signal_secret` | 5, 10 |
| Mastra's `mastra_workflow_*` | In the tenant database, kept out of `purgeExpiredRuns` and sync | 4 |

Migrations only add, except `0059` to `0062`, which rename and rebuild `chat_approval`. That is behind
`workMode`, and a process on the old code touching it during a rolling deploy fails.

## The line

- `take` claims, then drives without holding up `lookAtLine`. `RUNNER_MAX_RUNS` caps a process.
- `restRun` acts only `WHERE owner = this runner`. `wakeRun` clears the owner, so a wake during a rest
  keeps the run in line.
- `run_index.generation` counts claims and goes on the tenant row as `run.claim`. `updateRun` inside
  `drive` needs it: no row changed means another runner holds the run, and `drive` stops quietly.
- A person's write needs `run.rev` as they read it. The second of two answers gets `runBusy`.

## The clock

- Reaching a wait: the control copy of `wake_at` first, then the tenant row. A crash in between gives
  one harmless extra wake, never a lost one.
- Once a minute: every process that serves `runner` puts in line whatever came due. Several running
  it is harmless. Woken and not due, the run puts the time back from its own row and returns.
- On a wake the run holds credits again. Refused, it waits for them.
- `expiresAt` moves to the wake time plus `RESULT_TTL_DAYS`. A wait for a signal with no timeout counts
  as a year.
- An automatic step has a deadline, 8 hours and 12 for motion graphics (`RUNNER_STEP_DEADLINES`). Past
  it the step fails and its slot comes free.

## Signals

- `POST /api/public/signals/<token>` on the doors, no sign-in, `{ name, key, data?, delivery? }`. Its
  answer is `{ id, runs }` before any step runs. An HMAC in `x-wizards-signature` when the address has
  a secret, 422 when the data does not fit, 600 an hour per address.
- A token belongs to one wizard and matches only that wizard's runs. A signal from inside the space
  (plugin, MCP, mailbox, a run's end) reaches the space.
- A wait writes `run_wait` first, then looks for a signal since the run began. The intake writes the
  signal first, then wakes. That closes the race.
- The delivery key is unique per space, name and key. A webhook sent again or a mail pulled again is
  one signal, not two. Keys compare trimmed and in lower case.
- A signal's data stays under `.data`, so a sender can't set `came` or `timedOut`.
- `run.`, `mail.`, `message.` belong to the runtime. A run's end writes `run.done`, keyed by its id. A
  channel's message is the signal `message.received`, taken only by a wait for that name. A person's
  step takes it as the answer, never both.

## A mailbox as a source

`engine/mail-watch.ts` pulls from a stored cursor, once a minute, only while a run waits on that space's
mail and only for a connection that signs in as the space and that an admin switched on. One mail makes
two signals, by sender and by `thread:<id>`. Own mail and machine answers wake nothing. A sender whose
provider says SPF or DMARC failed loses the sender's signal, not the thread's.

A mail keeps its text only where a run waits on it as it is read. Everyone else's mail stays in the row
as headers, and a run that comes to one later reads its text from the mailbox (`withMailText`). Only reads
that found mail, and failures, leave an Audit line. The cursor is saved after the signals are sent, and
the message id as delivery key makes a crash in between harmless. Only Gmail has a stream.

## A durable agent step

`drive()` puts `state.turn = { stepId, id }` on the row, then runs the turn (`engine/durable-turn.ts`):

- the end kept in `run_effect` `<turn>:end`: use it, nothing runs
- `state.turn.answer` set: `resume`
- otherwise `recover`, and on no snapshot `stream`. `DURABLE_AGENT_RUN_ACTIVE` means the old lease; wait
  up to 25 s (it lapses in 15 s)

`ask_person` suspends the turn and writes `waiting_input`. The answer comes back on any runner. A cancel
stops the calls. A deploy's stop must not cancel. Costs book per model step. Tools stay closures over the
run and are rebuilt per process. Local tenant clients have an always-on write gate, because Mastra holds
a write transaction across awaits. A turn that acted and fails is not retried by itself, since a retry
gets new call ids. A person can still choose to try again.

`test/durable-turn.test.ts` runs on every Mastra upgrade. `browser` and `sandbox` stay out of durable
steps in v1.

## Outside actions once

Key: `<turn>:<toolCallId>`, or a visit counter for `call` steps. The wrap point is `brokerCall`
(`broker/effect.ts`), plus `http_request` other than GET. Found done: the stored result, no action. Found
started: it may have happened, so the model hears that and a person is told (`effect_unsure`). Never
repeated alone. `browser_*`, `run_command`, plugin tools, a GET and connectors inside `execute_typescript`
stay outside, and the authoring guide lists them.

## Retries

`engine/failures.ts` sorts errors, on the shapes the AI SDK and the gateways really throw. An unclear error
is final.

| Error | What happens |
|---|---|
| A provider's 429, 5xx, timeout, network | 3 tries, after 1, 5, 30 minutes or `Retry-After` up to 6 hours: `sleeping`, `state.pause = { kind: "retry" }`, count in `state.retries` |
| Out of credits | `sleeping`, `{ kind: "credits" }`, looks every 5 minutes. After 30 days `failed` |
| A sign-in ran out | The same, `{ kind: "sign_in", service }` |
| Anything else, or the step already acted | `onFail`, at most 3 times, or `failed` |

## Telling people

The `notice` row is written with the status change and is the outbox. A sender tick on a runner claims due
rows, then delivers: the bell (the row itself), the device, the mail. A crash can't lose one.

- A member's run: its member. A visitor's run: the device, and mail only at an `email` field with
  `notify`, because the address may be a customer's and the mail has a link that opens the run. A channel's
  run: its door says it. A team step: each person who may answer, by bell and mail.
- Nobody is told what they did themselves or while they look at the run. No mail to someone who saw the run
  in the last 10 minutes. A wait reached right after an answer tells nobody who just answered.
- `remind` is a notice due at its time, not a wake. A wait for credits or a sign-in writes one too.
- Mail goes through Manage's `/v1/run-mail`, with a long `runWaitTicket` in the link.
  `engenty-wizards-manage`, branch `feat/run-mail`, merges first.

## Where a person sees and answers

| Place | Shows |
|---|---|
| Work › Needs you | Runs waiting for me beside approvals and unread chats. Opens `/work/r/<id>`. Approvals use the chat's card |
| Work's sidebar | "Waiting for you", and "Waiting" for runs that need nobody now |
| The bell, mail, device | See above |
| The runner, for the run's own person | "Goes on {time}", or that the team has it, with "Withdraw" for a visitor |
| The runs panel | Log, label, "Continue now", "Stop", "Send test event" |

## Who may answer

`engine/answerers.ts`, `mayAnswerStep`. `accessibleRun` refuses every non-GET unless the route opts out, and
a test fails when a new write route is neither listed nor given another rule.

| `who` | Who may answer |
|---|---|
| `person` (default), `owner` | The run's person: its member, its visitor, whoever holds its link. A start's run has the start's owner as member |
| `team` | Those named under "Answered by" (`wizard.answerers`), or the admins. Never a visitor, a link or a client |
| any | Admins, the one person of a computer, and on a test run any non-client member |

- Back takes the right to answer both the step now and the step before.
- The first answer counts: 409 "Jonas answered this already". Reads stay open to whoever opens the run, but a
  visitor or link holder on someone else's step gets `answeredBy` and nothing of the step, then or later.
- Whoever edits the wizard names the answerers, through `PUT /wizards/:id/answerers`. In the cloud, publishing
  with a team step and nobody named is refused. A list emptied later still reaches the admins on running runs.
- Someone named may cancel. "Continue now" and "Stop" stay with admins and a test run's starter (`mayActOnWait`).
- A visitor may withdraw while the team has their run (`mayWithdraw`), and the log says so.

## Credits

A run holds on starting and again on each wake, and spends what steps cost. A step with `timeout` or `remind`
gives its hold back while it waits and holds again as it goes on. Refused, the answer stays and the run waits
for credits. Waiting costs nothing. Manage counts a hold for 24 hours, and reserving again replaces it.

## Retention

| Run | Kept until |
|---|---|
| Waiting with a wake time | That time plus `RESULT_TTL_DAYS` |
| Waiting for a signal with no timeout | A year plus `RESULT_TTL_DAYS` |
| Signals | 30 days |

## The run's log

`RUN_EVENT_TYPES` adds `run_started`, `wait` (with until when), `woken` (by what), `stopped` (by whom),
`resumed`, `effect_unsure`. The runs panel, `get_run` and a plugin's `subscribe` read the same rows.

## With fast-creation

`nextInBrowser` returns null when the next step is a `wait`, a page or review with `who` other than `person`,
or a step with a `timeout` or `remind`. `remindersOf` writes the reminder with the wait as the run reaches the
page, so the browser can't go to such a page alone. The server's state wins over what someone is still typing.

The rest is in `fast-creation.md` Part 4: the server shortcut in `answerGoesOn`, and `run.unsent` for what is
typed.

## PRs

| # | PR | State |
|---|---|---|
| 0 | Runner line: parallel takes, wakes that stay, fenced writes | merged, [#495](https://github.com/engenty/wizards/pull/495) |
| 1 | Wait steps and the clock | merged, [#496](https://github.com/engenty/wizards/pull/496) |
| 2 | Timeline, "Continue now", "Stop", label | merged together |
| 3 | Outside actions once | merged together, [#498](https://github.com/engenty/wizards/pull/498) closed |
| 4 | Durable agent steps | merged together |
| 5 | Signals | merged together |
| 6 | A mailbox wakes a run | merged together |
| 7 | Starts | merged together |
| 8 | Timeouts and reminders | merged together |
| 9 | Telling people, with Manage's `feat/run-mail` | merged together |
| 10 | Who may answer, runs in Needs you | merged together |
| 11 | Retries, `onFail` | merged together |
| 12 | Docs, and the PR that flips the switch | docs merged, the flip waits |

## Decisions

Decided by Matthias, 2026-10-31 to 2026-11-06:

| Question | Decision |
|---|---|
| Timeline buttons | Admins, and the starter of a test run |
| A mail's text | Headers for all, text only where a run waits on it; a later run reads it in the mailbox |
| A sender failing SPF or DMARC | Wakes no wait on that sender |
| Mail Audit lines | Only reads that found mail, and failures |
| Who names answerers | Whoever edits the wizard |
| A team step with nobody named | Publishing is refused |
| Test run with `who: "team"` | Any member may answer, cancel or retry; live runs stay narrow |
| `/cancel` by someone named | Allowed |
| A visitor while the team has their run | May withdraw |
| A notice for the next page right after an answer | None |
| A timed-out approval | `approved: false`, `timedOut: true` |
| `approve` with no branch on `approved` | A validator error |
| `passReviews` | Never approves |
| A `remind` on a first page | Goes out |
| An answer refused credits | Kept |
| Back over a timed-out page | Allowed |
| "Continue now" on a person's step | The same rule as the timeline buttons |
| Switch off | A new run ignores `timeout` and `remind` |
| Pause besides stop | None in v1 |
| Waiting runs on a new version | A run keeps the definition it started on |
| Parallel branches | No. One cursor |
| The longest wait | 31 days, 7 on Free. Not enforced yet, see below |

## Differs from the plan of 2026-10-30

Left out on purpose: `run.waiting` and `run.contact` (status and `state` carry it), `wizard.signals` (names are
free, and `wait.signal.fields` says what data must hold), `instructions` on a page, `who`, `credits` and `skills`
on an agent step, `estimateSegment` and holds per step (reserving again on a wake does it), an input hash for
`run_effect` (the call id replaces it), a memory thread for durable steps (`DurableAgent` replaces it), a Durable
Object per run (the sweep works the same on a local install, the VPS and the cloud).

## Before the switch flips

Not built:

- Limits per plan (Free: 10 waiting runs, 7 days, no signals; Pro: 1,000, 31 days). `wait.for` and
  `wait.signal.timeout` have no 31-day cap in the validator.
- The cloud taking signals for a linked local install while it is off.
- Studio controls for `onFail` and `notify`. Both exist only in the definition and the guide.
- `POST /v1/push` in Manage, and APNs or FCM there. Push has never arrived.
- Outlook and IMAP streams.

Must happen:

- The mobile app's copies learn `sleeping`, `question`, `pause`, `approve`, `decline`, the deadline line and the
  new event types.
- `RUNNER_MAX_RUNS=4` on the cloud. A release with it runs a week without new errors, which also gives real step
  lengths for the deadline.
- The `engenty/` copies PR 3 edits reach upstream, or `sync-engenty.mjs` overwrites them.
- A visitor who opens a mail's link on another device can't withdraw. Decide whether that stays.

Tested on the test environment `durable-runs-dsjk5` (2026-11-08, `pnpm testenv` of engenty-dev, no provider key):
the cloud's split roles (studio, doors and runner as three processes), PR 9's Manage part with the mail in Mailpit,
a team step, a wait, and a 25-minute wait across a deploy in place of the 2-day one: the run kept its wait and its wake time in the new containers.

Not tested together: real models on the cloud, a real mail, push, a real mailbox with real OAuth and a real
`Authentication-Results`, a real Manage-App role, Docker sandbox after a recovery, a signed call from a real
service, a real channel plugin.

Known and left: HMAC has no timestamp, so a signed call without a delivery key can be replayed. If a process crashes
between writing `run.done` and waking, a waiter with no timeout stays asleep. A hung step holds its slot until its
deadline.
