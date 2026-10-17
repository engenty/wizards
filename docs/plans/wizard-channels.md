# Concept: wizard channels

Since 2026-10-13: WhatsApp, SMS and calls are no longer part of the open repository. The
modules `modules/whatsapp`, `modules/sms` and `modules/calls` named below shipped up to v0.4.0;
from then on these channels run on engenty.ai only. The open runtime keeps everything they are
built on: the runners with `problem` and `address`, the SDK's thread door and
`server.speech.conversation()`.

Status: concept, written on 2026-10-08. Built on the branch the same day: the chat runner,
dictate and read aloud, live voice and live video on the web, WhatsApp in chat mode as the
module `modules/whatsapp`, SMS as `modules/sms` (text only; both are surfaces of the SDK's
thread door), live voice on a WhatsApp call and on the phone as `modules/calls` (Twilio
between Meta and OpenAI's SIP endpoint). The companion plan with the hooks, the order and
what each phase
built is `runners-and-voice.md`; the decision steps and views it builds on are
`dynamic-flow.md` (on main since v0.2.26).

One wizard, one run, many doors. A channel is a door with its own shape: what it can show, what
it can take in, how long it can wait, who the person is behind it. The wizard does not change;
the door decides what is native and what is handed to another door.

## What makes doors different

| Axis | Range | Decides |
|---|---|---|
| Surface | none · a text thread · a thread with cards and forms · a full screen | Which field kinds and outputs are native |
| Session | live conversation (seconds of silence hurt) · attended page (minutes with a spinner) · asynchronous thread (hours, days) · headless | How long a step may take, and whether the door must reach back |
| Who owns the UI | we do · a vendor does (Flows, Block Kit, RCS cards) · nobody (phone) | What we render versus what we map |
| Identity | anonymous visitor · a phone number · an account at a vendor · a signed-in user | What the wizard remembers, whether OAuth is possible, privacy |
| Media in | camera, mic, files, location, signature, touch | Which pages need no hand-off |
| Media out | render in place · send as file · picture plus link · link only · read aloud | How results arrive |
| Reach-back and cost | push, template message, DM, SMS, or none: a live door stays on the line · free, per message, per minute | "Continue your last run", long steps, plan gating |

## The six patterns

Two axes carry most of the weight: how live the session is, and how much surface there is.
Plotted on them, the doors fall into six patterns.

| | Pattern | Doors | Built how | When |
|---|---|---|---|---|
| 1 | **Screen, ours** | steps, chat, embed, PWA, the mobile app's WebView, our page inside Telegram's or Messenger's webview | built in | exists |
| 2 | **Live voice, live video** | web (the screen beside it) · a WhatsApp call · a phone call | web built in, calls as plugins | web now, WhatsApp call next, phone later |
| 3 | **Messengers** | WhatsApp (Flows), Slack, Teams, RCS, e-mail | one plugin each | WhatsApp now, the rest later |
| 4 | **Agent host** | Claude Desktop, ChatGPT, Cursor through MCP; the flow widget | exists | exists |
| 5 | **Headless** | API, schedules, webhooks, another wizard | partly exists | exists |
| 6 | **Text only** | SMS | plugin | next, as the hand-off carrier |

### 1 · Screen, ours

- Everything native. The only pattern that draws every field kind, so it ships with them.
- Dictate and read aloud: a mic on the chat's composer, a keyboard shortcut, the wizard's
  messages spoken. An accessibility feature of the chat runner, not a channel. Cheap, first.
- Reach-back: push, "Tell me when it is done". Identity: visitor, or the app's user.

### 2 · Live voice, live video

One conversation engine, several transports. On the web the engenty talks and listens on the
wizard's page with the screen beside it. On a WhatsApp call (Meta's calling API, WebRTC) and on
a phone call there is no screen.

- Pages become questions, choices become spoken lists of at most four, text outputs are read in
  short. Live video adds the camera the model can see.
- Anything visual: on the web the screen takes it, same page. On a WhatsApp call the thread
  takes it, as a Flow or a link. On the phone, an SMS link.
- No call-back for now. A long step keeps the line: "still working" spoken, progress on the
  screen where there is one. Transports without a screen get "cannot" from the matcher for
  wizards with long steps.
- Identity: visitor on the web, the number on a call. Cost per minute, plan-gated.

Live voice in a browser is not a door of its own: the person has a screen, hiding it is
artificial. So on the web it is the chat runner plus the conversation engine, built in and gated
by plan; the same engine later serves the calls through plugins. That removes the separate voice
page from the first plan, keeps every field drawable, and gives live video its screen for free.

### 3 · Messengers

