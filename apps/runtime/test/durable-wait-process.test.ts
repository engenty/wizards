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

describe("a kill -9 inside a step", () => {
  it("the next process says so once, and the log counts one visit", { timeout: 240_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-takeover-process-"));
    phase(dir, "die-in-step", { WAIT_KILL_IN: "before" });
    const first = lines(dir);
    const made = first.find((l) => l.includes("MADE"));
    expect(made, first.join("\n")).toBeTruthy();
    const startedIn = made?.split(" ")[0];
    const id = made?.split(" ")[2] ?? "";

    phase(dir, "take-over", { WAIT_RUN: id });
    const all = lines(dir);
    expect(all.at(-1), all.join("\n")).toContain("END status=sleeping");
    // The step worked twice: once in each process, because this one was broken off.
    const steps = all.filter((l) => l.includes("STEP before"));
    expect(steps).toHaveLength(2);
    expect(steps[1].split(" ")[0]).not.toBe(startedIn);
    const log = all.filter((l) => l.includes(" LOG ")).map((l) => l.split(" ").slice(2).join(" "));
    expect(log.filter((l) => l === "run_started -")).toHaveLength(1);
    expect(log.filter((l) => l === "resumed before")).toHaveLength(1);
    expect(log.filter((l) => l === "step_started before")).toHaveLength(1);
    expect(log.filter((l) => l === "step_done before")).toHaveLength(1);
    expect(log.filter((l) => l === "wait pause")).toHaveLength(1);
  });
});

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
