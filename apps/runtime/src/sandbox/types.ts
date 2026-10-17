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
  capabilities(): SandboxCapabilities;
  create(runId: string): Sandbox;
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
