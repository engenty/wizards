import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFINITION_VERSION, parseWizard } from "@engenty-wizards/shared/definition";
import { packageJsonSchema, wizardJsonSchema } from "@engenty-wizards/shared/json-schema";
import { Ajv2020 } from "ajv/dist/2020.js";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EXAMPLE_WIZARD } from "../src/authoring/example";
import { validateCommand, validatePath } from "../src/cli/validate";

const published = (path: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../docs/public/schema", path), "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
const checkWizard = ajv.compile(wizardJsonSchema());
const checkPackage = ajv.compile(packageJsonSchema());

const manifest = (definition: unknown) => ({
  $schema: "https://engenty.ai/schema/v1/wizard-package.json",
  format: "engenty-wizard",
  version: 1,
  definition,
});

describe("the published JSON Schemas", () => {
  it("are the ones the Zod schemas give (pnpm schema writes them)", () => {
    expect(published(`v${DEFINITION_VERSION}/wizard.json`)).toEqual(wizardJsonSchema());
    expect(published(`v${DEFINITION_VERSION}/wizard-package.json`)).toEqual(packageJsonSchema());
  });

  it("take what the app takes", () => {
    expect(checkWizard(EXAMPLE_WIZARD), JSON.stringify(checkWizard.errors)).toBe(true);
    expect(checkWizard({ ...EXAMPLE_WIZARD, $schema: "x" })).toBe(true);
    expect(checkPackage(manifest(EXAMPLE_WIZARD)), JSON.stringify(checkPackage.errors)).toBe(true);
    // Defaults may be left out, as a person writing the file by hand would.
    const bare = { title: "x", steps: [{ id: "r", type: "result", title: "R", deliverables: [] }] };
    expect(parseWizard(bare).ok).toBe(true);
    expect(checkWizard(bare)).toBe(true);
  });

  it("name a key the app would drop", () => {
    expect(checkWizard({ ...EXAMPLE_WIZARD, titel: "x" })).toBe(false);
    expect(checkPackage(manifest({ ...EXAMPLE_WIZARD, steps: [] }))).toBe(false);
  });
});

describe("wizards validate", () => {
  const dir = mkdtempSync(join(tmpdir(), "wizards-validate-"));
  const widget = {
    title: "Karte",
    steps: [
      { id: "map", type: "widget", title: "Karte", entry: "map/index.html" },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  };
  const write = (name: string, content: string | Uint8Array) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it("checks a definition on its own", () => {
    const r = validatePath(write("example.json", JSON.stringify(EXAMPLE_WIZARD)));
    expect(r).toMatchObject({ ok: true, steps: EXAMPLE_WIZARD.steps.length, issues: [] });
  });

  it("checks a package against its workspace", () => {
    const zip = (files: Record<string, Uint8Array>) =>
      zipSync({ "wizard.json": strToU8(JSON.stringify(manifest(widget))), ...files });
    const whole = validatePath(
      write("whole.wizard", zip({ "files/map/index.html": strToU8("<h1>Karte</h1>") })),
    );
    expect(whole).toMatchObject({ ok: true, steps: 2, files: 1 });
    const lacking = validatePath(write("lacking.wizard", zip({})));
    expect(lacking.ok).toBe(false);
    expect(lacking.issues.map((i) => i.message).join("\n")).toContain("map/index.html");
  });

  it("checks an unpacked package by its folder or its wizard.json", () => {
    const folder = join(dir, "unpacked");
    mkdirSync(join(folder, "files/map"), { recursive: true });
    writeFileSync(join(folder, "wizard.json"), JSON.stringify(manifest(widget)));
    writeFileSync(join(folder, "files/map/index.html"), "<h1>Karte</h1>");
    expect(validatePath(folder)).toMatchObject({ ok: true, files: 1 });
    expect(validatePath(join(folder, "wizard.json"))).toMatchObject({ ok: true, files: 1 });
  });

  it("names where the shape is wrong, and answers with 1", () => {
    const path = write(
      "broken.json",
      JSON.stringify({ title: "x", steps: [{ id: "ask", type: "page", title: 3 }] }),
    );
    const r = validatePath(path);
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toMatch(/^steps\[0\] "ask"/);
    expect(validatePath(join(dir, "missing.wizard")).issues[0].message).toBe(
      "No such file or folder.",
    );
    const log = console.log;
    console.log = () => {};
    try {
      expect(validateCommand([path], false)).toBe(1);
      expect(validateCommand([join(dir, "example.json")], true)).toBe(0);
      expect(validateCommand([], false)).toBe(2);
    } finally {
      console.log = log;
    }
  });
});
