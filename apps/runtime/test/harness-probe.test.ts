import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-harness-probe-"));
process.env.APP_URL = "http://localhost:5181";

vi.mock("@engenty/local-models/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@engenty/local-models/clients")>()),
  detectClient: vi.fn(async (client: { id: string }) =>
    client.id === "cursor"
      ? { version: null, auth: "none" }
      : { version: "2.1.0", auth: "subscription" },
  ),
}));

describe("an AI client on this machine", () => {
  it("is what the detection found, with how to install it and what it makes", async () => {
    const { detectHarness } = await import("../src/harness/index");
    expect(await detectHarness("claude")).toMatchObject({
      id: "claude",
      name: "Claude Code",
      version: "2.1.0",
      auth: "subscription",
      interactiveLogin: false,
      images: false,
    });
    expect(await detectHarness("codex")).toMatchObject({ name: "Codex", images: true });
    expect(await detectHarness("cursor")).toMatchObject({ version: null, auth: "none" });
    expect((await detectHarness("claude"))?.install).toBeTruthy();
  });

  it("says a file that ran out of time was killed, as the probe reads it", async () => {
    const { runFile } = await import("../src/cli/exec");
    await expect(
      runFile(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 100 }),
    ).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
  });
});
