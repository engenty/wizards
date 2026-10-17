import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickEngine, type SandboxEngine, shellToolDescription } from "../src/sandbox";
import { AgentOsSandbox, agentOsCapabilities, stopAgentOs } from "../src/sandbox/agentos";
import { DOCKER_CAPABILITIES, dockerSandbox } from "../src/sandbox/docker";
import {
  ENGINE_PACKAGES,
  engineDir,
  installedVersion,
  installEngine,
  packageEntry,
} from "../src/sandbox/install";
import { MastraRunSandbox } from "../src/sandbox/mastra";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

function dockerImage(): string | null {
  const image = process.env.SANDBOX_IMAGE || "engenty-sandbox:latest";
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
    return image;
  } catch {
    return null;
  }
}

describe("tool descriptions", () => {
  it("promise what the engine runs", () => {
    expect(shellToolDescription(DOCKER_CAPABILITIES)).toContain("python3");
    const agentOs = shellToolDescription(agentOsCapabilities());
    expect(agentOs).toContain("python3");
    expect(agentOs).toContain("micropip");
    expect(agentOs).toContain("none, except the npm and PyPI registries");
    expect(shellToolDescription(agentOsCapabilities(["api.example.com"]))).toContain(
      "only the npm and PyPI registries and api.example.com",
    );
  });
});

function fakeEngine(name: string, ready: boolean): SandboxEngine {
  return {
    name,
    ready: () => ready,
    capabilities: () => DOCKER_CAPABILITIES,
    create: () => {
      throw new Error("not in this test");
    },
  };
}

describe("picking the engine", () => {
  const engines = [fakeEngine("docker", false), fakeEngine("agentos", true), fakeEngine("e2b", true)];

  it("takes the first ready one when SANDBOX names none", () => {
    expect(pickEngine(engines, "")?.name).toBe("agentos");
    expect(pickEngine([fakeEngine("docker", false)], "")).toBeNull();
  });

  it("takes the one SANDBOX names, ready or not, and none for off or a name it doesn't know", () => {
    expect(pickEngine(engines, "docker")?.name).toBe("docker");
    expect(pickEngine(engines, "off")).toBeNull();
    expect(pickEngine(engines, "nope")).toBeNull();
  });
});

/** A Mastra sandbox that runs the commands on this machine's shell, as a provider would. */
function shellProvider(calls: string[]): WorkspaceSandbox {
  return {
    id: "fake",
    name: "Fake",
    provider: "fake",
    status: "pending",
    snapshot: async () => {},
    start: async () => {
      calls.push("start");
    },
    destroy: async () => {
      calls.push("destroy");
    },
    executeCommand: async (command, _args, options) => {
      calls.push(command.slice(0, 20));
      if (command === "sleep") {
        return { success: false, exitCode: 124, stdout: "", stderr: "", executionTimeMs: 1, timedOut: true };
      }
      try {
        const stdout = execFileSync("bash", ["-c", command], {
          cwd: options?.cwd,
          env: { ...process.env, ...options?.env },
          encoding: "utf8",
        });
        return { success: true, exitCode: 0, stdout, stderr: "", executionTimeMs: 1 };
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return { success: false, exitCode: e.status, stdout: "", stderr: String(e.stderr), executionTimeMs: 1 };
      }
    },
  } as WorkspaceSandbox;
}

