import { createTool } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CODE_LIMITS, codeTool, inProgram, PAID_TOOLS } from "../src/tools/code.js";

const ctx = { emit: async () => undefined, signal: new AbortController().signal };

/** A tool that answers a number's double, and remembers how many calls ran at once. */
function doubler() {
  const seen = { running: 0, most: 0, calls: 0, inProgram: [] as boolean[] };
  const tool = createTool({
    id: "double",
    description: "Doubles a number.",
    inputSchema: z.object({ n: z.number() }),
    execute: async ({ n }) => {
      seen.calls++;
      seen.running++;
      seen.most = Math.max(seen.most, seen.running);
      seen.inProgram.push(inProgram());
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.running--;
      return { value: n * 2 };
    },
  });
  return { tool, seen };
}

async function run(code: string, tools: Record<string, any>, limits = CODE_LIMITS) {
  const made = codeTool(tools, ctx, limits);
  if (!made) {
    throw new Error("no code tool");
  }
  return made.tool.execute({ code }, {});
}

describe("code mode", () => {
  it("runs a loop over a tool and returns only the sum", async () => {
    const { tool, seen } = doubler();
    const result = await run(
      `const all = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => external_double({ n })));
       return all.reduce((sum, r) => sum + r.value, 0);`,
      { double: tool },
    );
    expect(result).toMatchObject({ success: true, result: 42 });
    expect(seen.calls).toBe(6);
    expect(seen.inProgram.every(Boolean)).toBe(true);
    expect(inProgram()).toBe(false);
  });

  it("runs at most maxParallel calls at once", async () => {
    const { tool, seen } = doubler();
    await run(
      "await Promise.all(Array.from({ length: 12 }, (_, n) => external_double({ n }))); return 1;",
      { double: tool },
      { ...CODE_LIMITS, maxParallel: 3 },
    );
    expect(seen.most).toBe(3);
  });

  it("stops a program that makes too many calls", async () => {
    const { tool } = doubler();
    const result = await run(
      "for (let n = 0; n < 10; n++) { await external_double({ n }); } return 1;",
      { double: tool },
      { ...CODE_LIMITS, maxCalls: 4 },
    );
    expect(result.success).toBe(false);
    expect(result.error.message).toContain("at most 4 tool calls");
  });

  it("caps the calls of all programs of a step together", async () => {
    const { tool, seen } = doubler();
    const made = codeTool({ double: tool }, ctx, { ...CODE_LIMITS, maxCalls: 5, stepCalls: 8 });
    const program = "for (let n = 0; n < 5; n++) { await external_double({ n }); } return 1;";
    expect(await made?.tool.execute({ code: program }, {})).toMatchObject({ success: true });
    const second = await made?.tool.execute({ code: program }, {});
    expect(second.success).toBe(false);
    expect(second.error.message).toContain("8 tool calls");
    expect(seen.calls).toBe(8);
  });

  it("keeps a too large tool answer out of the program", async () => {
    const big = createTool({
      id: "big",
      description: "Answers a lot.",
      execute: async () => ({ text: "x".repeat(5000) }),
    });
    const result = await run("return (await external_big({})).text.length;", { big }, {
      ...CODE_LIMITS,
      answerChars: 1000,
    });
    expect(result.success).toBe(false);
    expect(result.error.message).toContain("call big directly");
  });

  it("leaves tools that cost credits on every call out of programs", () => {
    const { tool } = doubler();
    const paid = Object.fromEntries(
      [...PAID_TOOLS].map((id) => [id, createTool({ id, description: id, execute: async () => ({}) })]),
    );
    const made = codeTool({ ...paid, double: tool }, ctx);
    expect(made?.instructions).toContain("external_double");
    for (const id of PAID_TOOLS) {
      expect(made?.instructions).not.toContain(`external_${id}`);
    }
    expect(codeTool(paid, ctx)).toBeNull();
  });

  it("gives the program no files, network or process", async () => {
    const { tool } = doubler();
    const result = await run(
      "return [typeof process, typeof fetch, typeof require, typeof setTimeout, typeof globalThis.Deno];",
      { double: tool },
    );
    expect(result).toMatchObject({
      success: true,
      result: ["undefined", "undefined", "undefined", "undefined", "undefined"],
    });
  });

  it("ends an endless loop at the timeout", async () => {
    const { tool } = doubler();
    const result = await run(
      "while (true) {}",
      { double: tool },
      {
        ...CODE_LIMITS,
        timeoutMs: 300,
      },
    );
    expect(result.success).toBe(false);
  });

  it("cuts a long answer", async () => {
    const { tool } = doubler();
    const result = await run(
      'return "x".repeat(50_000);',
      { double: tool },
      { ...CODE_LIMITS, resultChars: 100 },
    );
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("[truncated");
    expect(String(result.result).length).toBeLessThan(200);
  });

  it("leaves out tools the server does not run itself", () => {
    expect(codeTool({ web_search: { type: "provider" } }, ctx)).toBeNull();
    const { tool } = doubler();
    const made = codeTool({ web_search: { type: "provider" }, double: tool }, ctx);
    expect(made?.instructions).toContain("external_double");
    expect(made?.instructions).not.toContain("external_web_search");
  });
});
