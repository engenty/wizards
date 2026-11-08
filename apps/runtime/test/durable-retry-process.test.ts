import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each phase is a process of its own on one data folder; its end is a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/durable-retry-worker.test.ts", "--pool=forks", "--reporter=dot"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dir,
        APP_URL: "http://localhost:5181",
        LOCAL_ACCESS_KEY: "test-key",
        MARKETPLACE_URL: "off",
        AI_GATEWAY_API_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        RUNTIME_ROLE: "runner",
        FEATURES: "durableRuns=on",
        RUNNER_CLOCK_MS: "200",
        RETRY_PHASE: name,
        ...env,
      },
      timeout: 110_000,
      stdio: "pipe",
    },
  );
}
const lines = (dir: string) => {
  const p = join(dir, "log");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : [];
};

describe("a retry across two processes", () => {
  it("the process that failed dies, another tries the step again, counting on", { timeout: 240_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-retry-process-"));
    phase(dir, "start");
    const first = lines(dir);
    const asleep = first.find((l) => l.includes("ASLEEP"));
    expect(asleep, first.join("\n")).toBeTruthy();
    expect(first.filter((l) => l.includes("STEP"))).toHaveLength(1);
    const startedIn = asleep?.split(" ")[0];
    const id = asleep?.split(" ")[2] ?? "";

    phase(dir, "wake", { RETRY_RUN: id });
    const all = lines(dir);
    const found = all.find((l) => l.includes("FOUND"));
    expect(found, all.join("\n")).toContain("status=sleeping wake=true pause=retry count=1");
    // It failed again in the second process: the count went on from the first's, to the second wait.
    const again = all.find((l) => l.includes("AGAIN"));
    expect(again, all.join("\n")).toContain("count=2 minutes=5");
    expect(again?.split(" ")[0]).not.toBe(startedIn);
    expect(all.at(-1)).toContain("END status=done");
    const steps = all.filter((l) => l.includes("STEP"));
    expect(steps.map((l) => l.split(" ")[2])).toEqual(["flaky", "flaky", "flaky", "after"]);
    expect(steps.slice(1).every((l) => l.split(" ")[0] !== startedIn)).toBe(true);
  });
});
