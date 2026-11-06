---
title: Runs that last days
description: A wizard that waits for a date, an email or another service, asks your team, and goes on by itself after an interruption.
version: 0.16.2
---

A wizard can wait for days and then go on by itself: send an offer, wait for the reply, and write a
reminder when none came. Nothing has to stay open while it waits. A waiting run costs no credits.

This is not on for everyone yet. In the cloud, engenty switches it on for an organization. On your
computer you add this line to `~/.engenty/wizards/.features`:

```bash
durableRuns=on
```

## Wait

A **Wait** step holds the run until something happens. You choose under “What the run waits for”:

| Choice | The run goes on |
|---|---|
| Time | After that many minutes, hours or days |
| Date | On that date. You can put an answer in, such as `{{delivery_date}}` |
| Event | When an event arrives. See below |

An event can have a deadline. When nothing came by then, the run goes on anyway, and a branch on
the deadline says where. Add a branch, or the next step follows as if the event had come.

## Events

An event wakes a run that waits for it. You choose where it comes from:

| Event | You set up | “From whom” |
|---|---|---|
| From another service | In “Share”, under “Events”, “Add” makes an address for other services. You see the address and its secret only once | What tells the runs apart, such as `{{email}}` |
| An email | In “Share”, under “Events”, you switch on a mailbox the space signs in to | The address the email comes from |
| A message from the person | Nothing: it works on a channel such as WhatsApp | Nothing |
| Another run has ended | Nothing | Which run |

To wait for a reply to an email the run sent, write `thread:` and the `thread_id` from the step that
sent it. A mailbox is read once a minute while a run waits for it. Out-of-office replies don’t count.
A sender who fails the provider’s checks wakes no wait on that address.

To try it, open the test run in the runs panel and choose “Send test event”.

## Who answers

On a page or a review, “Who answers this?” has three choices:

| Choice | Who |
|---|---|
| Whoever does the run | The person who opened it. This is the usual choice |
| The run’s owner | The member it belongs to. A run that started by itself belongs to whoever set up the start |
| The team | The people you name in “Share”, under “Answered by”, or all admins |

The people you name see the run under “Needs you”, and they get a mail. In the cloud you can’t publish
a wizard with a team step until “Answered by” names someone. On a test run, any member can answer.

The first answer counts. Anyone who answers later sees that it was answered already. While the team
has a run, the visitor who started it can withdraw it.

## Deadlines, reminders and approvals

A page or a review can also have:

| Setting | What it does |
|---|---|
| “Go on without an answer after” | The run goes on after that long, at most 31 days. A branch says where |
| “Remind after” | Whoever is asked gets one reminder |
| “Approve or decline” | A review asks for a decision. Add a branch on it to say what happens after a decline |

An approval that runs out counts as declined. A wizard that started by itself never approves on its
own.

## When something goes wrong

An AI step with “Survives interruptions” goes on where it was after a crash or an update, and it can
stop to ask a person. That person can answer days later. It can’t use the browser or the sandbox.

A mail or another action in a connected service goes out once, even after a crash. When the run
can’t tell whether it went out, it doesn’t send it again. The run’s log says so, and you can look in
the service.

When a provider has short trouble, the step tries again by itself, up to three times. When the
credits run out or a sign-in expires, the run waits and goes on once someone has acted. The person
is told.

## Follow a run

The runs panel shows the run’s log: each step, each wait, what ended it, and who answered. “Name of a
run” tells many runs apart, for example by company.

Admins can use “Continue now” and “Stop” on a waiting run. On a test run, so can the member who
started it.

The people a run needs get a mail and see it under the bell. A visitor gets a mail only at an email
field the wizard marks for it, because that address may belong to a customer.
