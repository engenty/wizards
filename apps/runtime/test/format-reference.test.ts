import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentStepSchema,
  CONDITION_OPS,
  MAKER_CLASSES,
  MAKERS,
  outputFieldSchema,
  STEP_CLASSES,
  stepSchema,
  TEXT_CLASSES,
  TOOL_IDS,
} from "@engenty/wizards-shared/definition";
import { describe, expect, it } from "vitest";

/**
 * The format is described twice besides its schema: for people in docs/content/dev/wizard-format,
 * for AI clients in prompts/authoring.md. The lists both spell out (step types, an agent step's
 * keys, tool ids, model classes and makers, output kinds, condition operators) must be the
 * schema's, in packages/shared/src/definition.ts. Change one and this says where the others lag.
 */

const DOCS = join(import.meta.dirname, "../../../docs/content/dev/wizard-format");
const doc = (page: string) => readFileSync(join(DOCS, `${page}.md`), "utf8");
const allDocs = readdirSync(DOCS)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(DOCS, f), "utf8"))
  .join("\n");
const GUIDE = readFileSync(join(import.meta.dirname, "../src/prompts/authoring.md"), "utf8");

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/** The rows of the Markdown table whose header starts with `head`, as lists of cells. */
function table(md: string, head: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`| ${head} |`));
  expect(start, `a table headed “${head}”`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(line.split(" | ").map((cell) => cell.replace(/^\|\s*|\s*\|$/g, "")));
  }
  return rows;
}

/** The values a table names in its first column. */
const firstColumn = (md: string, head: string) =>
  sorted(table(md, head).flatMap((row) => ticked(row[0])));

/** The quoted values of the guide's line that starts with `key` (after spaces), up to its comment. */
function guideUnion(key: string, within = GUIDE): string[] {
  const line = within.split("\n").find((l) => l.trimStart().startsWith(key));
  expect(line, `a line “${key}” in authoring.md`).toBeDefined();
  return sorted(quoted((line ?? "").split("//")[0]));
}

/** The guide's `type AgentStep = { … }`, and its durable section's line on an agent step. */
function guideAgentStep(): string {
  const start = GUIDE.indexOf("type AgentStep = {");
  const end = GUIDE.indexOf("\n}\n", start);
  const durable = GUIDE.split("\n").findIndex((l) => l.startsWith("On an agent step:"));
  expect(start).toBeGreaterThanOrEqual(0);
  return `${GUIDE.slice(start, end)}\n${GUIDE.split("\n")[durable + 1] ?? ""}`;
}

const STEP_BASE = ["id", "title", "description", "section", "next", "onFail", "type"];

describe("the format's reference lists", () => {
  it("step types", () => {
    const types = sorted(stepSchema.options.map((o) => o.shape.type.value as string));
    const guide = sorted([...GUIDE.matchAll(/\btype: "([\w-]+)"/g)].map((m) => m[1]));
    expect(guide).toEqual(types);
    // The index lists every type but `wait`, which comes with runs that last days.
    const docs = firstColumn(doc("index"), "Type");
    for (const type of types) {
      expect(
        docs.includes(type) || allDocs.includes(`"type": "${type}"`),
        `docs: step type ${type}`,
      ).toBe(true);
    }
    expect(docs.filter((t) => !types.includes(t))).toEqual([]);
  });

  it("an agent step's keys", () => {
    const keys = Object.keys(agentStepSchema.shape).filter((k) => !STEP_BASE.includes(k));
    const guide = guideAgentStep();
    const page = doc("agent-steps");
    for (const key of keys) {
      expect(new RegExp(`\\b${key}\\??:`).test(guide), `authoring.md: AgentStep.${key}`).toBe(
        true,
      );
      expect(page.includes(`\`${key}\``) || page.includes(`"${key}"`), `docs: ${key}`).toBe(true);
    }
  });

  it("tool ids", () => {
    const ids = sorted(TOOL_IDS);
    expect(guideUnion("tools:", guideAgentStep())).toEqual(ids);
    const page = doc("agent-steps");
    const listed = table(page, "Key").find((row) => row[0] === "`tools`");
    expect(sorted(ticked(listed?.[1] ?? "")).filter((t) => !t.includes("."))).toEqual(ids);
    expect(firstColumn(page, "Tool id")).toEqual(ids);
  });

  it("model classes and makers", () => {
    expect(guideUnion("model?:", guideAgentStep())).toEqual(sorted(STEP_CLASSES));
    expect(guideUnion("maker?:", guideAgentStep())).toEqual(sorted(MAKERS));
    const page = doc("agent-steps");
    expect(firstColumn(page, "`model`")).toEqual(sorted(TEXT_CLASSES));
    const makers = table(page, "`maker`").flatMap((row) =>
      ticked(row[0]).map((maker) => [maker, sorted(ticked(row[1]))] as const),
    );
    expect(Object.fromEntries(makers)).toEqual(
      Object.fromEntries(MAKERS.map((m) => [m, sorted(MAKER_CLASSES[m])])),
    );
  });

  it("output kinds", () => {
    const kinds = sorted(outputFieldSchema.shape.kind.options);
    const output = guideAgentStep()
      .split("\n")
      .find((l) => l.trimStart().startsWith("output:"));
    expect(sorted(quoted(output?.match(/kind: ([^,]+),/)?.[1] ?? ""))).toEqual(kinds);
    expect(firstColumn(doc("agent-steps"), "Kind")).toEqual(kinds);
  });

  it("condition operators", () => {
    const ops = sorted(CONDITION_OPS);
    const line = GUIDE.split("\n").find((l) => l.startsWith("// Condition = {"));
    expect(sorted(quoted(line?.match(/op: ([^,]+),/)?.[1] ?? ""))).toEqual(ops);
    expect(firstColumn(doc("branches"), "`op`")).toEqual(ops);
  });
});
