import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelFile } from "@engenty/wizards-shared/definition";
import { describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-check-"));
process.env.DATA_DIR = dir;

const example = new URL("../../../packages/kernel/examples/offer/", import.meta.url).pathname;

/** A wizard's code as a map of its files, read as the check reads a workspace. */
const from = (files: Record<string, string>) => ({
  paths: Object.keys(files),
  read: async (path: string) => files[path] ?? null,
});
const file = (edges: Record<string, string[]>, start = Object.keys(edges)[0]) =>
  ({ version: "0.3.0", title: "T", description: "", start, edges }) as KernelFile;
const messages = async (f: KernelFile, files: Record<string, string>) => {
  const { kernelCodeIssues } = await import("../src/kernel/check");
  const { paths, read } = from(files);
  return (await kernelCodeIssues(f, paths, read)).map((issue) => issue.message);
};

describe("the check of a wizard's code", () => {
  it("has nothing to say of the offer example", async () => {
    const files: Record<string, string> = {
      "wizard.ts": readFileSync(`${example}wizard.ts`, "utf8").replace("../../src/types.js", "./kernel-types.js"),
    };
    for (const name of readdirSync(`${example}steps`)) {
      files[`steps/${name}`] = readFileSync(`${example}steps/${name}`, "utf8");
    }
    const offer = JSON.parse(readFileSync(`${example}wizard.json`, "utf8")) as KernelFile;
    expect(await messages(offer, files)).toEqual([]);
  });

  it("names a step file that does not compile, with its line", async () => {
    const said = await messages(file({ ask: ["end"] }), {
      "steps/ask.ts": "export default async (run, ask) => {\n  return { value: await ask({ type: 'form' };\n};\n",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^steps\/ask\.ts:2: /);
  });

  it("names a step that imports anything but a file of its workspace", async () => {
    const said = await messages(file({ ask: ["end"] }), {
      "steps/ask.ts": 'import { readFileSync } from "node:fs";\nexport default async () => ({ value: readFileSync("x") });\n',
    });
    expect(said).toEqual(['steps/ask.ts:1: A step imports files of its own workspace only, not "node:fs".']);
  });

  it("names a step file that exports no function", async () => {
    const said = await messages(file({ ask: ["end"] }), { "steps/ask.ts": "export const one = 1;\n" });
    expect(said).toEqual(["steps/ask.ts: A step exports one function."]);
  });

  it("names a way the code takes and the map lacks, once", async () => {
    const step =
      'export default async (run, ask) => {\n  const a = await ask({ type: "form" });\n  if (a.again) return { value: a, to: "ask" };\n  return { value: a, to: a.ok ? "done" : "ask" };\n};\n';
    const said = await messages(file({ ask: ["done"], done: ["end"] }), {
      "steps/ask.ts": step,
      "steps/done.ts": "export default async () => ({ value: 1 });\n",
    });
    expect(said).toEqual(['steps/ask.ts goes to "ask", and the map has no such way from "ask".']);
  });

  it("names an eval that does not compile", async () => {
    const said = await messages(file({ ask: ["end"] }), {
      "steps/ask.ts": "export default async () => ({ value: 1 });\n",
      "evals/ask/good.ts": "export default async (run) => ({ score: 1 ;\n",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^evals\/ask\/good\.ts:1: /);
  });
});

describe("wizards check", () => {
  it("checks a wizard's folder with its tests, and an unpacked package as validate does", async () => {
    const { checkCommand } = await import("../src/cli/check");
    const folder = join(dir, "offer");
    cpSync(example, folder, { recursive: true });
    const pack = join(dir, "pack");
    cpSync(`${example}steps`, join(pack, "files", "steps"), { recursive: true });
    writeFileSync(join(pack, "files", "wizard.ts"), readFileSync(`${example}wizard.ts`, "utf8"));
    const { kernelShell } = await import("@engenty/wizards-shared/kernel-file");
    const offer = JSON.parse(readFileSync(`${example}wizard.json`, "utf8"));
    writeFileSync(join(pack, "wizard.json"), JSON.stringify(kernelShell(offer)));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await checkCommand([folder], true)).toBe(0);
      const [checked] = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(checked).toMatchObject({ path: folder, ok: true, issues: [] });
      expect(readdirSync(folder)).toContain("wizard.d.ts");

      // a step of the folder takes a way the map lacks
      const broken = join(dir, "broken");
      cpSync(example, broken, { recursive: true });
      writeFileSync(join(broken, "steps", "check.ts"), 'export default async (run, ask) => ({ value: 1, to: "nowhere" });\n');
      expect(await checkCommand([broken], true)).toBe(1);
      const [said] = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(said.issues).toEqual(['steps/check.ts goes to "nowhere", and the map has no such way from "check".']);

      // a step of the package no longer compiles: validate's check says so
      writeFileSync(join(pack, "files", "steps", "check.ts"), "export default async (run, ask) => {\n  return {;\n};\n");
      expect(await checkCommand([pack], true)).toBe(1);
      const [validated] = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(validated.issues.map((i: { message: string }) => i.message).join("\n")).toMatch(/steps\/check\.ts:2: /);
    } finally {
      log.mockRestore();
    }
  });
});