describe("a Mastra sandbox as a run's sandbox", () => {
  let workdir: string;
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "mastra-sandbox-"));
  });
  afterAll(() => rmSync(workdir, { recursive: true, force: true }));

  it("starts the provider once and passes the files through the shell", async () => {
    const calls: string[] = [];
    const sandbox = new MastraRunSandbox({ ...DOCKER_CAPABILITIES, workdir }, () =>
      shellProvider(calls),
    );
    // More than one chunk, and bytes that aren't text.
    const data = new Uint8Array(100_000).map((_, i) => i % 256);
    await sandbox.writeFile("out/data.bin", data);
    expect(Buffer.from(await sandbox.readFile("out/data.bin")).equals(Buffer.from(data))).toBe(true);
    expect((await sandbox.exec("echo $X", { env: { X: "set" } })).stdout).toBe("set\n");
    expect((await sandbox.exec("exit 3")).exitCode).toBe(3);
    expect((await sandbox.exec("sleep")).stderr).toBe("timed out");
    await sandbox.destroy();
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
    expect(calls.at(-1)).toBe("destroy");
  });

  it("tries again after the provider failed to come up", async () => {
    let attempts = 0;
    const sandbox = new MastraRunSandbox({ ...DOCKER_CAPABILITIES, workdir }, () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("no Docker");
      }
      return shellProvider([]);
    });
    await expect(sandbox.exec("true")).rejects.toThrow("no Docker");
    expect((await sandbox.exec("echo ok")).stdout).toBe("ok\n");
  });
});

describe("installing an engine", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engines-"));
    ENGINE_PACKAGES.fake = {
      label: "Fake",
      version: "1.2.3",
      packages: ["fake-engine@1.2.3"],
      size: "1 KB",
      prepare: (into) => execFileSync("touch", [join(into, "prepared")]),
    };
  });
  afterAll(() => {
    delete ENGINE_PACKAGES.fake;
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the packages with npm, prepares them and marks the folder last", async () => {
    const args: string[][] = [];
    const version = await installEngine("fake", join(dir, "fake"), async (a) => {
      args.push(a);
      return { code: 0, tail: "" };
    });
    expect(version).toBe("1.2.3");
    expect(args[0]).toContain("fake-engine@1.2.3");
    expect(args[0]).toContain("--ignore-scripts");
    expect(installedVersion(join(dir, "fake"))).toBe("1.2.3");
    expect(execFileSync("ls", [join(dir, "fake")], { encoding: "utf8" })).toContain("prepared");
  });

  it("finds a package's entry for import, through nested conditions too", () => {
    const pkg = (name: string, manifest: object) => {
      mkdirSync(join(dir, "pkgs", "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "pkgs", "node_modules", name, "package.json"), JSON.stringify(manifest));
      return packageEntry(join(dir, "pkgs"), name).slice(join(dir, "pkgs", "node_modules", name).length);
    };
    // As @mastra/e2b has it.
    expect(
      pkg("nested", {
        exports: {
          ".": {
            import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
            require: { default: "./dist/index.cjs" },
          },
        },
      }),
    ).toBe("/dist/index.js");
    expect(pkg("flat", { exports: { import: "./esm.js", require: "./cjs.cjs" } })).toBe("/esm.js");
    expect(pkg("plain", { exports: "./main.js" })).toBe("/main.js");
    expect(pkg("old", { main: "lib/old.js" })).toBe("/lib/old.js");
  });

  it("leaves no marker when npm fails, and knows only its engines", async () => {
    await expect(
      installEngine("fake", join(dir, "broken"), async () => ({ code: 1, tail: "E404 not found" })),
    ).rejects.toThrow("E404 not found");
    expect(installedVersion(join(dir, "broken"))).toBeNull();
    await expect(installEngine("nope", join(dir, "nope"), async () => ({ code: 0, tail: "" }))).rejects.toThrow(
      /no engine “nope”/,
    );
  });
});

/** Installed with `wizards sandbox add`, or `node …/install.js agentos` with SANDBOX_ENGINES_DIR. */
const agentOsDir = engineDir("agentos");

