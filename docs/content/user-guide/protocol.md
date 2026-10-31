---
title: Audit
description: Every time a wizard, a chat or Goose used a connection of your space, allowed or not – what critical means, and how to try a rule before anything runs.
version: 0.13.0
---

**[Capabilities](./capabilities.md) › Audit** shows every call your space’s wizards, Work chats and
Goose made to a connection. Each call is one line, whether it ran or not.
Only the owner and the admins of the organization see the audit. Members don’t find it in their menu.

## What a line says

A line reads like a sentence:

- **Who** called: a guest at a wizard’s link, a person by name, an admin, Goose for a person, a
  plugin, or a fixed step for a guest or a person.
- **What** they wanted: reading, writing, deleting or sending, and the connector’s name for the
  action, such as “Create a contact”.
- **On which connection**, such as “HubSpot · Sales”.
- **Where**: in a run of a wizard, in a test run, in a Work chat or with Goose.
- **What came of it**: *done*, *refused* with the reason in words, or *waiting for the admins’
  approval*.

A refused line has a red frame. A critical line has an orange one and the mark *critical*.

Click a line to see more: when exactly it happened and how long it took, which fields went in and
how big the input and the result were, and which rule decided. A line from a run also shows the
run’s grant: what the wizard allowed that run through this connection when the run started. The
buttons below lead to the run, the chat or the connection.

The audit never holds a password, a token, a key or a whole email. Of the input it keeps the names of
the fields, their sizes and one short value that is no secret.

## Filters

Above the lines you choose:

- **All**, **Refused**, **Critical** or **Waiting for approval**;
- who called: guests, members, admins, Goose, plugins or fixed steps;
- one connection;
- a time range, from the last hour to all time;
- a search. It finds a person’s name, a connection’s, a wizard’s, an action, a reason and the
  short value of the input.

The newest lines come first. “Load more” shows older ones.

## Critical

A line is critical when someone should hear of it:

- a write, a delete or a send was refused;
- a guest’s run reached a connection that is only for members or admins;
- a run asked for a host the wizard doesn’t allow;
- a limit was reached, such as the emails a guest’s run may send;
- a sign-in ran out or the service refused it;
- a connection was used for the first time;
- someone changed a rule.

The admins hear of a critical line at once, under the bell in Work. Where no admin was in the app,
they get one email an hour with the critical lines since the last one. The bell icon beside the
audit’s title, or **Settings › Notifications**, lets an admin turn the bell and the hourly email off
or on for the space.

## Who may do what?

Rules are easier to understand when you can try them. **Who may do what?**, the button beside the
audit’s title, answers a question before anything runs, for example “May Julia send an email in this space?”.

1. Choose **who**: a person of your organization, a guest, Goose, or a fixed step in a guest’s or
   a member’s run.
2. Choose the **connection** and the **action**.
3. Choose **where**: in a run or in a Work chat.

The answer is one sentence:

- “Julia may send in Gmail · Orders – once the admins approve.”
- “A guest may not read in HubSpot · Sales – the connection is for members only.”

Below it you see which rule decided, and “Change the rules” opens the connection. The answer comes from the
same rules that decide every real call, and nothing runs or lands in the audit.
