import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { env } from "../env.js";
import {
  AGENTOS_CORE,
  AGENTOS_EXTRA_COMMANDS,
  agentOsExtras,
  agentOsSidecar,
} from "./agentos-package.js";
import { importFromEngine, installedVersion } from "./install.js";
import {
  type ExecOptions,
  type ExecResult,
  PACKAGE_REGISTRIES,
  type RunHosts,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxEgress,
  type SandboxEngine,
} from "./types.js";

const WORKDIR = "/workspace";
const EXEC_TIMEOUT_MS = 120_000;
/**
 * Python starts in $HOME, whatever directory the shell is in. Before each command, `python3`
 * becomes a function that hands it the shell's directory as HOME.
 */
const PYTHON_FOLLOWS_CD =
  'python3() { HOME="$PWD" command python3 "$@"; }; python() { python3 "$@"; }\n';

/**
 * The hosts a VM reaches besides the registries. A run's: its grant's, and the server's
 * (`SANDBOX_ALLOW_HOSTS`) too where it may reach every public host. A Work chat's: the server's.
 */
export function agentOsHosts(run?: RunHosts): readonly string[] {
  if (!run) {
    return env.sandboxHosts;
  }
  return run.everyPublicHost ? [...new Set([...run.hosts, ...env.sandboxHosts])] : run.hosts;
}

/**
 * What an agentOS VM runs: a Linux userland compiled to WebAssembly (bash, coreutils and the
 * extra programs the install packs), Node in a V8 isolate and Python 3.13 as Pyodide. No native
 * programs: no ffmpeg, ImageMagick or LibreOffice.
 */
export function agentOsCapabilities(hosts: readonly string[] = []): SandboxCapabilities {
  return {
    commands: [
      "bash",
      "ls",
      "cat",
      "head",
      "sort",
      "grep",
      "sed",
      "awk",
      "find",
      "diff",
      "tar",
      "gzip",
      ...AGENTOS_EXTRA_COMMANDS,
      "node",
      "npm",
      "python3",
    ],
    network: hosts.length
      ? `only the npm and PyPI registries and ${hosts.join(", ")}`
      : "none, except the npm and PyPI registries",
    notes:
      "python3 is Pyodide: numpy and pandas load offline; install other pure-Python packages with " +
      `python3 -c "import micropip; await micropip.install('openpyxl')" (no pip command, no ` +
      "pillow, matplotlib or scipy). node runs JavaScript, not TypeScript.",
    uses: "calculations, tables or file conversion",
    workdir: WORKDIR,
  };
}

/** The part of agentOS's API the engine uses; its types are not installed with the workspace. */
interface AgentOsResult {
  outcome: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message: string };
}
interface AgentOsVm {
  process: {
    exec(command: string, options: Record<string, unknown>): Promise<AgentOsResult>;
  };
  filesystem: {
    mkdir(path: string, options: { recursive: boolean }): Promise<void>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
  };
  dispose(): Promise<void>;
}
interface AgentOsSidecar {
  dispose(): Promise<void>;
}
interface AgentOsModule {
  AgentOs: {
    createSidecar(): Promise<AgentOsSidecar>;
    create(options: Record<string, unknown>): Promise<AgentOsVm>;
  };
}

interface Runtime {
  agentOs: AgentOsModule["AgentOs"];
  sidecar: AgentOsSidecar;
}

let runtime: Promise<Runtime> | null = null;

/** One native helper process hosts the VMs of every run; the first sandbox starts it. */
function agentOsRuntime(dir: string): Promise<Runtime> {
  runtime ??= (async () => {
    // agentOS reads the helper's path from the environment when it starts the helper.
    if (!process.env.AGENTOS_SIDECAR_BIN && existsSync(agentOsSidecar(dir))) {
      process.env.AGENTOS_SIDECAR_BIN = agentOsSidecar(dir);
    }
    const mod = (await importFromEngine("agentos", dir, AGENTOS_CORE)) as AgentOsModule;
    return { agentOs: mod.AgentOs, sidecar: await mod.AgentOs.createSidecar() };
  })().catch((err) => {
    runtime = null;
    throw err;
  });
  return runtime;
}

