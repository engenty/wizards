# Plan: Work chats, step 3 — the space's AI answers, on Mastra

Status: plan, written on 2026-10-28 against v0.11.13 (`@mastra/core` 1.77; 1.80 in #267) with
steps 1 (#265) and 2 (#266) open. Concept: engenty-dev `concepts/` (Studio / Work / Client, Work
deep dive). Behind `workMode`.

## Goals

- Chats are multi-user and durable, in a shared space.
- The space's AI takes the messages and acts on them with tools and the space's resources: its
  computer, skills and tools, its browser, its data sources (knowledge base, connected sources,
  MCP, connections).
- Inside the computer the data is reachable through a command line and through search
  (keywords and embeddings).
- What the AI makes is a result, written into the same data as a wizard's results.
- Wizards run as subagents in the space, each with its own steps and tools.

## Rule: Mastra first

Mastra has the agent loop, threads and messages, messages that arrive during a turn (signals),
compaction (observational memory), approvals (suspended tool calls), workspaces with sandbox,
filesystem, skills and search, a browser, subagents and background tasks. engenty-pro ran all
of these for months and fixed their problems there; Mastra fixed many on its side (1.78–1.80).
We use them as they are and add our code only where Mastra has nothing: the sidebar, who may
see and do what, the space's resources as tools, the live feed, results.

Where step 2 built something Mastra owns (the messages in `chat_message`), step 3 replaces it.
Nothing of it is released.

## Who is who

- **The space's AI** answers in a chat in step 3: no persona and no record of its own, the
  space's chat engine (`chatTurnWay()`: the cloud's model classes, or locally a client such as
  Claude Code or Codex, keys or the account). It shows as the space's name with the engenty
  figure.
- **Engenties** (personas with a name, figure, instructions, their own tools and starts) come
  later: built in Studio, members of chats.
- **Goose** is each person's own copilot, bound to them. It is never a member of a Work chat and
  never writes in one.

## Mastra for each goal

| Goal | Mastra | Our layer |
|---|---|---|
| The agent | An `Agent` whose `model`, `memory`, `workspace`, `skills`, `browser` and `agents` are resolved per request (`DynamicArgument`, from a `RequestContext` with tenant, space, chat, person) | `chatModel(chatTurnWay())` as the model; the space's tools |
| Threads and messages | `Memory` threads: thread id = chat id, resource id = the space; messages stored by Mastra (libSQL store) in the tenant's database; a message the AI isn't asked about through `sendMessage` with `ifIdle: persist` (stored, no run). `Memory` and a `Mastra` instance cached per tenant | `chat` as the sidebar keeps it: title, section, parent, private, members, pins, unread, archive. The last message's author, text and time copied onto `chat` for the sidebar |
| Several people | Mastra's "multi-user threads": one resource for all, the speaker tagged in each message (`<turn author_id author_name>`) when the prompt is built | An input processor that adds the tags from the author stored on the message |
| Messages during a turn | Signals: `sendMessage` (into the running loop, interrupting a request that has only reasoned yet), `queueMessage` (after the turn), `abortThreadStream` (Stop, `clearPendingSignals`) | The composer (⌘↩ for after the answer); "the request before it still stands" on a message taken in (engenty-pro, 8e7b970d1) |
| Compaction | Observational memory (observer and reflector); its threshold set high so the prompt's prefix is rewritten rarely (engenty-pro: 80k tokens), `activateAfterIdle` for when the cache has expired anyway; a token limit processor as hard backstop | The thresholds per model window; the marker "Earlier messages summarised" in the chat |
| Approvals | Not Mastra's suspend: with a client as the model it is skipped (spike, #268). The gate sits on the tool (below) | The gate on the tool, who may approve (the person who asked, owners and admins, never the AI), the card (shadcn/ui Confirmation), the shell-command classifier |
| Streaming to the browser | `toAISdkStream` (`@mastra/ai-sdk`, `version: 'v7'`) into `useChat`; `toAISdkMessages` for the stored messages | The route, the shadcn/ui chat parts of step 2 |
| The space's computer | `Workspace` with our sandbox engines (`sandbox/`: Docker, agentOS, already `WorkspaceSandbox`), a filesystem with the space's files, workspace search (BM25, vector), skills (`SKILL.md`) | One computer per space that stays (sleep, wake), the egress proxy, the tool relay into the container, limits and usage |
| The browser | Mastra's browser, only once the CDP process-group kill of engenty-pro is shown fixed; else our `tools/browser.ts` as tools | A profile per space, a window per chat, the sign-in card, consent to browse unattended |
| Data, MCP, connections | Tools; `MCPClient` for outside servers | The space's knowledge and data tools as today; who owns a connection (below) |
| Subagents | `agents` on the `Agent` (a supervisor delegates, each subagent with its own context and tools); background tasks for work that outlasts a step | A sub-thread is a chat with a parent; the subagent works in it and reports back as one card |
| Wizards | A background task (or subagent) that starts a wizard run | The wizard engine runs it with its own steps and tools; its result lands in Results |
| Results | — | The same tables as wizards' results; a tool "save result" |
| Others see the chat | Mastra's thread subscription for the running stream | The live feed (`live_change`) for the sidebar and readers of the chat |

