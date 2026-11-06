---
title: Runs that last days
description: Wait steps and signals, who answers a page or review, timeouts and approvals, durable AI steps, onFail and a run's label.
version: 0.16.2
---

A run can wait for hours or days. Nothing runs meanwhile, it spends no credits, and it survives a
restart of every process. The keys on this page are all optional, so the format stays at version 2.

They come with the switch `durableRuns`, which is off by default. With it off, a wizard with a
`wait` step doesn’t start. On your computer you switch it on with a line in
`~/.engenty/wizards/.features`:

```bash
durableRuns=on
```

## A wait step

```json
{
  "id": "reply", "type": "wait", "title": "Wait for the reply",
  "signal": { "name": "mail.received", "key": "thread:{{steps.send.thread_id}}", "timeout": "3d" },
  "next": [{ "when": { "field": "steps.reply.timedOut", "op": "equals", "value": true }, "goto": "remind" }]
}
```

A `wait` has exactly one of these:

| Key | Waits |
|---|---|
| `for` | This long from the moment the run gets here: `"90m"`, `"6h"`, `"2d"` |
| `until` | Until a date: an ISO date or a [template](./templates.md) such as `"{{deadline}}"`. A date gone by waits for nothing. Text that is no date fails the run |
| `signal` | Until something arrives from outside. See [Signals](#signals) |

What a wait hands on, for `next` rules and templates:

| After | Output |
|---|---|
| `for`, `until` | `steps.<id>.waited` |
| `signal` | `steps.<id>.came`, `steps.<id>.timedOut`, `steps.<id>.data.<field>` |

A signal’s data stays under `data`, so a sender can’t set `came` or `timedOut`.

## Signals

`signal` has these keys:

| Key | What it does |
|---|---|
| `name` | What the signal is called, such as `"invoice.paid"` |
| `key` | Which signal is for this run, a template such as `"{{email}}"`. Keys compare without case |
| `timeout` | Give up after this long. Then `steps.<id>.timedOut` is true and the run goes on |
| `fields` | What its data must hold. A signal without them ends nothing, and only these fields reach the run |

A signal is written first and matched after, so the sender has its answer before any step runs.

- A signal that came after the run began and before it got to the wait counts, for 30 days.
- One signal reaches every run that waits for it. Each run takes a signal once.
- A wait without `timeout` is kept for about a year, then it goes with the run.

### Names the runtime writes

Nobody can send a name that starts with `run.`, `mail.` or `message.`. A wait can listen to these:

| Name | `key` | Data |
|---|---|---|
| `mail.received` | The sender’s address, or `thread:<id>` for a reply to a mail an earlier step sent | `from`, `name`, `subject`, `text`, `thread`, `message`, `at` |
| `message.received` | `person`: what the person writes on a channel while the run waits | `text` |
| `run.done` | The other run’s id | `status`, `wizardId` |

One mail makes two signals, by sender and by thread. A mail reaches a run only when:

- the connection signs in as the space, and an admin switched the mailbox on in the share dialog
  under **Events**;
- the mailbox didn’t send it itself and no machine wrote it. A sender who fails SPF or DMARC checks
  wakes no wait on that sender, though a wait on the thread still hears it.

A mailbox is read once a minute, only while a run waits on that space’s mail. Only Gmail can be read
so far.

### Sending a signal

The share dialog’s **Events** makes the wizard’s address, with a secret if you ask for one. Both are
shown once.

```bash
curl -X POST https://engenty.ai/api/public/signals/<token> \
  -H "content-type: application/json" \
  -H "x-wizards-signature: sha256=<hmac>" \
  -d '{ "name": "invoice.paid", "key": "anna@example.com", "data": { "amount": 129 }, "delivery": "evt_123" }'
```

The answer is `{ "id": "sig_…", "runs": 1 }`, with how many runs woke. An address reaches only the
runs of its own wizard.

| Key or header | What it does |
|---|---|
| `delivery`, or the header `idempotency-key` | Your id for this event. The same one again wakes nothing and answers what it answered first. Without it a repeated call is a new signal |
| `x-wizards-signature` | With a secret: `sha256=` and the hex HMAC-SHA256 of the raw body |

| Status | Means |
|---|---|
| `401` | The signature is wrong |
| `404` | The address doesn’t exist, or the switch is off |
| `413` | `data` is larger than 64 KB |
| `422` | The body doesn’t fit, the name is one only the runtime writes, or no wait of this wizard takes it |
| `429` | More than `SIGNALS_PER_HOUR` for this address (600 by default) |

The signature has no timestamp, so a recorded call can be sent again. Send a `delivery` to make that
harmless. Plugins send with [`server.signals.send`](../plugins/server.md#signals), AI apps with the
MCP tool `send_signal`, and the studio’s runs panel has **Send test event**.

## A person’s step

Pages and reviews take these keys:

| Key | What it does |
|---|---|
| `who` | Who answers: `person` (the default), `owner` or `team` |
| `timeout` | Go on without an answer after this long, at most 31 days. `steps.<id>.timedOut` is true |
| `remind` | Remind whoever is asked after this long, once, at most 31 days and shorter than `timeout` |

With no rule on `timedOut`, the next step follows and the page’s fields stay empty.

| `who` | Who may answer |
|---|---|
| `person`, `owner` | The run’s person: its member, its visitor, whoever holds its link. A start’s run belongs to the start’s owner |
| `team` | The people named in the share dialog under **Answered by**, or the admins if it says so. Never a visitor, a link or a client |
| any | The organization’s admins and the one person of a computer. On a test run, any member |

`who` names a role, never a person, so a `.wizard` file carries no names. In the cloud, a wizard with a
`team` step can’t be published until **Answered by** names someone or says “Admins”. The first answer
counts, and a later one is refused with who answered.

### Approvals

A review with `approve` asks to approve or decline instead of “Looks good”:

```json
{
  "id": "approveOffer", "type": "review", "title": "Approve the offer",
  "show": ["offer"], "who": "team", "approve": true, "timeout": "2d",
  "next": [{ "when": { "field": "steps.approveOffer.approved", "op": "equals", "value": false }, "goto": "rewrite" }]
}
```

It hands on `steps.<id>.approved` and `steps.<id>.note`, and it needs a rule on `approved`, or a
decline would go on like an approval. A timeout hands on `approved: false` with `timedOut: true`. A
start’s `passReviews` never approves.

## AI steps that go on

An [AI step](./agent-steps.md) with `"durable": true` keeps its conversation:

- After a crash or a deploy it goes on at the call it was at.
- It gets the tool `ask_person`. It stops and asks with nothing running, for days if it must.

It needs a model an API serves. `browser` and `sandbox` can’t be used, because what they have open
is gone after an interruption. It does nothing on a step with `each` or `call`.

### What happens once

What a step does through a connection, or with `http_request` other than GET, happens once. It is
written down before it runs. When a run comes back and can’t know whether it happened, it isn’t
repeated: an AI step is told so, and a person can check. Nothing can say this of `browser_*`,
`run_command`, a plugin’s tools, a GET, or a connector called inside `execute_typescript`, so keep
those safe to repeat.

## When a step fails

| What went wrong | What the run does |
|---|---|
| Short trouble at a provider: a 429, a 5xx, a timeout, the network | Waits and tries again after 1, 5 and 30 minutes, or what `Retry-After` says, up to 6 hours |
| Out of credits | Waits, and goes on within minutes of a top-up. After 30 days it fails |
| A sign-in ran out | Waits until someone signs in |
| Anything else, or the step already acted outside | Goes to `onFail`, or fails |

`onFail` names the step the run goes to when this one fails for good, at most three times. A person
can still try a failed run again, which starts the step anew.

An automatic step has a time limit of 8 hours, 12 for motion graphics. Past it, the step fails.

## A run’s label

`label` on the wizard tells its runs apart in the runs panel. It is a template of answers, filled as
they arrive:

```json
"label": "{{customer}} · {{offer}}"
```
