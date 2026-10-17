# Plan: triggers — a wizard that starts by itself

Status: plan, nothing built. From the comparison with Attio Workflows of 2026-10-10.

Scope: ways a published wizard starts without a person opening its link — on a schedule, when
something arrives at an address, when a mail comes in, when data changes, when another wizard
finished — and what a run started that way does with its pages. Owners, the inbox of waiting
runs, batch decisions and deadlines are a plan of their own (`hitl-at-scale`); this plan only
says where a triggered run hands over to it.

## What there is today

| Thing | How | Limit |
|---|---|---|
| Start by link | `POST /api/public/wizards/:token/runs` (`apps/runtime/src/routes/runs.ts`), the link's settings "on · 50 a day" in the share dialog | a person in a browser |
| Start from an AI client | `run_wizard` over MCP → `startRun(userId, wizardId, answers)` (`services/runs.ts`): answers pre-fill fields | a person at the client |
| Start from a plugin | the plugin run API on `claude/wizards-vs-bot-ui-1044fe` | the plugin has to know the wizard |
| Something arrived | plugin public routes `/api/public/plugins/<id>/<ref>/…` (`docs/content/dev/plugins/routes.md`) | a plugin is needed for every address |
| Something changed | plugin events `run.<status>`, `space.*`, `space.file.ready` (`apps/runtime/src/plugins/events.ts`) | plugins hear them; a wizard does not |
| Fields with a value | `prefill` from an earlier step | nothing from outside the run |
| Runs while the computer is off | the cloud runs the published version on the account's credits | the local install needs "start at login" |

## The idea in one line

A trigger is one more **way to start** in the share dialog, next to "Link": one sentence you can
read, written by hand or by telling the assistant, with a "Run now" to try it. What arrives
fills the first page; what is still missing, a person answers later.

## The six ways

| Way | The sentence in the share dialog | What fills the pages |
|---|---|---|
| Schedule | "Every weekday at 08:00" | nothing; the wizard starts with its own knowledge: lists, pages, connections |
| Address | "When something is sent to …/start/ab12" · Copy · Secret | the body: JSON, a form or a file |
| Mail | "When a mail arrives at ab12@in.engenty.ai" (cloud) · "…in the inbox *Rechnungen*" (a connection, polled) | the mail as a saved mail, its attachments as files |
| Data | "When a row is added to the list *Leads*" · "When a contact changes" · "When a file lands in *Eingang*" | the row, the contact, the file |
| Wizard | "When *Lead-Check* finished with *score = high*" | that run's values and outputs |
| Client | exists: MCP `run_wizard`, the plugin run API | answers |

Every way has the same three settings, shown as the link's are, in one line that folds out:
**on/off**, **runs as** (the owner: whose connections, keys and inbox), **at most N a day**.

### Filling the first page

The trigger does not map fields. The runtime takes what arrived and the first page's schema
and asks the classifier class once (`decide()` of the dynamic-flow plan) for structured output
into the page's fields; a row or a form whose keys already match the field ids skips the call.
Then:

- every field of the page filled and no condition open → the page is skipped, the run goes on;
- a required field empty → the run stops in `waiting_input` on that page, with the arrived
  data as prefill, and goes to the owner's inbox (`hitl-at-scale`);
- an AI step that wants a person (allow, sign-in, review) → the same.

A wizard whose first step is an AI step needs no page at all: the arrived data lands as
`steps.trigger` (text, a table or files) for the step to read.

"Run now" in the share dialog starts a test run with a sample: the schedule with nothing, the
address with a JSON you paste or the last body it received, the mail with a saved mail from the
space, data with the newest row. The runner opens as for any test run, so you see what was
filled and where it stopped.

## Model

```ts
// packages/shared/src/definition.ts — not part of the definition: triggers live with the
// sharing settings, so a new version does not change them and the draft has none.
type Trigger = {
  id: string;
  wizardId: string;
  kind: "schedule" | "address" | "mail" | "data" | "wizard";
  sentence: string;            // what the dialog shows, in the owner's language
  config:
    | { kind: "schedule"; cron: string; tz: string }
    | { kind: "address"; tokenHash: string; secretHash?: string }
    | { kind: "mail"; address?: string; connectionId?: string; folder?: string }
    | { kind: "data"; source: "list" | "contact" | "file" | "connector"; name: string; on: "added" | "changed" }
    | { kind: "wizard"; wizardId: string; when?: { field: string; op: string; value: unknown } };
  ownerId: string;             // runs as; connections and inbox of this person
  enabled: boolean;
  perDay: number;              // 50 unless changed, as the link
  lastRunAt?: string; lastStatus?: "completed" | "failed" | "waiting" | "refused";
  failures: number;            // in a row; at 5 the trigger pauses and tells the owner
};
```

