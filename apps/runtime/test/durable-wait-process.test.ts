import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each phase is a process of its own on one data folder; its end is a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/durable-wait-worker.test.ts", "--pool=forks", "--reporter=dot"],
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
        WAIT_PHASE: name,
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

describe("a wait across two processes", () => {
  it("the process that reached it dies, another wakes it and goes on", { timeout: 240_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-wait-process-"));
    phase(dir, "start");
    const first = lines(dir);
    const asleep = first.find((l) => l.includes("ASLEEP"));
    expect(asleep, first.join("\n")).toBeTruthy();
    expect(first.filter((l) => l.includes("STEP"))).toHaveLength(1);
    const startedIn = asleep?.split(" ")[0];
    const id = asleep?.split(" ")[2] ?? "";

    phase(dir, "wake", { WAIT_RUN: id });
    const all = lines(dir);
    const found = all.find((l) => l.includes("FOUND"));
    expect(found, all.join("\n")).toContain("status=sleeping wake=true");
    expect(found?.split(" ")[0]).not.toBe(startedIn);
    expect(all.at(-1)).toContain("END status=done");
    // Each step ran once: the one before the wait in the first process, the next in the second.
    const steps = all.filter((l) => l.includes("STEP"));
    expect(steps.map((l) => l.split(" ")[2])).toEqual(["before", "after"]);
    expect(steps[1].split(" ")[0]).not.toBe(startedIn);
  });
});
