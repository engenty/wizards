import { skillExtra, stepUp } from "@engenty/wizards-shared/extra";
import type { ModelPolicy, ModelTier } from "@engenty/wizards-shared/tiers";
import { describe, expect, it, vi } from "vitest";

// What the model does in the step: `script` runs inside its call, with the step's tools and
// options, as a model that calls tools would.
const model = vi.hoisted(() => ({
  script: async (_tools: Record<string, any>, _options: any) => {},
  tiers: { tier: null as unknown, modelPolicy: null as unknown },
}));
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    tools: Record<string, any>;
    constructor(config: { tools: Record<string, any> }) {
      this.tools = config.tools;
    }
    async generate(_message: unknown, options: any) {
      await model.script(this.tools, options);
      return {
        text: "Fertig.",
        steps: [{ text: "", usage: { tokens: 1 } }, { text: "Fertig.", usage: { tokens: 10 } }],
        usage: { tokens: 11 },
      };
    }
  },
}));
vi.mock("../src/models.js", () => ({
  // The model of a class and effort, by name: what a test reads back.
  textModel: async (cls: string, meta: { effort?: string; makerClass?: string }) => ({
    model: `${meta.makerClass ?? cls}:${meta.effort ?? "-"}`,
    vendor: "test",
    ref: `${meta.makerClass ?? cls}:${meta.effort ?? "-"}`,
  }),
  currentTiers: async () => model.tiers,
  attachTools: () => {},
  takesTools: () => true,
  keepsOwnLoop: () => false,
  // A dollar a token on the strong model, a cent on any other.
  costOf: (resolved: { ref: string }, usage: { tokens?: number } | undefined) =>
    (usage?.tokens ?? 0) * (resolved.ref.startsWith("high") ? 1 : 0.01),
  isHarnessVendor: () => false,
  agentModel: (resolved: { model: unknown }) => resolved.model,
  totalUsage: async (out: { totalUsage?: unknown; usage?: unknown }) =>
    (await out.totalUsage) ?? (await out.usage),
}));
vi.mock("../src/tools/index.js", () => ({
  buildStepTools: async () => ({ tools: {}, assets: [] }),
}));
vi.mock("../src/tools/store.js", () => ({ personUploads: async () => [] }));
vi.mock("../src/tools/plugin.js", () => ({
  callPluginTool: async () => null,
  spaceContextOf: async () => ({ blocks: [] }),
}));
vi.mock("../src/services/knowledge.js", () => ({ knowledgeBlock: async () => "" }));
const skills = vi.hoisted(() => ({ always: [] as any[] }));
vi.mock("../src/services/skills.js", async (original) => ({
  ...(await original<typeof import("../src/services/skills.js")>()),
  activeSkills: async () => ({ always: skills.always, demand: [] }),
}));

const { decideExtra } = await import("../src/engine/extra");
const { runAgentStep } = await import("../src/engine/steps");

const tier = (offered: string[]): ModelTier =>
  ({
    classes: Object.fromEntries(offered.map((id) => [id, { model: `m/${id}`, name: id }])),
  }) as unknown as ModelTier;

const policy = (p: Partial<ModelPolicy["purposes"]["wizard"]>, way: ModelPolicy["way"] = "B") =>
  ({
    way,
    purposes: { wizard: { models: null, default: null, effortCap: null, efforts: null, ...p } },
  }) as unknown as ModelPolicy;

