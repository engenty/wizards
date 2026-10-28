# Plan: Work chats, step 3 — the space's engenties answer

Status: plan, written on 2026-10-28 against v0.11.13 with steps 1 (#265) and 2 (#266) open.
Concept: engenty-dev `concepts/` (Studio / Work / Client, Work deep dive). Behind `workMode`.

## Where step 2 leaves it

People can chat: a message is stored (`chat_message`, AI SDK parts), the chat is named by its
first line, the others see it within 4 s (polling), unread, pins, archive and sections work.
Nobody answers: no model is called in a Work chat. The Trace lines (reasoning, tool calls) are
drawn already, from parts nothing writes yet.

## Who is who

- **An engenty** belongs to the space, not to a person: a name, a figure, instructions, the tools
  and data it may use. It is built in Studio and talked to in Work, by everyone of the team who
  sees the chat. It is a member of a chat like a person, and answers there under its own name.
- **Goose** is each person's own copilot, bound to them: their chats with it are private
  (`assistant_chat`), it acts with their access, on whatever page they are. In Work it stays
  that: docked beside the chat, it can read the open chat to help its person (summarise, draft a
  reply into their composer, find a file), but it is never a member of a chat and never writes in
  one. Its storage does not move.

## Decisions

| | Decision | Why |
|---|---|---|
| Agent | A Mastra `Agent` (`@mastra/core`), as the studio assistant, made from the engenty's record | Same model choice, `chatModel(chatTurnWay())`: the cloud's model classes, or locally a client (Claude Code, Codex …), keys or account. No second agent stack |
| What an engenty is | A tenant row `engenty`: space, name, figure, instructions, tools (a list of the space's tools and plugins it may use), model class, who made it | The least that makes it answer as itself; starts, pins and sub-threads it opens come later |
| Where it is made | Studio › Engenties (list + one page per engenty); Work › Engenties lists them and starts a chat with one | Builders build, the team talks, as the concept says |
| When it answers | In a chat with one engenty and one person: every message. Otherwise when named (`@Name`) | A group chat must not get an answer to every line |
| With whose access it acts | The narrower of the engenty's tools and the access of the person whose message started the turn | A member who can't see a private table can't reach it through an engenty |
| Stream format | The AI SDK's UI message stream (SSE), from Mastra's `fullStream` through `@mastra/ai-sdk`'s `toAISdkStream` | The shadcn/ui parts and `chat_message.parts` are that format already; the web takes it with `useChat` (`@ai-sdk/react`) |
| Where the answer is kept | One `chat_message` row (author `engenty:<id>`), written when the turn starts and updated with its parts while it streams (throttled), finished at the end | A reload, another person or the sidebar sees the turn as it grows, without a second store; nothing lost when the browser closes |
| Tool approvals | Our own: a tool that changes things outside (mail, publish, delete, a connected service's write) ends the turn with its part in `approval-requested`; Approve or Deny writes `approval-responded` and starts the next turn, which runs or skips the tool and goes on | Mastra's approvals resume a suspended run from its snapshot store; the runtime has no Mastra storage, and an approval may come hours later from another person or process |
| Who may approve | The person whose message started the turn; owners and admins too | The tool acts with their access |
| Live | The chat tables join `live_change` (kinds `chat`, `chatMessage`); the browser patches its cache, polling goes | One feed for the whole studio (live-changes.md); presence shows "<Name> schreibt …" |
| History a turn sends | The chat's last messages as they are, older ones as a running summary, like the assistant's `turnHistory` | Same limits, same costs as the studio assistant |

## Open

- **A space's first engenty.** Either every space starts with one ready engenty (a plain
  "Assistent" of the space, reading its knowledge and data, writing nothing), so a chat answers
  on day one; or none until someone builds one in Studio, and Work's empty state points there.

## Pieces, one PR each

1. **Engenties exist.** Migration for `engenty`; service and API (`/api/studio/engenties`);
   Studio › Engenties (list, page: name, figure from the engenty builder, instructions, tools,
   model class); Work › Engenties lists them. Behind `workMode`.
2. **The agent, shared.** Take the agent's making out of `runStudioAssistant`
   (`agents/studio-assistant.ts`) into one function that takes who acts and which tools: Goose
   gets the person and all their tools as today, an engenty its record and the narrower access.
   No change a person sees.
3. **The turn.** `POST /api/studio/work/chats/:id/turn` (message, engenties named) answers with
   the UI message stream. Writes the person's message, the engenty's row, its parts while it
   streams, usage and credits like the assistant (`onStep`), errors as a part the chat shows (no
   credits, model not set up, client signed out). `@mastra/ai-sdk` joins the runtime.
4. **The web.** `ai` and `@ai-sdk/react` join the web. The chat page sends through `useChat`
   with a transport to that route, seeded with the stored messages; Stop, retry of a failed
   turn. Adding an engenty to a chat (header and new chat), `@Name` in the composer (a mention
   menu), its figure as avatar. Text while it streams (shimmer), Sources for web results.
5. **Approvals.** Tools marked `needsApproval`; the Confirmation pattern (Approve / Deny with what
   the tool will do); `PUT /chats/:id/messages/:mid/approval`; the continuation turn. The bell
   counts approvals waiting for the person.
6. **Live.** Triggers for `chat`, `chat_member`, `chat_message`, `chat_state` into
   `live_change` (scripts/triggers.mjs), their views (a private chat only to its members), the
   cache patch in the web, presence for a turn under way. Polling goes.

## After step 3

- **Goose in Work.** The dock in Work: Goose reads the open chat for its person, drafts into the
  composer, never posts.
- **Engenties that act on their own.** Starts (docs/plans/starts.md), pins, sub-threads an
  engenty opens with a brief and reports back from as one card, engenties asking each other.
- **Wizards in a chat.** A real wizard as a sub-session one level down; a small one as a card.

## Risks

- **Clients as models.** On Claude Code or Codex the tools reach the client over MCP, and the
  client runs them itself. Its stream may carry tool calls as provider-executed parts with other
  ids and fewer states. The Trace must take those (no approval there: the client's own
  permissions apply), and a test turn on each client checks the parts. On a local install the
  client is the owner's: an engenty there answers on the owner's subscription.
- **Two people, one turn.** A second message while an engenty answers is queued for the next
  step, as the assistant's signals (`prepareStep`) do, not a second parallel turn.
- **Long turns.** A turn outlives a closed tab (the row keeps growing); the stream route must not
  tie the turn to the request. A turn runs on the process that took it; another process sees it
  through the row and the live feed.
