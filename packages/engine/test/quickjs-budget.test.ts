import { afterEach, describe, expect, it, vi } from "vitest";
import { runCode } from "../src/code-step.js";
import { quickJs } from "../src/quickjs.js";

/**
 * A program's time where the clock stands still while code runs (workerd's `Date.now()`): QuickJS's
 * own count of its work ends it with the same timeout as the clock does elsewhere.
 */

const run = (program: string, timeout: number) =>
  quickJs({ memoryLimitMb: 32 }).run({
    program,
    toolIds: [],
    dispatch: async () => null,
    timeout,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a program's time in QuickJS", () => {
  it("ends a loop that never stops when the clock stands still", async () => {
    const frozen = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    const started = performance.now();
    const ran = await run("while (true) {}", 200);
    expect(ran).toMatchObject({
      success: false,
      error: { name: "TimeoutError", message: "Code Mode execution timed out after 200ms" },
    });
    // The count, not the clock: well within the time a hung program would take.
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it("ends it by the clock where the clock runs, with the same words", async () => {
    const ran = await run("while (true) {}", 200);
    expect(ran).toMatchObject({ success: false, error: { name: "TimeoutError" } });
  });

  it("lets a short program finish with the clock standing still", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 11));
    const result = await runCode(
      "export function run(input) { let s = 0; for (let i = 0; i < 1000; i++) s += i; return { s, n: input.n }; }",
      { n: 2 },
    );
    expect(result).toEqual({ s: 499_500, n: 2 });
  });
});