## Connections: whose, and who may use them

A connection a person makes in a shared space is used by the space's AI for everyone who asks
it: whatever it reads can end up in any answer in that space. A personal account in a shared
space leaks. So:

| | Space connection | Personal connection |
|---|---|---|
| Belongs to | The space | One person |
| Used by | The space's AI (and later engenties) for everyone of the space, also unattended | Only that person's Goose, in any space |
| Data | May be synced (inbox, calendar, search) | Read live only: nothing synced or stored |
| Unattended | Yes | Never |

- **Private work** is an ordinary space with one member. A person may have several.
- No special personal space bound to each person: engenty-pro had one (`/s/me`) and removed it
  after a week (PLAN-personal-connections.md, 2026-09-29), since nobody could say where the
  copilot "lives" and what it could reach changed with the URL.
- What Goose writes into a shared space from a personal account is its person's act, like
  pasting a mail.

## The space's computer and browser

- **Today** a wizard step gets a sandbox per run (`sandbox/`, `run_command` in `tools/index.ts`),
  thrown away after the run, and a server-side browser (`tools/browser.ts`, `browser/fast/`).
- **The computer** is one sandbox per space that stays: its disk keeps files, installed packages
  and checkouts. Started by the first turn that needs it, asleep after 30 minutes idle, woken by
  the next command. Each chat works in a folder of its own (a working directory, not a mount).
  - Commands run one at a time per computer; background processes outside that queue.
  - Mounted is only what is the same for everyone: the space's files and caches. Never a
    person's folder or a run's records; a container keeps the mounts of the run that created it
    (engenty-pro, fd1ae87b1, 1333a0ab5). Those come through tools, as the person.
  - The disk may be lost: what matters goes to Files.
- **Data inside the computer.** A `wizards` command in the container calls the space's tools
  (knowledge search, tables, connections, MCP, results) through a relay over the engine's stdio,
  with a ticket per command. No runtime URL or token in the container.
- **Outbound traffic** denied but for package registries and the hosts the space allows (a
  proxy).
- **Limits and cost.** CPU, memory, processes, time per command; at most N computers per tenant
  and per space; container time booked in usage from the first day.
- **The browser** has a profile per space ("a space is the account": engenty-pro went from per
  person to per user to per space within two weeks), a window per chat, one seat per window, a
  live view in the chat.
  - **Signing in** is a form card: the values go into the page, never to the model; a password
    only into a password field. Taking the window over is for checks, passkeys and consent
    screens.
  - **Consent per space:** "may start the browser", "may browse with nobody watching".
  - **Page text is untrusted:** wrapped in markers that say so.
- **Full access, one rule.** Commands, installs, files, reading and clicking through sites run
  without asking. Asked first: an effect outside the space (sending, buying, publishing, deleting
  on a connected service). Shell commands are classified: what stays in the container runs;
  sending data out (`git push`, uploads, mail, ssh), deleting or moving in the space's files,
  and what can't be read (`eval`, `| sh`) asks; unclear goes to a classifier that fails closed.
  An approval holds for that exact command. A form that submits on a site is caught by nothing
  yet (nor in engenty-pro): its own design, open.
- **Where it runs.** The cloud's sandbox engine and browser; on a local install the computer's
  Docker or agentOS and its Chrome. Without a sandbox engine the chat says so and offers
  `wizards sandbox add`.

## Agent broker (later)

An agent broker will stand between the AI and the space's data and tools later: one gateway that
checks every access (who asks, for which chat, which connection, which tool) and logs it. Not
built now; nothing here may get around it or build part of it ahead:

- The AI reaches data and tools only through tools resolved per request, and the computer only
  through the relay; nothing reads a database, a connection's token or a file store directly.
- No tokens or credentials in the container, the prompt or the browser profile's reach beyond
  the space.
- Permission checks stay where they are today (the services); no new policy layer of our own
  that the broker would have to replace.

## Prompt caching

Mastra builds the prompt; we keep what goes into it stable, so each turn's prompt starts with
the previous turn's until observational memory rewrites it:

1. **Tools**: a fixed core set, sorted by name, for the whole chat. The rest are found and
   loaded through one tool whose result is appended. engenty-pro found its tool block at ~40 %
   of the prompt; showing tools per step rewrites the prefix.
2. **Instructions**: the space's, without time, person or page.
3. **Space context** that rarely changes (name, facts, brand).
4. **Observations** (observational memory): change only when it activates.
5. **Messages**, append-only, with the author tags; the author's name stored on the message, so
   a rename doesn't rewrite earlier turns.
6. **This turn**: the new message, and what changes each time (now, who asks, attachments).

- **Anthropic**: cache breakpoints on 2, 4 and the previous turn's last message (Mastra passes
  `providerOptions` per message); 5 minutes, 1 hour for 1–2 in busy chats.
