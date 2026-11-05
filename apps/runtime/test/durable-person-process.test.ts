import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each phase is a process of its own on one data folder; the first ends in a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/durable-person-worker.test.ts", "--pool=forks", "--reporter=dot"],
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
        PERSON_PHASE: name,
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
function waitingRun(dir: string) {
  phase(dir, "start");
  const first = lines(dir);
  const waits = first.find((l) => l.includes("WAITS"));
  expect(waits, first.join("\n")).toBeTruthy();
  expect(first.filter((l) => l.includes("STEP"))).toHaveLength(0);
  return { startedIn: waits?.split(" ")[0], id: waits?.split(" ")[2] ?? "" };
}

describe("a person's step across two processes", () => {
  it("the process that reached it dies, another times it out and goes on", { timeout: 240_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-person-process-"));
    const { startedIn, id } = waitingRun(dir);
    phase(dir, "time-out", { PERSON_RUN: id });
    const all = lines(dir);
    const found = all.find((l) => l.includes("FOUND"));
    expect(found, all.join("\n")).toContain("status=waiting_input wake=true reminder=true");
    expect(found?.split(" ")[0]).not.toBe(startedIn);
    expect(all.at(-1)).toContain('END status=done output={"timedOut":true}');
    // Nothing is left to remind of.
    expect(all.at(-1)).toContain("reminders=0");
    expect(all.filter((l) => l.includes("STEP after"))).toHaveLength(1);
  });

  it("the process that reached it dies, the answer reaches another", { timeout: 240_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-person-process-"));
    const { id } = waitingRun(dir);
    phase(dir, "answer", { PERSON_RUN: id });
    const all = lines(dir);
    expect(all.at(-1), all.join("\n")).toContain('END status=done output={"timedOut":false}');
    expect(all.at(-1)).toContain("after the restart");
    expect(all.filter((l) => l.includes("STEP after"))).toHaveLength(1);
  });
});
