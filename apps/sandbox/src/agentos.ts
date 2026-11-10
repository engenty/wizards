import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExecResult, type MakeVm, NotFound, networkPolicy, type Vm } from "./vm.ts";

/**
 * agentOS's VMs for the API. The VM is set up as the runtime's in-process engine sets up its own
 * (apps/runtime/src/sandbox/agentos.ts): the same working directory, extra programs and Python
 * fix, so a wizard's step runs alike on both.
 */

const WORKDIR = "/workspace";
/**
 * Python starts in $HOME, whatever directory the shell is in. Before each command, `python3`
 * becomes a function that hands it the shell's directory as HOME.
 */
const PYTHON_FOLLOWS_CD =
  'python3() { HOME="$PWD" command python3 "$@"; }; python() { python3 "$@"; }\n';

/** The part of agentOS's API used here; its types are not installed with the workspace. */
interface AgentOsResult {
  outcome: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message: string };
}
interface AgentOsVm {
  process: { exec(command: string, options: Record<string, unknown>): Promise<AgentOsResult> };
  filesystem: {
    mkdir(path: string, options: { recursive: boolean }): Promise<void>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ isDirectory: boolean }>;
    readdirEntries(
      path: string,
    ): Promise<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }[]>;
  };
  dispose(): Promise<void>;
}
interface AgentOsSidecar {
  dispose(): Promise<void>;
}
interface AgentOsModule {
  AgentOs: {
    createSidecar(options: Record<string, unknown>): Promise<AgentOsSidecar>;
    create(options: Record<string, unknown>): Promise<AgentOsVm>;
  };
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

function wrap(vm: AgentOsVm): Vm {
  const at = (path: string) => posix.resolve(WORKDIR, path);
  return {
    async exec({ command, cwd, env, timeoutMs }) {
      return toResult(
        await vm.process.exec(PYTHON_FOLLOWS_CD + command, {
          cwd: cwd ? at(cwd) : WORKDIR,
          env: { HOME: WORKDIR, ...env },
          timeoutMs,
          output: { capture: "all" },
        }),
      );
    },
    async writeFile(path, data) {
      const target = at(path);
      await vm.filesystem.mkdir(posix.dirname(target), { recursive: true });
      await vm.filesystem.writeFile(target, data);
    },
    async readFile(path) {
      const target = at(path);
      if (!(await vm.filesystem.exists(target)) || (await vm.filesystem.stat(target)).isDirectory) {
        throw new NotFound(`No file ${target}.`);
      }
      return vm.filesystem.readFile(target);
    },
    async list(path) {
      const target = at(path);
      if (!(await vm.filesystem.exists(target)) || !(await vm.filesystem.stat(target)).isDirectory) {
        throw new NotFound(`No folder ${target}.`);
      }
      return (await vm.filesystem.readdirEntries(target)).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : "file",
      }));
    },
    dispose: () => vm.dispose(),
  };
}

/**
 * agentOS stops a Node script after 30 s of CPU time and Python after 5 minutes: the command's
 * longest time is the limit instead. Python keeps a budget of 30 s CPU time that no option of
 * agentOS 0.4.7 raises (its Pyodide runner leaves `jsRuntime` out); importing pandas takes a few.
 */
export const execLimits = (maxExecMs: number) => ({
  jsRuntime: { cpuTimeLimitMs: maxExecMs, wallClockLimitMs: maxExecMs },
  python: { executionTimeoutMs: maxExecMs },
});

/**
 * Starts agentOS's helper from the folder the runtime's installer filled
 * (apps/runtime/src/sandbox/install.ts, `agentos`) and makes VMs on it. No mounts, no host
 * functions: a VM sees its own memory file system and the network its policy lets through.
 */
export async function agentOsVms(
  dir: string,
  maxVms: number,
  maxExecMs: number,
): Promise<{ makeVm: MakeVm; stop(): Promise<void> }> {
  const sidecarBin = join(dir, "sidecar.sh");
  // agentOS reads the helper's path from the environment when it starts the helper.
  if (!process.env.AGENTOS_SIDECAR_BIN && existsSync(sidecarBin)) {
    process.env.AGENTOS_SIDECAR_BIN = sidecarBin;
  }
  const core = join(dir, "node_modules", "@rivet-dev", "agentos-core", "dist", "index.js");
  const { AgentOs } = (await import(pathToFileURL(core).href)) as AgentOsModule;
  const sidecar = await AgentOs.createSidecar({ runtime: { executor: { maxActiveVms: maxVms } } });
  const extras = join(dir, "extras");
  return {
    async makeVm(hosts) {
      const vm = await AgentOs.create({
        sidecar: { kind: "explicit", handle: sidecar },
        software: [{ packagePath: extras }],
        permissions: {
          fs: "allow",
          childProcess: "allow",
          process: "allow",
          env: "allow",
          network: networkPolicy(hosts),
        },
        limits: execLimits(maxExecMs),
      });
      await vm.filesystem.mkdir(WORKDIR, { recursive: true });
      return wrap(vm);
    },
    stop: () => sidecar.dispose(),
  };
}
