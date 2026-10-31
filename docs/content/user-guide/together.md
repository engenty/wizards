---
title: Working together
description: How the studio shows what others change while you work, merges it with what you type, shows who else is in a wizard, page or table, where an organization’s settings are, and who may use the studio.
version: 0.13.0
---

The studio shows changes made elsewhere as they happen. You don’t reload anything. That holds
whoever made the change:

- another member of your organization, or you in another window;
- the AI: the assistant in the editor, or an app like Claude Code over MCP;
- a run that adds rows to a table;
- the cloud, when your computer keeps its spaces the same as there
  ([Spaces in the cloud](cloud-sync)).

A row, a card or a page that changed elsewhere lights up for a moment.

## While you type

What you type is never replaced. engenty wizards saves a moment after you stop typing:

| Your editor | A change from elsewhere |
|---|---|
| Nothing typed since the last save | Shows at once. The cursor stays where it was |
| Something typed, not saved yet | Waits. Nothing moves while you type. The next save merges both, and the editor shows “Merged with changes from …” |
| You and someone else changed the same place | The editor asks: “Keep mine” or “Take the other version”. Until you choose, your text stays and isn’t saved over theirs |

In a table each cell saves on its own. The cell you type in keeps what you type, and the other
cells of the row change as they come.

## Who else is here

The header of a wizard, page or table shows who else has it open, with a colour each:

- a person’s initials: they look at it, or edit it if their initials have a ring;
- a robot for the AI: the assistant for someone, or an app over MCP. An app counts as here for a
  minute after it read or changed the wizard.

Hold the pointer over a face to see what they do and where: a step of the wizard, a section of a
page, a row of a table. A row someone else edits has an edge in their colour, and a wizard card
shows a dot for each person in it. When you type where someone else types, the editor says
“Anna is editing this too”.

This is for your awareness only. Anyone can still edit, and nothing is locked.

## The AI knows too

An app over MCP learns who else is in a wizard when it reads or changes it. When a person edits
the same wizard, the app hears that their editor merges its change, and it tells you before
larger changes.

## Your organization

On engenty.ai the settings start with the organization’s:

| Page | What it holds |
|---|---|
| General | The organization’s name; its plan with what is in use (Spaces, Members, Credits left, Models: the [tier](./models.md#which-models) and the tiers the plan offers), and “Change plan” for owners and admins; its address, where the studio and the published wizards live |
| Members | Who is in it and who is invited, with their roles. Owners and admins change roles and remove people; owners invite, and on Team admins too. “Leave the organization” is here too, while someone else is in it |
| Credits, Usage, Invoices | The balance and its entries, what was spent, the bills |

The person who made the organization can change its address once, in its first 14 days. The
studio moves with it.

### Members in the studio

Admins decide for each space whether its members may use the studio: in the space’s info, with
“Members can use the studio”. The rule counts for every member, not for one person.

With it on, members build and test wizards in that space. They add and change skills, knowledge
and data, and use the connections open to them. Admins still publish wizards and share them
outside the space, set up connections and change their rules. Approvals go to the admins, and only
they see the [Log](./protocol.md). With it off, members work in Work and run the space’s wizards
there.

A new space starts with the studio closed to members. [Capabilities](./capabilities.md#who-sees-capabilities)
has a table of what each role sees.

## Switch it off

To turn live changes off on your computer, add this line to `~/.engenty/wizards/.features`:

```bash
liveChanges=off
```

The studio then shows what changed when you open a page again.
