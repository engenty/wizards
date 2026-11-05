import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// On the cloud the studio, the doors and the runner are separate processes on one database.
// Only a runner looks at the clock, or each would begin its own runs.
const dir = mkdtempSync(join(tmpdir(), "wizards-starts-roles-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";

const MINUTE = 60_000;

async function ticksAs(role: string) {
  vi.resetModules();
  process.env.RUNTIME_ROLE = role;
  const { startStarts } = await import("../src/engine/starts");
  const interval = vi.spyOn(globalThis, "setInterval");
  const timeout = vi.spyOn(globalThis, "setTimeout");
  startStarts();
  const every = interval.mock.results.filter((_, i) => interval.mock.calls[i]?.[1] === MINUTE);
  const soon = timeout.mock.results.filter((_, i) => timeout.mock.calls[i]?.[1] === 5_000);
  for (const r of every) {
    clearInterval(r.value);
  }
  for (const r of soon) {
    clearTimeout(r.value);
  }
  return every.length > 0;
}

describe("the clock's roles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["studio", false],
    ["doors", false],
    ["api", false],
    ["web", false],
    ["runner", true],
    ["all", true],
  ])("%s: %s", async (role, ticks) => {
    expect(await ticksAs(role)).toBe(ticks);
  }, 60_000);
});
