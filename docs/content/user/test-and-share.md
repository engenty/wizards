---
title: Test and share
description: Try the wizard, publish it, and hand out its link or put it on a website.
version: 0.5.0
---

## Test

“Test” in the editor starts a run of the draft, just as a person would see it. Test runs are
listed under “Runs”. A test spends what a real run spends: your model’s usage, or credits. A test
run reads the wizard’s memory, but it writes into a copy of its own, which goes with the run.

Where runs spend credits, each AI step shows an estimate. At first it is a formula. After five
runs it is measured from the latest ones.

## Publish

A wizard goes live the first time you share it. “Share” publishes the draft as version 1 as the
dialog opens, and the dialog says “Published when you shared it”. Nobody has the link yet, and
“Only you” under “Access” keeps it closed. A draft with issues is not published: the dialog lists
what to fix first, with “Let the assistant fix it”.

After that, the editor’s top bar shows “Publish changes” whenever the draft differs from the
version people run. It opens a dialog with these parts:

| Part | Says |
|---|---|
| What changed | The wizard’s own settings, each step by its title (new, removed, or which of its parts changed: fields, instructions, result …), the order of the steps and the files |
| Tested | Whether a test run used exactly this draft: “Tested 4 minutes ago – with these changes” with “See the run”, or “Not tested with these changes yet.” with “Test now” |
| Notes | Anyone in the middle of a run carries on with the version they started. Where the cost changed, it says what a run costs now. With an account, it says that the version also arrives in your account’s cloud |

“Publish” makes the draft the next version, and the link stays the same. Issues stop it, as on
the first share. The editor’s top bar and the wizard’s card on the start page say where it runs:

| It says | Means |
|---|---|
| “Not published yet” in the editor, “Draft” on the card | Only you can run it, as a test. Sharing it publishes it |
| “Live · version 3” in the editor, “Live” on the card | The link runs this version. With a cloud icon, it runs on engenty.ai for everyone with the link |
| “Live · 1 note” | It runs in the cloud, but one step does less there (see “Share”) |
| “Local” | It is published on your computer without an account. The link only answers on this computer, while engenty wizards is running |
| “On its way to the cloud” | The version hasn’t arrived on engenty.ai yet. The studio tries again by itself |
| “Not in the cloud” | engenty.ai doesn’t run this version. “Share” says why and what helps |

On a card, “Link” copies the address others can open, and the arrow opens it. A wizard that
runs only on this computer has no address for others. Its “Link” says so and explains how an
account gives it one, and the arrow opens it here.

The ⋯ menu on a card and in the editor has “Duplicate”, “Export as a wizard file (.wizard)” and
“Delete”.

## Share

“Share” says who may open the wizard and how others reach it, and it copies the link.

