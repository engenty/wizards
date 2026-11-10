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
import { declareSandboxTool, declareWizardTool } from "../src/engine/wizard-code";

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
    expect(wizardToolOfPath("tools/convert/TOOL.md")).toBe("convert");
    expect(wizardToolOfPath("tools/convert/convert.py")).toBeNull();
    expect(wizardToolOfPath("tools/a/b/TOOL.md")).toBeNull();
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
  it("name a tool without a file, with two files, and an agent without a file", () => {
    const messages = (tools: string[], files: string[]) =>
      validateWizard(definition(tools), files).map((i) => i.message);
    expect(messages(["wizard.score"], ["tools/score.ts"])).toEqual([]);
    expect(messages(["wizard.score"], [])).toEqual([
      'Tool "wizard.score" has no file: tools/score.ts, tools/score.js or tools/score/TOOL.md.',
    ]);
    expect(messages(["wizard.score"], ["tools/score.ts", "tools/score.js"])).toEqual([
      'Tool "wizard.score" has two files: keep one of tools/score.js, tools/score.ts.',
    ]);
    expect(messages(["agent.researcher"], [])).toEqual([
      'Tool "agent.researcher" has no file: agents/researcher.md.',
    ]);
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
    expect(said).toContain('Tool "wizard.gone" has no file: tools/gone.ts, tools/gone.js or tools/gone/TOOL.md.');
    expect(said).toContain('Tool "wizard.score" exports no "description": a sentence of what it does.');
    expect(said).toContain('Tool "wizard.other" has two files: keep one of tools/other.js, tools/other.ts.');
  });
});

const CONVERT = [
  "---",
  "description: Converts a supplier's price list into our item table",
  "input:  { type: object, properties: { file: { type: string } }, required: [file] }",
  "output:",
  "  type: object",
  "  properties:",
  "    items: { type: array }",
  "run: python3 convert.py",
  "hosts: [api.exchangerate.host]",
  "---",
  "Reads the file, maps the supplier's columns.",
].join("\n");

const withHosts = (tools: string[], hosts?: string[]) =>
  wizardSchema.parse({
    title: "T",
    description: "",
    avatar: "round",
    steps: [
      {
        id: "work",
        type: "agent",
        title: "Work",
        instructions: "Do it.",
        tools,
        ...(hosts ? { hosts } : {}),
        output: { format: "text" },
      },
      { id: "done", type: "result", title: "Done", deliverables: [] },
    ],
  }) as WizardDefinition;

describe("a wizard's sandbox tools", () => {
  it("are read from TOOL.md, its schemas in YAML or JSON", () => {
    expect(declareSandboxTool("convert", CONVERT)).toEqual({
      ok: true,
      tool: {
        description: "Converts a supplier's price list into our item table",
        input: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
        output: { type: "object", properties: { items: { type: "array" } } },
        run: "python3 convert.py",
        hosts: ["api.exchangerate.host"],
        body: "Reads the file, maps the supplier's columns.",
      },
    });
    const json = declareSandboxTool(
      "sum",
      '---\ndescription: Sums\ninput: {"type": "object", "properties": {"n": {"type": "number"}}}\nrun: node sum.js\n---\n',
    );
    expect(json).toMatchObject({ ok: true, tool: { run: "node sum.js", hosts: [] } });
  });

  it("say what their TOOL.md lacks", () => {
    const issues = (text: string) => {
      const read = declareSandboxTool("convert", text);
      return read.ok ? [] : read.issues;
    };
    expect(issues("no front matter")).toEqual([
      'Tool "wizard.convert": its TOOL.md has no front matter between --- lines.',
    ]);
    expect(issues("---\ninput: [unclosed\n---\n")[0]).toContain("is no YAML");
    expect(issues("---\ndescription: Converts\ninput: { type: string }\nhosts: [localhost, 'a b']\n---\n")).toEqual([
      'Tool "wizard.convert": "input" describes an object ("type": "object").',
      'Tool "wizard.convert" has no "run": the command that runs it, such as python3 convert.py.',
      'Tool "wizard.convert": "localhost" is no host name, such as api.example.com.',
      'Tool "wizard.convert": "a b" is no host name, such as api.example.com.',
    ]);
  });

  it("need a sandbox that runs a shell, which requires says where the files are known", () => {
    const def = withHosts(["wizard.convert"], ["api.exchangerate.host"]);
    const paths = ["tools/convert/TOOL.md", "tools/convert/convert.py"];
    expect(requiresOf(def, undefined, paths)).toMatchObject({
      tools: ["wizard.convert"],
      run: ["code"],
      sandbox: "shell",
      features: ["codeSteps"],
    });
    expect(requiresOf(def, undefined, ["tools/convert.ts"]).sandbox).toBeUndefined();
    // A writer that doesn't see the files keeps what the definition says.
    const saved = withRequires(def, undefined, paths);
    expect(withRequires(saved).requires?.sandbox).toBe("shell");
    expect(requiresOf(withHosts(["web_fetch"]), undefined, paths).sandbox).toBeUndefined();
  });

  it("are part of wizards validate: TOOL.md, its folder and the step's hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-validate-sandbox-tools-"));
    const write = (name: string, files: Record<string, string>, def: WizardDefinition) => {
      const path = join(dir, name);
      const paths = Object.keys(files);
      writeFileSync(
        path,
        zipSync({
          "wizard.json": strToU8(
            JSON.stringify({ format: "engenty-wizard", version: 1, definition: withRequires(def, undefined, paths) }),
          ),
          ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`files/${k}`, strToU8(v)])),
        }),
      );
      return path;
    };
    const files = { "tools/convert/TOOL.md": CONVERT, "tools/convert/convert.py": "print('ok')" };
    expect(
      await validatePath(
        write("ok.wizard", files, withHosts(["wizard.convert"], ["*.exchangerate.host"])),
      ),
    ).toMatchObject({ ok: true, files: 2 });

    const noHost = await validatePath(write("hosts.wizard", files, withHosts(["wizard.convert"])));
    expect(noHost.issues).toEqual([
      {
        stepId: "work",
        message:
          'Tool "wizard.convert" reaches api.exchangerate.host: list it in the step\'s "hosts" too.',
      },
    ]);

    const both = await validatePath(
      write("both.wizard", { ...files, "tools/convert.ts": SCORE }, withHosts(["web_fetch"])),
    );
    expect(both.issues.map((i) => i.message)).toContain(
      'Tool "wizard.convert" has two files: keep one of tools/convert.ts, tools/convert/TOOL.md.',
    );

    const stale = await validatePath(
      write("stale.wizard", { "tools/convert/TOOL.md": CONVERT }, withHosts(["wizard.convert"], ["api.exchangerate.host"])),
    );
    expect(stale.ok).toBe(true);
  });
});
