import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every phase is a process of its own on one data folder; a crash is a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  spawnSync(
    "npx",
    ["vitest", "run", "test/durable-turn-worker.test.ts", "--pool=forks", "--no-isolate", "--reporter=dot"],
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
        TURN_PHASE: name,
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
const count = (l: string[], s: string) => l.filter((x) => x.includes(s)).length;

describe("a durable agent step across processes", () => {
  it("kill -9 in the middle of a tool call: goes on at that call, nothing acts twice", { timeout: 200_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-turn-crash-"));
    phase(dir, "start", { TURN_CRASH_AT: "1" });
    phase(dir, "recover");
    const l = lines(dir);
    console.log(l.map((x) => x.split(" ").slice(1).join(" ")).join("\n"));
    expect(l.at(-1)).toContain("status=done");
    // Mail 0 finished before the crash; mail 1 had started: it may have gone out and is not repeated.
    expect(count(l, "EFFECT mail 0")).toBe(1);
    expect(count(l, "EFFECT mail 1")).toBe(1);
    expect(count(l, "EFFECT mail 2")).toBe(1);
  });

  it("a deploy (the runner stops) in the middle of a turn: the next runner goes on", { timeout: 200_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-turn-stop-"));
    phase(dir, "start", { TURN_STOP_AT: "1" });
    phase(dir, "recover");
    const l = lines(dir);
    console.log(l.map((x) => x.split(" ").slice(1).join(" ")).join("\n"));
    expect(l.at(-1)).toContain("status=done");
    expect(count(l, "EFFECT mail 0")).toBe(1);
    expect(count(l, "EFFECT mail 1")).toBe(1);
  });

  it("kill -9 after the turn ended, before its result is saved: the turn is not done again", { timeout: 200_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-turn-end-"));
    phase(dir, "start", { TURN_CRASH_AT_END: "1" });
    phase(dir, "recover");
    const l = lines(dir);
    console.log(l.map((x) => x.split(" ").slice(1).join(" ")).join("\n"));
    expect(l.at(-1)).toContain("status=done");
    expect(l.at(-1)).toContain('text="sent 3 mails"');
    expect(count(l, "EFFECT mail 0")).toBe(1);
    expect(count(l, "EFFECT mail 2")).toBe(1);
  });

  it("the turn asks a person: no process holds it, the answer goes on in another", { timeout: 200_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-turn-ask-"));
    phase(dir, "start", { TURN_ASK: "1" });
    expect(lines(dir).at(-1)).toContain("status=waiting_input");
    expect(lines(dir).at(-1)).toContain("question=Which offer?");
    phase(dir, "answer", { TURN_ASK: "1" });
    const l = lines(dir);
    console.log(l.map((x) => x.split(" ").slice(1).join(" ")).join("\n"));
    expect(l.at(-1)).toContain("status=done");
  });
});
