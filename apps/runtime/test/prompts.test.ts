import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authoringGuide } from "../src/authoring/guide.js";
import { type PromptFile, prompt, promptSections } from "../src/prompts.js";

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

const FILES = readdirSync(join(SRC, "prompts"))
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => f.slice(0, -3) as PromptFile);

/**
 * Every `prompt("file", "section"` in the code. A section given as a template literal
 * (`document.${kind}`) counts as the prefix before its first `${`.
 */
function calls(): { file: string; section: string; prefix: boolean }[] {
  const found: { file: string; section: string; prefix: boolean }[] = [];
  const CALL = /\bprompt\(\s*"(\w+)",\s*(?:"([\w.-]+)"|`([\w.-]*)\$\{)/g;
  for (const path of sources(SRC)) {
    for (const m of readFileSync(path, "utf8").matchAll(CALL)) {
      found.push(
        m[2] !== undefined
          ? { file: m[1], section: m[2], prefix: false }
          : { file: m[1], section: m[3], prefix: true },
      );
    }
  }
  return found;
}

describe("prompts", () => {
  it("every file parses", () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const file of FILES) expect(promptSections(file).size).toBeGreaterThan(0);
  });

  it("every section the code asks for exists", () => {
    for (const c of calls()) {
      const names = [...promptSections(c.file as PromptFile).keys()];
      const ok = c.prefix ? names.some((n) => n.startsWith(c.section)) : names.includes(c.section);
      expect(ok, `prompts/${c.file}.md#${c.section}`).toBe(true);
    }
  });

  it("every section is used", () => {
    const used = calls();
    for (const file of FILES) {
      for (const name of promptSections(file).keys()) {
        const hit = used.some(
          (c) => c.file === file && (c.prefix ? name.startsWith(c.section) : name === c.section),
        );
        expect(hit, `prompts/${file}.md#${name} is not used`).toBe(true);
      }
    }
  });

  it("the guide tells of waits only while a run can do them", () => {
    expect(authoringGuide()).not.toContain("type WaitStep");
    expect(authoringGuide([], [], [], [], { durableRuns: true })).toContain("type WaitStep");
  });

  it("the guide tells of code steps only while a run can do them", () => {
    expect(authoringGuide()).not.toContain("Code steps.");
    expect(authoringGuide([], [], [], [], { codeSteps: true })).toContain("Code steps.");
  });

  it("the guide names the connectors that can't connect here, with what the server's owner sets", () => {
    const guide = authoringGuide(
      [
        {
          id: "google-gmail",
          name: "Gmail",
          toolPrefix: "gmail",
          usable: false,
          missingSetup: "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET",
          actions: [],
        },
      ],
      [
        {
          name: "Gmail",
          usable: false,
          missingSetup: "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET",
        },
        { name: "IMAP", usable: true, missingSetup: null },
      ],
    );
    expect(guide).toContain(
      "- google-gmail — Gmail — CAN'T CONNECT on this server yet: don't build on it, and don't name it as a way to connect (the server's owner sets GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET), tools gmail_*",
    );
    expect(guide).toContain(
      'A connection of kind "mail" connects a mailbox here with these connectors; the person picks one:\n' +
        "- Gmail — CAN'T CONNECT on this server yet: don't build on it, and don't name it as a way to connect (the server's owner sets GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)\n" +
        "- IMAP\n",
    );
  });

  it("fills placeholders strictly", () => {
    expect(() => prompt("goose", "persona", { extra: "x" })).toThrow(/no \$\{extra\}/);
    expect(() => prompt("goose", "nope")).toThrow(/no section/);
  });
});
