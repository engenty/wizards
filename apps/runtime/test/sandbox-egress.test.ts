import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_REGISTRIES, type SandboxEgress } from "../src/sandbox";
import { AgentOsSandbox, agentOsHosts, stopAgentOs } from "../src/sandbox/agentos";
import { DOCKER_CAPABILITIES, dockerCapabilities, dockerSandbox } from "../src/sandbox/docker";
import { engineDir, installedVersion } from "../src/sandbox/install";

/**
 * A run's sandbox reaches outside by the broker's rule (docs/plans/broker.md): agentOS gets the
 * run's hosts when its VM starts, a Docker container sends every connection through the runtime,
 * which asks the broker. Here a stand-in for the broker allows a few hosts and keeps what it was
 * asked; broker/host.ts's own rule is in ways-out.test.ts.
 */

function egressOf(allowed: string[], everyPublicHost = false) {
  const asked: { host: string; allowed: boolean }[] = [];
  const egress: SandboxEgress = {
    hosts: async () => ({ hosts: allowed, everyPublicHost }),
    open: async (host, connect) => {
      const ok = everyPublicHost || allowed.includes(host) || PACKAGE_REGISTRIES.includes(host);
      asked.push({ host, allowed: ok });
      return ok ? connect() : null;
    },
  };
  return { egress, asked };
}

describe("what a run's sandbox is told it reaches", () => {
  it("names only the run's hosts for agentOS where the broker binds the run", () => {
    expect(agentOsHosts({ hosts: ["api.example.com"], everyPublicHost: false })).toEqual([
      "api.example.com",
    ]);
  });

  it("keeps Docker's open internet until the switch is on, then names the run's hosts", () => {
    const run = { hosts: ["api.example.com"], everyPublicHost: false };
    expect(dockerCapabilities(run)).toBe(DOCKER_CAPABILITIES);
    process.env.FEATURES = "dockerEgress=on";
    try {
      expect(dockerCapabilities(run).network).toBe(
        "only the npm and PyPI registries and api.example.com",
      );
      expect(dockerCapabilities({ hosts: [], everyPublicHost: false }).network).toBe(
        "none, except the npm and PyPI registries",
      );
      expect(dockerCapabilities({ hosts: [], everyPublicHost: true }).network).toContain(
        "the public internet",
      );
      expect(dockerCapabilities()).toBe(DOCKER_CAPABILITIES);
    } finally {
      delete process.env.FEATURES;
    }
  });
});

function dockerImage(): string | null {
  const image = process.env.SANDBOX_IMAGE || "engenty-sandbox:latest";
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
    return image;
  } catch {
    return null;
  }
}

const image = dockerImage();
const status = (url: string, extra = "") =>
  `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${extra} ${url}`;

describe.skipIf(!image)("a Docker sandbox through the broker", () => {
  const { egress, asked } = egressOf(["example.com"]);
  let sandbox: ReturnType<typeof dockerSandbox>;
  let host: Server;
  let hostPort = 0;

  beforeAll(async () => {
    process.env.FEATURES = "dockerEgress=on";
    host = createServer((_, res) => res.end("host-only")).listen(0, "127.0.0.1");
    await new Promise((resolve) => host.once("listening", resolve));
    hostPort = (host.address() as AddressInfo).port;
    sandbox = dockerSandbox(`egress${Date.now()}`, image ?? "", egress);
  });

  afterAll(async () => {
    await sandbox.destroy();
    host.close();
    delete process.env.FEATURES;
  }, 60_000);

  it("reaches a host the broker allows, over HTTPS and plain HTTP", async () => {
    expect((await sandbox.exec(status("https://example.com/"))).stdout).toBe("200");
    expect((await sandbox.exec(status("http://example.com/"))).stdout).toBe("200");
    expect(asked).toContainEqual({ host: "example.com", allowed: true });
  }, 180_000);

  it("reaches the package registries", async () => {
    const pip = await sandbox.exec("pip download --no-deps -q -d /tmp/pkgs six && ls /tmp/pkgs");
    expect(pip.stdout + pip.stderr).toContain("six-");
    const npm = await sandbox.exec("cd /tmp && npm view left-pad version");
    expect(npm.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 180_000);

  it("reaches no host the broker refuses, and the broker hears of it", async () => {
    const https = await sandbox.exec(status("https://www.wikipedia.org/"));
    expect(https.stdout).not.toBe("200");
    expect((await sandbox.exec(status("http://neverssl.com/"))).stdout).toBe("403");
    expect(asked).toContainEqual({ host: "www.wikipedia.org", allowed: false });
    expect(asked).toContainEqual({ host: "neverssl.com", allowed: false });
  }, 60_000);

  it("has no way out past the proxy: no direct connection, no name lookup", async () => {
    const direct = await sandbox.exec(status("https://example.com/", "--noproxy '*'"));
    expect(direct.stdout).not.toBe("200");
    const lookup = await sandbox.exec(
      `node -e 'require("dns").lookup("example.com", (e, a) => console.log(e ? "no" : a))'`,
    );
    expect(lookup.stdout.trim()).toBe("no");
  }, 60_000);

  it("never reaches this computer, even where the broker would allow any host", async () => {
    const open = egressOf([], true);
    const other = dockerSandbox(`egressopen${Date.now()}`, image ?? "", open.egress);
    try {
      const loopback = await other.exec(`curl -sS -m 10 http://127.0.0.1:${hostPort}/`);
      expect(loopback.stdout).not.toContain("host-only");
      const named = await other.exec(`curl -sS -m 10 http://host.docker.internal:${hostPort}/`);
      expect(named.stdout).not.toContain("host-only");
      expect((await other.exec(status("https://example.com/"))).stdout).toBe("200");
    } finally {
      await other.destroy();
    }
  }, 180_000);
});

const agentOsDir = engineDir("agentos");

describe.skipIf(!installedVersion(agentOsDir))("an agentOS sandbox with the run's hosts", () => {
  const { egress } = egressOf(["example.com", "*.wikipedia.org"]);
  const sandbox = new AgentOsSandbox(agentOsDir, egress);
  // agentOS's curl opens no connection at all (getsockname fails); its Node does.
  const fetched = async (url: string) =>
    (
      await sandbox.exec(
        `node -e 'fetch("${url}", { signal: AbortSignal.timeout(8000) }).then((r) => console.log(r.status), (e) => console.log(e.cause?.code ?? e.name))'`,
      )
    ).stdout.trim();

  afterAll(async () => {
    await sandbox.destroy();
    await stopAgentOs();
  }, 60_000);

  it("reaches the run's hosts, what is below a wildcard among them, and no other", async () => {
    expect(await fetched("https://example.com/")).toBe("200");
    expect(await fetched("https://de.wikipedia.org/")).toBe("200");
    expect(await fetched("https://www.google.com/")).toBe("EACCES");
  }, 180_000);
});