- Vendor UI: WhatsApp Flows and Slack modals carry most pages natively; RCS carries text, cards,
  media and links, no forms.
- Asynchronous: a run can span days. Identity is the vendor's account. Reach-back is a template
  message or a DM, often paid.
- Outputs as media within limits, pictures of widgets with a link, or the share page.

### 4 · Agent host

Someone else's LLM drives the run with our tools; someone else's chat is the surface. The same
shape as pattern 2 with a screen: `waitingFor`, `inChat`, `browserUrl`.

### 5 · Headless

No person. Pages are answered up front or the wizard has none. Asks time out. The wizard as a
workflow; outputs land in lists, files and connected systems.

### 6 · Text only

- No buttons, no media, no forms. Choices are numbered ("reply 1, 2 or 3"), every picture and
  file is a link, long text is cut to the gist.
- Its real job: the carrier of hand-offs and reach-back for the phone, and the floor every
  other door falls back to. A wizard run entirely by SMS is possible, slow, and fine for two or
  three short questions.
- Identity is the number, paid per message, asynchronous.

### When

| Now | Next | Later | Exists |
|---|---|---|---|
| Dictate and read aloud on the chat. Live voice on the web, live video after it. WhatsApp. The run contract underneath | Live voice on a WhatsApp call, same plugin and same engine. SMS as the hand-off carrier | Phone, Slack, Teams, RCS, e-mail, channel starters | Steps, chat, embed, mobile app, MCP host, headless |

Dictate needs nothing new. Live voice needs one model class. WhatsApp needs the run contract. The
WhatsApp call rides on both.

## What a wizard needs from a door

The wizard does not declare channels. Its steps already say what they need, and the runtime
reads it: a signature needs touch, a film needs a screen to be reviewed, a connection field needs
a browser for OAuth, a PDF needs a screen or a link. The question per door is only how much of
that is native.

| Kind of need | Examples | If the door lacks it |
|---|---|---|
| Consume here | Typing a value, picking an option, taking a photo, signing, looking at a draft before accepting it | Hand off to a door that has it, same run. In a live call without a screen: "cannot" |
| Deliver | A PDF, a film, a dashboard, a ZIP of files | Never a blocker. It goes out as media, as a picture with a link, or as the share page. "A voice chat producing a PDF" is fine; the PDF arrives by SMS or e-mail |

The matcher's three outcomes are about consumption: full, hands off at a step, cannot. "Cannot"
is rare: headless with a page, or a live door without a screen and a step that needs one. Since
v0.2.26 the AI can decide which branch a run takes and which fields a page shows, so the matcher
walks every reachable step and says "may hand off at".

The view step (v0.2.26) is the output every door likes best. Its parts are typed data, not
pixels: key figures and facts are read aloud on live voice, become cards on WhatsApp and Slack,
text on SMS, and are drawn on the screen. A widget stays a picture with a link everywhere but the
screen.

### One wizard across the doors

A damage report: five pages (contact, what happened, photos, where, signature), an AI step that
drafts the report, a review, a result with a PDF and a map widget.

| Step | Screen | Live voice, web | Phone, later | Live voice, WhatsApp call | WhatsApp | SMS | Slack | MCP host |
|---|---|---|---|---|---|---|---|---|
| Contact: name, e-mail, phone | native | spoken; e-mail read back | spoken; e-mail read back | spoken; number known | Flow screen | three messages | modal | in chat |
| What happened: long text, date | native | spoken | spoken | spoken | Flow screen | two messages | modal | in chat |
| Photos | camera | camera on the screen | SMS link | sent in the thread after the call | PhotoPicker, or sent in the chat | link | file input | run page |
| Where | location | address spoken, or the screen | address spoken | address spoken | "send location" button | address typed | typed address | typed address |
| Signature | finger | finger, on the screen | SMS link | link in the thread | link | link | link | run page |
| AI drafts the report, 3 min | spinner, push | "still working" spoken, screen shows notes | stays on the line, spoken notes | stays on the line, spoken notes | a message when done | a message when done | a DM when done | host waits with `get_run` |
| Review the draft | edit, accept, redo | read in short, accept or redo with a note | read in short, accept or redo | read in short, or the draft in the thread with buttons | text plus three buttons | the gist, "reply OK or NEW" | message plus buttons | host shows it, `review_step` |
| Result: PDF, map widget | download, widget | on the screen | SMS link to the share page | PDF and map picture in the thread | PDF as a document, map as a picture with a link | link to the share page | PDF uploaded, map picture | download links |
| **Fit** | full | full | two hand-offs | one hand-off, in its own thread | one hand-off | two hand-offs, slow | one hand-off | two hand-offs |

### The author's levers, in order

