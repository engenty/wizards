import { type CatalogEntry, createCatalogSearch, defineEmbedder } from "@engenty/search-index";
import { describe, expect, it, vi } from "vitest";
import { createToolHarness, type HarnessTool, TOOL_CALL, TOOL_SEARCH } from "./harness.js";
import { toolJudge } from "./judge.js";

const tool = (name: string, description: string, over: Partial<HarnessTool> = {}): HarnessTool => ({
  name,
  description,
  input: { type: "object", properties: {} },
  ...over,
});

const tools: HarnessTool[] = [
  tool("schedule_set", "Set a task that runs at a time.", {
    input: {
      type: "object",
      properties: { when: { type: "string", description: "The time." }, what: { type: "string" } },
      required: ["when", "what"],
    },
  }),
  tool("remember", "Keep something in mind."),
  tool("browser_open", "Open a web page."),
  tool("agent_create", "Make another agent.", { needs: "standard" }),
  tool("ask", "Ask the person."),
];
const core = ({ name }: HarnessTool) => name === "ask" || name === "remember";

const about = [/time|task|freitag/i, /web|page|öffne/i, /agent|bot/i];
const embedder = defineEmbedder(
  (texts) => Promise.resolve(texts.map((t) => about.map((word) => (word.test(t) ? 1 : 0.1)))),
  { dimensions: 3, modelId: "test" },
);
const harness = (over: Partial<Parameters<typeof createToolHarness>[0]> = {}) =>
  createToolHarness({
    tools,
    core,
    level: "high",
    search: createCatalogSearch({ embedder: () => embedder }),
    foldFrom: 0,
    ...over,
  });

describe("the harness", () => {
  it("keeps the core in the prompt, by name, and the rest behind two tools", () => {
    const { shown, meta } = harness();
    expect(shown.map((t) => t.name)).toEqual(["ask", "remember"]);
    expect(meta.map((t) => t.name)).toEqual([TOOL_SEARCH, TOOL_CALL]);
    expect(meta[0]?.description).toContain("agent_create, browser_open, schedule_set");
  });

  it("keeps a few small tools in the prompt altogether", () => {
    const { shown, meta } = harness({ foldFrom: 6000 });
    expect(shown).toHaveLength(5);
    expect(meta).toEqual([]);
  });

  it("finds by what is asked for, and says that nothing is done yet", async () => {
    const found = await harness().find("set a repeating task");
    expect(found).toContain("Nothing has been done yet");
    expect(found.indexOf("schedule_set")).toBeLessThan(found.indexOf("browser_open"));
    expect(found).toContain('"required":["when","what"]');
    expect(found).not.toContain("- ask");
  });

  it("reads out tools it is asked for by name", async () => {
    const found = await harness().find("browser_open, agent_create");
    expect(found).toContain("- browser_open");
    expect(found).toContain("- agent_create");
    expect(found).not.toContain("schedule_set");
  });

  it("gives the tools that may fit with the message, only where the meaning was found", async () => {
    expect(await harness().hint("Erinnere mich am Freitag")).toContain("schedule_set");
    expect(await harness({ search: createCatalogSearch() }).hint("a task at a time")).toBe("");
    const judged = createCatalogSearch({
      embedder: () => embedder,
      judge: async (_query, candidates) => candidates.map(() => 0.1),
    });
    expect(await harness({ search: judged }).hint("Danke")).toBe("");
  });

  it("runs what exists, however the model wrapped the input", () => {
    const { resolve } = harness();
    const input = { when: "fri 9:00", what: "bills" };
    for (const raw of [
      { name: "schedule_set", input },
      { name: "schedule_set", input: JSON.stringify(input) },
      { name: "schedule_set", ...input },
      { name: "schedule_set", arguments: input },
    ]) {
      expect(resolve(raw)).toMatchObject({ ok: true, input, tool: { name: "schedule_set" } });
    }
  });

  it("never runs a name it does not know, and names those that are alike", () => {
    const { resolve } = harness();
    expect(resolve({ name: "schedule_task", input: {} })).toEqual({
      ok: false,
      say: expect.stringMatching(/no tool “schedule_task”.*nothing was done.*schedule_set/s),
    });
    expect(resolve({ name: TOOL_CALL, input: {} }).ok).toBe(false);
    expect(resolve("not json").ok).toBe(false);
  });

  it("says what is missing instead of running without it", () => {
    const made = harness().resolve({ name: "schedule_set", input: { what: "bills" } });
    expect(made).toMatchObject({ ok: false });
    expect(made.ok ? "" : made.say).toMatch(/needs when\..*Do not make one up/s);
  });

  it("keeps a tool from a model that cannot be trusted with it, and says so", async () => {
    const basic = harness({ level: "basic" });
    expect(basic.meta[0]?.description).not.toContain("agent_create");
    expect(await basic.find("make another bot")).toContain("needs a more capable one");
    const refused = basic.resolve({ name: "agent_create", input: {} });
    expect(refused.ok).toBe(false);
    expect(await basic.hint("make another bot")).not.toMatch(/- agent_create/);
  });

  it("answers within its room: the last ones by their inputs' names", async () => {
    const large = Array.from({ length: 8 }, (_, n) =>
      tool(`task_${n}`, `A task at a time. ${"x".repeat(1500)}`, {
        input: { type: "object", properties: { when: {}, note: {} }, required: ["when"] },
      }),
    );
    const found = await harness({ tools: large, core: () => false }).find("task");
    expect(found.length).toBeLessThan(7500);
    expect(found).toContain("input: when, note?");
  });
});

describe("the judge", () => {
  const candidates = [{ id: "a", title: "a", description: "a" }] as CatalogEntry[];
  const model = (way: string) => ({
    way,
    model: "jev",
    systemOne: vi.fn(async () => ({
      model: "jev",
      answers: { t0: { type: "noul" as const, noul: 0.8 } },
    })),
  });

  it("asks a decision model that answers at once, never one on the computer", async () => {
    const jev = model("gateway");
    expect(await toolJudge(() => jev)("q", candidates)).toEqual([0.8]);
    const local = model("local");
    expect(await toolJudge(() => local)("q", candidates)).toBeNull();
    expect(local.systemOne).not.toHaveBeenCalled();
    expect(await toolJudge(() => null)("q", candidates)).toBeNull();
  });
});
