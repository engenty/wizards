---
title: Capabilities
description: One place for what your wizards, Work chats and Goose may use – skills, the space’s connections to other services, the log of every call, and a search for more.
version: 0.13.0
---

**Capabilities** in the app bar, after Sources, holds what a space’s wizards, Work chats and
Goose may use. On a phone you find it in the “More” menu. It belongs to the space you are in, and
each space has its own.

It opens on the **Overview**, then has three more sections. None of them has a menu of its own:
the list of sections stays beside the page.

| Section | What it holds | Who sees it |
|---|---|---|
| **Overview** | The skills that count, the space’s connections and the built-in connectors nobody connected yet, on one page, with a search over them. Its second tab, **Discover**, searches skills.sh and integrations.sh | Everyone who uses the studio. Only admins set up a connector from Discover |
| **Skills** | Instructions your wizards work by. See [Skills](./skills.md) | Everyone who uses the studio |
| **Connectors** | The space’s connections to other services, the built-in connectors and the ones from the registry | Everyone who uses the studio. Members see the connections open to them |
| **Log** | Every call to a connection, allowed or not. See [Log](./protocol.md) | The owner and the admins |

The old addresses still work: `/skills` opens Capabilities › Skills, the connectors’ old address
in the settings opens Capabilities › Connectors, and `/capabilities/discover` opens the Overview’s
Discover tab.

## Overview

The Overview shows the skills that are always on or on demand, with the ones always on first, and
the space’s connections, each with how it signs in and who may use it. “All” beside each part
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
the integrations.sh registry.

A connection belongs to the space, not to the person who set it up. Its page says who set it up
and when (“set up by Matthias on 12 Oct”), and when it was last used. It stays when that person
leaves. Only the space’s admins set up a connection, change it or remove it.

When an admin sets one up, they choose how it signs in and who may use it. On its page they then
set what it may do.

**How it signs in.** This can’t be changed later.

| Signs in | What it means |
|---|---|
| As the space | An admin signs in once, with an API key, an app token or a team account such as orders@. Everyone uses that account, also when nobody is watching. The AI only reads through it. Changes come from fixed steps or from an action a person confirms in a Work chat |
| Each person signs in | Each person signs in once with their own account, on the connection’s page or in their menu. The connection then acts as that person, and asks them before it changes something |

**Who may use it.** Admins, Members or Everyone. Everyone includes guests who start a wizard from
its link. A guest’s run never uses a connection that is only for members or admins.

**What it may do.** One rule for each kind of action: Read, Change, Delete and Send. Each rule is
Allowed, With approval or Never. A new connection reads freely, asks for approval before a change
or a send, and never deletes.

![A call to a connection meets its rule: Allowed runs, With approval waits for a yes, Never doesn’t run, and the Log keeps every call](../../assets/diagrams/capabilities-call.svg)

With approval on a connection that signs in as the space asks the space’s admins. The call waits
under the bell in Work until one of them agrees. Where each person signs in, With approval asks
that person.

Members see the connections open to them, with their rules, and change nothing. Where each person
signs in, they sign in right there. [Connectors](./connectors.md#connections-in-the-space) has the
details, and how a wizard uses a connector of its own.

## Your own connections

Your own menu, behind your avatar in the top bar, has **Connections**. It lists, for each of your spaces, the
connections open to you:

- Where each person signs in, you sign in or out. Your chats, your runs and your Goose then act as
  you, and nobody else sees your sign-in.
- Where the space signs in, you see its account and who set it up.

You set up no connection there. That stays with the space’s admins.

## Log

The Log shows every call your space’s wizards, Work chats and Goose made to a connection, one line
each, whether it ran or not. Critical lines, such as a refused change, reach the admins under the
bell in Work. **Who may do what?** tries a rule before anything runs. Only the owner and the admins
see the Log. [Log](./protocol.md) explains each line, the filters and what counts as critical.

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
| Log | Yes | No | No |
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