1. **Accept the hand-offs.** The default. The editor shows them; nothing to do.
2. **Ask the assistant to adapt the wizard.** "Make this run by phone" is a request to the
   architect: it reads the fit report and proposes edits. Replace the signature with a spoken
   confirmation and a later e-signature link, make the photos optional, add "send me the PDF" to
   the result. One definition, still.
3. **Per-step hints**, few and optional: "optional on voice", "deliver by link", a spoken prompt
   where the label reads badly aloud. The model in the middle rephrases labels anyway, so most
   wizards need none.
4. **Start from a channel starter.** "Build a real-time video chat wizard" is a starter, not a
   channel: pages designed for a camera and a conversation, few typed fields, outputs delivered by
   link. Starters exist; these are new ones.

Not a lever: a copy of the wizard per channel. It drifts, and the data model keeps one
definition on purpose.

## How it is structured

Three layers. Doors differ; the contract below them does not.

| Layer | Holds |
|---|---|
| Doors | Screen runner (steps, chat, dictate) · live voice and video (web built in; WhatsApp call, phone as plugins) · SMS (plugin) · messengers (one plugin each) · agent host (MCP, exists) · headless (API, exists) |
| Run contract, one for every door | runs API (start, answer, review) · report (`waitingFor`, outputs) · hand-off (ticket, same run) · identity (visitor, number, account) · reach-back (push, template, DM, SMS) · capability match (full, hands off, cannot) |
| Below | The run engine: steps, asks, events, credits, the one run every door sees. What the wizard remembers: lists, files, accounts, keyed by person, merged when a hand-off links two identities |

Two parts of the contract are new to this concept: an identity bridge, so a phone number and
the visitor who opens the SMS link are one person to the wizard, and reach-back, so a long step
can tell the person on the door they came from.

## Three people

### Admin, runs the install or the tenant: Settings → Channels

- One card per door: live voice and video (which model serves them, who may use them), the
  WhatsApp account and number, the SMS provider, later the phone and the Slack app.
- What it costs this month: minutes, template messages, per door.
- In a Manage-App tenant, the plan decides which doors exist. Each door is a plugin the plan
  switches on, as contacts is today.

### Owner, builds in the studio: Editor → "Where it runs"

- A panel per wizard: every door the tenant has, its fit (full, hands off at "Signature",
  cannot), a switch, and the address once on: the link, the sub-path, the QR code, the `wa.me`
  link with the wizard's keyword, the phone keyword.
- "Test here" opens the test drawer in that door: chat in voice mode, a simulated WhatsApp
  thread.
- The assistant takes "make it run by phone" and edits. The marketplace shows the doors as
  badges. Results carry the door they came through; filter by it.

### Customer, runs the wizard: any door, one run

- Arrives by link, QR, number or messenger. If several doors are on, the first screen offers
  them: "Talk to it", "Continue on WhatsApp".
- A hand-off is a link to the same run; nothing is asked twice. Back on the first door, it picks
  up where it left off.
- Results come through the door they are in, plus a link that works everywhere. "What this
  wizard remembers" is theirs on every door once two identities are linked.

### In the studio

Nothing new to learn. The share dialog grows a short list under "Looks"; the settings get one
section; the editor gets one line.

| Where | What is added |
|---|---|
| Share dialog | Under Looks (Steps, Chat): a "Channels" list, one row per door the tenant has: name, fit ("Full", "Hands off at 'Signature'", "Not set up · Settings → Channels"), a switch, and the address once on (`/w/<token>/talk`, `wa.me/…` with the keyword, QR). Embed below, unchanged |
| Settings → Channels | Heading outside the cards. One card per door: the model or the number, this month's usage, Connect or Disconnect. Doors that are not built yet are listed greyed |
| Editor, below the checks | One line from the matcher: "Runs as steps, chat, live voice and live video. On WhatsApp it hands off at 'Signature'." with a link that asks the assistant to adapt the wizard |
| Test drawer | The Steps / Chat switch gains the channels that are on; WhatsApp tests as a simulated thread, no number needed |
| The customer's first screen | As today, plus one line of alternatives below "Let's go": "Talk to it instead · Continue on WhatsApp", only for channels that are on |

### One run, two doors

A person scans a QR code, lands on WhatsApp with the wizard's keyword, fills two Flow screens
with photos. The signature step sends a link into the thread; they sign on the screen, in the
same run, and are back on WhatsApp by themselves. The AI step takes three minutes; a message
says it is done, free inside the 24-hour window. The draft arrives as text with three buttons,
the PDF as a document, the map as a picture. The run id never changes; the WhatsApp account and
the visitor who opened the link become one person to the wizard.

## Video: what is possible