describe("one step up", () => {
  it("takes the next class and the next effort", () => {
    expect(stepUp({})).toEqual({ model: "high", effort: "high" });
    expect(stepUp({ model: "low", effort: "low" })).toEqual({ model: "standard", effort: "medium" });
    expect(stepUp({ model: "classifier" })).toEqual({ model: "standard", effort: "high" });
    expect(stepUp({ model: "standard", effort: "medium" })).toEqual({
      model: "high",
      effort: "high",
    });
  });

  it("keeps the maker, and goes to highest only with one that has it", () => {
    expect(stepUp({ model: "standard", maker: "anthropic" })).toEqual({
      model: "high",
      maker: "anthropic",
      effort: "high",
    });
    expect(stepUp({ model: "high", maker: "openai", effort: "high" })).toEqual({
      model: "highest",
      maker: "openai",
      effort: "high",
    });
    expect(stepUp({ model: "high", maker: "google" })).toEqual({
      model: "high",
      maker: "google",
      effort: "high",
    });
    expect(stepUp({ model: "high" })).toEqual({ model: "high", effort: "high" });
  });

  it("is null at the top", () => {
    expect(stepUp({ model: "high", effort: "high" })).toBeNull();
    expect(stepUp({ model: "highest", maker: "anthropic", effort: "high" })).toBeNull();
  });

  it("stays inside the tier and the admins' policy", () => {
    const none = { tier: tier(["low", "standard"]), policy: null };
    expect(stepUp({ model: "standard", effort: "medium" }, none)).toEqual({
      model: "standard",
      effort: "high",
    });
    // Way C: the class is offered, but not on the admins' list.
    const listed = { tier: tier(["standard", "high"]), policy: policy({ models: ["standard"] }, "C") };
    expect(stepUp({ model: "standard", effort: "high" }, listed)).toBeNull();
    // Way B: the effort stops at the cap.
    const capped = { tier: tier(["standard", "high"]), policy: policy({ effortCap: "medium" }) };
    expect(stepUp({ model: "standard" }, capped)).toEqual({ model: "high", effort: "medium" });
    expect(stepUp({ model: "high", effort: "medium" }, capped)).toBeNull();
  });
});

describe("a skill that asks for Extra", () => {
  it("says so in its front matter", () => {
    const d = "Fills PDF forms";
    expect(skillExtra({ description: d, meta: { extra: "true" } })).toBe(d);
    expect(skillExtra({ description: d, meta: { extra: true } })).toBe(d);
    expect(skillExtra({ description: d, meta: { metadata: { extra: "true" } } })).toBe(d);
    expect(skillExtra({ description: d, meta: { extra: "The form tool needs care" } })).toBe(
      "The form tool needs care",
    );
    expect(skillExtra({ description: d, meta: { extra: "false" } })).toBeNull();
    expect(skillExtra({ description: d, meta: {} })).toBeNull();
  });
});

/** A step's context with what Extra reads and writes, and what it said. */
function context(answer: unknown = { type: "done" }) {
  const said: { code: string; params?: Record<string, unknown> }[] = [];
  const asked: unknown[] = [];
  const ctx = {
    stepId: "draft",
    def: { title: "Angebot", steps: [] },
    space: { id: "p" },
    dataSpace: { id: "p", name: "" },
    holder: { kind: "person", id: "u", role: "member" },
    store: { wizardId: "w", holder: "u:u" },
    call: { runId: "r", stepId: "draft" },
    signal: new AbortController().signal,
    state: { values: {}, outputs: {}, notes: {} } as Record<string, any>,
    scope: { def: { title: "Angebot", steps: [] }, state: {}, brand: {} },
    resources: {},
    files: [],
    emit: async (_type: string, note: any) => {
      said.push(note);
    },
    ask: async (ask: unknown) => {
      asked.push(ask);
      return answer;
    },
    saveState: async () => {},
    chargeUsd: vi.fn(async (_usd: number) => {}),
  };
  return { ctx, said, asked };
}

const by = { kind: "model" as const, name: "need_extra" };