A triggered run is an ordinary run with `startedBy: { trigger: id, payload }` in `RunState`,
so the run report says what started it and the inbox can group by trigger.

## Where each way runs

| Way | Local install | Cloud (engenty.ai) | Own server |
|---|---|---|---|
| Schedule | while the runtime runs ("start at login"); a missed time runs once at the next start, not for every missed slot | yes | yes |
| Address, mail by address | only with a public https address (`server.md`); the share dialog says so | yes, `in.engenty.ai` | yes |
| Mail by connection (polled) | yes, every 5 minutes | yes | yes |
| Data: list, file, wizard | yes | yes, for data that lives there | yes |
| Data: contact | where the `contacts` plugin runs | yes | yes |
| Data: connector | polling through the connector's actions, every 15 minutes; a webhook where the service has one | yes | yes |

Triggers go to the cloud with the sharing settings (`test-and-share.md`, "Goes to the cloud").
A schedule set on a local install and published to the cloud runs in **one** place: the share
dialog asks "Here or in the cloud?" once and shows it in the sentence.

## Writing a trigger

Three ways, all ending in the same `Trigger` row:

1. **Share dialog → "Also starts …" → pick a way.** A schedule shows a sentence field: "every
   Monday at 9", "daily at 7:30", "1st of the month" — the assistant turns it into `cron` + `tz`
   and shows the next three times. An address shows the address and "Copy". Mail, data and
   wizard show a select of what the space has.
2. **The assistant.** "Start this every weekday at 8 as me" / "Let the webshop start it when an
   order comes in" — the architect writes the trigger and the share dialog shows it.
3. **A plugin.** `server.registerTrigger` (plugin SDK) adds a way of its own, for example the
   shop plugin's "when an order comes in", with its own sentence and its own source of events.
   The plugin raises `server.fireTrigger(id, payload)`.

## Guards

- A trigger is bound to the published version; "Unpublished changes" does not change it.
- `perDay` counts as the link's limit; the 51st start of a day is refused and counted, not
  queued. The owner's inbox says "refused 12 today".
- Address and mail: the token is a secret in the address; an optional second secret signs the
  body (`X-Signature`, HMAC); only hashes are kept. 4 MB body as plugin routes.
- A trigger whose runs fail five times in a row pauses; the owner gets the push / mail of the
  inbox plan. "Run now" un-pauses after a good run.
- Deleting the owner or the wizard deletes its triggers; "Create a new link" does not.
- Data triggers never fire for rows a run of the same wizard wrote (no loop).

## Releases

| | Holds | Touches |
|---|---|---|
| 1 | `Trigger` table and service, share dialog section, **schedule** and **address**, filling the first page, `startedBy` in run state, "Run now", `perDay`, pause after failures | `packages/shared/src/run.ts`, `apps/runtime/src/db`, `services/triggers.ts`, `routes/public.ts` (`/start/:token`), `apps/web/src/studio/share/*`, `test-and-share.md` |
| 2 | **mail** (cloud address in manage, polled connection locally), **data** for lists and space files, **wizard** on `run.completed` | `apps/runtime/src/plugins/events.ts` → trigger bus, manage `/v1/mail/in`, `connectors` |
| 3 | the assistant writes triggers; plugin SDK `registerTrigger` / `fireTrigger`; `contacts` and `shop` plugins register theirs; connector polling | `services/architect.ts`, `packages/plugin-sdk`, the closed plugins |
| 4 | handover to `hitl-at-scale`: owner's inbox lists triggered runs waiting, deadlines on a wait | that plan |

## Open

- Whether a schedule on a local install with the published version also in the cloud should
  run in both places by choice (today: one place).
- `in.engenty.ai` mail: Resend inbound on `mail.engenty.ai` or a mailbox in the Workspace.
- Connector webhooks need a public address per install; the cloud can relay to a local install
  only when it is reachable — probably polling only, locally.
