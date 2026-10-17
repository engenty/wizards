# Concept: wizards in generative UI chats

Status: concept, written on 2026-10-17. A first trial is built: see [Trial](#trial).

> **OpenUI makes the UI generative. Wizards make the flow dependable.**

In general: generated UI lets an agent show whatever it thinks it needs. A wizard is the flow
that runs the same way every time, with the pages, buttons and fields its author defined.

## Why

Chat apps are moving from text in, text out to generated UI: an agent composes cards, charts,
forms and buttons on the fly. [OpenUI](https://github.com/thesysdev/openui) (Thesys, MIT) is
one way to do it. A2UI and json-render are others. What an agent improvises is right most of
the time, not every time. Some processes must run the same way on every run: a damage report,
an invoice, an onboarding. That is what a wizard is.

The pitch: "Use wizards in OpenUI." The chat improvises where that is fine and hands over to a
wizard where the flow must hold.

## How it fits

Two layers, as in any agent UI stack:

| Layer | Does | Here |
|---|---|---|
| Connection | messages, tool calls, state, events between agent and app | the host's own (AG-UI, Vercel AI SDK, …) plus our runtime's API |
| UI | how a view is described and rendered | OpenUI Lang, rendered with the host's components |

The chat agent decides that a wizard runs, or the person asks for one. It writes one line:

```
w = Wizard("damage-report", {prefill: {plate: "W-12345"}})
```

From then on the `Wizard` component talks to the runtime directly and shows each step: pages,
progress while AI steps work, the review and the result with its downloads. The model does not
regenerate the steps, so they are what the author defined. At the end the component hands the
result back to the conversation (an OpenUI action) and the agent goes on with it.

This is the same split as today in Claude and ChatGPT over MCP (`docs/content/user/ai-apps.md`):
the chat decides, the runtime owns the flow. The difference is the look. Today a step is our
page in an iframe (an MCP App). Here it is the host's own components, inline in the
conversation.

## What to build

1. **A component package** (`@engenty-wizards/openui` or similar): the field kinds, review,
   result and surfaces as OpenUI components that take the host's theme. The runner is React 19,
   as OpenUI's React renderer is, so most of it comes from `packages/runner`.
2. **A runtime API for host apps:** start a run, follow its events, answer pages. The MCP tools
   do all of this already. It needs app keys instead of a person's OAuth, and an answer to whose
   credits a run spends.
3. **A prompt snippet** that tells the chat agent which wizards exist and when to start one.

The `Wizard` component sits on the runtime API, not inside OpenUI. Other UI formats (A2UI)
can follow the same way.

## Open questions

- Device fields (camera, signature, location) inside someone else's app. The mobile app gives
  some of them through its own bridge today.
- AI steps that take minutes, shown live inside a chat message.
- OpenUI's maturity: the language and the React renderer are 1.0 since 2026-10-12, the chat kit
  is 0.x.
- The audience: OpenUI is a toolkit for developers. "Use wizards in OpenUI" reaches people who
  build chat apps, not the people who chat.

## Trial

Built on 2026-10-17, as the first step this concept named:

- `packages/wizards/src/openui` (`@engenty/wizards/openui`): the `Wizard` component for OpenUI's React
  renderer, and its prompt half for the chat's server. It draws the run with the runner
  (`packages/runner`) and its scoped styles, over the runtime's public run routes.
- `examples/openui-chat`: an OpenUI chat (Agent Interface) with any OpenAI-compatible model,
  the wizards it may start, and a proxy to the runtime. Its README says how to try it.
- The runtime's `GET /api/public/wizards/:token` now lists what the wizard's pages ask
  (`fields`), so the chat's model can prefill what the person already said.

Tried in a browser with two wizards, on a phone's width too: the chat starts the wizard, the
plate the person named starts filled in, a photo uploads, the AI step, review and result run
inline, and the chat answers once the wizard is done.

Decided on the way:

- The component draws our runner, not OpenUI's own form components. The pages look like the
  wizard's own page, and every field kind works, the camera and the signature included.
  Drawing pages with the host's components is a later step.
- The run starts once the model's line has finished streaming: a half-written token never
  starts a run.
- The run's id is kept in the message's OpenUI state, so the same message shows the same run.
  The chat hears of a run it saw finish; a message shown again with a done run tells nothing.

The developer docs describe the result: `docs/content/dev/integration/openui.md`.
