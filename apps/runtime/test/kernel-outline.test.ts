import { describe, expect, it } from "vitest";
import { isTextMime, mimeForPath } from "@engenty/wizards-shared/workspace";
import { editStep, stepOutline } from "../src/kernel/outline.js";

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

  it("writes a text a person typed over where it stands, the code between its words kept", async () => {
    const source = `const label: string = "Name";
export default async function (run: any, ask: any) {
  const value: any = await ask({
    type: "agent",
    title: "Pitch",
    instructions: \`Write to \${text(run.input.customer)}.\`,
    fields: [{ id: "name", label, options: ["a", "b"] }],
  });
  return { value };
}`;
    const at = (await stepOutline(source)).asks[0].at ?? {};
    expect(source.slice(...at.title)).toBe('"Pitch"');
    expect(source.slice(...at["fields.0.label"])).toBe('"Name"');
    expect(source.slice(...at["fields.0.options.1"])).toBe('"b"');

    const titled = await editStep(source, at.title, 'The "pitch"');
    expect(titled).toContain('title: "The \\"pitch\\"",');
    const labelled = await editStep(source, at["fields.0.label"], "Your name");
    expect(labelled).toContain('const label: string = "Your name";');
    const told = await editStep(source, at.instructions, [
      "Dear `",
      { $code: "text(run.input.customer)" },
      "`,\nsay ${hello}.",
    ]);
    expect(told).toContain(
      "instructions: `Dear \\`${text(run.input.customer)}\\`,\nsay \\${hello}.`,",
    );
    expect((await stepOutline(told)).asks[0].spec?.instructions).toEqual({
      $text: ["Dear `", { $code: "text(run.input.customer)" }, "`,\nsay ${hello}."],
    });
    await expect(editStep(source, [0, 5], "x")).rejects.toThrow();
  });
});

describe("a step file in a wizard's workspace", () => {
  it("is text, so the code view shows it and a tool that reads text reads it", () => {
    expect(mimeForPath("steps/reply.ts")).toBe("text/typescript");
    expect(isTextMime(mimeForPath("steps/reply.ts"))).toBe(true);
    expect(isTextMime(mimeForPath("evals/end/signed.ts"))).toBe(true);
  });
});