/** Stops the helper process. The next sandbox starts a new one. */
export async function stopAgentOs(): Promise<void> {
  const current = runtime;
  runtime = null;
  await (await current?.catch(() => null))?.sidecar.dispose();
}

function toResult(result: AgentOsResult): ExecResult {
  const stdout = result.stdout ?? "";
  let stderr = result.stderr ?? "";
  if (result.outcome === "timed_out") {
    stderr = `${stderr}\ntimed out`.trim();
  } else if (result.outcome !== "succeeded" && !stdout && !stderr) {
    stderr = result.error?.message ?? result.outcome;
  }
  return { exitCode: result.exitCode ?? (result.outcome === "succeeded" ? 0 : 1), stdout, stderr };
}

/** Where `wizards sandbox add agentos` put it. */
export const agentOsDir = () => join(env.sandboxEngines, "agentos");

/** Ready once `wizards sandbox add agentos` installed it. */
export const agentOsEngine: SandboxEngine = {
  name: "agentos",
  ready: () => installedVersion(agentOsDir()) !== null,
  capabilities: (run) => agentOsCapabilities(agentOsHosts(run)),
  create: (_runId, egress) => new AgentOsSandbox(agentOsDir(), egress),
};

/**
 * One agentOS VM per run, in the server's helper process: no Docker, no container. A run's VM
 * reaches the hosts the broker gives it when it starts; a list instead of an egress (a Work chat,
 * a test) is taken as it is.
 */
export class AgentOsSandbox implements Sandbox {
  readonly capabilities: SandboxCapabilities;
  private machine: Promise<AgentOsVm> | null = null;

  constructor(
    private readonly dir: string = agentOsDir(),
    private readonly egress: SandboxEgress | readonly string[] = env.sandboxHosts,
  ) {
    this.capabilities = agentOsCapabilities(Array.isArray(egress) ? egress : []);
  }

  private async hosts(): Promise<readonly string[]> {
    const egress = this.egress;
    return Array.isArray(egress) ? egress : agentOsHosts(await (egress as SandboxEgress).hosts());
  }

  private vm(): Promise<AgentOsVm> {
    this.machine ??= (async () => {
      const hosts = await this.hosts();
      const { agentOs, sidecar } = await agentOsRuntime(this.dir);
      const vm = await agentOs.create({
        sidecar: { kind: "explicit", handle: sidecar },
        software: [{ packagePath: agentOsExtras(this.dir) }],
        // Anything not listed is refused, the host's own loopback and private networks included.
        permissions: {
          fs: "allow",
          childProcess: "allow",
          process: "allow",
          env: "allow",
          network: {
            default: "deny",
            rules: [
              {
                mode: "allow",
                operations: ["*"],
                patterns: [...PACKAGE_REGISTRIES, ...hosts].flatMap((host) => [
                  `dns://${host}`,
                  `tcp://${host}:443`,
                ]),
              },
            ],
          },
        },
      });
      await vm.filesystem.mkdir(WORKDIR, { recursive: true });
      return vm;
    })();
    this.machine.catch(() => {
      this.machine = null;
    });
    return this.machine;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const vm = await this.vm();
    return toResult(
      await vm.process.exec(PYTHON_FOLLOWS_CD + command, {
        cwd: options.cwd ?? WORKDIR,
        env: { HOME: WORKDIR, ...options.env },
        timeoutMs: options.timeoutMs ?? EXEC_TIMEOUT_MS,
        output: { capture: "all" },
      }),
    );
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const vm = await this.vm();
    const target = posix.resolve(WORKDIR, path);
    await vm.filesystem.mkdir(posix.dirname(target), { recursive: true });
    await vm.filesystem.writeFile(target, data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const vm = await this.vm();
    return vm.filesystem.readFile(posix.resolve(WORKDIR, path));
  }

  async destroy(): Promise<void> {
    const machine = this.machine;
    this.machine = null;
    await (await machine?.catch(() => null))?.dispose();
  }
}
