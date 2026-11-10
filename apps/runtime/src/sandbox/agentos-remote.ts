import { env } from "../env.js";
import { agentOsCapabilities, agentOsHosts } from "./agentos.js";
import {
  type ExecOptions,
  type ExecResult,
  PACKAGE_REGISTRIES,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxEgress,
  type SandboxEngine,
} from "./types.js";

const EXEC_TIMEOUT_MS = 120_000;
/** What a request may take beyond the command's own time: making the VM, the way there and back. */
const REQUEST_MARGIN_MS = 60_000;

/** Where the sandbox container answers, and the secret both sides share. */
export interface SandboxService {
  url: string;
  secret: string;
}

class SandboxAnswer extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The cloud's sandbox: agentOS in a container of its own (deploy/Dockerfile.sandbox,
 * apps/sandbox), one VM per run, reached over HTTP. What a VM runs is what the in-process engine
 * runs. Picked with `SANDBOX=agentos-remote`, `SANDBOX_URL` and `SANDBOX_SECRET`.
 */
export const agentOsRemoteEngine: SandboxEngine = {
  name: "agentos-remote",
  ready: () => Boolean(env.sandboxUrl && env.sandboxSecret),
  capabilities: (run) => agentOsCapabilities(agentOsHosts(run)),
  create: (runId, egress) =>
    new RemoteAgentOsSandbox(runId, { url: env.sandboxUrl, secret: env.sandboxSecret }, egress),
};

/**
 * A run's VM in the sandbox container. Made on the first call with the hosts the broker gives the
 * run (the container only applies them), destroyed with the run. A VM the container destroyed
 * meanwhile (idle, a restart) is made again, empty.
 */
export class RemoteAgentOsSandbox implements Sandbox {
  readonly capabilities: SandboxCapabilities;
  private machine: Promise<void> | null = null;

  constructor(
    private readonly runId: string,
    private readonly service: SandboxService,
    private readonly egress: SandboxEgress | readonly string[] = env.sandboxHosts,
  ) {
    this.capabilities = agentOsCapabilities(Array.isArray(egress) ? egress : []);
  }

  private async hosts(): Promise<readonly string[]> {
    const egress = this.egress;
    const hosts = Array.isArray(egress)
      ? egress
      : agentOsHosts(await (egress as SandboxEgress).hosts());
    return [...new Set([...PACKAGE_REGISTRIES, ...hosts])];
  }

  private async request(
    path: string,
    init: { method: string; body?: BodyInit; json?: unknown; timeoutMs?: number },
  ): Promise<Response> {
    if (!this.service.url || !this.service.secret) {
      throw new Error("The sandbox isn’t set up on this server: SANDBOX_URL and SANDBOX_SECRET.");
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.service.secret}` };
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.service.url}/vms/${encodeURIComponent(this.runId)}${path}`, {
      method: init.method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.timeout((init.timeoutMs ?? 0) + REQUEST_MARGIN_MS),
    }).catch((err) => {
      throw new Error(`The sandbox doesn’t answer: ${(err as Error).message}`);
    });
    if (res.ok) {
      return res;
    }
    const answer = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const code = answer.error ?? "failed";
    if (res.status === 429) {
      throw new SandboxAnswer(
        429,
        code,
        "The sandbox is full right now: try again in a few minutes.",
      );
    }
    throw new SandboxAnswer(
      res.status,
      code,
      answer.message ?? `The sandbox answered ${res.status}.`,
    );
  }

  private vm(): Promise<void> {
    this.machine ??= (async () => {
      await this.request("", { method: "PUT", json: { hosts: await this.hosts() } });
    })();
    this.machine.catch(() => {
      this.machine = null;
    });
    return this.machine;
  }

  /** Runs `call` on the run's VM; when the container no longer has it, makes it again once. */
  private async onVm<T>(call: () => Promise<T>): Promise<T> {
    await this.vm();
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof SandboxAnswer && err.code === "no-vm")) {
        throw err;
      }
      this.machine = null;
      await this.vm();
      return call();
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
    return this.onVm(async () => {
      const res = await this.request("/exec", {
        method: "POST",
        json: { command, cwd: options.cwd, env: options.env, timeoutMs },
        timeoutMs,
      });
      return (await res.json()) as ExecResult;
    });
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.onVm(() =>
      this.request(`/files?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        body: typeof data === "string" ? data : Buffer.from(data),
      }),
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.onVm(async () => {
      const res = await this.request(`/files?path=${encodeURIComponent(path)}`, { method: "GET" });
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  async destroy(): Promise<void> {
    const machine = this.machine;
    this.machine = null;
    if (await machine?.then(() => true).catch(() => false)) {
      await this.request("", { method: "DELETE" });
    }
  }
}
