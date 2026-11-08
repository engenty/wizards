export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** What an engine really runs. The agent's tool descriptions are written from this. */
export interface SandboxCapabilities {
  /** Programs the shell finds on its PATH. */
  commands: readonly string[];
  /** What the sandbox reaches over the network, as told to the agent. */
  network: string;
  /** What else the agent must know to use it, such as how Python packages get in. */
  notes?: string;
  /** What the sandbox is good for, as told to whoever authors a wizard. */
  uses: string;
  workdir: string;
}

/** Where npm and Python packages come from: every sandbox of a run reaches them. */
export const PACKAGE_REGISTRIES: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];

/** What a run's sandbox may reach besides the registries (broker/host.ts, `runHosts`). */
export interface RunHosts {
  hosts: readonly string[];
  /** A member's run while the `broker` switch is off. */
  everyPublicHost: boolean;
}

/**
 * A run's way out, decided by the broker: an engine that takes a list (agentOS) asks `hosts`
 * once when the machine starts, one that sends every connection through the runtime (Docker)
 * asks `open` for each. A Work chat's sandbox has none and keeps the server's rule.
 */
export interface SandboxEgress {
  hosts(): Promise<RunHosts>;
  /**
   * Opens a connection to `host` with `connect` when the broker allows it, and logs it. Null
   * when it is refused: the host is not the run's, or the run is over.
   */
  open<T>(host: string, connect: () => Promise<T>): Promise<T | null>;
}

/**
 * A way to run sandboxes: Docker, agentOS, a hosted one. The engines are listed in index.ts;
 * one whose code is not part of engenty wizards installs it with `wizards sandbox add <name>`
 * (install.ts) and loads it from there.
 */
export interface SandboxEngine {
  /** What `SANDBOX` names it. Lower case. */
  readonly name: string;
  /**
   * Whether it can run here without being asked for: the image is there, the package is
   * installed. Without `SANDBOX` the first engine that is ready runs the sandboxes.
   */
  ready(): boolean;
  /** With a run's hosts: what that run's sandbox reaches; without: the server's rule. */
  capabilities(run?: RunHosts): SandboxCapabilities;
  create(runId: string, egress?: SandboxEgress): Sandbox;
}

/** The private machine of one run: made on the first tool call, destroyed when the run stops. */
export interface Sandbox {
  readonly capabilities: SandboxCapabilities;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Relative paths are taken from the working directory. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  destroy(): Promise<void>;
}
