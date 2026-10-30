# Plan: wizards as durable agents with a person in the loop

Status: plan, nothing built. Written on 2026-10-30 against `feat/work-mode` (v0.13.x). Behind a
new switch `durableRuns`, off by default.

Scope: a wizard run that lasts hours or days. It follows its steps, branches and waits, survives
restarts of every process, and stops for a person where it needs one (approve, answer, take over),
then goes on. What this plan covers: the run's statuses, what the definition gains, where a person
sees and answers, who may answer, durability, the clock and incoming signals, credits per step,
retention, the run's timeline, the clock's design, the order of PRs.

Not in scope: how a run begins without a person (`starts.md`, phase 1 on `feat/starts`), how
pages move without waiting on the server (`fast-creation.md`), parallel branches (one cursor per
run stays), Engenties as chat members (`work-chats.md`, "After step 3").

## Why

A run today is a stepped form that runs once while someone watches. It cannot do what a campaign,
an onboarding or a complaint needs: "on day 1 send the offer; when the order is paid, thank them;
if nothing came after 3 days, send a reminder; when they complain, a person from the team
answers". The analysis of 2026-10-10 found six missing pieces. They still hold on `feat/work-mode`:

| # | Missing | Today |
|---|---|---|
| 1 | A timed wait | No status for it. `askPerson` (`engine/asks.ts`) waits at most 15 minutes, in a runner's memory |
| 2 | A wait for a signal | Nothing delivers an outside event to a running run |
| 3 | Starts without a person | `starts.md`; schedules built on `feat/starts`, not merged |
| 4 | Waiting runs kept | A live run gets `expiresAt` = start + `RESULT_TTL_DAYS` (7); `purgeExpiredRuns` deletes it whatever its status |
| 5 | Credits per step | `createRun` holds the whole run's estimate (`reserveForRun`) until the run ends |
| 6 | A step someone else answers | A page or review waits for the run's own person; only Work chats' approvals let an admin decide |

What already carries the weight:

- **State after every step.** `drive()` (`engine/runner.ts`) writes `state` and `cursor` after
  each step. A run whose runner dies goes back in line after 30 s and goes on from its cursor.
- **The line in the control database.** `run_index` holds `active`, `owner`, `seen`. `wakeRun`,
  `claimRun`, `restRun` move a run in and out of it; every runner polls it every 2 s
  (`runner-process.md`). A run that waits is not in the line and holds no slot.
