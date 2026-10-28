# Plan: Work chats, step 3 — the space's AI answers

Status: plan, written on 2026-10-28 against v0.11.13 with steps 1 (#265) and 2 (#266) open.
Concept: engenty-dev `concepts/` (Studio / Work / Client, Work deep dive). Behind `workMode`.

## Where step 2 leaves it

People can chat: a message is stored (`chat_message`, AI SDK parts), the chat is named by its
first line, the others see it within 4 s (polling), unread, pins, archive and sections work.
Nobody answers: no model is called in a Work chat. The Trace lines (reasoning, tool calls) are
drawn already, from parts nothing writes yet.

## Who is who

- **In step 3 a chat talks to the space's AI**: no persona, no record of its own. It is the
  space's chat engine (`chatTurnWay()`: the cloud's model classes, or locally a client such as
  Claude Code or Codex, keys or the account) with the space's data, sources, connections and
  skills. In the chat it shows as the space's name and the engenty figure.
- **Engenties** (personas: a name, a figure, instructions, their own tools and starts) come
  later. They belong to the space, are built in Studio and join chats as members.
- **Goose** is each person's own copilot, bound to them: their chats with it are private
  (`assistant_chat`), it acts with their access. It is never a member of a Work chat and never
  writes in one; later it may dock beside a chat for its person (summarise, draft into their
  composer).

## Mastra: which concept for what

| Ours | Mastra (`@mastra/core` 1.77) | In step 3 |
|---|---|---|
| The space's AI in a chat | An `Agent` made per turn, instructions and tools from the request (tenant, space, person) | Yes |
| A chat | A memory thread with a shared `resourceId` per space and the speaker tagged in each message (Mastra's "multi-user threads") | Our `chat` / `chat_message` hold it; the turn hands the agent the history, as the studio assistant does. Mastra Memory would keep a second copy of every message, and its storage is one store, not our database per tenant |
| A sub-thread | A subagent of a supervisor agent (`agents` on the `Agent`): its own context and tools, reports back to the lead | Later: a sub-thread is a chat with a parent; the lead agent opens one with a brief, the subagent works in it and answers in the parent as one card |
| Data, sources | Tools (the space's tools and plugin tools the studio assistant has), workspace search (BM25 / vector) | Tools as today |
| Connections | Tools of the plugins; MCP for outside servers (`MCPClient`) | Tools as today |
| Skills | Workspace skills: `SKILL.md` folders (Agent Skills spec) | Later, with the skills plan |
| Approvals | `requireApproval` with suspended runs (needs Mastra storage) or AgentController permission policies | Our own, in the message's parts (see Decisions) |
| Long runs, runs that outlive a request | Durable agents, background tasks, signals (messages into a running thread) | No: the row grows while the turn runs; messages meanwhile go in through `prepareStep`, as the assistant's signals do |
| Starts | Schedules, signal providers | Later (docs/plans/starts.md) |

`AgentController` (Mastra's "harness" before 1.7x, the host of Mastra Code) is not the frame for
team chats: it gives each person (`resourceId` + scope) a Session with its own live state, modes
and a thread owner, built for one person working with an agent. Several people in one thread is
what our chat model already does. Its parts we want (approvals, subagents, signals, durable runs)
exist at the `Agent` level or as harness features of their own; each needs Mastra storage when it
must outlive a process, which is the point to decide on a store per tenant.

## Decisions

| | Decision | Why |
|---|---|---|
| Agent | A Mastra `Agent`, as the studio assistant, with the space's tools | Same model choice, `chatModel(chatTurnWay())`. No second agent stack |
| When it answers | In a chat with one person: every message. With more people: when asked (`@` + the space's name, or the "Ask" button on the composer) | A group chat must not get an answer to every line |
| With whose access it acts | The access of the person whose message started the turn | A member who can't see a private table can't reach it through the chat |
| Stream format | The AI SDK's UI message stream (SSE), from Mastra's `fullStream` through `@mastra/ai-sdk`'s `toAISdkStream` | The shadcn/ui parts and `chat_message.parts` are that format already; the web takes it with `useChat` (`@ai-sdk/react`) |
| Where the answer is kept | One `chat_message` row (a new author kind `ai` beside `person` and `engenty`), written when the turn starts and updated with its parts while it streams (throttled), finished at the end | A reload, another person or the sidebar sees the turn as it grows, without a second store; nothing lost when the browser closes |
| Tool approvals | Our own: a tool that changes things outside (mail, publish, delete, a connected service's write) ends the turn with its part in `approval-requested`; Approve or Deny writes `approval-responded` and starts the next turn, which runs or skips the tool and goes on | Mastra's approvals resume a suspended run from its snapshot store; the runtime has no Mastra storage, and an approval may come hours later from another person or process |
| Who may approve | The person whose message started the turn; owners and admins too | The tool acts with their access |
| Live | The chat tables join `live_change` (kinds `chat`, `chatMessage`); the browser patches its cache, polling goes | One feed for the whole studio (live-changes.md); presence shows that the AI is answering |
| History a turn sends | The chat's last messages as they are, older ones as a running summary, like the assistant's `turnHistory` | Same limits, same costs as the studio assistant |

## Pieces, one PR each

1. **The agent, shared.** Take the agent's making out of `runStudioAssistant`
   (`agents/studio-assistant.ts`) into one function that takes the person, the space and which
   tools: Goose with its page snapshot as today, the Work turn with the chat. No change a person
   sees.
2. **The turn.** `POST /api/studio/work/chats/:id/turn` (message, whether the AI is asked) answers with
   the UI message stream. Writes the person's message, the AI's row, its parts while it
   streams, usage and credits like the assistant (`onStep`), errors as a part the chat shows (no
   credits, model not set up, client signed out). `@mastra/ai-sdk` joins the runtime.
3. **The web.** `ai` and `@ai-sdk/react` join the web. The chat page sends through `useChat`
   with a transport to that route, seeded with the stored messages; Stop, retry of a failed
   turn. Asking the AI in a group chat (`@` menu, Ask button), the engenty figure as its avatar.
   Text while it streams (shimmer), Sources for web results.
4. **Approvals.** Tools marked `needsApproval`; the Confirmation pattern (Approve / Deny with what
   the tool will do); `PUT /chats/:id/messages/:mid/approval`; the continuation turn. The bell
   counts approvals waiting for the person.
5. **Live.** Triggers for `chat`, `chat_member`, `chat_message`, `chat_state` into
   `live_change` (scripts/triggers.mjs), their views (a private chat only to its members), the
   cache patch in the web, presence for a turn under way. Polling goes.

## After step 3

- **Engenties.** The `engenty` record (name, figure, instructions, tools, model class), built
  in Studio, a member of chats, answering when named.
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
  client is the owner's: the chat answers on the owner's subscription.
- **Two people, one turn.** A second message while the AI answers is queued for the next
  step, as the assistant's signals (`prepareStep`) do, not a second parallel turn.
- **Long turns.** A turn outlives a closed tab (the row keeps growing); the stream route must not
  tie the turn to the request. A turn runs on the process that took it; another process sees it
  through the row and the live feed.
