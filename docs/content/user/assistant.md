---
title: Goose, the help assistant
description: The chat at the bottom of every studio page. Goose knows engenty wizards, sees the page you are on, shows you where things are and fills in the space.
version: 0.5.0
---

Goose is still being tried out and doesn’t show in every studio yet. Where it is switched on, it
works as described here.

Goose stands at the bottom of every page of the studio except the editor, which has a chat of its
own: the assistant that builds your wizard. Goose runs on the High class of Text & reasoning:
your subscription, your own API keys or your credits ([Models and account](./models.md)).

| Ask it | Goose |
|---|---|
| How something works | Reads this guide (the version you installed) and links the page |
| Where something is | Opens the page and points at the place |
| About your account | Looks up your plan, credits and what you used. It never buys or upgrades anything |
| About templates | Searches the templates and shows the ones it recommends as cards under its answer. A card opens the template, and you start a wizard from it there |
| About your wizards | Looks at their runs, the failed ones too |
| About models | Says which models are set up here, and what is missing |
| To fill in the space | Reads a website or your files ([Space](./space.md#have-it-filled-in)) |

Goose sees the page you write from: where you are, what is open and what the page shows. It may
put a value into a field for you; you check it and save. It doesn’t click buttons.

## Where it stands

| | |
|---|---|
| At the bottom | The default. Click the field, and the chat rises above it |
| Closed | ✕ in the header closes it to “Ask Goose” at the lower right. A click opens the chat where it last stood. On Data and Results it starts there |
| Sidebar | Beside the page, in a window 1,520 pixels wide or more |

The buttons in the chat’s header (“As a sidebar”, “Dock at the bottom”) switch between them. The
studio remembers your choice.

At the bottom, you can move the chat out of the way of what it covers: drag it by its grip, or by
Goose sitting on top of it. It stays where you put it. Near the bottom it snaps to the middle or
the right. Near the right side, higher up, it becomes the sidebar, and the sidebar’s grip pulls it
out again. A dashed outline shows where it will snap. The handle on top of the chat sets how tall
the chat history is; a click on it folds the history away.

## Writing while it works

You can keep writing while Goose answers. What you send waits above the field:

| | |
|---|---|
| Enter | Goose reads it before its next step. It keeps to what you asked before unless the new message changes it |
| ⌘↩ (Ctrl+↩) | It goes out as the next question once the answer is done |
| “Send now” | Stops Goose and sends it at once |

While Goose answers and the field is empty, the stop button stands where “Send” does.

## One chat

You have one chat. It is the same on every page and in every space, after a reload and on another
device. Nobody else in the team sees it.

- **“New chat”** (the pen in the header, or the menu at the chat’s name) clears the chat at once
  and summarises the old one in the background. Goose keeps the summaries of your last chats in
  mind.
- **“Earlier chats”** lists the closed ones, for you to read. Ask about something you discussed
  before, and Goose searches them.

## Live chat

**“Talk”** stands where “Send” does while the field is empty. The chat becomes a call: you speak,
a pause sends what you said, and Goose reads its answer aloud. Then it listens again. If you talk
over it, it stops speaking.

- Chrome and Safari turn your speech into text themselves. Other browsers record it, and your
  model for voice notes writes it down.
- Goose reads its answers with your computer’s voices, or with the speech model where one is set
  up (the speaker button in the call).
- Everything said stays in the chat as messages.