- **Questions in the row.** `run.ask` and `run.answer` carry a question across processes.
- **The gate on the tool** (`work-chats.md`, PR #273). A tool with `risk: outside` stores its
  call in `chat_approval`. The asker or an admin approves, the stored call runs once, the result
  goes back to the AI.
- **Needs you** on Work's start page (`WorkHome.tsx`): pending approvals and unread chats. The
  bell counts approvals.
- **Decisions and loops** (`dynamic-flow.md`): `next` rules, `ask` branches through `decide()`,
  loop `max`, `each`.

## Rules

1. **The engine stays ours.** Wizards keep their own runner and line. Mastra is used inside
   agent steps (as today) and for an agent step's thread (below), not as the run engine. A
   wizard's flow is code-owned (`dynamic-flow.md`, rule 1); Mastra's workflows would be a
   second flow model next to the definition.
2. **One step per wake.** A runner takes a run, does steps until the run waits, then gives it
   back. Nothing waits in a process's memory longer than one step.
3. **The clock is outside the run.** A waiting run has a wake time in a column. One statement
   a minute wakes what is due. No timer in memory, no process that must stay up for a run.
4. **Signals are rows.** Whatever arrives is written first, then matched to the runs that wait
   for it. A signal that comes before its run waits is not lost.
5. **The live view reads the database.** The studio, Work and the runner show what the rows
   say (`watchRun`, the live feed), so it does not matter which process moved the run.
6. **Heavy steps stay workers.** The browser, the sandbox and media steps run in a runner as
   today. The tick and the signal intake need neither, so they can later move to an edge layer.
7. **Additive format.** Every addition to the definition is optional. `DEFINITION_VERSION`
   stays 2 (`definition-versions.md`).
8. **A person's step is never answered by the AI or by a signal.** A timeout can move the run
   past it, as the author wrote. Nobody's answer is invented.

## The run's statuses

| Status (code) | Status (UI, en / de) | Means | In the line | Wake time |
|---|---|---|---|---|
| `running` | running / läuft | A runner works on a step | yes | — |
| `waiting_input` | needs you, waiting for {name} / braucht dich, wartet auf {name} | A page, a review, an approval or a question waits for a person | no | the timeout, if any |
| `sleeping` (new) | waits until {time} / wartet bis {time} | A `wait` step for a time | no | the time |
| `waiting_signal` (new) | waits for {signal} / wartet auf {signal} | A `wait` step for a signal | no | the timeout, if any |
| `done` | done / fertig | The result is there | no | — |
| `failed` | failed / fehlgeschlagen | A step failed for good. Retry stays possible | no | — |
| `cancelled` | stopped / gestoppt | A person stopped it | no | — |

- The code keeps `cancelled`: renaming a stored value buys nothing. The UI says "stopped".
- "Sleeping" stays a code word. The UI says what happens: "waits until Tuesday 8:00".
- A run in `waiting_input` today waits for its own person. With `who` (below) it can wait for
  someone else. Which one is in the new column `run.waiting`.

### New columns

| Table | Column | Holds |
|---|---|---|
| `run` | `wake_at` (ms) | When the run wakes: the end of a `wait`, a timeout, a retry's next try. Null: nothing due |
| `run` | `waiting` (JSON) | What it waits on: `{ kind: "page" \| "review" \| "approval" \| "question" \| "time" \| "signal" \| "credits", stepId, who?, signal?: { name, key }, since, remindAt? }`. Null while running or finished |
| `run` | `contact` | The key a run is found by: an e-mail, a phone number, a row id. Set from the step that names it (`signal.key`), shown in lists |
| `run_index` (control) | `wake_at` | The same wake time, so one statement can sweep every tenant |

Status, `waiting` and `wake_at` are written in one update. The control copy of `wake_at` is
written next to `restRun`. When the two disagree, the tenant's row wins: a wake that finds the
run already moved on does nothing.

## What the definition gains

All optional. An existing wizard parses, validates and runs as before. Version stays 2.

### A `wait` step

```diff
 export const stepSchema = z.discriminatedUnion("type", [
   pageStepSchema,
   agentStepSchema,
   …
+  waitStepSchema,
 ]);

+const durationSchema = z.object({
+  minutes: z.number().int().min(0).optional(),
+  hours: z.number().int().min(0).optional(),
+  days: z.number().int().min(0).max(365).optional(),
+});
+
+export const waitStepSchema = z
+  .object({
+    ...stepBase,
+    type: z.literal("wait"),
+    /** Wait this long from the moment the run reaches the step. */
+    for: durationSchema.optional(),
+    /** Or until this time: a template that gives an ISO date ("{{steps.plan.sendAt}}"). */
+    until: z.string().optional(),
+    /** Or until this signal comes for this run. */
+    signal: z
+      .object({
+        /** One of the wizard's `signals`. */
+        name: z.string(),
+        /** Which run it is for: a template, e.g. "{{email}}". */
+        key: z.string(),
+      })
+      .optional(),
+    /** With `signal`: give up after this long. Then `steps.<id>.came` is false. */
+    timeout: durationSchema.optional(),
+    /** Shown in the runner and the run's timeline while it waits. */
+    working: z.string().optional(),
+  })
+  .refine((s) => [s.for, s.until, s.signal].filter(Boolean).length === 1, {
+    message: 'A wait step has one of "for", "until" or "signal".',
+  });
```

- The output of a `wait` step is JSON: `{ came: boolean, at, signal?: { name, at, data } }`.
  Rules read it as they read any agent step's output: `steps.<id>.came`,
  `steps.<id>.signal.data.amount`. Branching after a timeout is an ordinary `next` rule:

  ```json
  { "type": "wait", "id": "paid", "title": "Wait for the payment",
    "signal": { "name": "order.paid", "key": "{{email}}" }, "timeout": { "days": 3 },
    "next": [{ "when": { "field": "steps.paid.came", "op": "equals", "value": false }, "goto": "remind" }] }
  ```

- The least wait is one minute, the longest 365 days. A wait in a loop needs the loop's `max`
  (the validator already warns about loops; a loop with a wait becomes an error).
- A page right after a `wait` is shown when the run wakes, not before.

### Signals the wizard listens for

```diff
 export const wizardSchema = z.object({
   …
+  /**
+   * The outside events the wizard's `wait` steps listen for. Declared here so the validator
+   * checks every `wait.signal.name`, and the share dialog can show where to send them.
+   */
+  signals: z
+    .array(
+      z.object({
+        name: z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/),
+        /** What it means, in the wizard's language: "The order was paid." The UI shows this. */
+        description: z.string().min(1),
+        /** The data it brings: a shape as in `output.schema`. */
+        data: outputShapeSchema.optional(),
+      }),
+    )
+    .max(20)
+    .optional(),
 });
```

### A person's step: `who`, `timeout`, `remind`

Pages and reviews gain three properties. A page with `who` is the handoff: a question or a task
for someone other than the run's person. A review with `approve` is the approval.

```diff
+/** Who answers a page or review. Default "person": the run's own person, as today. */
+const whoSchema = z.enum(["person", "owner", "team"]);
+
+const personStep = {
+  who: whoSchema.optional(),
+  /** Give up waiting after this long; then `steps.<id>.timedOut` is true and `next` decides. */
+  timeout: durationSchema.optional(),
+  /** Remind whoever is asked after this long, once. */
+  remind: durationSchema.optional(),
+};

 export const pageStepSchema = z.object({
   ...stepBase,
+  ...personStep,
   type: z.literal("page"),
   …
+  /** For `who` other than the person: what they are asked to do, shown above the fields. */
+  instructions: z.string().optional(),
 });

 export const reviewStepSchema = z.object({
   ...stepBase,
+  ...personStep,
   type: z.literal("review"),
   show: z.array(z.string()).min(1),
   edit: z.boolean().optional(),
   regenerate: z.boolean().optional(),
+  /** Approve or decline instead of "Looks good": `steps.<id>.approved`, `steps.<id>.note`. */
+  approve: z.boolean().optional(),
 });
```

| The author wants | Written as |
|---|---|
| Wait until tomorrow 8:00 | `wait` with `until` |
| Wait 3 days | `wait` with `for` |
| Wait for the payment, at most 3 days | `wait` with `signal` and `timeout` |
| A manager approves the offer | `review` with `approve`, `who: "team"` |
| Someone from the team answers the complaint | `page` with `who: "team"`, `instructions`, a text field |
| The owner fills in what the start could not | `page` with `who: "owner"` (what `starts.md` does by rule today) |
| The customer confirms, else go on after 2 days | `page` with `timeout`, a `next` rule on `timedOut` |

- `who` names a role, never a person. People are this install's: the share dialog names them on
  the wizard row (`wizard.answerers`, below), as `starts.md` keeps starts off the definition.
- `timedOut` and `approved` are read by `next` rules like any output. With no rule, a timed-out
  step goes to the next step in the list, and its fields stay empty.
- Take over in a chat runner (a person writes to the customer in the wizard's place) is a page
  with `who: "team"` whose answer the chat shows as the wizard's message. The runner part of it
  is an open question.

### Agent steps that last

```diff
 export const agentStepSchema = z.object({
   …
+  /** The space's skills this step loads, by name; default: the space's own modes. */
+  skills: z.array(z.string()).max(12).optional(),
+  /**
+   * The step may stop to ask a person (`ask_person`) and its outside tools wait for approval.
+   * Its conversation is kept, so it goes on where it stopped, after a restart too.
+   */
+  durable: z.boolean().optional(),
+  /** Who answers its questions and approvals; default "person". */
+  who: whoSchema.optional(),
+  /** At most this many credits for the step; then it stops and asks the owner. */
+  credits: z.number().int().min(1).optional(),
 });
```

- `skills` is the per-step choice `skills.md` left for later. It adds no version.
- A `durable` step runs its Mastra agent with a memory thread per run and step
  (`run:<runId>:<stepId>`), stored as Work chats store theirs. A tool call that waits (a
  question, an approval) ends the step's turn. The run goes `waiting_input` with
  `waiting.kind = "question" | "approval"`. The answer goes back into the thread and the step's
  next turn starts from it, on whichever runner takes the run.
- Approvals use the gate of Work chats. `chat_approval` becomes `approval` with `chat_id` or
  `run_id` + `step_id` (Work is behind `workMode` and unreleased, so the table changes outright).
- A step without `durable` works as today: one turn, `maxSteps` 20 or 60, the 15-minute ask.

### Failure and retries

```diff
 const stepBase = {
   id,
   title: z.string().min(1),
   description: z.string().optional(),
   next: z.array(nextRuleSchema).optional(),
+  /** Where the run goes when the step fails for good; default: the run fails. */
+  onFail: z.string().optional(),
 };
```

Retries need no property. The runtime retries what is worth retrying (below); `onFail` decides
what happens after.

### The validator

| Check | Issue |
|---|---|
| `wait` has exactly one of `for`, `until`, `signal` | error |
| `wait.signal.name` is one of `signals` | error |
| `timeout`, `remind`, `for` between 1 minute and 365 days; `remind` shorter than `timeout` | error |
| A loop through a `wait` without `max` | error |
| `onFail` names a step | error |
| `who: "team"` on a wizard whose share settings name no one | warning at publish: "Nobody is set to answer “{step}”." |
| `durable` on a step without tools that wait | warning |

`apps/docs/public/schema/v2/wizard.json` is generated again. The authoring guide gets the new
steps and one rule: "A flow that spans days uses `wait` steps, never an agent step that loops
and checks the time."

## Where a person sees and answers

| Place | Shows | Answers |
|---|---|---|
| Work › Needs you (`WorkHome.tsx`) | Runs waiting for me next to the approvals and unread chats: the wizard, the step, the contact, since when, until when | Opens the run's page or review in Work (`/work/r/<runId>`, the runner inside Work). Approvals of a `durable` step use the same card as chat approvals |
| Work's sidebar | "Waiting for you" (`work.waiting`) lists the same | the same |
| The bell | One count: approvals, runs waiting for me, finished and failed started runs (the `notice` table of `feat/starts`) | links to the run |
| E-mail | "{wizard} needs you: {step}" with one button, "Open". Sent once when the run starts waiting for someone who has not seen it in 10 minutes, and once more at `remind` | the link opens the run |
| Push | the installed studio and the mobile app (`engine/push.ts` gains owner and team targets next to the visitor's device) | the same link |
| The runner, for the run's own person | while the run waits for someone else: "{name} from the team looks at it. You get an e-mail when it goes on." While it waits for a time: "Goes on {time}." | nothing to answer |
| The studio's runs panel | the timeline (below) and the actions "Go on now", "Stop", "Retry", "Send a test signal" | |

- A visitor who left an e-mail on a page gets the run's link by e-mail when the run reaches a page
  for them again ("Weitermachen" on wizards.page, `starts.md`). The mail goes out through the
  account (the cloud's mail). Through the space's own mailbox is an open question.
- A run on a channel (WhatsApp, SMS, the chat runner) asks its person in that channel, as today.
  The person's next message there is the answer.

## Who may answer

| `who` | Who may answer | Who sees it in Needs you |
|---|---|---|
| `person` (default) | The run's person: its `userId`, its `visitorId`, or whoever holds the run's link (as today) | the person, if signed in |
| `owner` | The run's owner: the one who started it, or for a started run the start's owner | the owner |
| `team` | The people named in the share dialog under "Answered by" (`wizard.answerers`: user ids, or "admins") | each of them |
| any | Admins of the organization, always (as for approvals) | only in the space's list, not in their own Needs you |

- The first answer counts. The page's submit already checks the cursor (`requireWaiting`). A
  second person gets "Anna answered this already" and the run as it is now.
- Each answer records who gave it (`run_event`, below). The run's result shows it.
- `wizard.answerers` is this install's data, like `wizard.starts`. A `.wizard` file carries the
  role, never the people.
- A person who may answer may also stop the run. Only the owner and admins may "Go on now" past
  a wait.
- Members-only answering on wizards.page (`starts.md`, "On wizards.page") uses the same rule:
  the link goes there once members-only spaces exist, until then into Work.

## Durability

### What is kept per step

| What | Where | Already |
|---|---|---|
| Answers, outputs, cursor, decisions, loops | `run.state`, `run.cursor` | yes |
| What the run waits on and until when | `run.status`, `run.waiting`, `run.wake_at`, `run_index.wake_at` | new |
| A durable agent step's conversation | its Mastra thread | new |
| Outside actions done | `run_effect` (new): `(run_id, step_id, attempt, call, input_hash, state: started \| done \| failed, output)` | new |
| Signals received | `run_signal` (new, below) | new |

### After a restart

- A runner that stops hands its runs back (`disownRuns`); one that dies loses them after 30 s.
  Either way the next runner starts the step from the top. That is how it works today.
- Waiting runs are not in anyone's hands. They wait in rows. Nothing is lost when every
  process is down. When the tick runs again, it wakes everything that came due meanwhile, once.
- A local install that was off overnight wakes what came due at its next start. Signals sent to
  it while it was off are not there (open question: the cloud as relay).

### Steps that run twice

A step started again must not do its outside work twice: the mail sent, the order placed.

- Every tool with `risk: outside` (and every connector action that writes) goes through
  `run_effect`. Before it acts, it writes `started` with the input's hash. After, `done` with the
  output.
- On a second attempt of the same step, the same call with the same input finds `done` and gets
  the stored output without acting.
- A call that finds `started` without `done` did not report back: it may have happened. The
  run asks the owner ("Did the mail to anna@… go out?") as an approval, never redoes it alone.
- A service that takes an idempotency key gets the effect's id (mail through Resend, payment
  providers).
- Steps without outside effects (models, reading) simply run again. What they cost the first
  time is booked; that is the price of a crash.

### Retries

| Error | Retried | How |
|---|---|---|
| A provider's 429, 5xx, timeout, network | 3 times, after 1, 5, 30 minutes | the run goes `sleeping` with `wake_at`; no retry loop in memory |
| A model refusal, a content rule, invalid output after its own retry | no | `onFail` or `failed` |
| Out of credits | no | `waiting_input` with `waiting.kind = "credits"`; the owner tops up and it goes on |
| A connection that needs signing in again | no | `waiting_input` for the connection's owner |

`retry(runId)` (exists) starts the failed step again by hand.

## The clock and incoming signals

### The tick

Every process that serves `runner` (and `all` on a local install) runs once a minute:

```sql
UPDATE run_index SET active = 1, owner = NULL, seen = NULL
WHERE active = 0 AND wake_at IS NOT NULL AND wake_at <= :now
```

That is the whole clock. The line does the rest: a runner claims the run, `drive()` loads it,
sees `sleeping` or `waiting_*` with `wake_at` passed, moves it to `running` in one conditional
update (`… WHERE status = 'sleeping' AND wake_at <= :now`, so two runners cannot both wake it),
writes the `wait` step's output (`came: false`) or `timedOut: true`, and goes on. A `remind`
due wakes the run only to send the reminder and puts it back.

Several runners running the statement at once is harmless. The health check (`health.ts`) reports
the last tick. A due run more than 5 minutes late is a health warning.

### Signals

```text
POST /api/public/signals/<token>      (doors, no sign-in)
{ "name": "order.paid", "key": "anna@example.com", "data": { "amount": 129 } }
→ 202 { "id": "sig_…", "runs": 1 }
```

| Piece | Does |
|---|---|
| `run_signal` (tenant DB) | `id, space_id, wizard_id?, name, key, data, at, source`. Kept 30 days |
| `run_wait` (tenant DB) | `run_id, step_id, name, key, since`: one row per run waiting for a signal; an index on `(name, key)` |
| The intake | writes the signal, finds `run_wait` rows with the same name and key in the space, writes the signal's id into each run's `waiting`, and wakes them. Answers before any step runs |
| A run reaching a `wait` | first looks for a signal with its name and key that came since the run started and that it has not taken. Found: the step is done at once. Else it writes `run_wait` and goes `waiting_signal` |
| The token | one per wizard, made in the share dialog ("Signals"), shown once, kept as a hash (like the starts webhook). An optional secret signs the body (`X-Signature`, HMAC) |

Sources besides the address, all writing the same row:

| Source | How |
|---|---|
| A plugin | `server.signals.send({ name, key, data })` in the plugin SDK (`packages/wizards/src/plugin`). Contacts, shop and appointments send their events this way |
| A channel | an inbound message on WhatsApp or SMS is the signal `message` with the sender's number as key |
| A table row | starts phase 2's `record.changed` sends `row.added` / `row.changed` with the row id as key |
| Another run | `run.done` sends `wizard.done` with the run's `contact` as key |
| MCP and the assistant | a tool `send_signal`, for tests and for AI clients |
| The studio | "Send a test signal" in the runs panel |

- A signal moves runs that wait. A start begins new runs (`starts.md`). One event may do both:
  the intake writes the signal, the starts watcher reads the same row.
- One signal reaches every run that waits for it: a contact in two campaigns hears the payment
  in both. Each run takes a signal once.
- A signal no run waits for stays 30 days. A run that reaches its `wait` later takes it, so
  "the payment came before the reminder step" works.

## Credits per step

Today `createRun` holds the whole estimate and `syncRunCost` books each step. For a run of days,
the hold blocks credits for days, and a run admitted on Monday may find nothing left on Friday.

| When | What is held | What happens without enough |
|---|---|---|
| The run starts | the estimate up to the first step that waits (page, review, `wait`), at least 1 credit | refused, as today (`NoCreditsError`) |
| The run wakes or a person answers | the estimate up to the next step that waits | the run goes `waiting_input`, `waiting.kind = "credits"`, the owner is told: "{wizard} stopped: the credits ran out. It goes on when you add credits." |
| Each step ends | the hold is released, the real cost booked (as today) | |
| A `durable` agent step | its `credits` limit, or the class's estimate × 3 per turn | it stops and asks the owner to allow more |
| Waiting | nothing | |

- The hold is keyed by run and step attempt instead of by run. The account's hold API needs a
  step key next to the run id: a change in the closed admin app, plain in shape.
- `estimate.ts` gains `estimateSegment(def, from)`: the steps from `from` to the next waiting step
  on every branch, the dearest branch counted.
- Local install without credits: nothing changes, as `canSpend()` returns true.

## Retention

| Run | Kept until |
|---|---|
| Finished (`done`, `failed`, `cancelled`) | `RESULT_TTL_DAYS` after it finished (today: after its start) |
| `sleeping`, `waiting_signal` | `RESULT_TTL_DAYS` after its `wake_at` (the timeout); a signal wait without timeout: 365 days after it began |
| `waiting_input` for someone other than the person | `RESULT_TTL_DAYS` after its timeout, else 365 days |
| `waiting_input` for the person (a visitor left a page) | `RESULT_TTL_DAYS` after its last change (today: after its start) |
| Signals | 30 days |
| A test run | as today |

`expiresAt` is set again whenever status or `wake_at` changes. `purgeExpiredRuns` stays as it is.
A run past its expiry while waiting is stopped and its owner told before it goes.

## The run's timeline

`run_event` already holds `step_started`, `step_done`, `tool`, `info`, `error`. It gains:

| Type | Message and data |
|---|---|
| `waiting` | for whom or what, until when |
| `woke` | by what: the time, a signal, an answer, a timeout, "Go on now" by {name} |
| `signal` | name, key, source; matched or kept |
| `answered` | by whom, which step |
| `approval` | asked, approved or declined, by whom |
| `effect` | an outside action done, its effect id |
| `retry` | which try, when the next |
| `credits` | held and booked for a step |

- The studio's runs panel shows a run as a timeline: steps, the gaps of waiting ("waited 2 days
  for the payment"), who answered. Work's run view shows the same, shorter.
- `get_run` (MCP) and the admin app's `debug_run` read the same events.
- The runs panel filters by status. Its count per wizard says how many wait and for what.

## The clock: a minute sweep or a Durable Object per run

| | Minute sweep in the control database | A Durable Object per run (Cloudflare) |
|---|---|---|
| What it is | one `UPDATE` a minute in each runner | an object per run with an alarm at `wake_at`; it calls the runtime when it fires |
| Change to the code | `run_index.wake_at` and a timer next to `startRunner` | a new service at the edge, a second place where a run's waiting state lives, an authenticated call into each runtime |
| Local install | works as is | does not exist there: the sweep would be needed anyway |
| Our VPS and Coolify | works as is | a second platform to run, pay and watch |
| Precision | up to a minute late | to the second |
| Signals while the runtime is down | lost until it is up (the cloud's doors are up separately) | the object can take them and hold them |
| Scale | one indexed query a minute; fine for a long way at our size | per run, without limit |

**Recommendation: the minute sweep.** It is the smallest change, it works the same on a local
install, the VPS and the cloud, and it keeps one place for a run's state. The rules above (one
step per wake, the clock outside, signals as rows, the live view from the database) keep a later
move open: the intake and the tick can run at an edge layer that writes the same rows, without
changing the engine. That move is worth it only when signals must be taken while the runtime is
down, or when waits shorter than a minute matter.

## With the fast-creation plan

`fast-creation.md` lets the browser move from page to page and keeps the server as the record.
Here the server owns every wait.

- `nextInBrowser` returns null when the next step is a `wait`, a page or review with `who` other
  than `person`, or any step with a `timeout`. The runner then waits on the server, as it does
  for an AI step.
- `RunState.typed` keeps what someone types on a team page too: Anna starts an answer on her
  phone and finishes it on her computer.
- A page that times out while the person is typing: the server's state wins, the runner loads the
  run again and shows where it is now. What was typed stays in `typed` and the timeline.

## Words

- The UI never says "workflow", "trigger" or "signal" alone. A wizard has steps. A wait for a
  signal shows the signal's `description`: "waits until the order is paid".
- "Sleeping" is a code word only. The UI says "waits until {time}" / „wartet bis {time}“.
- "Needs you" / „Braucht dich“ and "Waiting for you" / „Wartet auf dich“ as Work has them.
- A stopped run: "stopped" / „gestoppt“.

## Order of PRs

Each PR behind `durableRuns` (`packages/shared/src/feature-flags.ts`), into `feat/work-mode` or
its successor. Each one is usable and tested on its own.

| # | PR | Holds | Needs |
|---|---|---|---|
| 1 | `feat(runtime): wait steps and the minute tick` | `waitStepSchema` with `for` and `until`; `sleeping`; `run.wake_at`, `run.waiting`, `run_index.wake_at`; the tick; `drive()` waking; retention per status; the runner's "Goes on {time}"; the diagram's wait node | — |
| 2 | `feat(studio): a run's timeline` | the new `run_event` types; the runs panel timeline; "Go on now", "Stop" | 1 |
| 3 | `feat(runtime): signals` | `signals` on the wizard; `wait.signal` and `timeout`; `waiting_signal`; `run_signal`, `run_wait`; the public route and its token in the share dialog; `send_signal` (MCP); "Send a test signal" | 1 |
| 4 | `feat(runtime): timeouts and approvals on person steps` | `timeout`, `remind`, `timedOut` on pages and reviews; `approve` on reviews; `onFail` | 1 |
| 5 | `feat(work): runs waiting for you in Needs you` | `who`; `wizard.answerers` and "Answered by" in the share dialog; who may answer; runs in Needs you and the sidebar; the run inside Work | 4 |
| 6 | `feat(runtime): tell people a run waits for them` | e-mail and push to owner and team; the bell's one count | 5, the `notice` table from `feat/starts` (merged first or taken over) |
| 7 | `feat(runtime): credits held per step` | `estimateSegment`; the hold per step; `waiting.kind = "credits"`; the admin app's step key | 1, the closed admin app |
| 8 | `feat(runtime): outside actions run once, retries over time` | `run_effect`; the effect check in the tool gate and connector writes; retries as `sleeping` | 1 |
| 9 | `feat(runtime): durable agent steps` | `durable`, `who`, `credits`, `skills` on agent steps; the thread per step; `ask_person`; `chat_approval` → `approval` | 5, 8 |
| 10 | `feat(runtime): signals from plugins, channels, tables and runs` | `server.signals.send`; channel messages; `record.changed`; `wizard.done` | 3; starts phase 2 for tables |
| 11 | `docs: long-running wizards` and the architect | the authoring guide, the architect's prompt and tools, `steps.md`, `test-and-share.md`, the plugin docs; the switch flips in a release | all |

Tests in `apps/runtime/test/durable.test.ts`: a wait across a restart (the process stops, a new one
wakes the run once); two runners waking the same run; a signal before the wait and one after; a
timeout branch; a team page answered by two people at once; a step with an outside effect run
twice; a run out of credits after a wake, then topped up; retention of a run that waits 30 days.

## Changes by file

| File | Change |
|---|---|
| `packages/shared/src/definition.ts` | `waitStepSchema`, `durationSchema`, `signals`, `who`/`timeout`/`remind`/`instructions` on pages, `approve` on reviews, `durable`/`who`/`credits`/`skills` on agent steps, `onFail`; validator cases |
| `packages/shared/src/run.ts` | `RunStatus` gains `sleeping`, `waiting_signal`; `RunWaiting`; `RunView.waiting` |
| `packages/shared/src/feature-flags.ts` | `durableRuns` |
| `apps/runtime/src/db/schema.ts`, migrations | `run.wake_at`, `run.waiting`, `run.contact`; `run_signal`, `run_wait`, `run_effect`; `chat_approval` → `approval`; `run_event` types; `wizard.answerers`; control `run_index.wake_at` |
| `apps/runtime/src/tenants/control.ts` | `sleepRun(runId, wakeAt)`, `wakeDue()` |
| `apps/runtime/src/engine/runner.ts` | the `wait` step; waking in `drive()`; timeouts; `who`; holds per segment; retries as sleeping; `onFail` |
| `apps/runtime/src/engine/signals.ts` (new) | intake, matching, taking a signal at a `wait` |
| `apps/runtime/src/engine/effects.ts` (new) | `run_effect` around outside tools and connector writes |
| `apps/runtime/src/engine/steps.ts` | durable agent steps: thread, `ask_person`, the gate, `credits`, `skills` |
| `apps/runtime/src/credits/credits.ts`, `estimate.ts` | holds per step, `estimateSegment` |
| `apps/runtime/src/routes/signals.ts` (new), `app.ts` | the public route (doors) |
| `apps/runtime/src/services/work-chats.ts`, `routes/work.ts` | approvals from runs; runs waiting for a person |
| `apps/runtime/src/engine/push.ts`, `notices.ts` | owner and team targets; mail |
| `apps/runtime/src/services/runs.ts` | `expiresAt` per status |
| `apps/runtime/src/mcp/tools.ts` | `send_signal`; `get_run` with `waiting` and the timeline |
| `packages/wizards/src/plugin` | `server.signals.send` |
| `apps/web/src/studio/work/WorkHome.tsx`, `ChatSidebar.tsx` | runs in Needs you and Waiting for you; the run inside Work |
| `apps/web/src/studio/editor/RunsPanel.tsx`, `FlowDiagram.tsx`, `ShareDialog.tsx` | timeline and actions; wait nodes and timeout edges; "Answered by", "Signals" |
| `packages/runner` | "Goes on {time}", "{name} looks at it", team pages with `instructions` |
| `apps/runtime/src/authoring/guide.ts` | the new steps and the rule against looping agent steps |

## Open questions

1. **Pause.** Should the owner be able to pause a waiting run (its wake time stops) besides
   stopping it? Not in this plan.
2. **New versions.** A run keeps the definition it started on (as today). Should a waiting run
   be moved to a newly published version, for long campaigns? Not in v1. The owner stops it and
   starts it again.
3. **A local install that is off.** Waits catch up at the next start, but signals sent while it
   was off are lost. Does the cloud take signals for a linked local install and hand them over
   (the relay `starts.md` mentions for webhooks)?
4. **Plans.** How many waiting runs, and how long a wait, per plan? The data does not care.
5. **The price of waiting.** Waiting costs no credits here. Should a run that waits for months
   cost something for being kept?
6. **Parallel branches.** One cursor stays. `timeout` and `remind` cover "remind while waiting".
   Is there a real case for two things happening at once in one run?
7. **The word for a signal** in the UI where no description fits (the share dialog's section
   name): "Events" / „Ereignisse“?
8. **Take over in a chat runner.** A team member writing to the customer as the wizard: part of
   PR 5, or later with Engenties?
9. **Who the team is.** A list per wizard ("Answered by"), or the space's members, or the
   sections of Work?
10. **Mail to a visitor.** From engenty's address through the account, or from the space's
    connected mailbox, so the customer gets mail from the business itself?
11. **The longest wait.** 365 days, or shorter until a real case asks for it?
