import { describe, expect, it } from "vitest";
import { stepOutline } from "../src/kernel/outline.js";

describe("what the studio reads of a step file", () => {
  it("reads an ask's literals, a template's parts and a constant of the file", async () => {
    const step = await stepOutline(`/**
 * The pitch
 * One line below.
 *
 * Converted from somewhere.
 */
const cols = [{ id: "name", label: "Name", kind: "text" }];
const text = (v: unknown): string => String(v);
export default async function (run: any, ask: any) {
  const value: any = await ask({
    type: "agent",
    title: "Pitch",
    model: "standard",
    instructions: \`Write to \${text(run.input.customer)}.\`,
    fields: [{ id: "items", kind: "items", required: true, columns: cols }],
    tools: pick(run),
  });
  return { value };
}`);
    expect(step.title).toBe("The pitch");
    expect(step.description).toBe("One line below.");
    expect(step.asks).toHaveLength(1);
    const spec = step.asks[0].spec as Record<string, unknown>;
    expect(spec.type).toBe("agent");
    expect(spec.title).toBe("Pitch");
    expect(spec.instructions).toEqual({
      $text: ["Write to ", { $code: "text(run.input.customer)" }, "."],
    });
    expect(spec.fields).toEqual([
      {
        id: "items",
        kind: "items",
        required: true,
        columns: [{ id: "name", label: "Name", kind: "text" }],
      },
    ]);
    expect(spec.tools).toEqual({ $code: "pick(run)" });
    expect(step.ways).toEqual([{}]);
  });

  it("reads each way with the condition around it", async () => {
    const step = await stepOutline(`
const check = async (_run, ask) => {
  const review = await ask({ type: "review", show: ["offer"], regenerate: true });
  const helper = () => { return { to: "nowhere" }; };
  if (review?.regenerate === "offer") return { value: review, to: "offer", why: "Make it again" };
  return { value: review, to: review.approved ? "accept" : "end" };
};
export default check;`);
    expect(step.asks[0].spec).toEqual({ type: "review", show: ["offer"], regenerate: true });
    expect(step.ways).toEqual([
      { to: "offer", when: 'review?.regenerate === "offer"', why: "Make it again" },
      { to: "accept", when: "review.approved" },
      { to: "end", when: "!(review.approved)" },
    ]);
  });

  it("keeps an ask that is worked out as code, and says why a file cannot be read", async () => {
    const worked = await stepOutline(
      "export default async function (run, ask) { await ask(specFor(run.input.kind)); }",
    );
    expect(worked.asks).toEqual([{ code: "specFor(run.input.kind)" }]);
    const broken = await stepOutline("export default async function (run, ask) {");
    expect(broken.asks).toEqual([]);
    expect(broken.error).toBeTruthy();
  });
});

describe("a way a model decides", () => {
  it("is read from the decision ask that names it", async () => {
    const step = await stepOutline(`
export default async function (run, ask) {
  const value = await ask({ type: "form", fields: [{ id: "text", kind: "text" }] });
  if (value.text === "") return { value, to: "empty" };
  const way = await ask({
    type: "decision",
    instructions: \`What was typed: \${value.text}\`,
    ways: { callNow: "It is urgent.", later: "It can wait a week." },
  });
  if (way?.to === "callNow") return { value, to: "callNow" };
  return { value, to: "queue" };
}`);
    expect(step.ways).toEqual([
      { to: "empty", when: 'value.text === ""' },
      { to: "callNow", when: 'way?.to === "callNow"', ask: "It is urgent." },
      { to: "queue" },
      { to: "later", ask: "It can wait a week." },
    ]);
  });
});
