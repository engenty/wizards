---
title: Build a wizard
description: Describe what the wizard should do, or start from a template. Then change it in the chat or step by step.
version: 0.5.0
---

## Start one

“New wizard” on the list of your wizards, or in the sidebar, opens the page “What should your
wizard do?”. It gives you three ways in:

| Way | How |
|---|---|
| Describe it | Write what the wizard should do in your own words and click “Build wizard” |
| A template | Choose one under “Or start from a template”. Search, or narrow the list by industry, result and capability |
| A wizard file | “Import a wizard file”, at the foot of the page, takes a `.wizard` file someone exported |

A description that works says who enters what, what the wizard does with it, and what comes out:

> Customers enter their product and audience. The wizard researches competitors and writes a
> positioning briefing as a PDF.

You can change everything afterwards in the chat.

### Before you build

- **How it runs.** “Runs as” above the text field says how people will reach the wizard: as a
  “Step-by-step wizard” unless you choose otherwise. The + beside it asks “How should it run?”
  and lists the other channels this studio offers, for example “Chat”, “Live voice” or “Video
  call”. One channel always stays on. The assistant builds the wizard for what you chose.
- **Files.** Attach examples, price lists or screenshots with the + in the text field, or paste
  or drop them there. They go into the wizard’s files, and the assistant looks at them.
- **Dictation.** The microphone button lets you speak instead of type.
- **Similar wizards.** While you type, the page lists up to ten of your own wizards and templates
  that come close. “Open” opens one of yours, and “Use” starts from a template. This way you
  don’t build again what is already there.

### Templates

- A template shows how the wizard runs, how long a run takes, what it costs and what it needs
  before you start from it with “Start with this template”.
- “Not set up here” names a model that isn’t set up on this computer yet, for example for video.
  Set it up under [Models and account](./models.md), or choose another template.
- A template marked “Pro” needs plugins that come with Pro on engenty.ai.
- A star keeps a template on this computer, so you can use it without a connection.
- A wizard started from a template is your copy. Later changes to the template don’t touch it.

## The editor

| Part | What it is for |
|---|---|
| The diagram, left | The steps as a flow with their branches. Click a step to open it |
| Chat | Say what should change. The assistant edits the flow and tells you what it did |
| Steps | One step at a time: its texts, fields, tools and model class. Move it up or down, or delete it |
| Files | Files the wizard uses on every run, like widget code, libraries or price lists. Upload your own or let the assistant write them |
| Memory | What the wizard knows across all its runs: the notes that AI steps with the “Pages” tool read and add to, and the tables of its shared lists |
| Runs | The test runs and live runs of this wizard |

On a phone or a narrow window the panels sit in a sheet over the bottom of the diagram. Drag its handle to make it taller, or tap
it to fold it away.

A click on the wizard’s name in the top bar opens its own settings: its title, description and
greeting, its avatar, and the language it speaks to people in. With “Automatic, from its texts”
the wizard speaks the language its texts are written in.

The ⋯ button in the top bar (“More”) duplicates the wizard, exports it, or deletes it. Only
whoever manages the team can delete a wizard. The same menu is on the wizard’s card in the list.

### In the chat

- Write what should be different: “Ask for the delivery date on the first page”, “Add a review
  before the PDF”.
- Attach files the assistant should look at: an example document, a price list, a screenshot.
- Dictate instead of typing with the microphone button.
- If the connection drops, what was already built is saved. Send your message again.

### Step by step

Open a step from the diagram or under “Steps”. What you can set depends on its type: see
[Steps](./steps.md).

“Add step” on a step in the diagram, or under “Steps”, puts a new step after it. Say what it
should do and choose its kind, or leave it to “AI chooses”. Then say when it runs: “Always”,
“Only if…” a condition holds, or when “AI decides…”. “Create” lets the assistant build the step
in the chat. “Insert empty” adds a blank step of the kind you choose, for you to fill in.

## When the wizard needs fixes

A draft may be incomplete while you work on it. Before you test or share, the editor lists what
is missing, for example a step that uses an answer that is only asked later, or a tool that isn’t
installed here. “Let the assistant fix it” hands that list to the chat.

If a step needs a model that isn’t set up here, the editor names the step and the model, and
“Set up models” takes you there. If every path of the wizard needs that model, the wizard can’t
start. If only one branch needs it, choose another path when you test.

## What makes a good wizard

- Write for people who are not technical: use plain words, and phrase titles as questions.
- Keep to few pages, one theme per page and at most five fields. Ask only what the result needs.
- Put a review before anything expensive, such as video, and before the final result.
- Let the phone do the typing: a photo instead of a description, the location instead of an
  address form, a voice note instead of a long text.
- Put money in a line-items field. The wizard works out net, VAT and total itself; a model never
  does.
- Facts from the web need a research step before the step that writes.

## Take it with you

“Export as a wizard file (.wizard)” in the wizard’s ⋯ menu downloads its steps and its files as
one file. “Import a wizard file” on the “New wizard” page of any studio takes it in.

The share dialog downloads a wizard file too, under “Website” → “Without an account: as a
package”. It holds the published version, or the draft while there is none, for a WordPress site
that runs it without an account. With “Take the knowledge along”, the space’s pages go with it
as files. See [WordPress](./wordpress.md#without-an-account).
