# Plan: Work chats, step 3 — engenties answer

Status: plan, written on 2026-10-28 against v0.11.13 with steps 1 (#265) and 2 (#266) open.
Concept: engenty-dev `concepts/` (Studio / Work / Client, Work deep dive). Behind `workMode`.

## Where step 2 leaves it

People can chat: a message is stored (`chat_message`, AI SDK parts), the chat is named by its
first line, the others see it within 4 s (polling), unread, pins, archive and sections work.
Nobody answers: no model is called in a Work chat. The Trace lines (reasoning, tool calls) are
drawn already, from parts nothing writes yet.

## Decisions

| | Decision | Why |
|---|---|---|
| Agent | A Mastra `Agent` (`@mastra/core` 1.77), as the studio assistant | Same tools, same `chatModel(chatTurnWay())`: the cloud's model classes, or locally the person's client (Claude Code, Codex …), keys or account. No second agent stack |
| Who answers in step 3 | Goose, the space's built-in engenty, and only it | Engenties of their own need an engenty to exist first (built in Studio); that is its own step |
| When Goose answers | In a chat of one person with Goose: every message. With more people: when named (`@Goose`) | A group chat must not get an answer to every line |
| Stream format | The AI SDK's UI message stream (SSE), from Mastra's `fullStream` through `@mastra/ai-sdk`'s `toAISdkStream` | The shadcn/ui parts and `chat_message.parts` are that format already; the web takes it with `useChat` (`@ai-sdk/react`) |
| Where the answer is kept | One `chat_message` row (author `engenty:goose`), written when the turn starts and updated with its parts while it streams (throttled), finished at the end | A reload, another person or the sidebar sees the turn as it grows, without a second store; nothing lost when the browser closes |
| Tool approvals | Our own: a tool that changes things outside (mail, publish, delete, a connected service's write) ends the turn with its part in `approval-requested`; Approve or Deny writes `approval-responded` and starts the next turn, which runs or skips the tool and goes on | Mastra's approvals resume a suspended run from its snapshot store; the runtime has no Mastra storage, and an approval may come hours later from another person or process |
| Who may approve | The person whose message started the turn; owners and admins too | The tool acts with their access ("the narrower of person and engenty") |
| Live | The chat tables join `live_change` (kinds `chat`, `chatMessage`); the browser patches its cache, polling goes | One feed for the whole studio (live-changes.md); presence shows "Goose schreibt …" |
| History a turn sends | The chat's last messages as they are, older ones as a running summary, like the assistant's `turnHistory` | Same limits, same costs as the studio assistant |
| Studio assistant | Stays on `assistant_chat` in this step | Moving it is its own PR (see below) and must not change Studio while the switch is off |

## Pieces, one PR each

1. **The Goose agent, shared.** Take the agent's making out of `runStudioAssistant`
   (`agents/studio-assistant.ts`): tools (`knowsTools`, space and plugin tools), instructions,
   model. The studio assistant and the Work turn both call it; the studio assistant keeps its page
   snapshot and `assistant_chat` history. No change a person sees.
2. **The turn.** `POST /api/studio/work/chats/:id/turn` (message + whether Goose is asked) answers
   with the UI message stream. Writes the person's message, the Goose row, its parts while it
   streams, usage and credits like the assistant (`onStep`), errors as a part the chat shows
   (no credits, model not set up, client signed out). `@mastra/ai-sdk` joins the runtime.
   Goose joins the chat as a member on its first answer.
3. **The web.** `ai` and `@ai-sdk/react` join the web. The chat page sends through `useChat`
   with a transport to that route, seeded with the stored messages; Stop, retry of a failed
   turn, the composer locked only for Goose's chat while it answers. `@Goose` in the composer
   (a mention menu). The Tool, Reasoning and Chain of Thought patterns as in step 2, plus Text
   while it streams (shimmer), Sources for web results.
4. **Approvals.** Tools marked `needsApproval`; the Confirmation pattern (Approve / Deny with what
   the tool will do); `PUT /chats/:id/messages/:mid/approval`; the continuation turn. The bell
   counts approvals waiting for the person.
5. **Live.** Triggers for `chat`, `chat_member`, `chat_message`, `chat_state` into
   `live_change` (scripts/triggers.mjs), their views (a private chat only to its members), the
   cache patch in the web, presence for a turn under way. Polling goes.

## After step 3

- **Goose's chats move into Work.** `assistant_chat` + `assistant_message` become private chats
  with the person and Goose, once and by migration (no compat branch). The studio assistant reads
  and writes `chat`. Needs: the dock in Studio shows the person's Goose chat; "earlier chats"
  become Work chats. Its own step, when `workMode` is meant to come on.
- **Engenties of their own.** An `engenty` record (name, picture, instructions, tools, starts),
  built in Studio, pinned and talked to in Work; then several engenties per chat, sub-threads an
  engenty starts with a brief, and its starts (docs/plans/starts.md).
- **Wizards in a chat.** A real wizard as a sub-session one level down; a small one as a card.

## Risks

- **Clients as models.** On Claude Code or Codex the tools reach the client over MCP, and the
  client runs them itself. Its stream may carry tool calls as provider-executed parts with other
  ids and fewer states. The Trace must take those (no approval there: the client's own
  permissions apply), and a test turn on each client checks the parts.
- **Two people, one turn.** A second message while Goose answers is queued for the next step, as
  the assistant's signals (`prepareStep`) do, not a second parallel turn.
- **Long turns.** A turn outlives a closed tab (the row keeps growing); the stream route must not
  tie the turn to the request. A turn runs on the process that took it; another process sees it
  through the row and the live feed.
