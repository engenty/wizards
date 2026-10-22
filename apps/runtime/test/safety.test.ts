import { describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn: vitest reports a rejection a mock records as unhandled.
let decide: (input: unknown) => Promise<unknown>;
const asked: { state?: unknown; questions?: Record<string, { instructions: string }> }[] = [];
vi.mock("../src/engine/decide.js", () => ({
  decide: (input: unknown) => {
    asked.push(input as (typeof asked)[number]);
    return decide(input);
  },
}));

const { checkContent, contentPolicy, ContentBlockedError } = await import("../src/safety.js");

const breaks = (p: number) => async () => ({
  answers: { breaks: { type: "noul", noul: p } },
  source: "systemone",
});

describe("content rules", () => {
  it("ask one yes/no question that carries the policy", async () => {
    decide = breaks(0.02);
    await expect(checkContent({ kind: "image", text: "a lake at dawn" })).resolves.toBeUndefined();
    const last = asked.at(-1);
    expect(last?.state).toEqual({ kind: "image", request: "a lake at dawn" });
    expect(last?.questions?.breaks.instructions).toContain(contentPolicy());
  });

  it("stop a request that breaks them, with a note for the person", async () => {
    decide = breaks(0.97);
    const err = await checkContent({ kind: "speech", text: "…" }).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(err.note).toEqual({ code: "contentBlocked" });
  });

  it("make nothing when the check cannot run", async () => {
    decide = async () => {
      throw new Error("no classifier");
    };
    const err = await checkContent({ kind: "video", text: "…" }).catch((e) => e);
    expect(err.note).toEqual({ code: "contentCheckFailed", params: { detail: "no classifier" } });
  });
});
