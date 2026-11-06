---
title: Capabilities
description: One place for what your wizards, Work chats and Goose may use – skills, the space’s connections to other services, the audit of every call, who may read, change and run what, and a search for more.
version: 0.17.0
---

**Capabilities** in the app bar, after Resources, holds what a space’s wizards, Work chats and
Goose may use. On a phone you find it in the “More” menu. It belongs to the space you are in, and
each space has its own.

It opens on the **Overview**, then has four more sections. None of them has a menu of its own:
the list of sections stays beside the page.

| Section | What it holds | Who sees it |
|---|---|---|
| **Overview** | The skills that count, the space’s connections and the built-in connectors nobody connected yet, on one page, with a search over them. Its second tab, **Discover**, searches skills.sh and integrations.sh | Everyone who uses the studio. Only admins set up a connector from Discover |
| **Skills** | Instructions your wizards work by. See [Skills](./skills.md) | Everyone who uses the studio |
| **Connectors** | The space’s connections to other services, the built-in connectors and the ones from the registry | Everyone who uses the studio. Members see the connections open to them |
| **Audit** | Every call to a connection, allowed or not. See [Audit](./protocol.md) | The owner and the admins see every line. A member sees their own |
| **Rights** | Who may read, change and run what in the space. See [Rights](#rights) | The owner and the admins |

The old addresses still work: `/skills` opens Capabilities › Skills, the connectors’ old address
in the settings opens Capabilities › Connectors, and `/capabilities/discover` opens the Overview’s
Discover tab.

## Overview

The Overview shows the skills that are always on or on demand, with the ones always on first, and
the space’s connections, each with how it signs in and who may use it. A connection that guests
reach is marked “open to guests”, and admins see a note above the list that counts them (see
[Connections that guests reach](#connections-that-guests-reach)). “All” beside each part
opens its section, and the menu shows how many skills and connections the space has. The search
looks through both. The “Discover” tab, or a search for something the space doesn’t have, searches
skills.sh and integrations.sh in place, with the same words. “Add” leads to a new skill, a new
connection (admins) or Discover. Picking Skills in the menu again, with a skill open, shows all
skills.

## Skills

A skill is a set of instructions your wizards follow: how you write, what a quote must hold, how
to handle a PDF. Each one is always on, on demand or off. “In this space” lists the space’s
skills, and you add one from skills.sh, write one or upload one. [Skills](./skills.md) explains
each setting, the scripts a skill may bring, and the limits.

## Connectors

Under Connectors, “In this space” lists the space’s **connections**. A connection is one account
at a service that the space uses, such as Gmail · Orders or HubSpot · Sales. Below the list you
see the built-in connectors that nobody connected yet, and under “More connectors” the ones from
the integrations.sh registry and the ones you add by their address.

**By address.** A service the registry doesn’t list, such as your own MCP server, comes in under
“More connectors” with “By address”. You paste the address, check what engenty wizards read there,
and import it. Such a connector is marked “not checked”: nobody has looked at the server, and its
texts reach the AI as they are. A new connection on it is for admins only at first. On your
computer the address may be a private one, such as `localhost`. In the cloud a private address is
refused. [Connectors](./connectors.md#by-its-address) has the steps.

A connection belongs to the space, not to the person who set it up. Its page says who set it up
and when (“set up by Matthias on 12 Oct”), and when it was last used. It stays when that person
leaves. Only the space’s admins set up a connection, change it or remove it.

When an admin sets one up, they choose how it signs in and who may use it. On its page they then
set what it may do.

**How it signs in.**

| Signs in | What it means |
|---|---|
| As the space | An admin signs in once, with an API key, an app token or a team account such as orders@. Everyone uses that account, also when nobody is watching. The AI only reads through it. Changes come from fixed steps or from an action a person confirms in a Work chat |
| Each person signs in | Each person signs in once with their own account, on the connection’s page or in their menu. The connection then acts as that person, and asks them before it changes something |

An admin can change this later on the connection’s page. The change removes the sign-ins made
until then: every person’s when the connection becomes the space’s, the space’s when each person
signs in from then on. The page asks before it changes anything. A connection that a plugin uses
always signs in as the space.

In the cloud, your organization’s plan decides whether “Each person signs in” is available. Where
the plan doesn’t include it, the choice is greyed out with a sentence that says so, and a new
connection signs in as the space. A connection that already has each person sign in keeps working,
and people still sign in and out of it. You can change it to “As the space”, but not back. On your
computer there is no plan, so both ways are always available.

**Who may use it.** Admins, Members or Everyone. Everyone includes guests who start a wizard from
its link. A guest’s run never uses a connection that is only for members or admins.

### Connections that guests reach

Guests reach a connection that is for Everyone and signs in as the space. The list marks each one
“open to guests”. Where each person signs in, a guest has no sign-in of their own, so guests don’t
reach it, whoever it is for.

Admins see a note above the list, on the Overview and under Connectors, as long as the space has
such a connection. It says how many there are and names each one. “Narrow to members” beside a
connection sets it to Members with one click, and nothing changes until you click. To open it
again, choose Everyone on the connection’s page. Members don’t see the note.

A connection that a plugin set up names the plugin, in the list and on its page. The appointment
planner, for example, books for guests through a calendar connection. The note says so before you
narrow it: once the connection is for members only, the plugin can’t reach it when a guest starts
a wizard. What the plugin does by itself, such as keeping a calendar in step, goes on.

**What it may do.** One rule for each kind of action: Read, Change, Delete and Send. Each rule is
Allowed, With approval or Never. A new connection reads freely, asks for approval before a change
or a send, and never deletes.

![A call to a connection meets its rule: Allowed runs, With approval waits for a yes, Never doesn’t run, and the Log keeps every call](../../assets/diagrams/capabilities-call.svg)

With approval on a connection that signs in as the space asks the space’s admins. The call waits
under the bell in Work until one of them agrees. Where each person signs in, With approval asks
that person.

**What a guest’s run may send.** A guest starts a wizard from its link, and nobody of your team
watches the run. So the rules above are not all that counts for it:

- It sends an email only to the address the guest gave in the wizard, or to an address in the
  space’s own mail domains.
- It posts to Slack only from a fixed step, and only to the channel written into that step of the
  published wizard. A channel taken from what the guest typed is refused.
- One run sends three emails and messages in all. A wizard’s guests send a set number per day.

Your members’ runs are not bound by this. The [Audit](./protocol.md) shows each refusal with its
reason.

Members see the connections open to them, with their rules, and change nothing. Where each person
signs in, they sign in right there. [Connectors](./connectors.md#connections-in-the-space) has the
details, and how a wizard uses a connector of its own.

### Pause a connection

An admin can pause a connection without removing it. “Pause connection” is at the bottom of the
connection’s page, beside “Remove connection”. While it’s paused, nobody reaches it: no wizard, no
chat, no plugin. A step that was already running is refused at its next call. Nothing is lost. The
sign-ins, the rules and who may use it stay as they are.

The page says on top that the connection is paused, since when and who paused it. “Resume” there
gives it back as it was. The lists on the Overview, under Connectors and under Connections in your
own menu mark it *paused*. The [Audit](./protocol.md) shows the pause and the resume as critical
lines. Each call the connection refused meanwhile is a line too, with the reason “the connection
is paused”.

## Your own connections

Your own menu, behind your avatar in the top bar, has **Connections**. It lists, for each of your spaces, the
connections open to you:

- Where each person signs in, you sign in or out. Your chats, your runs and your Goose then act as
  you, and nobody else sees your sign-in.
- Where the space signs in, you see its account and who set it up.

You set up no connection there. That stays with the space’s admins.

## Audit

The Audit shows every call your space’s wizards, Work chats and Goose made to a connection, one line
each, whether it ran or not. Critical lines, such as a refused change, reach the admins under the
bell in Work. **Who may do what?** tries a rule before anything runs, for the owner and the admins.

The owner and the admins see every line. A member sees only their own: what they called, what
Goose called for them and what the fixed steps of their runs called. [Audit](./protocol.md)
explains each line, the filters, what counts as critical and what a member sees.

**Stop a run.** An admin stops a run from the Audit. Click a line of a run that is still under
way, then “Stop run”. From then on the run calls nothing more: each later call is refused, on
every connection, and the line says the run is *stopped*. A call that was already under way still
finishes. A stopped run can’t be continued. Stopping a run is the one way to take back what it may
reach, and there is no other.

## Rights

**Rights** is the one place where the owner and the admins see and change who may read, change
and run what in the space. Nobody else sees it.

**What everyone may do.** The top of the page lists what each group may do with everything in the
space, as long as no exception says otherwise.

| Group | Who it is | Can you change it |
|---|---|---|
| Admins | The owner and the admins | No. What they may do is fixed |
| Members | The people working in the space, also in Work | Yes, each right has a switch |
| Guests | Someone at a shared link or a public page, without signing in | Yes, for the rights a guest can have |
| Clients | Your clients, signed in to their client space. Shown where client spaces are on | Yes |

Each row is one right. Rights names only what engenty wizards checks, and it words each right as
far as the check goes.

| Right | What it covers |
|---|---|
| “Read documents”, “Read pages and folders”, “Read tables” | Reading Knowledge, wherever it is read: the studio, a wizard’s step, a Work chat, Goose, the search, a shared link |
| “Have Goose change pages”, “Have Goose change the space’s setup” | Goose writes a page of Knowledge or the space’s info and brand for you only with this right. Someone who writes in the studio themselves doesn’t need it |
| “Let the AI find wizards”, “Let the AI start wizards” | The AI in Work and in connected apps such as Claude or Codex lists and starts a wizard for you only with this right. A member starts any wizard themselves in Work and in the studio, and a guest reaches a wizard by its link. For clients the rights read “See wizards” and “Start wizards”, and hold in their client space |
| “Use skills”, “Run the scripts of skills” | A wizard’s step, a Work chat and Goose read a skill for you, and a skill’s scripts run in your runs and chats |

A switch that is off means that nothing allows it for the whole group. An exception can still
allow it for one person or one thing. The AI in Work and Goose may do what the person they work
for may. An exception can allow them less.

**Exceptions.** Below the groups you see every other rule of the space as a sentence, for example
*Guests may not read the folder “Internal prices”.* A “may not” always holds, even where another
rule allows it. Under each sentence it says where the rule is set.

| It says | How you change it |
|---|---|
| “Set on this page.” | “Remove” takes the exception away |
| “Set in Knowledge, under ‘Who sees this folder’.” | “Change it there” opens that dialog for the page or folder |
| “Set in Files, on the folder itself.” | “Change it there” opens the mounted folder, where you set who sees it, which wizards use it and what the AI in Work may do |
| “Set with ‘Visible to clients’.” | “Change it there” opens the document or table in Knowledge, or the Clients part for a wizard |

**Add an exception.** “Add an exception” asks who, “may not” or “may”, what to do, and with what:
a document, a page or folder, a table, a wizard, a skill or the space’s setup. You choose a group,
one person, Goose for one person, the AI in Work, a wizard or a plugin. The form offers only what
engenty wizards checks, and it shows the sentence before you add it. What holds for a whole group
with everything of a kind is set at the top, not here.

**Connections have their own rules.** Who uses a connection and what it may do is set on the
connection’s page, not here. Rights shows how many connections the space has and how many of them
guests reach, and “Open Connectors” leads there.

**Who may do what?** On this page the question is about content. Choose a person, a guest, Goose
or the AI in Work for a person, a wizard in a guest’s or a person’s run, or a plugin, then what
they want to do with which document, page, table, wizard or skill. The answer says yes or no and
names the rule that decided, with where it is set. Nothing is read or run for it. For a
connection, ask in the Audit.

Rights does not cover everything. A member who may use the studio changes pages, tables and the
space’s setup there, and starts any wizard of the space in Work. A guest who has a wizard’s link
runs it. Mail, the hosts a wizard requests and commands in the sandbox follow a connection’s rules
and [what the run may reach](./protocol.md), not these rights.

## Discover

Discover searches skills.sh for skills and integrations.sh for connectors at once. You view a skill
whole and add it right in the results. A connector’s result has “Set up” for the admins, which
starts a connection with it. What the space already has shows “In this space”.

## Who sees Capabilities

In an organization in the cloud, the space’s admins decide whether its members may use the studio:
in the space’s info, with **Members can use the studio**. The rule counts for every member of that
space. There is no switch for one person.

| | Owner, admin | Member, where the space lets members in | Member, where it doesn’t |
|---|---|---|---|
| Studio | Yes | Yes | No, Work only |
| Wizards | Build, test, publish and share | Build and test | Run them in Work |
| Skills, knowledge, data | Add and change | Add and change | – |
| Connections | Set up, choose how they sign in, set the rules and who may use them | Use the ones open to members. The rules are locked | Their Work chats use the ones open to them |
| Audit | Every line, **Who may do what?** and the notifications | Their own lines | No |
| Rights | See and change them | No | No |
| Own sign-ins | In their menu | In their menu | In their menu |

Approvals always go to the space’s admins, never to a member. On your computer you are the only
person, so the rule doesn’t come up. [Working together](./together.md#members-in-the-studio) says
more about members.

## Switch it off

Capabilities is on by default. To turn it off on your computer, add this line to
`~/.engenty/wizards/.features`:

```bash
capabilities=off
```

Skills then has its own place in the app bar again, and the connectors move back to the settings.
