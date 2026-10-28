# Spike: Work chats on Mastra

Status: done on 2026-10-28 against `@mastra/core` 1.80.0, `@mastra/memory` 1.39.1,
`@mastra/libsql` 1.27.1, `@mastra/ai-sdk` 1.11.2. PR 0 of `docs/plans/work-chats.md`. The
scripts are in `apps/runtime/spike/work-chats/`; each prints what it measured.

## Results

| Point | Result | Script |
|---|---|---|
| Mastra's store in a tenant's database | Works. `LibSQLStore` on the tenant's file adds 40 tables, all `mastra_`, none clashes; our migrations run after it as before | `storage.ts` |
| Memory per request (thread = chat, resource = space) | Works: the second turn sees the first, with the authors. The `memory` function is called ~15 times per turn: the `Memory` must be cached per tenant, not made per call | `storage.ts` |
| A `Mastra` instance | 3 ms to make: one per tenant (cached) holds that tenant's suspended runs in the tenant's store | `storage.ts` |
| Approval across a restart (API model) | Works: the turn stops at `tool-call-approval`; after a new `Mastra` on the same store, `listSuspendedRuns` finds the run, `approveToolCall` runs the tool once and the answer goes on | `storage.ts` |
| Approval in the browser | `toAISdkStream` (v7) turns it into the AI SDK's own `tool-approval-request`, what the shadcn/ui Tool pattern shows as Approve / Deny | `storage.ts` |
| Signals, several people | All work: a message the AI isn't asked about is kept without a run (`ifIdle: persist`, no model call); `sendMessage` wakes an idle chat and reaches a running turn at its next step; authors as `attributes` reach the model as `<user name="Ben">`; `queueMessage` waits; `abortThreadStream` with `clearPendingSignals` drops what waits. People's messages are stored with the role `signal` | `signals.ts` |
| Prompt caching (Anthropic, through the AI Gateway) | The prompt of each turn starts with the one before (Mastra replays memory stably). Marking only the system prompt: 96 → 90 % read from cache over four turns. Marking also the newest message (`processLLMRequest`): 97–98 % on every turn | `cache.ts` |
| Observational memory with caching | Thread scope. An activation breaks the message part of the prefix once: 74–80 % from cache on that turn (the system prompt stays cached), 95 % on the next. With a high threshold (engenty-pro: 80k tokens) that is rare | `om.ts` |
| A client (Claude Code) as the model | Answers, with memory, and runs our tools itself over the bridge (`model.attach(tools)`, as `models.ts` does). **But: `requireApproval` does not hold** (the mail tool ran without asking, no suspended run), and **its tool calls don't reach the stream** (text only). Usage comes back with the client's own cache reads | `client.ts` |

## What changes in the plan

1. **Approvals sit at the tool, not in Mastra's loop.** On a client the model runs the tools
   itself, so Mastra's suspend never sees them. One way for every model: a tool that acts
   outside the space doesn't act when called; it records the call (tool, arguments, who asked)
   as a pending approval and answers "waiting for approval". Approve runs the stored call once,
   with the stored arguments, and sends the result into the chat as a signal; the AI goes on
   from there. Deny sends that. The gate on the tool is also where the agent broker will stand.
   Mastra's suspend (which works on API models) is not used, so there is one path, not two.
2. **Tool steps of a client** are written by the bridge: each call and its result become tool
   parts of the AI's message (the bridge knows name, arguments and result), so the Trace shows
   them as on an API model.
3. **Memory cached per tenant**, a `Mastra` instance per tenant (its store is the tenant's).
4. **Messages the AI isn't asked about** go through `sendMessage` with `ifIdle: persist`: one
   store for every message of a chat, no `chat_message`.
5. **Cache marks**: system prompt plus the newest message, in an input processor
   (`processLLMRequest`); observational memory per thread with a high threshold and
   `activateAfterIdle: "auto"`.

## Not shown here

- A second process per tenant (signals need a shared pub/sub then; the cloud runs a tenant's
  chats on one process until there is one).
- Codex as the model (same bridge as Claude Code; expected the same).
- The space computer and browser through Mastra's `Workspace` and browser: their own spike
  with PR 5 and 6.
- The Anthropic key of this computer was at its usage limit; the cache runs used the AI
  Gateway with `anthropic/claude-haiku-5.5`.
