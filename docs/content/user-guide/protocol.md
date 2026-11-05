---
title: Audit
description: Every time a wizard, a chat or Goose used a connection of your space, allowed or not – what critical means, what a member sees, and how to try a rule before anything runs.
version: 0.16.2
---

**[Capabilities](./capabilities.md) › Audit** shows every call your space’s wizards, Work chats and
Goose made to a connection. Each call is one line, whether it ran or not.

The owner and the admins of the organization see every line. A member sees only their own lines,
in a space that lets members use the studio. [What a member sees](#what-a-member-sees) says which
lines those are.

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
- who called: guests, members, admins, Goose, plugins or fixed steps. Only admins have this
  filter, because a member’s lines are all their own;
- one connection;
- a time range, from the last hour to all time;
- a search. It finds a person’s name, a connection’s, a wizard’s, an action, a reason and the
  short value of the input.

The newest lines come first. “Load more” shows older ones.

## What a member sees

As a member you see your own calls and nobody else’s:

- what you called yourself, in a Work chat or in an AI step of a run you started;
- what Goose called for you;
- what the fixed steps of your runs called.

Each of your lines opens like any other, with the input’s fields, the rule that decided and your
run’s grant. The filters and the search only ever count your own lines. A search for a colleague’s
name finds nothing.

Three things stay with the admins:

- the filter by who, **Who may do what?** and the notifications;
- the name of a connection that is not open to you. A call of yours that such a connection
  refused shows without the connection’s name;
- what you called while you were an admin yourself. Those lines stay admins’ lines.

## Critical

A line is critical when someone should hear of it:

- a write, a delete or a send was refused;
- a guest’s run reached a connection that is only for members or admins;
- a run asked for a host the wizard doesn’t allow;
- a limit was reached, such as the emails a guest’s run may send;
- a sign-in ran out or the service refused it;
- a connection was used for the first time;
- someone changed a rule.

A member’s own lines show the mark too. Only the admins hear of them.

The admins hear of a critical line at once, under the bell in Work. Where no admin was in the app,
they get one email an hour with the critical lines since the last one. The bell icon beside the
audit’s title, or **Settings › Notifications**, lets an admin turn the bell and the hourly email off
or on for the space.

## Who may do what?

Rules are easier to understand when you can try them. **Who may do what?**, the button beside the
audit’s title, answers a question before anything runs, for example “May Julia send an email in this space?”.
Only the owner and the admins have it.

1. Choose **who**: a person of your organization, a guest, Goose, or a fixed step in a guest’s or
   a member’s run.
2. Choose the **connection** and the **action**.
3. Choose **where**: in a run or in a Work chat.

The answer is one sentence:

- “Julia may send in Gmail · Orders – once the admins approve.”
- “A guest may not read in HubSpot · Sales – the connection is for members only.”

Below it you see which rule decided, and “Change the rules” opens the connection. The answer comes from the
same rules that decide every real call, and nothing runs or lands in the audit.
