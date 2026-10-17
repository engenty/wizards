# Plan: runners, channels and the plugin hooks they need

Since 2026-10-13: WhatsApp, SMS and calls are no longer part of the open repository. The
modules `modules/whatsapp`, `modules/sms` and `modules/calls` named below shipped up to v0.4.0;
from then on these channels run on engenty.ai only. The open runtime keeps everything they are
built on: the runners with `problem` and `address`, the SDK's thread door and
`server.speech.conversation()`.

Status: phase 1 is on the branch; phase 2 built on 2026-10-08 (branch
`claude/wizards-vs-bot-ui-1044fe`, off main): the run report lists a page's shown fields, the
runner registry with capabilities and `runnersFor`, the share dialog's Channels list, sub-paths
with the redirect, `wizards.server.runs` and `registerRunner` with page runners served at
`/w/<token>/<runner>`, the run's `runner` column, tests, the plugin docs' Runners page. Dictate and read aloud on the chat built the same day (browser voices and recognition, a run-scoped
transcribe route as the fallback), and live voice on the web as the built-in runner `talk`: the
runtime mints the realtime session on the tenant's OpenAI key (`POST /api/runs/:id/talk`), the
browser talks to the model over WebRTC and runs its tool calls against the run's own routes
(`apps/web/src/runner/live-voice.ts`); offered at `/w/<token>/talk` where switched on. Live video the same way: the camera is a toggle in the conversation, frames go to the model when the
person speaks and on its `look`, `take_photo` fills a photo field; and, after it turned out a
camera toggle in a chat does not read as a video call, the call screen as its own built-in door
`video` at `/w/<token>/video`: a stage with the camera and the engenty, captions from the
model's transcripts, mute/camera/leave, the chat beside it as the screen. Not yet a
model class of its own, not on credits, no per-minute booking. WhatsApp built the same day as
the module `modules/whatsapp` (chat mode): Meta's Cloud API with the tenant's own number, the
webhook on a public route, a keyword per wizard, one field per message with buttons, lists,
the location request and media in the thread, hand-off links for what the thread cannot take,
results as pictures, documents and a link; with it the hooks `registerShareSection`,
`PluginRunner.problem`, `runs.report({ draft })`, `runs.wizards`, `runs.transcribe` and the
report's `lang` and `picture`. `registerChannelAddress` turned out unnecessary: the plugin keeps
the keyword table itself and asks `runs.wizards` which wizards are on. SMS followed the same
day (`modules/sms`, Twilio, text only), and the conversation both share is now the SDK's
`ThreadDoor` (`@engenty/wizards/plugin/thread`), each messenger a `ThreadSurface`. The
WhatsApp call and the phone followed as `modules/calls`: Meta's SIP mode → a Twilio SIP domain
→ TwiML → OpenAI's SIP endpoint, the plugin drives the run over the WebSocket to the call
(`server.speech.conversation()`), links by SMS; the open question "relay or direct" is
answered with "neither: Twilio in between", since Meta's INVITE names the business number as
its SIP user and OpenAI routes by project id. Not yet: Flow mode and `wizard.published`, the
editor's one-line notice, the marketplace badges; none of the three modules was exercised
against a real number or call. Written on 2026-10-08, checked against v0.2.26. The
concept behind it (the six channel patterns, the three people's view) is `wizard-channels.md`;
read that first. The chat runner it merges in phase 1 is on branch
`claude/wizard-chatbot-ui-variants-de6db6`.

Scope: how a run is driven from more than the stepped page — the chat runner, live voice and
video on the web, WhatsApp, SMS, the phone — and what the plugin framework has to expose so the
plugin doors can be built without touching the runtime's code.

## Decisions

| | Decision | Why |
|---|---|---|
| Steps and chat | Built in | They draw every field kind, so they ship with the field kinds |
| Live voice, live video | Built into the chat runner on the web, plan-gated; the WhatsApp call and the phone are plugin transports of the same engine | The person in a browser has a screen; a plugin page would hide it |
| WhatsApp, SMS, phone, Slack | One plugin each | Optional, paid, vendor UI; they hand off to the built-in page for what they cannot do |
| Framework work | A run API for plugins, a runner registry with capabilities, sub-paths with a fallback | Listed as hooks below |
| Addresses | `/w/<token>` opens the default runner; `/w/<token>/<runner>` only for runners the owner switched on | The token names the wizard, not a UI |
| Capabilities | The runner declares, the runtime matches per wizard | Wizards are many, runners few; the author declares nothing per channel |

### The rule for runners

| | Steps | Chat | A plugin door |
|---|---|---|---|
| Draws every field kind, ask and review itself | yes | yes, `control` fields inline | no, hands off to `browserUrl` |
| Coupled to `definition.ts` release for release | yes | yes | only to the report shape |
| Optional per tenant, paid, or third-party | no | no, a switch in the share dialog | yes |
| Rendered by the wizard's public page | yes | yes, `/w/<token>/chat`, `popout` | no, its own page or no page |
| When it is missing | nothing works | falls back to steps | falls back to the hand-off page by design |

A runner that must draw every field kind is built in, because it ships with the field kinds. A
runner that hands off can be a plugin, because the built-in one is its fallback. Moving steps and
chat into `modules/` later is a relocation, not a rewrite, once they are registrants of the same
contract; it would add a plugin host on public pages (one more round trip per wizard open, a
new blank-page failure mode) and is not done now.

## Where runs are driven from today

| Driver | Reads | Through |
|---|---|---|
| Steps page, chat page | `RunView`, the full view | `GET /api/runs/:id` with a ticket or the visitor cookie |
| MCP host (Claude Desktop, Cursor …) | `runReport`: `waitingFor`, `inChat` per field, `browserUrl` | `run_wizard`, `answer_page`, `review_step`, `answer_ask`, `control_run` in `apps/runtime/src/mcp/tools.ts` |
| A plugin's server half | nothing: it sees a run id only when one of its tools is called | — |

Two shapes, and no path for plugins. The MCP contract is already the right one for every door
that is not a screen: it says what the run waits for, which fields can be answered without a
screen, and where to send the person for the rest.

## Target

Two changes. The MCP tools' functions become a run API every plugin can call. And the live
doors are one conversation engine: on the web inside the chat runner, on a call inside a plugin.

Four drivers, one engine: steps and chat keep reading `RunView`; the MCP host and a plugin's
server half use the runs API; both reach `engine/runner.ts`, `asks.ts`, `events.ts`.

Live voice on the web: the chat runner holds the mic and the engenty face beside the thread. The
browser exchanges audio with the realtime speech model over WebRTC and receives the model's tool
calls on the data channel; the page posts each tool call to the runtime, which answers it into
the run (`submitPage`, `reviewStep`, `answerAsk`) and streams the run's notes back; the runtime
mints the model session through its own model routing. Audio never touches the runtime, and
there is no WebSocket. The same engine on a WhatsApp call or a phone call lives in a plugin and
uses `speech.session` and the runs API below.

## Addresses

| Address | Opens | Rule |
|---|---|---|
| `/w/<token>` | The wizard's default runner | The owner picks the default in the share dialog. Steps until changed |
| `/w/<token>/chat` | The chat runner | Only when switched on for this wizard. Built in, rendered in place |
| `/w/<token>/talk`, `/w/<token>/call` | The chat runner with live voice, with live video | Only when switched on. Plan-gated |
| A sub-path that is off or unknown | Redirects to `/w/<token>` | Never a dead link in a QR code or an old message |
| `embed.js` | `data-runner="chat"` builds `w/<token>/chat?embed=…` | Replaces `data-ui`. A runner that is off falls back to the default inside the frame |
| WhatsApp, SMS, phone, Slack | No address of their own | A number, a bot user, a channel. The plugin keeps "this address runs wizard X" per tenant, bound in the share dialog |

Runner names are reserved beside the existing sub-paths `runs`, `icons`, `manifest.webmanifest`.
The chat branch's `?ui=chat` moves to `/w/<token>/chat` before it merges.

## Capabilities

The runner declares what it can do. `runnersFor(definition)` walks every reachable step once
per runner and returns full, hands off (at which steps), or cannot. The editor and the share
dialog show it; the marketplace later.

| Dimension | A runner declares | Exists today as |
|---|---|---|
| Input | The field kinds it takes itself | `FIELD_WAYS` in `packages/shared/src/definition.ts` (typed, tapped, value, device), read by the chat runner and by `inChat` for MCP hosts; on the chat branch |
| Output | What it shows itself, what it shows as a picture, what it can only link | The result step's formats per kind; signed links in `runReport` |
| Asks | ConfirmAsk yes or no. LoginAsk only in a browser | `RunAsk` |
| Review | Accept, new version with a note, edit by hand | The review step's settings |
| Waiting | Stays through a long step, or must be told when it is done | `ASK_TIMEOUT_MS`, push |
| Hand-off | How it gets a link to the person: screen, thread, SMS, push | `browserUrl` |

Output is where doors differ most, and the mapping is mechanical: the runtime already produces
every format and signs the links; a door only decides what to attach, what to picture and what
to link. The share page `/s/<token>` is the floor every door can reach. Views (v0.2.26) are
typed parts and map to text, cards or speech without a picture.

## Hooks to add to the plugin framework

### A · Run API for the server half — new

`wizards.server.runs`. The functions behind the MCP tools, lifted off the owner's user id onto
the public path: wizard token, visitor id, turnstile and limits as in `POST /wizards/:token/runs`.

| Hook | Signature | Wraps today | Used by | Phase |
|---|---|---|---|---|
| `runs.start` | `({ token, person: { channel, id }, answers?, runner }) → { runId, ticket }` | `createRun` in `engine/runner.ts`; the public start in `routes/runs.ts`. `runner` is kept on the run; `person` keys what the wizard remembers | WhatsApp webhook, call start | 2 |
| `runs.report` | `(runId, { waitSeconds? }) → RunReport` | `runReport` and `waitingFor` in `services/runs.ts`: status, `waitingFor` (page with the fields **shown**, their `kind`, `known`, `options`; review; ask), outputs clipped with signed links, `browserUrl` with the ticket, credits. Today `waitingFor` lists every field; since v0.2.26 fields can be hidden by a condition or chosen by a decision, so the report lists the shown ones and accepts a page in several turns when a field's `when` reads another field of the same page | Every turn; the stateless webhook | 2 |
| `runs.answerPage` | `(runId, stepId, values) → RunReport` | `submitPage`, with the refusals the MCP tool returns | Tool call from the model, a Flow reply | 2 |
| `runs.review` | `(runId, stepId, { accept } \| { regenerate: stepId, note } \| { edit: stepId, text })` | `reviewStep` | "Fine" / "make it shorter" | 2 |
| `runs.answerAsk` | `(runId, askId, { type: "done" \| "skip", remember? })` | `answerAsk` in `engine/asks.ts`. ConfirmAsk only; a LoginAsk is a hand-off | "Allow it" | 2 |
| `runs.control` | `(runId, "back" \| "retry" \| "cancel")` | `goBack`, `retry`, `cancel` | "Go back", hang-up | 2 |
| `runs.subscribe` | `(runId, listener) → unsubscribe` | `subscribe` in `engine/events.ts`; the signal carries the `RunNote`, spoken or sent in the person's language | Notes while an AI step works | 2 |
| `runs.handoffUrl` | `(runId) → string` | `browserUrl` with `runTicket` from `secrets/signing.ts`, so a plugin cannot build it wrong; links the door's identity to the visitor who opens it | Link into the thread, SMS | 2 |
| `runs.upload` | `(runId, { data, mime, name }) → assetId` | `saveAsset` in `files/storage.ts`, as `POST /api/runs/:id/uploads` does | Inbound media from WhatsApp, a frame from the camera | 2 |

`RunReport` moves to `packages/shared` so the MCP tools, the SDK and the hand-off read one shape.
Its field entries carry `kind`; `inChat` stays for the MCP hosts. A plugin door owns its own
field set.

### B · Speech for the server half — new

`wizards.server.speech`. Today `server.generate` is text only, while `models.ts` resolves
speech and transcription models for the tenant.

| Hook | Signature | Wraps today | Used by | Phase |
|---|---|---|---|---|
| `speech.session` | `({ instructions, tools, voice?, lang }) → { clientSecret, model, expiresAt }` | Nothing yet. A new model class **conversation** on the Models page, served over credits or an own key; billed per minute. The web runner uses the same routing directly | Call transports | 5 |
| `speech.transcribe` | `({ data, mime, lang? }) → { text }` | `transcriptionModel` in `models.ts` | Phone path, recordings | 5 |
| `speech.speak` | `({ text, voice?, how? }) → { data, mime }` | `speechModel` in `models.ts` | Phone path (TwiML plays a file) | 5 |

### C · Runner registry and capabilities — new

| Hook | Signature | Where it lands | Used by | Phase |
|---|---|---|---|---|
| `server.registerRunner` | `({ id, label: { de, en }, kind: "page" \| "channel", path?, capabilities: RunnerCapabilities, page?: (request) => Response, notify?: (runId, note) => Promise<void> })` | Registry in `plugins/registry.ts`, taken back on reload like tools. A `page` runner is served at `/w/<token>/<path>`; a `channel` runner has no address. `notify` is its reach-back | Every plugin door | 2 |
| `RunnerCapabilities` | `{ input: FieldKind[], output: { shows: OutputKind[], pictures: OutputKind[] }, asks: ("confirm" \| "login")[], review: ("accept" \| "regenerate" \| "edit")[], waits: boolean, handoff: ("screen" \| "thread" \| "sms" \| "push")[] }` | `packages/shared/run.ts`. The built-ins declare theirs in code | `runnersFor` | 2 |
| `runnersFor` | `(definition) → { runner, outcome: "full" \| "handoff" \| "no", steps: { id, title, why }[] }[]` | `services/runners.ts`, one walk over every reachable step per runner (branches the AI decides count as reachable). Also behind `GET /api/studio/wizards/:id/runners` and in `validate_wizard` | Editor line, share dialog, marketplace later | 2 |
| Sharing: default and enabled runners | `{ runner: string, runners: string[] }` on the wizard's sharing settings | Beside the fields `set_sharing` already writes; not in the definition | `/w/<token>` picks the default; sub-paths exist for `runners` | 2 |
| `PublicWizard.runners` | `{ id, label, url }[]`, the enabled ones, default first | `packages/shared/run.ts`; filled in `GET /wizards/:token` | The first screen's "Talk to it instead"; `embed.js`; the mobile app | 2 |
| Share dialog | Looks as today, then "Channels": one row per door with fit, switch, address | `studio/editor/ShareDialog.tsx` reads the list and the outcomes | Owner | 2 |
| `studio.registerShareSection` | `({ runner, component })` | Built: the studio half draws its part under the runner's row of the share dialog once the runner is on: the keyword, the link, the QR code | Channel plugins | 3 |
| `server.registerChannelAddress` | — | Dropped: a plugin's public route already runs inside the tenant of its address, and `runs.wizards(runner)` lists the wizards that are on; the plugin keeps its keyword table itself | WhatsApp, SMS, phone | 3 |
| `PluginRunner.problem` | `() => string \| null` | Built: asked per tenant where the runners are listed; a runner that is not set up (no number connected) cannot be switched on | Channel plugins | 3 |
| `run.runner` column | `"steps" \| "chat" \| <runner id>` | `db/schema.ts`; set by `runs.start` and the public start; shown on the space's results | Results page, call log | 2 |
| `on("wizard.published")` | `PluginWizardEvent` with the definition and version | `plugins/events.ts` | WhatsApp regenerates its Flows per page | 3 |

### D · Addresses and fallback — new

| Where | Behaviour | Phase |
|---|---|---|
| `/w/<token>` | Renders the wizard's default runner. Steps and chat in place; a plugin page runner by serving its `page` there | 2 |
| `/w/<token>/<path>` | Only for runners in the wizard's `runners`. Off or unknown: redirect to `/w/<token>` | 2 |
| `embed.js` | `data-runner="chat"` replaces `data-ui`. Builds `w/<token>/chat?embed=…`; the redirect above is the fallback | 2 |
| Chat branch | Done on its branch: `/w/<token>/chat`, a run at `/w/<token>/chat/<runId>`, `data-runner="chat"`, `data-mode="popout"` loads the chat. Always on for now; the per-wizard switch is phase 2 | 1 |
| Marketplace | Doors as capabilities from `runnersFor`, shown like "film" is today. Closed app | later |

### E · What already serves a plugin door

| Need | Framework today |
|---|---|
| A page nobody signs in to | A public route returns a `Response`: HTML, SSE. `routes/plugin-public.ts` |
| Webhooks from a vendor | Public routes, 4 MB body, token in the path |
| Pro only, per tenant | `PLUGINS_DEFAULT` and the Manage-App's `modules` per tenant, as for contacts |
| Settings: number, provider key, voice | `studio.registerSettingsSection` |
| Call log, minutes and messages per run | `registerMigrations` tables, `on("run.done")`, `registerSpaceSection` under results |
| A text model for a slow path | `server.generate` |

### F · Deliberately not in this plan

| Item | Why not now |
|---|---|
| `@engenty/wizards/plugin/runner`: the field controls as a bundle for plugin pages | No plugin draws fields; they hand off. A plugin page has no studio to borrow React from, so this would be a bundle of its own with versioning the docs otherwise avoid |
| Plugin code on public pages | Stays ruled out. A plugin page runner is served whole at its sub-path; nothing is loaded into the steps or chat page |
| WebSocket on public routes | Only a relay for a vendor's audio leg would need it (Twilio media streams, maybe the WhatsApp call). Not yet |
| New step or field kinds from a plugin | Unrelated to runners; the docs list it as not there yet |
| "I'll call you back" | A live door stays on the line with spoken notes; a transport without a screen gets "cannot" for wizards with long steps |

## The doors

### Live voice and live video on the web — built in

- The chat runner gains a mic and the engenty face. A session with the conversation model class
  is minted by the runtime; the browser speaks WebRTC with the model; the model's tool calls
  (`answer_page`, `review_step`, `answer_ask`, `take_frame`) are posted to the runtime and answered
  into the run; notes come back as they do today and are spoken.
- Input the model takes itself: text, textarea, number, select, multiselect, toggle, date, an
  address; e-mail, url, colour it infers and reads back. Photos, files, signature, connection,
  lists and any sign-in stay on the screen, same page. Reviews of text are read in short;
  everything else is on the screen.
- Live video switches the camera on: frames go to the model ("show me the label"), and
  "hold it still" uploads a frame into the image field.
- Dictate and read aloud come first and need neither: a mic on the composer that transcribes
  into the field, a shortcut, the wizard's messages spoken with the speech model.

### WhatsApp — plugin

Two modes in one plugin. Chat mode first: one field per message, three reply buttons or a
ten-row list, media in and out, the "send location" button. Flow mode second: on
`wizard.published` the plugin generates one Flow per page through the Flows API (text, number,
e-mail, date, dropdown, checkboxes, opt-in, photo and document pickers; `If` and `Switch` for a
field's `when`) and keeps the ids per wizard version. Needs a WhatsApp Business Account, business
verification and endpoint encryption keys. One number serves many wizards: `wa.me/<number>?text=<keyword>`
pre-fills the first message; the share dialog shows the link and its QR code. The person's first
message opens the 24-hour window; a run inside it costs nothing today. A step finishing after a
day of silence needs an approved utility template, paid per message. Twilio carries buttons,
lists and Flows through its Content API, so one provider can serve WhatsApp, SMS and the phone.

| Field kind | On WhatsApp |
|---|---|
| text, textarea, number, email, url, date, select, multiselect, toggle | A Flow screen, natively; in chat mode one message each, buttons and lists for choices |
| image, file | PhotoPicker, DocumentPicker in the Flow; or sent in the chat, pulled with `runs.upload` |
| location | The "send location" button in the chat |
| voice note | The person sends a voice message; the runtime transcribes it as today |
| signature, line items, list editing, connection, LoginAsk | Hand off to the run page, link in the thread |
| ConfirmAsk, review | Three reply buttons: Allow / Don't; Looks good / New version / Edit |
| Outputs | Image, PDF, MP4 as media within the limits (5, 100, 16 MB). Views as text and cards. Widgets and dashboards as PNG plus a URL button to the full HTML. Everything else a link to the share page |

### SMS — plugin

Text and links only. Numbered choices, the gist of long text, every picture and file a link.
Its job is the hand-off and reach-back carrier for the phone and the floor every door falls
back to. Same provider as the phone.

### Live voice on a WhatsApp call, the phone — plugins, later

The same conversation engine with `speech.session` and the runs API, no screen. Hand-offs go
into the WhatsApp thread or by SMS. The phone needs `transcribe` and `speak` for a TwiML speech
gather path (plain HTTP, stateless, each webhook calls `runs.report`), or a media-stream relay
with the WebSocket this plan leaves out.

## Checked against the decision steps (v0.2.26)

| Landed | Touches | The plan says |
|---|---|---|
| A field shown only under a condition (`when`), also on another field of the same page | Every door that asks one field at a time: chat, live voice, WhatsApp Flows, MCP hosts | The report lists shown fields and `known`; a page may be answered in several turns. The chat runner evaluates the page's conditions as it goes, with the shared `shownFields`. Flows map it to `If` and `Switch` |
| Choices from earlier data (`optionsFrom`) | Choice fields everywhere | The report carries `options`. WhatsApp lists hold ten rows, voice reads four; beyond that the door asks for a word and matches |
| Fields and groups the AI picks when the run reaches the page (`decidedFields`, `pages[id].shown`) | Same, plus the note "Choosing the right questions…" | Shown set from the report; the note is spoken or sent like any other |
| Branches with a statement the AI decides, loops with a maximum, AI steps per row | `runnersFor` | The matcher walks every reachable step; wording "may hand off at". Loops add nothing |
| The view step: key figures, facts, a list with pictures, a table, a chart; JSON download only | Outputs on every door | The most channel-friendly output: typed parts read aloud, cards on WhatsApp and Slack, text on SMS, drawn on the screen. Add a PNG render of a view, like widgets and dashboards have, for the picture-plus-link case |
| The chat runner branch sits on v0.2.25 and changes `RunView`, `engine/runner.ts` and the runner files, which v0.2.26 changed too; v0.2.26 adds `runner/surface.tsx` | Phase 1 | Done on the branch (78afec8): fields asked with `shownFields` and recomputed after every answer, decided fields and options from the view, views through `OutputView`, the new notes in the working bubble |

Found while checking, and confirmed by the chat session: the MCP `waitingFor` in `services/runs.ts`
lists every field of a page, hidden and undecided ones included. The run API in hook A fixes that
for every door at once.

## Order

| Phase | Work | Gate |
|---|---|---|
| 1 · Merge the chat runner | On the branch already: rebased on v0.2.26, conditions, decided fields, options and views in the thread, `/w/<token>/chat`, `data-runner`, `FIELD_WAYS`, `RunView.answered`, `popout`, `avatar.svg`; biome, tsc and 308 runtime tests green. Left: merge, release. Not checked in a browser there: options from data, decided fields, a view's regenerate button | The chat UI on main, at its final address, with a conditional field appearing mid-page |
| 2 · Framework hooks | A (runs API), C (registry, `RunnerCapabilities` for steps and chat, `runnersFor`, sharing default and enabled, share dialog, `run.runner`), D (sub-paths, redirect, `embed.js`); `RunReport` into `packages/shared`; tests in `apps/runtime/test/plugins.test.ts` | A test plugin registers a page runner and runs a wizard end to end through the API; the editor shows "may hand off at …" for a wizard with a signature |
| 3 · Live voice, web | Dictate and read aloud first. Then the conversation model class and its credit price, the mic, the engenty face, tool calls into the run, the live-voice capability set, `/w/<token>/talk` | A wizard in the voice set runs by voice start to result; a photo field is taken on the screen without leaving the page |
| 4 · Live video, web | Camera track, frames to the model, `take_frame` into image fields | A receipt held to the camera lands in the image field |
| 5 · WhatsApp | Chat mode built (`modules/whatsapp`): webhook on a public route with the signature check, the keyword table and `runs.wizards`, media in with `runs.upload`, voice messages with `runs.transcribe`, pictures out with the report's `picture`, `registerShareSection` for the keyword and the QR code, a utility template for reach-back after a day. Still open: Flow mode on `wizard.published` | Done in the test runtime against a stand-in for Meta: a wizard with a photo and a location field runs in the thread start to result, a page with a signature hands off and comes back. Not yet run against a real number |
| 6 · SMS, WhatsApp call | SMS built (`modules/sms`, Twilio, text only): numbered choices, addresses typed, every picture and file a link, the gist of long text; with it the conversation moved out of the WhatsApp module into the SDK as `@engenty/wizards/plugin/thread` (`ThreadDoor` + a `ThreadSurface` per messenger), so Slack or Telegram are a surface each. The WhatsApp call built as `modules/calls`, and the phone with it: Meta's SIP mode sends the call to a Twilio SIP domain, Twilio asks the plugin for TwiML, the TwiML hands the call to the tenant's OpenAI project over SIP with a token in a header, OpenAI posts `realtime.call.incoming`, the plugin accepts with the wizard's rules and tools (`server.speech.conversation()` gives the key and model) and drives the run over the WebSocket to the call; hand-off links and the result go by SMS from a Twilio number. No media in the runtime, no WebSocket on public routes | SMS and the call done in the test runtime against stand-ins for Twilio and OpenAI: a wizard with a choice and a toggle runs by text and by voice tools; its photo page hands off and comes back. Not yet run against a real number or a real call |
| Later | Phone (TwiML or a media-stream relay), Slack, Teams, RCS, e-mail; marketplace badges from `runnersFor`; channel starters; the SDK runner bundle; WebSocket public routes | |

## Open decisions

| Decision | Options | Lean |
|---|---|---|
| Where the plugins live | `modules/` (open, every runtime) or closed in the manage repo like contacts | WhatsApp went into `modules/`: the tenant brings its own Meta account, so nothing costs engenty; in a managed runtime the plan still decides who has it (`PLUGINS_DEFAULT`). Minutes on engenty's credits (live voice on a call, the phone) stay a reason for closed |
| The conversation model class | Credits only, own key only, or both as on the Models page | Both, like speech today; the price per minute is a manage decision |
| Email, url, colour by voice | The model infers and reads back, or always hands off | Infer and read back; hand off on the second miss |
| Which speech provider first | OpenAI Realtime (WebRTC native), Gemini Live (WebSocket, needs a relay) | OpenAI Realtime; it fits the no-WebSocket rule |
| WhatsApp access | Cloud API with the tenant's own Meta business, or through Twilio | Built on the Cloud API: buttons, lists and the location request are native there, Flow mode needs Meta's API anyway, and a Meta test number works at once. Twilio can come as a second provider behind the same `Graph` class when SMS and the phone arrive |
| Who renders pictures for channels | The runtime's PNG format of widgets, documents and dashboards (exists), extended to views, or the plugin | The runtime; the plugin only asks for `png` |
| Default runner per wizard | On the sharing settings or in the definition | Sharing settings; it is how the wizard is offered, not what it is |
