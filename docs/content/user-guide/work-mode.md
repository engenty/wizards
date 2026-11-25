---
title: Work mode
description: The Studio · Work · Client switch, Work’s chats on your team’s Bot Server, what waits for you, and what Client shows.
version: 0.21.1
---

Work mode is where your team works: you chat with the agents of your team’s Bot Server and
answer what waits for you. Studio stays where you build wizards.

Work mode is not on for everyone yet. In the cloud, engenty switches it on for an organization. On
your computer you add this line to `~/.engenty/wizards/.features`:

```bash
workMode=on
```

Without it, the studio looks as before: Studio alone, with no switch.

Client comes with the public page, so it shows only where `pages=on` is set as well.

## Studio, Work and Client

The switch sits in the app bar, right under the space. On a phone it sits in the top bar. The
engenty in the bar’s corner shows the mode you are in: green for Studio, blue for Work, violet
for Client.

| Mode | For | What it holds |
|---|---|---|
| **Studio** | The people who build | Wizards, Resources, Capabilities and the settings, as before |
| **Work** | Everyone in the organization | The chats of your team’s Bot Server, and what waits for you |
| **Client** | A look at what your clients see | Nothing yet. “This view comes soon.” |

![Studio, Work and Client all look at the same space](../../assets/diagrams/work-modes.svg)

The owner and the admins see all three. A member sees Work and Client. Where the space’s admins
switched on **Members can use the studio**, members get Studio as well
([Capabilities](./capabilities.md#who-sees-capabilities)). A member who opens a Studio address of
a space that doesn’t let them in lands in Work. The studio remembers your mode in this browser.

## Work’s places

Work’s app bar has Chats and **Waiting for you**.

## Chats

Work’s chats are the chats of your team’s Bot Server ([wizards.bot](https://wizards.bot)). The
studio shows the Bot Server’s own page under **Chats**. Your agents, their chats, their memory and
their tasks live on the Bot Server, so you find the same chats in its apps for the Mac and the
iPhone.

| Your team’s Bot Server | What Chats shows |
|---|---|
| Runs | Its page. The studio signs you in to it as yourself |
| Doesn’t exist yet | An owner or admin sees **Set up the Bot Server**, which leads to the account pages. A member is told to ask them |
| Is being set up or is stopped | A note that says so |

For now, the owners and admins of a team chat on its Bot Server. In an organization of one, the
Bot Server is your own, and its page asks for its pairing code the first time.

The chat knows the space that is open in the studio’s top bar, and it acts there as you. Ask what
the space knows about a topic, and the answer comes from that space’s Resources. Tell it to run a
wizard, and it asks you once before the run starts. It reads and runs only what you may read and
run in the space. Switch the space, and the chat works in the other one from your next message.

You don’t connect anything for this: the Bot Server knows your team’s studio. It is your team’s
own, so it keeps working where your organization keeps apps on members’ subscriptions out of its
spaces.

Chats need the cloud: a studio on your computer that isn’t connected to an account has no Bot
Server to show.

## Waiting for you

**Waiting for you** lists the runs that wait for you: a page to answer, a result to review, an
approval to give. For the owner and the admins it also shows the critical lines of the space’s
[Audit](./protocol.md), such as a refused change or a connection used for the first time. Opening
it marks them seen.

## Client

Client is where you will see the space as your clients see it. It shows a placeholder for now.