| Part | Does |
|---|---|
| Access | With “Anyone with the link”, anyone can open and fill it in, up to the runs a day set under “Settings”. “Only you” switches the link off: everyone else sees a notice, and you test in the studio |
| How others reach it | The channels the wizard runs as (see below), grouped by kind: in the browser, on the phone, by message. A browser channel has its own link, and a message channel its keyword and number. Each row copies its own. “Change” lets you choose the channels, from the same list as for a new wizard |
| QR code | One of the links as a QR code to download or print, and the wizard’s ID for the mobile app |
| Website | The code for a website (see below). For WordPress, it offers the plugin, or the wizard as a package that runs without an account, with what it lacks there: see [WordPress](./wordpress.md#without-an-account) |
| Copy link | The link people open. It opens the first browser channel, and the wizard offers the others on its first page |
| Settings (the gear) | “Limit per day” (50 runs unless you change it, with what that costs at most), each message channel’s keyword, and “Create a new link”: the old link and its QR code stop working, in the cloud too |

Where the draft has changes, the dialog says so at the top and leads to “Publish changes”.

One visitor can start 6 runs an hour.

### Channels

A wizard can run page by page, as a chat, as a live conversation on top of the chat, or as a
video call on a stage with the chat beside it. In a conversation or a call, the person talks,
and the wizard talks back and sees the camera. For now, both need an OpenAI API key under
Models. A plugin can add further ways, such as a kiosk page or a messenger.

A wizard you start on the “New wizard” page runs step by step unless you choose more under “How
should it run?”. A wizard without its own choice, such as one from a template or an import, has
the step-by-step page and the chat switched on. You can change the channels later under “Change”
in the share dialog.

Where a channel can’t take a step, the step goes to the wizard’s page. The person gets a link for
a photo, a signature or a sign-in, and comes back afterwards. If nobody can hand a step off (for
example, one that takes minutes on a channel that can’t wait), the row shows “Not possible: …”
under the channel’s name. A channel that still needs something says so in its row:

| The row says | What you can do |
|---|---|
| “Not set up yet” | “Set up” opens the channel’s settings inside the dialog. “Back” returns to the rows |
| “Waiting” | Nothing for now. The channel is waiting for something, for example a number that was requested |
| “Not in your plan” | “See {plan}” or “See the plans” shows the plan that has it |

The cards on the start page show the channels that are on as small icons, the link’s channel
first. Once wizards with two or more statuses are in the space, a row of pills above the cards
narrows them to one status: “Draft”, “Local”, “Live” or “Not in the cloud”.

The link opens the first browser channel that is on. The others answer under their own address
(`/steps`, `/chat`, `/talk` for live voice, `/video` for the video call) and are offered on the
wizard’s first page, for example “Or: Chat”. An address that is switched off sends people to
the link instead.

### WhatsApp, SMS and calls

On engenty.ai a wizard can also run in a WhatsApp chat, by text message and as a phone call,
where the team’s plan includes them. These channels are not part of the open source engenty
wizards. On your computer, you get them through your account in the cloud.

When you switch one on for a wizard, its row in the share dialog shows the number and the
**keyword**. Whoever sends the keyword to the number starts the wizard. “Link” copies a link that
writes the message, and the QR code view draws it. You change the keyword under “Settings”.

- **WhatsApp**: one field per message, buttons for up to three choices and a list for more. The
  person sends a photo or a file in the chat, “send location” for a place, and a voice message
  for a text field. A free message can go out within 24 hours of the person’s last one. A wizard
  that finishes later reaches back with an approved template, or waits for the person’s next
  message.
- **SMS**: text only. Choices come as numbered lines, answered with the number, and a place as a
  typed address. Long texts come as their gist, and every picture, document and the whole result
  as links.
- **Calls**: the speech model talks, as the chat’s live voice does. It asks for one field at a
  time, reads out the choices and reads email addresses and numbers back. If several wizards are
  on for calls, the call first asks which one.

What a channel can’t take (a signature or a sign-in, and by text or phone also a photo or a
file) arrives as a link to the wizard’s page. The conversation goes on once it has been filled in
there. “stop” ends a run in a chat, and the keyword starts a new one.

### Who can open the link

engenty wizards on your computer only answers on `localhost`. The link works on that computer,
not for anyone else. To let others run the wizard:

| Way | How |
|---|---|
| The cloud | Sign in with an [account](./create-account.md). Every version that goes live (the first share, and each “Publish”) then also goes to engenty.ai. Its link there runs on the account’s credits, even while your computer is off |
| Your own server | [Run engenty wizards on a server](./server.md) with a public https address |

### In the cloud

Once you sign in to an account under Settings → Account, every version that goes live also
arrives on engenty.ai. Your avatar then carries a small cloud, and its menu says “Connected to
engenty.ai” with your credits. The share dialog gives the wizard’s address at engenty.ai, which
stays the same when you publish again. Where the cloud doesn’t run this version, the dialog says
so at the top:

| It shows | Means |
|---|---|
| “Version 3 doesn’t run in the cloud.” | Something the wizard needs is missing there. The list says what, and the version before keeps running |
| “Send again” | The last version didn’t arrive, or the space changed. When engenty.ai was the problem, the studio tries again by itself and says when |

Without an account, the dialog says that the wizard runs only on this computer (“Only on this
computer” under “Access”). It greys out the ways others reach it and offers “Sign in” and “Create
account”. “Website” still gives you the WordPress package.

What goes to the cloud and what stays:

| Goes to the cloud | Stays on your computer |
|---|---|
| The published version and its files | Drafts and the chat with the assistant |
| The space’s name, what it says about itself, its colours, facts and logo | Runs and results on your computer |
| The space’s own tables and pages | What the wizards keep: their lists and notes |
| How the link is shared: on or off, runs a day, channels | Connected accounts, keys, the space’s knowledge and its connected systems |

At engenty.ai/studio you see the space and its runs there. A small laptop icon marks the space,
and a note says “You edit this space in engenty wizards on your computer.” The studio there
doesn’t edit it. An account holds one space from one computer. On a new computer, the share
dialog offers “Replace that space”, which removes the old computer’s wizards and their links from
the cloud.

When you delete a wizard here, its copy in the cloud is deleted too. When you switch its link
off here, it is switched off there as well.

### Embed in a website

Under “Website”, the share dialog gives you code to paste into a page’s HTML. Where the wizard
has both the step-by-step page and the chat on, you first choose what the website shows:

| What does the website show? | Shows |
|---|---|
| Step-by-step wizard | The wizard page by page |
| Chat | The wizard as a chat, 640 px high (`data-height` changes that) |

| Where on the page? | Shows |
|---|---|
| In the page | The wizard in that place on the page, as tall as its content |
| Behind a button | Step by step only: a button in that place that opens the wizard in a window over the page |
| As a chat button | Chat only: the wizard’s engenty in the bottom right corner. The chat opens above it |
| As a bubble | Step by step only: a round button at the bottom right of the page that opens the wizard in a window over the page. It is best put in the site’s footer |

```html
<script async src="https://example.com/embed.js" data-wizard="TOKEN"></script>
<script async src="https://example.com/embed.js" data-wizard="TOKEN" data-mode="modal" data-label="Start"></script>
<script async src="https://example.com/embed.js" data-wizard="TOKEN" data-runner="chat"></script>
<script async src="https://example.com/embed.js" data-wizard="TOKEN" data-mode="popout"></script>
<script async src="https://example.com/embed.js" data-wizard="TOKEN" data-mode="bubble" data-label="Questions?" data-text="A quote in 2 minutes"></script>
```

The code only works once the wizard is published and open to anyone with the link. A chat in the
page that is switched off for the wizard shows the step-by-step page instead. The chat button
always opens the chat.

| Attribute | Does |
|---|---|
| `data-label` | The button’s words. Beside the chat button, a short label. For the bubble, its name for screen readers |
| `data-text` | A short line beside the bubble |
| `data-color` | The colour of the chat button and of the bubble |
| `data-height` | The height of a chat in the page, in px |
| `data-page` | The page a run is started on, kept with its result. Without it, the page’s own address is used |

Your website’s own styles reach the button through the class `engenty-wizard-button`, the chat
button through `engenty-wizard-launcher` and the bubble through `engenty-wizard-bubble`. A page
shows only one bubble: a second bubble tag does nothing.

On WordPress the plugin writes this code for you, and its results show the page: see
[WordPress](./wordpress.md).

## Results people share

On the result page, a person can share what they got as a link. The result of a run over the
wizard’s link, and the link to it, are deleted after 7 days. The person can withdraw the link
earlier.

## Move a wizard

Export it as a wizard file (`.wizard`) from its ⋯ menu, and import it in another studio or in
the WordPress plugin. See [Build a wizard](./build-a-wizard.md#take-it-with-you).