describe.skipIf(!installedVersion(agentOsDir))("agentOS sandbox", () => {
  let sandbox: AgentOsSandbox;
  let host: Server;
  let hostUrl: string;

  beforeAll(async () => {
    host = createServer((_, res) => res.end("host-only")).listen(0, "127.0.0.1");
    await new Promise((resolve) => host.once("listening", resolve));
    hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`;
    process.env.SANDBOX_TEST_SECRET = "host-secret";
    sandbox = new AgentOsSandbox(agentOsDir, []);
  });

  afterAll(async () => {
    await sandbox.destroy();
    await stopAgentOs();
    host.close();
  }, 60_000);

  it("runs a shell command in its working directory", async () => {
    const result = await sandbox.exec(
      "pwd && printf 'b\\na\\n' > list.txt && sort list.txt | head -1 && echo $GREETING",
      { env: { GREETING: "hallo" } },
    );
    expect(result).toEqual({ exitCode: 0, stdout: "/workspace\na\nhallo\n", stderr: "" });
  }, 120_000);

  it("runs every command it promises", async () => {
    const result = await sandbox.exec(`which ${sandbox.capabilities.commands.join(" ")}`);
    expect(result.stdout.trim().split("\n")).toHaveLength(sandbox.capabilities.commands.length);
    expect(result.exitCode).toBe(0);
    expect((await sandbox.exec("node -e 'console.log(6 * 7)'")).stdout).toBe("42\n");
    expect((await sandbox.exec(`echo '{"a":[1,2,3]}' | jq '.a | add'`)).stdout).toBe("6\n");
    expect((await sandbox.exec("sqlite3 :memory: 'select 6 * 7'")).stdout).toBe("42\n");
  }, 120_000);

  it("runs Python from the shell and shares its files with the host", async () => {
    await sandbox.writeFile("in/data.csv", "a,b\n1,2\n3,4\n");
    const python = await sandbox.exec(
      `cd in && python3 -c "import pandas; d = pandas.read_csv('data.csv'); open('../out.txt', 'w').write(str(d.b.sum())); print('done')"`,
    );
    expect(python).toMatchObject({ exitCode: 0, stdout: "done\n" });
    expect(text(await sandbox.readFile("out.txt"))).toBe("6");

    const failed = await sandbox.exec("python3 -c \"raise ValueError('boom')\"");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("ValueError: boom");
    await expect(sandbox.readFile("missing.txt")).rejects.toThrow();
  }, 180_000);

  it("kills a command that outlives its timeout", async () => {
    const result = await sandbox.exec("while true; do :; done", { timeoutMs: 3000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timed out");
    expect((await sandbox.exec("echo alive")).stdout).toBe("alive\n");
  }, 120_000);

  it("sees neither the host's files and environment nor its loopback", async () => {
    const files = await sandbox.exec(`ls ${process.cwd()} /Users; echo "[$SANDBOX_TEST_SECRET]"`);
    expect(files.stdout).toBe("[]\n");
    expect((await sandbox.exec("env")).stdout).not.toContain("host-secret");

    const fromNode = await sandbox.exec(
      `node -e 'fetch("${hostUrl}").then(async (r) => console.log("reached", await r.text()), (e) => console.log("blocked", e.cause?.code))'`,
    );
    expect(fromNode.stdout).toBe("blocked EACCES\n");
    const fromCurl = await sandbox.exec(`curl -sS -m 5 ${hostUrl}`);
    expect(fromCurl.exitCode).not.toBe(0);
    expect(fromCurl.stdout).not.toContain("host-only");
  }, 180_000);
});

const image = dockerImage();

describe.skipIf(!image)("Docker sandbox", () => {
  const sandbox = dockerSandbox(`test${Date.now()}`, image ?? "");

  afterAll(() => sandbox.destroy(), 60_000);

  it("runs shell and Python and moves files in and out", async () => {
    const which = await sandbox.exec(`which ${DOCKER_CAPABILITIES.commands.join(" ")}`);
    expect(which.exitCode).toBe(0);

    const python = await sandbox.exec(
      `python3 -c "open('out.txt', 'w').write('from python'); print(6 * 7)"`,
    );
    expect(python).toMatchObject({ exitCode: 0, stdout: "42\n" });
    expect(text(await sandbox.readFile("out.txt"))).toBe("from python");

    const big = "zeile 'eins'\n".repeat(20_000);
    await sandbox.writeFile("in/big.txt", big);
    expect((await sandbox.exec("wc -c < in/big.txt")).stdout.trim()).toBe(String(big.length));
    await expect(sandbox.readFile("missing.txt")).rejects.toThrow();
  }, 180_000);
});
