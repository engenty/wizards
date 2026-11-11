import type { ModelClass, Requires } from "@engenty/wizards-shared/definition";
import { HOST_OFFERS, hostFit, MODEL_WAYS, type ModelWay } from "@engenty/wizards-shared/fit";
import { RUN_HOST_KINDS, type RunHostKind } from "@engenty/wizards-shared/run";
import { describe, expect, it } from "vitest";

// Which host can run a wizard (docs/plans/runs-on-their-own.md, 4.6): a pure check from what the
// wizard requires and how the tenant reaches each class.

const thinks: Requires = { models: ["standard"] };

/** Every class of `requires` on one way. */
const all = (way: ModelWay, ...classes: ModelClass[]) =>
  Object.fromEntries(classes.map((cls) => [cls, way])) as Partial<Record<ModelClass, ModelWay>>;

/** Which kinds run a wizard whose one class takes `way`. */
const EXPECTED: Record<ModelWay, RunHostKind[]> = {
  credits: ["runtime", "node", "edge"],
  key: ["runtime", "node", "edge"],
  ollama: ["runtime", "node"],
  apple: ["runtime"],
  client: ["runtime"],
};

describe("hostFit", () => {
  for (const way of MODEL_WAYS) {
    for (const kind of RUN_HOST_KINDS) {
      const fits = EXPECTED[way].includes(kind);
      it(`a class on ${way} ${fits ? "fits" : "does not fit"} a ${kind} host`, () => {
        expect(hostFit(thinks, kind, all(way, "standard"))).toEqual(
          fits ? { fits: true } : { fits: false, missing: [{ cls: "standard", way }] },
        );
      });
    }
  }

  it("an installed client runs only on the runtime", () => {
    const ways = all("client", "standard");
    expect(RUN_HOST_KINDS.filter((kind) => hostFit(thinks, kind, ways).fits)).toEqual(["runtime"]);
  });

  it("names every class the host cannot reach, and only those", () => {
    const requires: Requires = { models: ["classifier", "standard", "image"] };
    const ways = { classifier: "credits", standard: "client", image: "key" } as const;
    expect(hostFit(requires, "node", ways)).toEqual({
      fits: false,
      missing: [{ cls: "standard", way: "client" }],
    });
  });

  it("an optional class counts: a run never moves to another host in the middle", () => {
    const requires: Requires = { models: ["standard"], optional: { models: ["high"] } };
    const ways = { standard: "credits", high: "client" } as const;
    expect(hostFit(requires, "edge", ways)).toEqual({
      fits: false,
      missing: [{ cls: "high", way: "client" }],
    });
  });

  it("an agent's classes count", () => {
    const requires: Requires = {
      models: ["standard"],
      agents: { helper: { models: ["low"] } },
    };
    expect(hostFit(requires, "node", { standard: "credits", low: "apple" })).toEqual({
      fits: false,
      missing: [{ cls: "low", way: "apple" }],
    });
  });

  it("a class without a known way fits nowhere but the runtime", () => {
    expect(hostFit(thinks, "node", {})).toEqual({
      fits: false,
      missing: [{ cls: "standard", way: null }],
    });
    // The runtime refuses it at the start; placing changes nothing there.
    expect(hostFit(thinks, "runtime", {})).toEqual({
      fits: false,
      missing: [{ cls: "standard", way: null }],
    });
  });

  it("a wizard that calls no model fits every host", () => {
    for (const kind of RUN_HOST_KINDS) {
      expect(hostFit({}, kind, {})).toEqual({ fits: true });
    }
  });

  it("tools, code, the sandbox, plugins and data go through the run's services on every host", () => {
    const requires: Requires = {
      models: ["standard"],
      tools: ["browser", "web_search", "sandbox"],
      run: ["code"],
      sandbox: "shell",
      plugins: ["contacts"],
      data: "person",
    };
    for (const kind of RUN_HOST_KINDS) {
      expect(hostFit(requires, kind, { standard: "credits" })).toEqual({ fits: true });
    }
  });

  it("takes what a host offers instead of a kind: wizards run without an organization", () => {
    const alone = { ways: ["ollama", "key"] as const };
    expect(hostFit(thinks, alone, { standard: "ollama" })).toEqual({ fits: true });
    expect(hostFit(thinks, alone, { standard: "credits" })).toEqual({
      fits: false,
      missing: [{ cls: "standard", way: "credits" }],
    });
    expect(hostFit(thinks, HOST_OFFERS.node, { standard: "credits" })).toEqual({ fits: true });
  });

  it("a host without the run's services lacks what they give: tools, connections, data …", () => {
    const alone = { ways: ["ollama", "key"] as const, services: false };
    const requires: Requires = {
      models: ["standard"],
      tools: ["web_search"],
      sandbox: "shell",
      plugins: ["contacts"],
      connections: ["mail"],
      data: "person",
      makers: ["anthropic"],
      run: ["code"],
    };
    expect(hostFit(requires, alone, { standard: "ollama" })).toEqual({
      fits: false,
      missing: [],
      lacks: [
        { need: "tools", names: ["web_search"] },
        { need: "sandbox", names: ["shell"] },
        { need: "plugins", names: ["contacts"] },
        { need: "connections", names: ["mail"] },
        { need: "data", names: ["person"] },
        { need: "makers", names: ["anthropic"] },
      ],
    });
    // The wizard's own code runs in the engine, which every host has.
    expect(hostFit({ models: ["standard"], run: ["code"] }, alone, { standard: "ollama" })).toEqual(
      { fits: true },
    );
    expect(hostFit({ models: ["image"] }, alone, { standard: "ollama" })).toEqual({
      fits: false,
      missing: [{ cls: "image", way: null }],
    });
  });
});
