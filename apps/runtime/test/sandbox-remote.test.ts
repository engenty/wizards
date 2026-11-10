import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickGuestEngine, type SandboxEngine } from "../src/sandbox";
import { RemoteAgentOsSandbox } from "../src/sandbox/agentos-remote";

// The cloud's sandbox engine against a stub of the sandbox container's API (apps/sandbox).

const SECRET = "x".repeat(40);

interface Call {
  method: string;
  path: string;
  auth: string;
  body: string;
}

/** The container's API in memory: one VM per run, files in a map. */
function stubSandbox() {
  const calls: Call[] = [];
  const vms = new Map<string, { hosts: string[]; files: Map<string, Buffer> }>();
  let full = false;
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const body = await read(req);
    calls.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      auth: req.headers.authorization ?? "",
      body: body.toString("utf8"),
    });
    const send = (status: number, value?: unknown) =>
      res
        .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
        .end(value === undefined ? undefined : JSON.stringify(value));
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      return send(401, { error: "unauthorized" });
    }
    const [, , run, action] = url.pathname.split("/");
    const vm = vms.get(run);
    if (req.method === "PUT" && !action) {
      if (full) {
        return send(429, { error: "full", message: "All 4 VMs are in use." });
      }
      vms.set(run, vm ?? { hosts: JSON.parse(body.toString()).hosts, files: new Map() });
      return send(vm ? 200 : 201, { created: !vm });
    }
    if (req.method === "DELETE") {
      vms.delete(run);
      return send(204);
    }
    if (!vm) {
      return send(404, { error: "no-vm", message: `There is no VM for ${run}.` });
    }
    const path = url.searchParams.get("path") ?? "";
    if (action === "exec") {
      const { command, env, timeoutMs } = JSON.parse(body.toString());
      return send(200, { stdout: `${command} ${env?.A ?? ""} ${timeoutMs}`, stderr: "", exitCode: 3 });
    }
    if (action === "files" && req.method === "PUT") {
      vm.files.set(path, body);
      return send(204);
    }
    if (action === "files") {
      const file = vm.files.get(path);
      return file
        ? res.writeHead(200, { "content-type": "application/octet-stream" }).end(file)
        : send(404, { error: "no-file", message: `No file /workspace/${path}.` });
    }
    send(405, { error: "not-allowed" });
  });
  return {
    server,
    calls,
    vms,
    setFull: (value: boolean) => {
      full = value;
    },
  };
}

let stub: ReturnType<typeof stubSandbox>;
let url: string;

beforeAll(async () => {
  stub = stubSandbox();
  stub.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => stub.server.once("listening", resolve));
  url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  (stub.server as Server).closeAllConnections();
  stub.server.close();
});

const egress = (hosts: string[]) => ({
  hosts: async () => ({ hosts, everyPublicHost: false }),
  open: async () => null,
});

describe("a run's sandbox in the sandbox container", () => {
  it("makes the run's VM once, with the registries and the run's hosts, and sends the secret", async () => {
    const sandbox = new RemoteAgentOsSandbox("run-1", { url, secret: SECRET }, egress(["api.example.com"]));
    const result = await sandbox.exec("echo hi", { env: { A: "1" }, timeoutMs: 5000 });
    expect(result).toEqual({ stdout: "echo hi 1 5000", stderr: "", exitCode: 3 });
    await sandbox.exec("true");
    const puts = stub.calls.filter((c) => c.method === "PUT" && c.path === "/vms/run-1");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]?.body ?? "")).toEqual({
      hosts: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.example.com"],
    });
    expect(stub.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
    await sandbox.destroy();
    expect(stub.vms.has("run-1")).toBe(false);
  });

  it("moves files in and out, bytes that aren't text too", async () => {
    const sandbox = new RemoteAgentOsSandbox("run-2", { url, secret: SECRET }, []);
    const data = new Uint8Array(70_000).map((_, i) => i % 256);
    await sandbox.writeFile("out/data.bin", data);
    expect(Buffer.from(await sandbox.readFile("out/data.bin")).equals(Buffer.from(data))).toBe(true);
    await sandbox.writeFile("a b.txt", "hallo");
    expect(Buffer.from(await sandbox.readFile("a b.txt")).toString()).toBe("hallo");
    await expect(sandbox.readFile("missing.txt")).rejects.toThrow("No file /workspace/missing.txt.");
    await sandbox.destroy();
  });

  it("makes the VM again, empty, when the container no longer has it", async () => {
    const sandbox = new RemoteAgentOsSandbox("run-3", { url, secret: SECRET }, []);
    await sandbox.writeFile("x.txt", "1");
    stub.vms.delete("run-3");
    expect((await sandbox.exec("ls")).exitCode).toBe(3);
    expect(stub.vms.has("run-3")).toBe(true);
    await sandbox.destroy();
  });

  it("says when the container is full or refuses the secret, and tries again on the next call", async () => {
    stub.setFull(true);
    const sandbox = new RemoteAgentOsSandbox("run-4", { url, secret: SECRET }, []);
    await expect(sandbox.exec("ls")).rejects.toThrow("The sandbox is full right now");
    stub.setFull(false);
    expect((await sandbox.exec("ls")).exitCode).toBe(3);
    await sandbox.destroy();

    const wrong = new RemoteAgentOsSandbox("run-5", { url, secret: "wrong" }, []);
    await expect(wrong.exec("ls")).rejects.toThrow("The sandbox answered 401.");
    const gone = new RemoteAgentOsSandbox("run-6", { url: "http://127.0.0.1:1", secret: SECRET }, []);
    await expect(gone.exec("ls")).rejects.toThrow("The sandbox doesn’t answer");
  });

  it("destroys nothing when it never made a VM", async () => {
    const before = stub.calls.length;
    await new RemoteAgentOsSandbox("run-7", { url, secret: SECRET }, []).destroy();
    expect(stub.calls.length).toBe(before);
  });
});

function fakeEngine(name: string, ready: boolean): SandboxEngine {
  return {
    name,
    ready: () => ready,
    capabilities: () => ({ commands: [], network: "none", uses: "", workdir: "/w" }),
    create: () => {
      throw new Error("not in this test");
    },
  };
}

describe("a guest's engine", () => {
  it("may be the sandbox container, when it is set up", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(pickGuestEngine([fakeEngine("agentos-remote", true)], "agentos-remote")?.name).toBe(
      "agentos-remote",
    );
    expect(pickGuestEngine([fakeEngine("agentos-remote", false)], "agentos-remote")).toBeNull();
    expect(pickGuestEngine([fakeEngine("docker", true)], "docker")).toBeNull();
  });
});
