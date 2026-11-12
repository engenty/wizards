# Plan: Extra, asked for during a run

Status: plan, 2026-11-12. Phase 1 built (see the end).

## Why

A step names a class (`low`, `standard`, `high`, `highest` with a maker) and maybe an effort. The
author picks them once, for the run they imagine. Some runs need more than that: a cheap model
often fails to use a tool that only appears after it loaded a skill, where a stronger one uses it
every time. engenty.goose found this first and built „Extra“ there; the studio's chats have an
Extra model per way already (`services/chat-models.ts`, `normal` and `extra`).

Here, Extra means: a skill, a tool or the model itself asks for a stronger model and more effort
for the rest of the run. Depending on what the step allows and who is there, the run switches on
its own and says so, or asks the person first.

## Decisions

1. **Who asks.**
   - A skill: front matter `extra: true`, for a space's skill and a wizard's own skill alike
     (`meta.extra`). It asks when a step loads it with `skill_load`; a skill always on asks as the
     step starts.
   - The model: a tool `need_extra { reason }` in every AI step whose rule is not `deny`. Its
     description says when: a tool it cannot get right, a task that turns out harder than it
     looked.
   - A tool, later (phase 2): a plugin tool's spec (`extra: true`), a connection's action, an MCP
     tool's `_meta["engenty/extra"]`. Each asks when it is called; the ask has the tool's name.
   - The step itself does not ask: it names its class and effort. It says what happens when
     something asks (2).
2. **What the step allows.** An AI step takes `extra`, in the words a connection's rules use:
   `allow` (Erlaubt), `ask` (Mit Freigabe, the default), `deny` (Nie).

   | Who is there | `allow` | `ask` | `deny` |
   |---|---|---|---|
   | A person of the organization in the runner, test or live | switches, says so | asks; the answer holds for the run | stays |
   | A guest of a shared wizard | switches, says so | stays: the organization pays, the guest has no say | stays |
   | A start, an autopilot, an MCP client driving the run | switches, says so | stays: nobody to ask | stays |

   "Says so" is a line in the run's log, „Extra · <reason>“. "Stays" is a line too, so the author
   sees in the test run that something asked.
3. **Scope: the run.** Once on, every later AI step of the run starts on Extra, each entry of a
   `foreach` too. It is kept in the run's state (`RunState.extra`), so a runner that takes over
   after a crash or a deploy goes on with it. Nothing outside the run changes: not the step, not
   the wizard, not the studio's Extra of a chat.
4. **A person's no wins.** „Nicht jetzt“ is kept in the run's state as Extra off; nothing asks
   again in this run, whatever skill or tool comes. No answer within the ask's 15 minutes counts
   as a no.
5. **Per model step.** The run decides before each model call: an ask granted in the middle of a
   step switches the step's next model call, so loading a skill switches what follows. A model
   that keeps its own loop (an installed client, the run's device, a durable turn) switches from
   the next AI step.
6. **One step up.** From the step's own class and effort, both one level higher:

   | Class | Extra |
   |---|---|
   | `classifier`, `low` | `standard` |
   | `standard` | `high` |
   | `high` | `highest` with a maker that has it (`anthropic`, `openai`), else `high` |
   | `highest` | `highest` |

   Effort: `low` → `medium` → `high`; none given → `high`. The class keeps its maker, so a step
   on `anthropic/standard` goes to `anthropic/high`. Where the class runs is decided as for any
   class (`models.ts`): an installed client runs its model of the next class (Claude Code
   haiku → sonnet → opus, Codex its `high` model), an own key its provider's model of that class,
   the credits `wizards/<class>`.

   The organization's tier and its admins' policy bound it: a class the tier doesn't offer, or the
   way-C list leaves out, stays where it was; an effort above the policy's `effortCap` stays at
   the cap. Where nothing goes up, nothing switches, and the log says the step is at the top.
7. **Only AI steps.** Decisions keep the classifier, image, video and voice steps their class.
   Document, dashboard and motion-graphics steps can follow in phase 2: they have a class and an
   effort too.
8. **Costs.** Extra runs on the stronger model and is booked as that model, step by step. The ask
   says so in a sentence.

## The ask

A new ask kind next to `login` and `confirm` (`RunAsk`), shown by the runner's `AskPanel`:

```ts
interface ExtraAsk {
  kind: "extra";
  reason: string;            // in the model's or the skill's words
  by: { kind: "skill" | "model" | "tool"; name: string };
}
```

The panel: the reason as the heading, who asks under it, one sentence on what Extra does and that
it costs more, „Nicht jetzt“ and „Extra einschalten“. Answers are the existing `done` and `skip`.
`askOf` (`engine/runner.ts`) puts an `extra` ask only to a person of the organization: a run
without a user, a started run or an autopilot's run gets null.

## Phases

1. Built on `claude/suspicious-mcclintock-02c8f5`: step `extra`, `stepUp` in shared
   (`extra.ts`), `RunState.extra`, the skill front matter, `need_extra`, the switch per model call
   in an agent step, the ask and its panel, the log lines, tests.
2. Tools ask: plugin tool specs, connection actions, MCP `_meta`. Document, dashboard and
   motion-graphics steps.
3. The editor: `extra` in the Inspector's model section, next to class and effort.

## Open

- Guests: with `ask` a guest's run stays. Whether an organization wants guests to say yes on its
  credits is a choice for later; `allow` covers it per step today.
- Starts: a start that allows changes (`allowChanges`) could allow Extra too. Kept apart for now.