describe("deciding Extra", () => {
  it("switches where the step allows it, and says so", async () => {
    const { ctx, said, asked } = context();
    expect(await decideExtra({ extra: "allow" }, ctx as any, "Das Formular ist knifflig", by)).toBe(
      "on",
    );
    expect(asked).toEqual([]);
    expect(ctx.state.extra).toMatchObject({ on: true, reason: "Das Formular ist knifflig", by });
    expect(said).toContainEqual({ code: "extraOn", params: { reason: "Das Formular ist knifflig" } });
  });

  it("asks the person by default, and a yes holds for the run", async () => {
    const { ctx, asked } = context({ type: "done" });
    expect(await decideExtra({}, ctx as any, "Knifflig", by)).toBe("on");
    expect(asked).toEqual([{ kind: "extra", reason: "Knifflig", by }]);
    expect(await decideExtra({}, ctx as any, "Noch einmal", by)).toBe("on");
    expect(asked).toHaveLength(1);
  });

  it("keeps a person's no for the rest of the run", async () => {
    const { ctx, said, asked } = context({ type: "skip" });
    expect(await decideExtra({}, ctx as any, "Knifflig", by)).toBe("off");
    expect(ctx.state.extra).toMatchObject({ on: false });
    expect(said.map((s) => s.code)).toEqual(["extraDeclined"]);
    // A skill that asks later hears the no; nobody is asked again.
    expect(
      await decideExtra({ extra: "allow" }, ctx as any, "PDF", { kind: "skill", name: "pdf" }),
    ).toBe("off");
    expect(asked).toHaveLength(1);
  });

  it("stays where nobody can say yes, where the step says never, and at the top", async () => {
    const nobody = context(null);
    expect(await decideExtra({}, nobody.ctx as any, "Knifflig", by)).toBe("stays");
    expect(nobody.ctx.state.extra).toBeUndefined();
    expect(nobody.said.map((s) => s.code)).toEqual(["extraNobody"]);
    // Asked again in the same step: no second line.
    await decideExtra({}, nobody.ctx as any, "Knifflig", by);
    expect(nobody.said).toHaveLength(1);

    const never = context();
    expect(await decideExtra({ extra: "deny" }, never.ctx as any, "Knifflig", by)).toBe("stays");
    expect(never.asked).toEqual([]);
    expect(never.said.map((s) => s.code)).toEqual(["extraStays"]);

    const top = context();
    expect(
      await decideExtra({ model: "high", effort: "high" }, top.ctx as any, "Knifflig", by),
    ).toBe("stays");
    expect(top.asked).toEqual([]);
    expect(top.said.map((s) => s.code)).toEqual(["extraTop"]);
  });
});

const draft = {
  id: "draft",
  type: "agent",
  title: "Angebot schreiben",
  instructions: "Write the offer.",
  tools: [],
  output: { format: "markdown" },
};

describe("Extra in an AI step", () => {
  it("switches the step's next model call once the model asked, and books each as its model", async () => {
    const { ctx } = context({ type: "done" });
    const seen: unknown[] = [];
    model.script = async (tools, options) => {
      expect(tools.need_extra).toBeDefined();
      seen.push((await options.prepareStep({ stepNumber: 0 }))?.model);
      await tools.need_extra.execute({ reason: "Die Tabelle kriege ich nicht hin" }, {});
      seen.push((await options.prepareStep({ stepNumber: 1 }))?.model);
      // Switched once: the calls after go on on it.
      seen.push((await options.prepareStep({ stepNumber: 2 }))?.model);
    };
    await runAgentStep(draft as any, ctx as any);
    expect(seen).toEqual([undefined, "high:high", undefined]);
    expect(ctx.state.extra).toMatchObject({ on: true, reason: "Die Tabelle kriege ich nicht hin" });
    // The first call on the step's own model, the second on Extra.
    expect(ctx.chargeUsd).toHaveBeenCalledWith(0.01 + 10);
  });

  it("starts the run's later AI steps on Extra", async () => {
    const { ctx } = context();
    ctx.state.extra = { on: true, reason: "Knifflig", by, at: "" };
    let first: unknown;
    model.script = async (_tools, options) => {
      first = await options.prepareStep({ stepNumber: 0 });
    };
    await runAgentStep(draft as any, ctx as any);
    expect(first).toBeUndefined();
    // Every call of the step on the stronger model.
    expect(ctx.chargeUsd).toHaveBeenCalledWith(11);
  });

  it("gives no need_extra where the step says never", async () => {
    const { ctx } = context();
    let tools: Record<string, unknown> = {};
    model.script = async (t) => {
      tools = t;
    };
    await runAgentStep({ ...draft, extra: "deny" } as any, ctx as any);
    expect(tools.need_extra).toBeUndefined();
  });

  it("asks for a skill always on before the step picks its model", async () => {
    skills.always = [
      {
        name: "angebote",
        description: "Angebote mit Staffelpreisen",
        body: "Rechne die Staffeln genau.",
        meta: { extra: "true" },
        files: [],
        blobFiles: [],
      },
    ];
    const { ctx, asked } = context({ type: "done" });
    model.script = async () => {};
    await runAgentStep(draft as any, ctx as any);
    skills.always = [];
    expect(asked).toEqual([
      { kind: "extra", reason: "Angebote mit Staffelpreisen", by: { kind: "skill", name: "angebote" } },
    ]);
    expect(ctx.chargeUsd).toHaveBeenCalledWith(11);
  });
});
