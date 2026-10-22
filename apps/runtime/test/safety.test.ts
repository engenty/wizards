import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn: vitest reports a rejection a mock records as unhandled.
let decide: (input: unknown) => Promise<unknown> = async () => answer("allowed");
const asked: { state?: unknown }[] = [];
vi.mock("../src/engine/decide.js", () => ({
  decide: (input: unknown) => {
    asked.push(input as { state?: unknown });
    return decide(input);
  },
}));

const { checkContent, contentPolicy, contentQuestion, ContentBlockedError } = await import(
  "../src/safety.js"
);

const answer = (choice: string) => ({
  answers: { rule: { type: "choice", choice } },
  source: "systemone",
});

beforeEach(() => {
  asked.length = 0;
});

describe("content rules", () => {
  it("ask one choice question with every criterion of safety.md", () => {
    const q = contentQuestion();
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)[0]).toBe("allowed");
    expect(Object.keys(q.criteria)).toEqual(
      expect.arrayContaining(["extremism", "hate", "sexual", "minors", "violence", "real_person"]),
    );
  });

  it("let an allowed request through", async () => {
    decide = async () => answer("allowed");
    await expect(checkContent({ kind: "image", text: "a lake at dawn" })).resolves.toBeUndefined();
    expect(asked[0].state).toEqual({ kind: "image", request: "a lake at dawn" });
  });

  it("stop a request that breaks a rule, with a note for the person", async () => {
    decide = async () => answer("extremism");
    const err = await checkContent({ kind: "speech", text: "…" }).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(err.rule).toBe("extremism");
    expect(err.note).toEqual({ code: "contentBlocked" });
  });

  it("make nothing when the check cannot run", async () => {
    decide = async () => {
      throw new Error("no classifier");
    };
    const err = await checkContent({ kind: "video", text: "…" }).catch((e) => e);
    expect(err.note).toEqual({ code: "contentCheckFailed", params: { detail: "no classifier" } });
  });

  it("are part of the system prompts", () => {
    expect(contentPolicy()).toMatch(/^CONTENT RULES/);
  });
});
