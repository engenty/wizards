import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The six pinned runs (pinned-runs.test.ts) with the run's services over HTTP: the runner asks
 * them with each run's token at `RUN_SERVICES_URL`, and they end as pinned, snapshots and all.
 * Once with a server of the runner's own process on loopback, once with a broker of its own
 * (`RUNTIME_ROLE=broker`, pinned-runs-broker.test.ts) beside the runner on one data folder.
 */

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

const vitest = (file: string) => [
  "exec",
  "vitest",
  "run",
  file,
  "--pool=forks",
  "--maxWorkers=1",
  "--reporter=dot",
];

/** pinned-runs.test.ts in a process of its own; its output when it fails. */
function pinnedRuns(env: Record<string, string>) {
  const ran = spawnSync("pnpm", vitest("test/pinned-runs.test.ts"), {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    timeout: 240_000,
    stdio: "pipe",
  });
  return { status: ran.status, said: `${ran.stdout}\n${ran.stderr}` };
}

async function until(ok: () => boolean, ms: number) {
  const stop = Date.now() + ms;
  while (!ok() && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return ok();
}

describe("the pinned runs ask their services over HTTP", () => {
  it("of a server in the runner's own process", { timeout: 300_000 }, async () => {
    const port = await freePort();
    const ran = pinnedRuns({
      PINNED_SERVICES: "here",
      PINNED_PORT: String(port),
      RUN_SERVICES_URL: `http://127.0.0.1:${port}`,
    });
    expect(ran.status, ran.said).toBe(0);
  });

  it("of a broker in a process of its own", { timeout: 360_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-pinned-apart-"));
    const port = await freePort();
    const shared = { DATA_DIR: dir, APP_SECRET: "pinned-runs-apart" };
    const log = openSync(join(dir, "broker.log"), "a");
    const broker = spawn("pnpm", vitest("test/pinned-runs-broker.test.ts"), {
      cwd: process.cwd(),
      env: { ...process.env, ...shared, PINNED_BROKER_PORT: String(port) },
      stdio: ["ignore", log, log],
      detached: true,
    });
    try {
      const ready = await until(() => existsSync(join(dir, "broker-ready")), 120_000);
      expect(ready, readFileSync(join(dir, "broker.log"), "utf8")).toBe(true);
      const ran = pinnedRuns({
        ...shared,
        PINNED_SERVICES: "apart",
        RUN_SERVICES_URL: `http://127.0.0.1:${port}`,
      });
      expect(ran.status, `${ran.said}\n--- broker\n${readFileSync(join(dir, "broker.log"), "utf8")}`).toBe(0);
      // The broker did the model's work and the tool's: the runner's process did neither.
      expect(readFileSync(join(dir, "calls"), "utf8")).not.toBe("");
      expect(readFileSync(join(dir, "stamps"), "utf8")).not.toBe("");
    } finally {
      writeFileSync(join(dir, "stop"), "");
      await until(() => broker.exitCode !== null, 20_000);
      if (broker.exitCode === null && broker.pid) {
        process.kill(-broker.pid, "SIGKILL");
      }
    }
  });
});
