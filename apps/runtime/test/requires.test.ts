import { wizardSchema } from "@engenty/wizards-shared/definition";
import { requiresOf, requiresProblem, withRequires } from "@engenty/wizards-shared/requires";
import { describe, expect, it } from "vitest";
import { fillRequires } from "../scripts/definition-v1.mjs";

/** A wizard that needs a bit of everything: what `requires` says it needs. */
const wizard = () =>
  wizardSchema.parse({
    title: "Alles",
    connections: [{ id: "inbox", kind: "mail" }],
    steps: [
      {
        id: "ask",
        type: "form",
        title: "Fragen",
        fields: [
          { id: "topic", label: "Thema", kind: "text" },
          { id: "deep", label: "Gründlich", kind: "toggle" },
        ],
        next: [{ when: { field: "deep", op: "truthy" }, goto: "research" }, { goto: "free" }],
      },
      {
        id: "research",
        type: "agent",
        title: "Recherche",
        instructions: "Find out about {{topic}}.",
        tools: ["web_search", "sandbox", "contacts.lookup"],
        model: "high",
        maker: "anthropic",
      },
      {
        id: "free",
        type: "tool",
        title: "Freie Termine",
        call: { tool: "appointments.availability", input: {} },
        next: [{ ask: "The person wants a call", goto: "score" }],
      },
      {
        id: "score",
        type: "code",
        title: "Punkte",
        code: { entry: "code/score.ts", input: {} },
        output: { fields: [{ id: "total", kind: "number" }] },
      },
      { id: "later", type: "wait", title: "Warten", for: "1d" },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  });

describe("requires", () => {
  it("is worked out from the steps", () => {
    expect(requiresOf(wizard())).toEqual({
      models: ["classifier"],
      makers: ["anthropic"],
      tools: ["sandbox", "web_search"],
      run: ["code"],
      sandbox: "shell",
      plugins: ["appointments", "contacts"],
      connections: ["mail"],
      features: ["codeSteps", "durableRuns"],
      // Only runs that take the branch to the research step need its class.
      optional: { models: ["high"] },
    });
  });

  it("leaves out what a wizard doesn't need", () => {
    const plain = wizardSchema.parse({
      title: "Nur Fragen",
      steps: [
        { id: "ask", type: "form", title: "F", fields: [{ id: "a", label: "A", kind: "text" }] },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    });
    expect(requiresOf(plain)).toEqual({});
    expect(withRequires(plain)).not.toHaveProperty("requires");
  });

  it("is written before the steps, and validate says where a stored one differs", () => {
    const filled = withRequires(wizard());
    expect(Object.keys(filled).indexOf("requires")).toBeLessThan(
      Object.keys(filled).indexOf("steps"),
    );
    expect(requiresProblem(filled)).toBeNull();
    expect(requiresProblem(wizard())).toContain('"requires" is not what the steps need');
    expect(requiresProblem({ ...filled, requires: { models: ["low"] } })).not.toBeNull();
    // Order inside a list doesn't count.
    const requires = filled.requires ?? {};
    expect(
      requiresProblem({ ...filled, requires: { ...requires, tools: ["web_search", "sandbox"] } }),
    ).toBeNull();
  });

  it("is filled in once by the migration, and a second run leaves it", () => {
    const shared = { wizardSchema, requiresOf };
    const raw = JSON.parse(JSON.stringify(wizard()));
    const once = fillRequires(raw, shared);
    expect(once?.requires).toEqual(requiresOf(wizard()));
    expect(fillRequires(once, shared)).toBe(once);
    expect(fillRequires({ title: "x", steps: [{ type: "film" }] }, shared)).toBeNull();
  });
});
