import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each phase is a process of its own on one data folder; its end is a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/kernel-restart-worker.test.ts", "--pool=forks", "--reporter=dot"],
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
        FEATURES: "durableRuns=on,kernel=on",
        RUNNER_CLOCK_MS: "200",
        KERNEL_PHASE: name,
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
/** What a line says, without the process that said it. */
const said = (line: string | undefined) => line?.split(" ").slice(1).join(" ");

/**
 * A run of version 0.3.0 across restarts of its runner (docs/plans/kernel.md, "Before the switch
 * flips"): at each kind of wait the process that brought the run there dies, and another one finds
 * the run as it stood and takes it on.
 */
describe.each(["quickjs", "native"] as const)("a run of version 0.3.0, its steps run as %s", (mode) => {
  it("goes on in a new process from a person, a time, a signal and the leave for an action", { timeout: 480_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-restart-"));
    const env: Record<string, string> = { KERNEL_STEPS: mode };

    phase(dir, "start", env);
    const first = lines(dir);
    const made = first.find((l) => l.includes("AT person"));
    expect(made, first.join("\n")).toBeTruthy();
    env.KERNEL_RUN = made?.split(" ")[3] ?? "";

    for (const next of ["person", "time", "signal", "leave"]) {
      phase(dir, next, env);
    }
    const all = lines(dir);
    const log = all.join("\n");

    // What each new process found before it did anything: the run as the dead one left it.
    expect(all.filter((l) => l.includes(" FOUND ")).map(said), log).toEqual([
      "FOUND status=waiting_input cursor=check waiting=check:form wait=-",
      "FOUND status=sleeping cursor=nap waiting=nap:wait wait=-",
      "FOUND status=waiting_signal cursor=paid waiting=paid:wait wait=order.paid",
      "FOUND status=waiting_input cursor=send waiting=send:tool,send:approval wait=-",
    ]);
    // The signal found the run by its address, with no process alive that had written the wait.
    expect(all.find((l) => l.includes(" SENT ")), log).toContain("SENT runs=1");
    // Every wait was reached in one process and left in another.
    const at = all.filter((l) => l.includes(" AT "));
    expect(at.map((l) => l.split(" ")[2])).toEqual(["person", "time", "signal", "leave"]);
    expect(new Set([...at, all.at(-1) ?? ""].map((l) => l.split(" ")[0])).size).toBe(5);
    // The action was done once, after the leave, and nothing else was asked of a machine.
    expect(all.filter((l) => l.includes(" STEP ")).map(said), log).toEqual(["STEP send tool"]);
    // Each ask and each leaving is one row: no step's rows were written twice.
    expect(said(all.find((l) => l.includes(" ROWS "))), log).toBe(
      "ROWS check:ask:done check:left:- nap:ask:done nap:left:- paid:ask:done paid:left:- send:ask:done send:approval:done send:left:-",
    );
    expect(said(all.at(-1)), log).toBe(
      'END status=done output={"note":"go","woke":true,"amount":42,"sent":"msg_9"}',
    );
  });
});
