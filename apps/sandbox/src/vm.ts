/** What one run's machine does for the API (server.ts). agentos.ts makes them with agentOS. */
export interface Vm {
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Relative paths are taken from the working directory; missing folders are made. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Throws `NotFound` when there is no such file. */
  readFile(path: string): Promise<Uint8Array>;
  /** Throws `NotFound` when there is no such folder. */
  list(path: string): Promise<DirEntry[]>;
  dispose(): Promise<void>;
}

/** Makes a VM that reaches exactly these hosts (`networkPolicy`). */
export type MakeVm = (hosts: readonly string[]) => Promise<Vm>;

export interface ExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export class NotFound extends Error {}

/**
 * Names that resolve to the machine or its private networks: Docker's `host.docker.internal`,
 * mDNS, reverse lookups. A host the runner sends must be a public DNS name.
 */
const PRIVATE_SUFFIXES = ["localhost", "internal", "local", "lan", "home", "arpa", "intranet"];

/**
 * A public DNS name, `*.` allowed in front: two labels at least, the last one starting with a
 * letter. That leaves out IP addresses, `localhost` and a container's name on its network.
 */
const HOST =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function publicHost(host: string): boolean {
  if (host.length > 253 || !HOST.test(host)) {
    return false;
  }
  const last = host.slice(host.lastIndexOf(".") + 1);
  return !PRIVATE_SUFFIXES.includes(last);
}

/**
 * agentOS's network permission for a VM: everything refused but DNS and HTTPS to the hosts the
 * runner sent (the npm and PyPI registries and the run's grant). Loopback, the container's
 * networks and 169.254.169.254 stay refused.
 */
export function networkPolicy(hosts: readonly string[]) {
  const patterns = hosts.flatMap((host) => [`dns://${host}`, `tcp://${host}:443`]);
  return {
    default: "deny" as const,
    rules: patterns.length ? [{ mode: "allow" as const, operations: ["*"], patterns }] : [],
  };
}