| Possible now | How |
|---|---|
| The model sees the camera | Realtime models take image frames in a session (OpenAI's realtime model, Gemini Live). "Show me the label" and the model reads the serial number into the field; "is the dent on the left?" and it answers |
| Frames into fields | "Hold it still" captures a frame, uploads it to the run; the image field is filled for the record, with the AI label where a model changed it |
| The bot's face | The engenty, moving with its speech. A synthesized human face adds cost and unease and no information |
| The bot's screen | The run page beside the call. The bot "shows" by advancing the run: the draft, the map, the PDF |

| Not sensible | Why |
|---|---|
| Reviewing a generated film by voice | A film is judged by watching it. The review stays on the screen; voice can only say "accept" or "redo" |
| Screen sharing from the bot | There is nothing to share that the run page does not already show |
| Live video as an engine of its own | It is live voice with the camera switched on. One engine, one toggle |

Where it pays: inspections, claims, on-site checks, guided setup of a device, anything where
the person's hands are busy and the camera is the best input.

## Naming

| In the product | In code | Why |
|---|---|---|
| Channels (Kanäle): the doors an admin connects and an owner switches on | `runner`, as today for the UI that shows a run | "Channel" is what admins know from support tools; "runner" is what the code already calls it |
| Live voice, Live video: channels with transports (web, WhatsApp call, phone) | `live` runner with a `transport` | One engine; the owner switches the channel on, the transport is where the person is |
| Dictate, Read aloud: accessibility of the chat | mic and speech on the composer | Not a channel; always there once the models are set up |
| Where it runs: the panel in the editor | `runnersFor(definition)` | Says what the owner wants to know, not how it is computed |

## What this changes in `runners-and-voice.md`

| In the plan | Now |
|---|---|
| Voice as a plugin page at `/w/<token>/talk` | Live voice is a channel with transports. On the web it is built into the chat runner, gated by plan; `/w/<token>/talk` opens it. The WhatsApp call and the phone are its plugin transports later |
| `speech.session` for plugins | Stays, for the call transports. On the web the runtime mints the session through its own model routing |
| Before phase 3 | Dictate and read aloud on the chat. Transcription and speech models exist; nothing new underneath |
| Phase 3 "Voice in the browser" | Becomes "Live voice, web": the conversation model class, the mic, the engenty face, tool calls into the run. No plugin, no iframe |
| Phase 4 "Video call" | Becomes "Live video, web": camera frames to the model and into fields |
| "I'll call you back" | Dropped for now. A live door stays on the line with spoken notes; a transport without a screen gets "cannot" for wizards with long steps |
| Phase 5 Phone, Phase 6 Messengers | Reordered: WhatsApp thread, WhatsApp voice and SMS before the phone |
| No SMS door | SMS is its own pattern and plugin: the text-only door, and the carrier for hand-offs and reach-back of the phone |
| Hooks A, C, D | Unchanged. Add to the contract: `runs.start({ person: { channel, id } })` and the identity link on hand-off; `runs.upload`; a reach-back hook per runner; `wizard.published` for Flow generation |
| Share dialog "Looks" | Becomes the "Where it runs" panel with fit, switches, addresses and "Test here" |
| Marketplace capability "by voice" | Badges per door from the same matcher |

## Open questions

- **Identity linking and privacy.** Linking a phone number to a visitor on hand-off is a merge of
  two "what this wizard remembers" scopes. Needs a line in the privacy text and the GDPR work
  already on the roadmap.
- **How long is "long" for a live door without a screen.** The matcher needs a number per step
  kind to say "cannot"; the step estimates that exist for credits can carry a time too.
- **WhatsApp voice.** Answered on 2026-10-08: Meta's calling API has a SIP mode that sends a
  user's call as a SIP INVITE to a server of the business's choosing, with the business number
  as the SIP user; OpenAI's SIP endpoint routes by project id, so the two cannot meet directly.
  A Twilio SIP domain in between takes Meta's INVITE, asks the runtime for TwiML, and dials
  OpenAI's project with a header that names the call; the runtime accepts the call and drives
  the run over OpenAI's WebSocket. No media relay, no WebSocket on public routes. Built as
  `modules/calls`, the phone with it. Meta's SIP needs the app in Live mode and TLS on 5061;
  still to check against a real number: whether Meta's digest challenge and Twilio's domain
  auth meet (Meta's IP allowlist in the domain's access list), and the EU SIP endpoint.
- **Which messenger first.** WhatsApp has the richest native forms, the clearest demand, and voice
  on the same account; Slack is the easiest to build. Telegram is nearly free because it opens
  our page.
- **Starters per door**: "video inspection", "phone intake", "WhatsApp lead". Content work, not
  framework work.