- **OpenAI, Google**: automatic prefix caching; `prompt_cache_key` = the chat id.
- **Clients** (Claude Code, Codex) cache themselves.
- **Measured**: cached input tokens booked per step, as part of the input (engenty-pro billed
  cache reads twice and only the last step, c1cbedeae); the share read from cache per chat; a
  test that turn N+1's prompt starts with turn N's.

## Lessons from engenty-pro kept

- An approved call runs once, with its stored arguments; a decision counts only while pending; a
  double click is locked out (fbc35d922, e97a9252f). Before the next model call every tool call
  without a result gets an error result.
- A step stops after 3 minutes, a turn after 20; a turn on a process that died is marked failed.
- U+0000 and leaked model control tokens are stripped before a message is stored (93540e29e).
- Observer and reflector outputs are capped; `bufferOnIdle` off (two observer calls per turn cost
  ~22 % of the turn).
- The "send after the answer" queue is tied to the chat, cleared on Stop, held while an approval
  is open (ff749bdfa, 2b4682968).

## Approvals: the gate on the tool

The spike (#268, `docs/plans/work-chats-spike.md`) showed that with Claude Code as the model the
client runs our tools itself over the bridge, and Mastra's `requireApproval` never sees the call:
a mail went out without asking. So there is one path for every model:

- A tool that acts outside the space doesn't act when it is called. It stores the call (tool,
  arguments, chat, who asked) as a pending approval and answers "waiting for approval".
- Approve runs the stored call once, with the stored arguments, and sends the result into the
  chat as a signal (`sendSignal`, reactive); the AI goes on from there. Deny sends that.
- The card is the shadcn/ui Confirmation; the bell counts pending approvals per person.
- This gate on the tool is where the agent broker will stand later.

A client's tool steps don't reach Mastra's stream either: the bridge writes each call and its
result as tool parts of the AI's message, so the Trace shows them as on an API model.

## Pieces, one PR each

0. **Spike: prove the integration points.** Done: #268, results in
   `docs/plans/work-chats-spike.md`. What it was to prove: A test runtime with:
   - Mastra's libSQL store in a tenant's database (beside our tables, `mastra_` prefix, its own
     migrations), a `Memory` made per request, a thread per chat with the space as resource.
   - Where suspended snapshots go: Mastra keeps them in the `Mastra` instance's storage, one
     store. Either one `Mastra` instance per tenant (cached) or the snapshots in the tenant
     store by another way; measured.
   - Observational memory with prompt caching: cached share before and after an activation.
   - Signals with one process per tenant (the default in-memory pub/sub); what a second process
     does.
   - A Claude Code or Codex client as the model under memory, signals and suspend.
   - `toAISdkStream` into `useChat` with tool parts and an approval.
   Each point either works or names what our layer must do. The rest of the plan follows that.
1. **The agent, shared.** One function that makes the `Agent` from a request: the studio
   assistant (Goose, its page snapshot) and the Work chat both use it. Tools sorted, the prompt
   order above. No change a person sees.
2. **Chats on Mastra memory.** Threads and messages move to Mastra; `chat_message` goes; the
   sidebar's last message on `chat`; the person's messages saved into the thread even when the
   AI is not asked; author tags processor.
3. **The turn and the web.** The route (`toAISdkStream`), `useChat`, Stop, retry, signals
   (taken in now, after the answer), asking the AI in a group chat (`@` + the space's name or an
   Ask button), observational memory and its marker, timeouts, usage per step.
4. **Approvals.** The gate on the tool (above), the classifier for commands, the Confirmation
   card, who may approve, the bell's count; the bridge's tool parts for clients.
5. **The space's computer.** A sandbox per space that stays, the `Workspace` with the space's
   files, search and skills, the `wizards` command and its relay, the egress proxy, limits,
   usage.
6. **The space's browser.** Profile per space, window per chat, live view and takeover, the
   sign-in card, consent, untrusted page text.
7. **Results and wizards.** "Save result" into the wizards' results; a wizard as a background
   task or subagent in a sub-thread, reporting back as one card.
8. **Live.** The sidebar and readers of a chat on `live_change`; polling goes.

## After step 3

- **Engenties**: the persona record, built in Studio, members of chats, answering when named,
  with starts (docs/plans/starts.md) as Mastra schedules and signal providers.
- **Goose in Work**: docked beside a chat for its person; drafts into their composer, never
  posts.
- **Durable turns** (Mastra's durable agents, beta) if turns must survive a process restart.

## Risks

- **Mastra storage in the tenant database.** Its tables and migrations beside ours, sync between
  a local install and the cloud (tenant-sync.md), the live feed's triggers on its tables. The
  spike decides.
- **Clients as models.** On Claude Code or Codex the client runs the tools over the bridge:
  Mastra's suspend doesn't apply and its stream carries text only (spike). Hence the gate on the
  tool and the bridge's tool parts.
- **Several processes per tenant.** Signals and suspend need a shared pub/sub (Redis) across
  instances; until then a tenant's chats run on one process.
- **Mastra betas.** Durable agents and parts of signals are marked beta; we take what is stable
  and pin the version (#267 moves to 1.80).
