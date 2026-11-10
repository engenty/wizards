import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each phase is a process of its own on one data folder; the first ends with a real `kill -9`. */
function phase(dir: string, name: string, env: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/pending-jobs-worker.test.ts", "--pool=forks", "--reporter=dot"],
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
        FEATURES: "durableRuns=on,runServices=on",
        RUNNER_CLOCK_MS: "200",
        JOB_PHASE: name,
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

describe("a film across two processes", () => {
  it("the runner dies in the middle of the film; the next one makes it again, and the run ends with it", {
    timeout: 240_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-job-process-"));
    phase(dir, "start");
    const first = lines(dir);
    const asleep = first.find((l) => l.includes("ASLEEP"));
    expect(asleep, first.join("\n")).toBeTruthy();
    const [startedIn, , id, owner] = asleep?.split(" ") ?? [];
    expect(first.filter((l) => l.includes("FILM"))).toHaveLength(1);

    phase(dir, "wake", { JOB_RUN: id });
    const all = lines(dir);
    // The run slept on the job the dead process left running.
    const found = all.find((l) => l.includes("FOUND"));
    expect(found, all.join("\n")).toContain(
      `status=sleeping job=true jobStatus=running owner=${owner}`,
    );
    const films = all.filter((l) => l.includes("FILM"));
    expect(films).toHaveLength(2);
    const wokeIn = films[1].split(" ")[0];
    expect(wokeIn).not.toBe(startedIn);
    expect(all.at(-1)).toBe(
      `${wokeIn} END status=done text=film_by_${wokeIn} jobStatus=done owner=this job=gone`,
    );
  });
});
