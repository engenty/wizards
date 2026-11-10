import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentOsVms } from "../src/agentos.ts";
import { NotFound, type Vm } from "../src/vm.ts";

/** Installed with `pnpm sandbox:add agentos` (SANDBOX_ENGINES_DIR moves it), as the image does. */
const dir =
  process.env.AGENTOS_DIR ||
  join(process.env.SANDBOX_ENGINES_DIR || join(homedir(), ".engenty", "wizards", "engines"), "agentos");

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

describe.skipIf(!existsSync(join(dir, "engine.json")))("agentOS VMs", () => {
  let agentOs: Awaited<ReturnType<typeof agentOsVms>>;
  let a: Vm;
  let b: Vm;
  let host: Server;
  let hostUrl: string;

  beforeAll(async () => {
    host = createServer((_, res) => res.end("host-only")).listen(0, "127.0.0.1");
    await new Promise((resolve) => host.once("listening", resolve));
    hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`;
    agentOs = await agentOsVms(dir, 4, 600_000);
    [a, b] = await Promise.all([agentOs.makeVm(["pypi.org"]), agentOs.makeVm([])]);
  }, 120_000);

  afterAll(async () => {
    await a?.dispose();
    await b?.dispose();
    await agentOs?.stop();
    host.close();
  }, 60_000);

  it("keeps each VM's files its own", async () => {
    await a.writeFile("in/data.csv", new TextEncoder().encode("x\n1\n2\n"));
    expect(text(await a.readFile("in/data.csv"))).toBe("x\n1\n2\n");
    await expect(b.readFile("in/data.csv")).rejects.toBeInstanceOf(NotFound);
    expect(await a.list(".")).toEqual([{ name: "in", type: "directory" }]);
    expect((await b.exec({ command: "ls -A /workspace" })).stdout).toBe("");
  }, 120_000);

  it("writes a CSV with Python and pandas", async () => {
    const result = await a.exec({
      command:
        "cd in && python3 -c \"import pandas; d = pandas.read_csv('data.csv'); d['sq'] = d.x ** 2; d.to_csv('../squares.csv', index=False); print('done')\"",
      timeoutMs: 600_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "done\n" });
    expect(text(await a.readFile("squares.csv"))).toBe("x,sq\n1,1\n2,4\n");
  }, 660_000);

  it("reaches neither the host's loopback nor a host it wasn't given", async () => {
    const loopback = await a.exec({
      command: `node -e 'fetch("${hostUrl}").then(() => console.log("reached"), (e) => console.log("blocked", e.cause?.code))'`,
    });
    expect(loopback.stdout).toBe("blocked EACCES\n");
    const other = await b.exec({ command: "curl -sS -m 10 https://pypi.org/simple/" });
    expect(other.exitCode).not.toBe(0);
  }, 120_000);
});
