# Plan: tools, skills and agents shipped in the wizard file

Status: plan, written on 2026-11-09. Not built. Comes after the version-1 stack (#577, #579, #580
and what follows), which brings `tool` and `code` steps, JSON Schema outputs and the root
`requires`.

## Why

A wizard can't give its model a tool of its own: every tool is runtime or plugin code, and a plugin
needs an admin to install it. The `code` step runs a function, but the model can't call it. Mastra
registers agents and tools in code and points at them by id; a `.wizard` file should carry its own
and stay self-contained.

## Decisions

1. **Three kinds of files in the workspace**, in the shape Claude Code uses, which models already
   know: Markdown with frontmatter.

   ```
   files/tools/score.ts            a function tool, run in QuickJS
   files/tools/convert/TOOL.md     a sandbox tool, its scripts beside it, run in agentOS
   files/skills/<name>/SKILL.md    a skill of the wizard, with scripts
   files/agents/<name>.md          an agent: instructions, model class, tools
   ```

2. **Wizard code is untrusted.** It comes from the marketplace, from imports and runs as a guest. It
   runs only in QuickJS or agentOS, never in the runtime's process. Every effect goes through the
   broker with the run's caller and grant. Trusted code stays a plugin.
3. **Names are prefixed.** A step lists `wizard.score`, `wizard.convert`, `agent.researcher`. A
   wizard's skill counts only inside its wizard and comes before a space skill of the same name.
4. **One level.** An agent used as a tool can't call another agent.
5. **`requires`** at the root names all of it (`run: ["code"]`, `sandbox: "shell"`, the
   `wizard.*` and `agent.*` tools), so a runtime that lacks something refuses before the start.
6. **Agents live in the wizard first.** The same file becomes a space element later (Studio's
   "Wizards, agents" on the modular roadmap).

## Function tools: `tools/<name>.ts`

```ts
export const description = "Scores an offer against the budget";
export const input = {
  type: "object",
  properties: { price: { type: "number" }, budget: { type: "number" } },
  required: ["price", "budget"],
};
export async function run({ price, budget }, { fetch, tools }) {
  return { score: Math.max(0, 1 - price / budget) };
}
```

- Runs in QuickJS like the `code` step (`engine/code-step.ts`): no imports, 64 MB, 10 s a call,
  no credits, guests too.
- `fetch` reaches the step's `hosts` through the broker. `tools.<id>(args)` calls the step's other
  tools, as `execute_typescript` does (`tools/code.ts`); a write that needs a yes still asks.
- `input` is JSON Schema; the model sees it as the tool's schema. An `output` schema is optional
  and checked when given.

## Sandbox tools: `tools/<name>/TOOL.md`

```markdown
---
description: Converts a supplier's price list (CSV or XLSX) into our item table
input:  { type: object, properties: { file: { type: string } }, required: [file] }
output: { type: object, properties: { items: { type: array } } }
run: python3 convert.py
hosts: [api.exchangerate.host]
---
Reads the file, maps the supplier's columns, converts currencies to EUR.
```

- Runs in the run's sandbox (agentOS, or Docker where that is the engine). The folder is copied to
  `tools/<name>/`; the call writes `input.json`, runs `run`, reads `output.json`. Files written
  to `out/` become the step's assets. An upload named in the input is copied in first.
- Network: the tool's `hosts`, and only those the run's grant also allows. The sandbox's own
  default-deny rules hold them.
- The VM lasts the run: installed packages and files stay between calls.
- A step's model calls it with typed arguments and gets typed output. It never sees the script.

## Skills: `skills/<name>/SKILL.md`

- The same format and tools as the space's skills (`tools/skills.ts`): `skill_load`, `skill_read`,
  scripts copied to `skills/<name>/` in the sandbox and run with `run_command`.
- Always on or on demand, as a space skill. Only the steps of the wizard see it.
- For open work where the model decides what to run. A fixed entry point with typed arguments is a
  sandbox tool.

## Agents: `agents/<name>.md`

```markdown
---
model: standard
tools: [web_search, web_fetch, wizard.score]
output: { type: object, properties: { offers: { type: array } } }
---
You research offers and score them against the budget …
```

- **As a step's agent:** `{ "type": "agent", "agent": "researcher", "instructions": "Find offers for {{product}}" }`.
  The file gives the system part, model and tools; the step gives the task and may narrow
  the tools, never widen them.
- **As a tool:** a step lists `agent.researcher`. Its model hands a task over and gets the agent's
  answer, or its `output` as JSON. It runs as a Mastra `Agent` built like an agent step, with the
  step's caller and grant; its model calls are charged to the run.

## Where it shows

| Place | What changes |
|---|---|
| `definition.ts` | `tools` accepts `wizard.<name>` and `agent.<name>`; `agent` on an agent step |
| `wizards validate` | Every named tool, skill and agent exists in `files/`; frontmatter and schemas parse; `requires` matches |
| Import and marketplace | Show `requires` and that the wizard brings code; refuse what the runtime lacks |
| Studio | The workspace lists tools, skills and agents; a step's tool picker offers them; the architect writes them |
| `authoring.md`, docs | A page "Tools, skills and agents in the wizard" |
| Tool catalogue | Wizard items join a step's tools under the broker, with their own log lines |

## Order

1. Function tools in QuickJS, with `requires` and `validate`.
2. Agents as files: first as a step's agent, then as tools.
3. Skills in the wizard, on the existing skill tools.
4. Sandbox tools, together with agentOS in its own container in the cloud (below).

Each step adds keys and files only: no stored wizard changes.

## Before sandbox code runs in the cloud

From `agentos-sandbox.md`: agentOS isolates with WebAssembly and V8, not a kernel. It moves into a
container of its own behind a small API (exec, read, write, destroy), reached like the browser
container, with a cap on parallel VMs per runner. Until then sandbox tools and skill scripts run on
local installs and where Docker is the engine. Guests need `SANDBOX_GUESTS=agentos`.

## Open

- Marketplace: whether a wizard that brings sandbox code needs a review before it is listed.
- Translation: tool and agent descriptions stay in the wizard's language.
- Versions: a wizard's code changes with the wizard; nothing is pinned separately.
