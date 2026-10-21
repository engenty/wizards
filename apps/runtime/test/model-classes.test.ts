import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFINITION_VERSION,
  parseWizard,
  readable,
  upgradeDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import {
  blockingNeeds,
  CLASS_NEEDS,
  missingNeeds,
  traitsOf,
} from "@engenty/wizards-shared/providers";

const dir = mkdtempSync(join(tmpdir(), "wizards-model-classes-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.MANAGE_URL = "";
process.env.SECRETS = "file";

const step = (id: string, model?: string) => ({
  id,
  type: "agent",
  title: id,
  instructions: "x",
  tools: [],
  ...(model ? { model } : {}),
});
const result = { id: "r", type: "result", title: "R", deliverables: [{ from: "a", formats: ["md"] }] };

/** A definition of version 1: its classes one step lower than today's. */
const version1 = (version?: number) => ({
  ...(version ? { version } : {}),
  title: "Old",
  steps: [step("a", "standard"), step("b", "high"), step("c", "highest"), step("d", "classifier"), step("e"), result],
});

const modelsOf = (def: unknown) =>
  (def as { steps: { model?: string }[] }).steps.map((s) => s.model);

describe("a definition of version 1", () => {
  it("is read with its own class names and comes out in today's", () => {
    for (const def of [version1(1), version1()]) {
      const parsed = parseWizard(def);
      expect(parsed.ok).toBe(true);
      const wizard = parsed.ok ? parsed.wizard : null;
      expect(wizard?.version).toBe(2);
      expect(modelsOf(wizard)).toEqual(["low", "standard", "high", "classifier", undefined, undefined]);
      expect(readable(def)).toBe(true);
    }
  });

  it("leaves a definition of today's version, and one of a later version, as it is", () => {
    const today = { ...version1(), version: 2 };
    expect(upgradeDefinition(today)).toBe(today);
    // Version 2 has no class `highest`.
    expect(wizardSchema.safeParse(today).success).toBe(false);
    const valid = { version: 2, title: "New", steps: [step("a", "high"), step("b", "low"), result] };
    expect(modelsOf(wizardSchema.parse(valid))).toEqual(["high", "low", undefined]);
    const later = { ...version1(), version: 3 };
    expect(upgradeDefinition(later)).toBe(later);
    expect(wizardSchema.safeParse(later).success).toBe(false);
  });

  it("is of today's version where its writer read today's guide", () => {
    const written = { title: "New", steps: [step("a", "high"), result] };
    const upgraded = upgradeDefinition(written, DEFINITION_VERSION);
    expect(upgraded).toMatchObject({ version: 2 });
    expect(modelsOf(upgraded)).toEqual(["high", undefined]);
  });

  it("keeps an effort as it is: effort is not a class", () => {
    const def = { version: 1, title: "x", steps: [{ ...step("a", "high"), effort: "high" }, result] };
    expect(wizardSchema.parse(def).steps[0]).toMatchObject({ model: "standard", effort: "high" });
  });
});

describe("the migrations to version 2", () => {
  const sql = (name: string) =>
    readFileSync(join(import.meta.dirname, "../src/db/migrations", name), "utf8").split(
      "--> statement-breakpoint",
    );

  it("rename the classes of stored drafts, versions and runs, step by step in order", async () => {
    const db = createClient({ url: ":memory:" });
    for (const table of ["wizard (draft text)", "wizard_version (definition text)", "run (definition text)"]) {
      await db.execute(`CREATE TABLE ${table}`);
    }
    const rows = [JSON.stringify(version1(1)), JSON.stringify(version1()), JSON.stringify({ ...version1(), version: 2 })];
    for (const row of rows) {
      await db.execute({ sql: "INSERT INTO wizard VALUES (?)", args: [row] });
      await db.execute({ sql: "INSERT INTO wizard_version VALUES (?)", args: [row] });
      await db.execute({ sql: "INSERT INTO run VALUES (?)", args: [row] });
    }
    for (const statement of sql("tenant/0021_model_classes.sql")) {
      await db.execute(statement);
    }
    for (const [table, column] of [["wizard", "draft"], ["wizard_version", "definition"], ["run", "definition"]]) {
      const stored = (await db.execute(`SELECT ${column} AS d FROM ${table}`)).rows.map((r) => JSON.parse(String(r.d)));
      expect(stored.map((d) => d.version)).toEqual([2, 2, 2]);
      expect(stored.map((d) => d.steps.map((s: { id: string }) => s.id).join(""))).toEqual(["abcder", "abcder", "abcder"]);
      expect(stored.map(modelsOf)).toEqual([
        ["low", "standard", "high", "classifier", undefined, undefined],
        ["low", "standard", "high", "classifier", undefined, undefined],
        ["standard", "high", "highest", "classifier", undefined, undefined],
      ]);
    }
  });

  it("move the bindings of this computer and of each team to the renamed classes", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute("CREATE TABLE setting (key text PRIMARY KEY, value text NOT NULL)");
    const put = (key: string, value: unknown) =>
      db.execute({ sql: "INSERT INTO setting VALUES (?, ?)", args: [key, JSON.stringify(value)] });
    await put("models", { source: "own", bindings: { classifier: "a", standard: "b", high: "c", highest: "d", image: "i" } });
    await put("models:t1", { bindings: { high: "c" }, keys: null });
    await put("chat-engine", "claude");
    for (const statement of sql("control/0011_model_classes.sql")) {
      await db.execute(statement);
    }
    const value = async (key: string) =>
      JSON.parse(String((await db.execute({ sql: "SELECT value FROM setting WHERE key = ?", args: [key] })).rows[0].value));
    expect((await value("models")).bindings).toEqual({ classifier: "a", low: "b", standard: "c", high: "d", image: "i" });
    expect((await value("models:t1")).bindings).toEqual({ standard: "c" });
    expect(await value("chat-engine")).toBe("claude");
  });
});

describe("what a class needs of its model", () => {
  const all = traitsOf(["tool-use", "structured-output", "vision", "reasoning"], 1_000_000);

  it("is met by a model that has everything", () => {
    for (const cls of ["classifier", "low", "standard", "high"] as const) {
      expect(missingNeeds(cls, all)).toEqual([]);
    }
  });

  it("names what a model lacks, and blocks only what a class cannot work without", () => {
    const noTools = traitsOf(["structured-output", "reasoning"], 100_000);
    expect(missingNeeds("classifier", noTools)).toEqual([]);
    expect(missingNeeds("standard", noTools)).toEqual(["tools", "vision", "context"]);
    expect(blockingNeeds("standard", missingNeeds("standard", noTools))).toEqual(["tools"]);
    expect(blockingNeeds("low", missingNeeds("low", noTools))).toEqual([]);
    expect(missingNeeds("high", traitsOf(["tool-use", "structured-output", "vision"], null))).toEqual(["reasoning"]);
  });

  it("grows from class to class", () => {
    expect(CLASS_NEEDS.classifier.context).toBeLessThan(CLASS_NEEDS.low.context);
    expect(CLASS_NEEDS.low.context).toBeLessThan(CLASS_NEEDS.standard.context);
    expect(CLASS_NEEDS.standard.context).toBeLessThan(CLASS_NEEDS.high.context);
  });
});

describe("a binding checked against the AI Gateway's catalog", () => {
  let models: typeof import("../src/models");

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url) === "https://ai-gateway.vercel.sh/v1/models"
          ? new Response(
              JSON.stringify({
                data: [
                  { id: "deepseek/deepseek-v4.1-flash", context_window: 1_048_576, tags: ["reasoning", "tool-use", "vision", "structured-output"] },
                  { id: "zai/glm-5.3", context_window: 1_000_000, tags: ["reasoning", "tool-use", "structured-output"] },
                  { id: "acme/no-tools", context_window: 1_000_000, tags: ["structured-output", "vision"] },
                  { id: "anthropic/claude-sonnet-5.5", context_window: 1_000_000, tags: ["reasoning", "tool-use", "vision", "structured-output"] },
                ],
              }),
            )
          : new Response("{}"),
      ),
    );
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    models = await import("../src/models");
    await models.loadCatalog(true);
  }, 60_000);

  it("knows a model by the gateway's id and by a provider's own", () => {
    expect(models.modelTraitsOf("zai/glm-5.3")).toMatchObject({ tools: true, vision: false });
    expect(models.modelTraitsOf("anthropic:claude-sonnet-5-5")).toMatchObject({ vision: true });
    expect(models.modelTraitsOf("ollama:qwen3")).toBeNull();
    expect(models.modelTraitsOf("credits")).toBeNull();
  });

  it("refuses a model without tool calls for Standard and High only", () => {
    expect(models.blockedBinding({ low: "acme/no-tools", classifier: "acme/no-tools" })).toBeNull();
    expect(models.blockedBinding({ standard: "acme/no-tools" })).toEqual({
      cls: "standard",
      ref: "acme/no-tools",
      needs: ["tools"],
    });
    expect(models.blockedBinding({ high: "zai/glm-5.3" })).toBeNull();
    expect(models.blockedBinding({ high: "unknown/model" })).toBeNull();
  });

  it("says per class what the model it runs on lacks", () => {
    const way = (kind: "key" | "client" | "credits", ref: string) => ({ kind, by: null, ref, problem: null });
    const fit = models.classFit({
      classifier: way("key", "deepseek/deepseek-v4.1-flash"),
      low: way("key", "zai/glm-5.3"),
      standard: way("client", "claude/sonnet"),
      high: way("credits", "acme/no-tools"),
      image: way("key", ""),
      video: way("key", ""),
      audio: way("key", ""),
      speech: way("key", ""),
    });
    expect(fit).toEqual({ classifier: [], low: ["vision"], standard: null, high: null });
  });
});
