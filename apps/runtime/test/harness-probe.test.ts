import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-harness-probe-"));
process.env.APP_URL = "http://localhost:5181";

vi.mock("../src/harness/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/harness/env")>()),
  resolveEnv: async () => ({ env: {}, auth: "subscription" }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("whether an AI client is installed", () => {
  it("keeps an installed client installed while its version probe runs out of time", async () => {
    const { ProbeUndecided } = await import("../src/harness/env");
    const { claude } = await import("../src/harness/claude");
    const { detectHarness } = await import("../src/harness/index");
    vi.useFakeTimers({ toFake: ["Date"] });
    const version = vi.spyOn(claude, "version").mockResolvedValueOnce("2.1.0");
    expect(await detectHarness("claude", true)).toMatchObject({
      version: "2.1.0",
      auth: "subscription",
    });

    // Another Claude Code is busy: `claude --version` does not answer in time.
    vi.setSystemTime(Date.now() + 61_000);
    version.mockRejectedValueOnce(new ProbeUndecided("claude --version did not finish"));
    expect(await detectHarness("claude")).toMatchObject({ version: "2.1.0" });

    // Uninstalled: the probe finishes and finds nothing.
    vi.setSystemTime(Date.now() + 61_000);
    version.mockResolvedValueOnce(null);
    expect((await detectHarness("claude"))?.version).toBeNull();
  });

  it("does not take a client that never answered for installed", async () => {
    const { ProbeUndecided } = await import("../src/harness/env");
    const { codex } = await import("../src/harness/codex");
    const { detectHarness } = await import("../src/harness/index");
    vi.spyOn(codex, "version").mockRejectedValueOnce(new ProbeUndecided("codex --version"));
    expect((await detectHarness("codex", true))?.version).toBeNull();
  });

  it("says a file that ran out of time was killed, as the probe reads it", async () => {
    const { runFile } = await import("../src/cli/exec");
    await expect(
      runFile(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 100 }),
    ).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
  });

  it("reads a missing binary as not installed", async () => {
    const { probeVersion } = await import("../src/harness/env");
    expect(await probeVersion("/nonexistent/claude", {}, (s) => s.trim())).toBeNull();
  });
});
