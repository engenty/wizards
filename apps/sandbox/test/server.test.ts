import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxServer } from "../src/server.ts";
import { type MakeVm, NotFound, networkPolicy, publicHost, type Vm } from "../src/vm.ts";

const SECRET = "s".repeat(40);

/** A VM in memory: `exec` echoes, files live in a map of its own. */
function fakeVms(made: { hosts: readonly string[]; disposed: boolean }[]): MakeVm {
  return async (hosts) => {
    const record = { hosts, disposed: false };
    made.push(record);
    const files = new Map<string, Uint8Array>();
    const vm: Vm = {
      exec: async ({ command, env, timeoutMs }) => ({
        stdout: `${command}|${env?.X ?? ""}|${timeoutMs}`,
        stderr: "",
        exitCode: 0,
      }),
      writeFile: async (path, data) => {
        files.set(path, data);
      },
      readFile: async (path) => {
        const data = files.get(path);
        if (!data) {
          throw new NotFound(path);
        }
        return data;
      },
      list: async () => [...files.keys()].map((name) => ({ name, type: "file" as const })),
      dispose: async () => {
        record.disposed = true;
      },
    };
    return vm;
  };
}

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

async function start(overrides: { maxVms?: number; idleMs?: number; makeVm?: MakeVm } = {}) {
  const made: { hosts: readonly string[]; disposed: boolean }[] = [];
  const api = sandboxServer({
    secret: SECRET,
    maxVms: overrides.maxVms ?? 2,
    idleMs: overrides.idleMs ?? 60_000,
    maxExecMs: 5000,
    maxFileBytes: 1024,
    makeVm: overrides.makeVm ?? fakeVms(made),
    log: () => undefined,
  });
  api.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.server.once("listening", resolve));
  close = api.close;
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { secret?: string | null } = {}) => {
    const { secret = SECRET, ...rest } = init;
    return fetch(base + path, {
      ...rest,
      headers: { ...(secret === null ? {} : { authorization: `Bearer ${secret}` }), ...rest.headers },
    });
  };
  const create = (run: string, hosts: string[] = []) =>
    call(`/vms/${run}`, { method: "PUT", body: JSON.stringify({ hosts }) });
  return { api, made, call, create };
}

describe("the secret", () => {
  it("is wanted on every route but /health", async () => {
    const { call } = await start();
    expect((await call("/health", { secret: null })).status).toBe(200);
    expect((await call("/vms/run-1", { method: "PUT", secret: null })).status).toBe(401);
    expect((await call("/vms/run-1", { method: "PUT", secret: "wrong" })).status).toBe(401);
    expect((await call("/vms/run-1/exec", { method: "POST", secret: `${SECRET}x` })).status).toBe(401);
    expect(
      (await call("/vms/run-1", { method: "PUT", body: '{"hosts":[]}' })).status,
    ).toBe(201);
  });
});

describe("the cap on VMs", () => {
  it("refuses a VM beyond it, and takes one again after one is destroyed", async () => {
    const { create, call, made } = await start({ maxVms: 2 });
    expect((await create("a")).status).toBe(201);
    expect((await create("b")).status).toBe(201);
    const full = await create("c");
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: "full" });
    // The same run again is no new VM.
    expect((await create("a")).status).toBe(200);
    expect(made).toHaveLength(2);

    expect((await call("/vms/a", { method: "DELETE" })).status).toBe(204);
    expect(made[0]?.disposed).toBe(true);
    expect((await create("c")).status).toBe(201);
    expect((await (await call("/health")).json()).vms).toBe(2);
  });

  it("counts a VM that is still starting, and frees the place of one that failed", async () => {
    let attempts = 0;
    const slow: MakeVm = async (hosts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error("no helper");
      }
      return fakeVms([])(hosts);
    };
    const { create } = await start({ maxVms: 1, makeVm: slow });
    expect((await create("a")).status).toBe(500);
    expect((await create("a")).status).toBe(201);
    expect((await create("b")).status).toBe(429);
  });

  it("destroys a VM nobody used for the idle time", async () => {
    const { create, call, made } = await start({ idleMs: 200 });
    await create("a");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(made[0]?.disposed).toBe(true);
    expect((await call("/vms/a/exec", { method: "POST", body: '{"command":"true"}' })).status).toBe(
      404,
    );
  });
});

describe("one VM per run", () => {
  it("keeps each run's files and hosts its own", async () => {
    const { create, call, made } = await start();
    await create("run-a", ["api.example.com"]);
    await create("run-b", ["pypi.org"]);
    expect(made.map((m) => m.hosts)).toEqual([["api.example.com"], ["pypi.org"]]);

    const put = await call("/vms/run-a/files?path=out.csv", { method: "PUT", body: "a,b\n" });
    expect(put.status).toBe(204);
    const mine = await call("/vms/run-a/files?path=out.csv");
    expect(await mine.text()).toBe("a,b\n");
    const theirs = await call("/vms/run-b/files?path=out.csv");
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toMatchObject({ error: "no-file" });
    expect(await (await call("/vms/run-b/list?path=.")).json()).toEqual([]);
    expect(await (await call("/vms/run-a/list?path=.")).json()).toEqual([
      { name: "out.csv", type: "file" },
    ]);
  });

  it("has no VM for a run that made none", async () => {
    const { call } = await start();
    const res = await call("/vms/nobody/exec", { method: "POST", body: '{"command":"ls"}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no-vm" });
  });
});

describe("requests", () => {
  it("runs a command with its environment and cuts its timeout to the longest allowed", async () => {
    const { create, call } = await start();
    await create("a");
    const res = await call("/vms/a/exec", {
      method: "POST",
      body: JSON.stringify({ command: "echo", env: { X: "1" }, timeoutMs: 999_999 }),
    });
    expect(await res.json()).toEqual({ stdout: "echo|1|5000", stderr: "", exitCode: 0 });
  });

  it("refuses hosts that aren't public names, bad run ids and files over the limit", async () => {
    const { create, call } = await start();
    for (const host of ["127.0.0.1", "localhost", "runner", "host.docker.internal", "a b.com"]) {
      expect((await create("a", [host])).status).toBe(400);
    }
    expect((await create("a%20b")).status).toBe(400);
    await create("a");
    const big = await call("/vms/a/files?path=x", { method: "PUT", body: "x".repeat(2048) });
    expect(big.status).toBe(413);
    expect((await call("/vms/a/files", { method: "PUT", body: "x" })).status).toBe(400);
  });
});

describe("the network policy", () => {
  it("refuses everything but DNS and HTTPS to the hosts it is given", () => {
    expect(networkPolicy([])).toEqual({ default: "deny", rules: [] });
    expect(networkPolicy(["pypi.org", "*.example.com"])).toEqual({
      default: "deny",
      rules: [
        {
          mode: "allow",
          operations: ["*"],
          patterns: ["dns://pypi.org", "tcp://pypi.org:443", "dns://*.example.com", "tcp://*.example.com:443"],
        },
      ],
    });
  });

  it("takes public host names only", () => {
    expect(publicHost("registry.npmjs.org")).toBe(true);
    expect(publicHost("*.example.com")).toBe(true);
    for (const host of ["10.0.0.1", "localhost", "runner", "x.local", "metadata.internal", "-a.com"]) {
      expect(publicHost(host)).toBe(false);
    }
  });
});
