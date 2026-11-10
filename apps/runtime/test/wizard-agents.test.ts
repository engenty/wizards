import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWizard, type WizardDefinition, wizardSchema } from "@engenty/wizards-shared/definition";
import {
  agentsMismatch,
  requiresOf,
  requiresProblem,
  withRequires,
} from "@engenty/wizards-shared/requires";
import {
  parseWizardAgent,
  parseYamlMap,
  type WizardAgent,
  wizardAgentUseIssues,
} from "@engenty/wizards-shared/wizard-agents";
import { wizardAgentOfPath, wizardAgentsUsed } from "@engenty/wizards-shared/wizard-code";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { grantOf } from "../src/broker/grant";
import { validatePath } from "../src/cli/validate";

const RESEARCHER = `---
description: Finds offers and scores them against the budget
model: high
tools: [web_search, web_fetch, wizard.score]
output: { type: object, properties: { offers: { type: array, items: { type: string } } }, required: [offers] }
---
You research offers and score them against the budget.
`;

const agentOf = (name: string, text: string, paths?: string[]): WizardAgent => {
  const parsed = parseWizardAgent(name, text, paths);
  if (!parsed.ok) {
    throw new Error(parsed.issues.join("\n"));
  }
  return parsed.agent;
};

const definition = (step: Record<string, unknown>) =>
  wizardSchema.parse({
    title: "T",
    description: "",
    avatar: "round",
    steps: [
      { id: "work", type: "agent", title: "Work", instructions: "Do it.", output: { format: "text" }, ...step },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  }) as WizardDefinition;

describe("an agent's front matter", () => {
  it("reads mappings and lists by indentation, flow ones, quotes, blocks and comments", () => {
    expect(
      parseYamlMap(`description: "Finds: offers" # a comment
model: standard
tools:
  - web_search
  - wizard.score
output:
  type: object
  properties:
    offers: { type: array, items: { type: string } }
    total: {"type": "number"}
  required: [offers, total]
notes: |
  line one
  line two
flag: true
count: 3`),
    ).toEqual({
      description: "Finds: offers",
      model: "standard",
      tools: ["web_search", "wizard.score"],
      output: {
        type: "object",
        properties: {
          offers: { type: "array", items: { type: "string" } },
          total: { type: "number" },
        },
        required: ["offers", "total"],
      },
      notes: "line one\nline two\n",
      flag: true,
      count: 3,
    });
    expect(parseYamlMap("tools:\n- a\n- 'b, c'\nitems:\n  - name: x\n    n: 1")).toEqual({
      tools: ["a", "b, c"],
      items: [{ name: "x", n: 1 }],
    });
    expect(parseYamlMap("output: {\n  type: object,\n  properties: {}\n}")).toEqual({
      output: { type: "object", properties: {} },
    });
    expect(() => parseYamlMap("output: { type: object")).toThrow();
    expect(() => parseYamlMap("a: 1\na: 2")).toThrow('"a" is there twice');
  });
});

describe("an agent's file", () => {
  it("gives the instructions, the model, the tools and the output", () => {
    expect(agentOf("researcher", RESEARCHER, ["tools/score.ts"])).toEqual({
      name: "researcher",
      description: "Finds offers and scores them against the budget",
      model: "high",
      tools: ["web_search", "web_fetch", "wizard.score"],
      output: {
        type: "object",
        properties: { offers: { type: "array", items: { type: "string" } } },
        required: ["offers"],
      },
      instructions: "You research offers and score them against the budget.",
    });
    expect(agentOf("plain", "---\n---\nYou write.")).toMatchObject({
      model: "standard",
      tools: [],
    });
  });

  it("says what is wrong with it", () => {
    const issues = (text: string, paths: string[] = []) => {
      const parsed = parseWizardAgent("x", text, paths);
      return parsed.ok ? [] : parsed.issues;
    };
    expect(issues("You write.")).toEqual([
      'Agent "agents/x.md" has no front matter between --- lines.',
    ]);
    expect(
      issues(
        "---\nname: y\nmodel: huge\ntools: [agent.other, wizard.gone, nothing, contacts.list]\ncolor: red\n---\n",
      ),
    ).toEqual([
      'Agent "agents/x.md": "color" is no key of an agent: description, model, tools, output.',
      'Agent "agents/x.md" is named "y": name it "x", as its file.',
      'Agent "agents/x.md": "model" is one of classifier, low, standard, high, highest, not "huge".',
      'Agent "agents/x.md" lists "agent.other": an agent can\'t call another agent.',
      'Agent "agents/x.md" lists "wizard.gone", which has no file: tools/gone.ts or .js.',
      'Agent "agents/x.md" lists "nothing", which is no tool.',
      'Agent "agents/x.md" has no instructions: the text below the front matter.',
    ]);
    expect(issues("---\noutput: { type: string }\n---\nGo.")[0]).toContain(
      '"output" is no output schema',
    );
  });

  it("is found in agents/ by its name", () => {
    expect(wizardAgentOfPath("agents/researcher.md")).toBe("researcher");
    expect(wizardAgentOfPath("agents/sub/x.md")).toBeNull();
    expect(wizardAgentOfPath("agents/Bad.md")).toBeNull();
    expect(wizardAgentOfPath("tools/x.md")).toBeNull();
  });
});

describe("a step and the wizard's agents", () => {
  const researcher = agentOf("researcher", RESEARCHER, ["tools/score.ts"]);
  const agents = new Map([["researcher", researcher]]);

  it("name agents that have files, and a step that runs one names no model", () => {
    const messages = (step: Record<string, unknown>, files: string[]) =>
      validateWizard(definition(step), files).map((i) => i.message);
    const files = ["agents/researcher.md", "tools/score.ts"];
    expect(messages({ agent: "researcher" }, files)).toEqual([]);
    expect(messages({ tools: ["agent.researcher"] }, files)).toEqual([]);
    expect(messages({ agent: "gone" }, files)).toEqual(['Agent "gone" has no file: agents/gone.md.']);
    expect(messages({ agent: "researcher", model: "low" }, files)).toEqual([
      'The step runs agent "researcher": its file gives the model, the step names none.',
    ]);
    expect(messages({ agent: "researcher", tools: ["agent.researcher"] }, files)).toEqual([
      'Tool "agent.researcher": a step that runs an agent lists no other agent.',
    ]);
    expect(wizardAgentsUsed(definition({ agent: "a", tools: ["agent.b", "web_fetch"] }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("narrow the agent's tools, never widen them, and a tool's agent has a description", () => {
    const issues = (step: Record<string, unknown>, own = agents) =>
      wizardAgentUseIssues(definition(step), own).map((i) => i.message);
    expect(issues({ agent: "researcher", tools: ["web_fetch"] })).toEqual([]);
    expect(issues({ agent: "researcher", tools: ["web_fetch", "browser"] })).toEqual([
      'The step lists "browser", which agent "researcher" doesn\'t: a step narrows an agent\'s tools, never widens them.',
    ]);
    const quiet = new Map([["quiet", agentOf("quiet", "---\n---\nGo.")]]);
    expect(issues({ tools: ["agent.quiet"] }, quiet)).toEqual([
      'Agent "quiet" is a tool here and needs a "description" in its front matter: what the step\'s model reads.',
    ]);
  });

  it("put what the agents need into requires, and keep it where the files aren't read", () => {
    const asStep = definition({ agent: "researcher" });
    const required = requiresOf(asStep, agents);
    expect(required).toEqual({
      models: ["classifier", "high"],
      tools: ["agent.researcher", "web_fetch", "web_search", "wizard.score"],
      run: ["code"],
      features: ["codeSteps"],
      agents: {
        researcher: {
          models: ["classifier", "high"],
          tools: ["web_fetch", "web_search", "wizard.score"],
        },
      },
    });
    // A writer that reads only the definition keeps what `requires.agents` says.
    const saved = withRequires(asStep, agents);
    expect(withRequires(saved).requires).toEqual(required);
    expect(requiresProblem(saved, agents)).toBeNull();
    // Without its files, a step's agent is on the default class until they are read.
    expect(requiresOf(asStep).models).toEqual(["standard"]);
    // The file changed: validate says so.
    const lower = new Map([["researcher", { ...researcher, model: "low" as const }]]);
    expect(requiresProblem(saved, lower)).toContain('"requires.agents.researcher" says');

    const asTool = definition({ tools: ["agent.researcher"], model: "low" });
    expect(requiresOf(asTool, agents)).toMatchObject({
      models: ["classifier", "high", "low"],
      tools: ["agent.researcher", "web_fetch", "web_search", "wizard.score"],
    });
    // A step that narrows the tools needs only those.
    expect(requiresOf(definition({ agent: "researcher", tools: ["web_fetch"] }), agents)).toMatchObject({
      tools: ["agent.researcher", "web_fetch"],
    });
    expect(
      requiresOf(definition({ agent: "researcher", tools: ["web_fetch"] }), agents).run,
    ).toBeUndefined();
  });

  it("say which agent's entry in requires differs from its file, and drop agents no step uses", () => {
    const saved = withRequires(definition({ agent: "researcher" }), agents);
    const lower = new Map([["researcher", { ...researcher, model: "low" as const }]]);
    expect(agentsMismatch(saved, lower)).toEqual([
      {
        name: "researcher",
        message:
          '"requires.agents.researcher" says models ["classifier","high"], tools ["web_fetch","web_search","wizard.score"]; agents/researcher.md needs models ["classifier","low"], tools ["web_fetch","web_search","wizard.score"].',
      },
    ]);
    expect(requiresProblem(saved, lower)).toBe(agentsMismatch(saved, lower)[0].message);
    const missing = withRequires(definition({ agent: "researcher" }));
    expect(agentsMismatch(missing, agents)[0].message).toContain(
      '"requires.agents" has no "researcher": agents/researcher.md needs',
    );
    // A writer that reads only the definition keeps an agent a step still names, and drops one
    // no step uses any more.
    const moved = { ...saved, steps: definition({ instructions: "Alone." }).steps };
    expect(withRequires(moved).requires?.agents).toBeUndefined();
    const extra = { ...moved, requires: { ...saved.requires, agents: saved.requires?.agents } };
    expect(agentsMismatch(extra, agents)).toEqual([
      { name: "researcher", message: '"requires.agents.researcher": no step uses this agent.' },
    ]);
  });

  it("are in the run's grant, with the tools their files list", () => {
    const grant = grantOf(withRequires(definition({ agent: "researcher" }), agents));
    expect(grant.tools).toEqual(["agent.researcher", "web_fetch", "web_search", "wizard.score"]);
  });

  it("are part of wizards validate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-validate-agents-"));
    const write = (name: string, def: WizardDefinition, files: Record<string, string>) => {
      const path = join(dir, name);
      writeFileSync(
        path,
        zipSync({
          "wizard.json": strToU8(JSON.stringify({ format: "engenty-wizard", version: 1, definition: def })),
          ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`files/${k}`, strToU8(v)])),
        }),
      );
      return path;
    };
    const score = `export const description = "Scores";
export const input = { type: "object", properties: {} };
export function run() { return { score: 1 }; }`;
    const files = { "agents/researcher.md": RESEARCHER, "tools/score.ts": score };
    const ok = withRequires(definition({ agent: "researcher" }), agents);
    expect(await validatePath(write("ok.wizard", ok, files))).toMatchObject({ ok: true, files: 2 });

    // Saved by a writer that never read the agent's file: requires is out of date.
    const stale = withRequires(definition({ agent: "researcher" }));
    const said = (await validatePath(write("stale.wizard", stale, files))).issues.map((i) => i.message);
    expect(said).toEqual([
      expect.stringContaining('"requires.agents" has no "researcher": agents/researcher.md needs'),
    ]);

    const broken = await validatePath(
      write("broken.wizard", withRequires(definition({ agent: "researcher", tools: ["browser"] })), {
        ...files,
        "agents/other.md": "---\nmodel: huge\n---\nGo.",
        "agents/Bad.md": "---\n---\nGo.",
      }),
    );
    expect(broken.ok).toBe(false);
    expect(broken.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'The step lists "browser", which agent "researcher" doesn\'t: a step narrows an agent\'s tools, never widens them.',
        'Agent "agents/other.md": "model" is one of classifier, low, standard, high, highest, not "huge".',
        'Agent "agents/Bad.md": a file directly in agents/, named in lowercase letters, digits and _, starting with a letter.',
      ]),
    );
  });
});
