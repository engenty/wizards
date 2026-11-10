import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginToolOf,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { pluginsOf, requiresOf, withRequires } from "@engenty/wizards-shared/requires";
import {
  jsonSchemaIssues,
  wizardCodeOf,
  wizardToolOfPath,
  wizardToolsIn,
} from "@engenty/wizards-shared/wizard-code";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { validatePath } from "../src/cli/validate";
import { declareWizardTool } from "../src/engine/wizard-code";

const SCORE = `
export const description = "Scores an offer";
export const input = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
export function run({ price }: { price: number }) { return { score: price / 100 }; }
`;

const definition = (tools: string[]) =>
  wizardSchema.parse({
    title: "T",
    description: "",
    avatar: "round",
    steps: [
      { id: "work", type: "agent", title: "Work", instructions: "Do it.", tools, output: { format: "text" } },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  }) as WizardDefinition;

describe("the wizard's own tool ids", () => {
  it("are no plugin's tools", () => {
    expect(wizardCodeOf("wizard.score")).toEqual({ kind: "tool", name: "score" });
    expect(wizardCodeOf("agent.researcher")).toEqual({ kind: "agent", name: "researcher" });
    expect(wizardCodeOf("contacts.list")).toBeNull();
    expect(pluginToolOf("wizard.score")).toBeNull();
    expect(pluginToolOf("contacts.list")).toEqual({ plugin: "contacts", tool: "list" });
    expect(pluginsOf(definition(["wizard.score", "contacts.list"]))).toEqual(["contacts"]);
  });

  it("are in requires, with the code they run and its switch", () => {
    expect(requiresOf(definition(["web_fetch", "wizard.score"]))).toMatchObject({
      tools: ["web_fetch", "wizard.score"],
      run: ["code"],
      features: ["codeSteps"],
    });
    expect(requiresOf(definition(["web_fetch"])).run).toBeUndefined();
  });

  it("are read from tools/ in the workspace, directly and by .ts or .js", () => {
    expect(wizardToolOfPath("tools/score.ts")).toBe("score");
    expect(wizardToolOfPath("tools/rate.js")).toBe("rate");
    expect(wizardToolOfPath("tools/convert/TOOL.md")).toBeNull();
    expect(wizardToolOfPath("code/score.ts")).toBeNull();
    expect(wizardToolsIn(["tools/a.ts", "tools/a.js", "tools/b.ts"])).toEqual(
      new Map([
        ["a", ["tools/a.ts", "tools/a.js"]],
        ["b", ["tools/b.ts"]],
      ]),
    );
  });
});

describe("checks of a wizard's function tools", () => {
  it("name a tool without a file, with two files, and agents that aren't there yet", () => {
    const messages = (tools: string[], files: string[]) =>
      validateWizard(definition(tools), files).map((i) => i.message);
    expect(messages(["wizard.score"], ["tools/score.ts"])).toEqual([]);
    expect(messages(["wizard.score"], [])).toEqual([
      'Tool "wizard.score" has no file: tools/score.ts or tools/score.js.',
    ]);
    expect(messages(["wizard.score"], ["tools/score.ts", "tools/score.js"])).toEqual([
      'Tool "wizard.score" has two files: keep one of tools/score.js, tools/score.ts.',
    ]);
    expect(messages(["agent.researcher"], [])[0]).toContain("aren't supported yet");
    const toolStep = wizardSchema.parse({
      title: "T",
      steps: [
        { id: "call", type: "tool", title: "Call", call: { tool: "wizard.score" }, output: {} },
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    }) as WizardDefinition;
    expect(validateWizard(toolStep, ["tools/score.ts"]).map((i) => i.message)).toContain(
      'A tool step calls a plugin\'s tool. The wizard\'s own "wizard.score" is called by an AI step that lists it in tools.',
    );
  });

  it("read what the file exports, in QuickJS", async () => {
    expect(await declareWizardTool("score", SCORE)).toMatchObject({
      ok: true,
      tool: { description: "Scores an offer", input: { type: "object" } },
    });
    const issues = async (source: string) => {
      const declared = await declareWizardTool("x", source);
      return declared.ok ? [] : declared.issues;
    };
    expect(await issues('import x from "y";\nexport function run() {}')).toEqual([
      'Tool "wizard.x" imports: a function tool has no modules.',
    ]);
    expect(await issues("export function run() {}")).toEqual([
      'Tool "wizard.x" exports no "description": a sentence of what it does.',
      'Tool "wizard.x" exports no "input": the JSON Schema of its arguments.',
    ]);
    expect(
      await issues(
        'export const description = "d";\nexport const input = { type: "string" };\nexport const output = { type: "objekt" };',
      ),
    ).toEqual([
      'Tool "wizard.x": "input" describes an object ("type": "object").',
      'Tool "wizard.x": output: "objekt" is no JSON Schema type.',
      'Tool "wizard.x" exports no function run(input, { fetch, tools }).',
    ]);
    expect((await issues("throw new Error('boom');"))[0]).toContain("doesn't load: boom");
  });

  it("know a JSON Schema from something else", () => {
    expect(
      jsonSchemaIssues(
        { type: "object", properties: { a: { type: ["string", "null"] } }, required: ["a"] },
        "input",
      ),
    ).toEqual([]);
    expect(jsonSchemaIssues({ type: "object", required: ["b"] }, "input")).toEqual([
      'input: "b" is required but no property.',
    ]);
    expect(jsonSchemaIssues({ type: "array", items: { type: "nope" } }, "input")).toEqual([
      'input[]: "nope" is no JSON Schema type.',
    ]);
  });

  it("are part of wizards validate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-validate-tools-"));
    const manifest = (tools: string[]) =>
      JSON.stringify({
        format: "engenty-wizard",
        version: 1,
        definition: withRequires(definition(tools)),
      });
    const write = (name: string, files: Record<string, string>, tools: string[]) => {
      const path = join(dir, name);
      writeFileSync(
        path,
        zipSync({
          "wizard.json": strToU8(manifest(tools)),
          ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`files/${k}`, strToU8(v)])),
        }),
      );
      return path;
    };
    expect(await validatePath(write("ok.wizard", { "tools/score.ts": SCORE }, ["wizard.score"]))).toMatchObject({
      ok: true,
      files: 1,
    });
    const broken = await validatePath(
      write("broken.wizard", { "tools/score.ts": "export function run() {}", "tools/other.ts": SCORE, "tools/other.js": SCORE }, ["wizard.score", "wizard.gone"]),
    );
    expect(broken.ok).toBe(false);
    const said = broken.issues.map((i) => i.message);
    expect(said).toContain('Tool "wizard.gone" has no file: tools/gone.ts or tools/gone.js.');
    expect(said).toContain('Tool "wizard.score" exports no "description": a sentence of what it does.');
    expect(said).toContain('Tool "wizard.other" has two files: keep one of tools/other.js, tools/other.ts.');
  });
});
