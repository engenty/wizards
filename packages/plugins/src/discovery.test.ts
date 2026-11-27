import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { discoverPlugins, skillsDir } from "./discovery.js";
import { MANIFEST_FILE, modelToolName, pluginManifestSchema, toolId } from "./manifest.js";

let dir: string;
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const manifest = (folder: string, fields: Record<string, unknown>) =>
  write(`${folder}/${MANIFEST_FILE}`, JSON.stringify(fields));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugins-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("discoverPlugins", () => {
  it("finds a manifest, a folder without one, one file and a package", () => {
    manifest("contacts", { id: "contacts", name: "Contacts" });
    write("contacts/src/plugin.ts", "export default () => {};");
    write("hello/index.ts", "export default () => {};");
    write("notify.ts", "export default () => {};");
    manifest("node_modules/@acme/weather", { id: "weather", name: "Weather", version: "1.2.0" });
    write("_draft/index.ts", "");
    write(".hidden.ts", "");
    write("readme.md", "");

    const { found, problems } = discoverPlugins([dir]);
    expect(problems).toEqual([]);
    expect(found.map((s) => [s.id, s.single, s.entry !== null])).toEqual([
      ["contacts", false, true],
      ["hello", false, true],
      ["weather", false, false],
      ["notify", true, true],
    ]);
    expect(found.find((s) => s.id === "weather")?.manifest.version).toBe("1.2.0");
  });

  it("keeps the first of two plugins with one id and names the other", () => {
    const second = mkdtempSync(join(tmpdir(), "plugins-"));
    try {
      write("same/index.ts", "");
      mkdirSync(join(second, "same"));
      writeFileSync(join(second, "same", "index.ts"), "");
      const { found, problems } = discoverPlugins([dir, second]);
      expect(found).toHaveLength(1);
      expect(found[0].root).toBe(join(dir, "same"));
      expect(problems[0].message).toContain("already loaded");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("refuses a manifest that is not valid or points out of the folder", () => {
    manifest("bad", { id: "Bad Id", name: "" });
    manifest("escape", { id: "escape", name: "Escape", server: "../notify.ts" });
    write("notify.ts", "");
    write("broken/engenty.plugin.json", "{");
    const { found, problems } = discoverPlugins([dir]);
    expect(found.map((s) => s.id)).toEqual(["notify"]);
    expect(problems.map((p) => p.path.split("/").pop())).toEqual(["bad", "broken", "escape"]);
  });

  it("keeps a host's own fields and checks them with its schema", () => {
    manifest("studio", { id: "studio", name: "S", studio: "dist/client.js", features: { x: 1 } });
    const schema = pluginManifestSchema.extend({
      features: z.record(z.string(), z.boolean()).optional(),
    });
    expect(discoverPlugins([dir]).found[0].manifest.studio).toBe("dist/client.js");
    expect(discoverPlugins([dir], { manifest: schema }).problems).toHaveLength(1);
  });

  it("finds the skills folder", () => {
    manifest("a", { id: "a", name: "A" });
    write("a/skills/notes/SKILL.md", "---\nname: notes\n---\n");
    manifest("b", { id: "b", name: "B", skills: "docs/skills" });
    write("b/docs/skills/x/SKILL.md", "");
    manifest("c", { id: "c", name: "C" });
    const found = discoverPlugins([dir]).found;
    expect(found.map((s) => skillsDir(s)?.slice(dir.length))).toEqual([
      "/a/skills",
      "/b/docs/skills",
      undefined,
    ]);
  });
});

describe("ids", () => {
  it("names a tool for a wizard and for a model", () => {
    expect(toolId("run-log", "recent")).toBe("run-log.recent");
    expect(modelToolName("run-log", "recent")).toBe("run_log_recent");
  });
});
