import { posix } from "node:path";
import type { WorkspaceSandbox } from "@mastra/core/workspace";
import type { ExecOptions, ExecResult, Sandbox, SandboxCapabilities } from "./types.js";

/** Bytes per append when a file is written through the shell; stays far below ARG_MAX. */
const WRITE_CHUNK = 48 * 1024;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Makes one of Mastra's sandboxes (`WorkspaceSandbox`: @mastra/docker, @mastra/e2b,
 * @mastra/daytona, …) the sandbox of a run. The provider is made on the first call and started
 * once; an engine installed apart from the runtime passes a factory that loads it first.
 *
 * Files go through the shell (`base64`), which every provider runs, so they land as the user the
 * commands run as.
 */
export class MastraRunSandbox implements Sandbox {
  private provider: Promise<WorkspaceSandbox> | null = null;

  constructor(
    readonly capabilities: SandboxCapabilities,
    private readonly make: () => WorkspaceSandbox | Promise<WorkspaceSandbox>,
  ) {}

  private start(): Promise<WorkspaceSandbox> {
    this.provider ??= (async () => {
      const sandbox = await this.make();
      if (!sandbox.executeCommand) {
        throw new Error(`${sandbox.name} runs no commands.`);
      }
      await sandbox.start?.();
      return sandbox;
    })();
    this.provider.catch(() => {
      this.provider = null;
    });
    return this.provider;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sandbox = await this.start();
    const result = await sandbox.executeCommand!(command, [], {
      timeout: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    });
    const stderr = result.timedOut ? `${result.stderr}\ntimed out`.trim() : result.stderr;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr };
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const target = quote(posix.resolve(this.capabilities.workdir, path));
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    await this.must(`mkdir -p "$(dirname ${target})" && : > ${target}`);
    for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
      const chunk = bytes.subarray(at, at + WRITE_CHUNK).toString("base64");
      await this.must(`printf %s ${chunk} | base64 -d >> ${target}`);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    // No `-w0` and no file argument: macOS's base64 takes neither. Node skips the line breaks.
    const result = await this.must(
      `base64 < ${quote(posix.resolve(this.capabilities.workdir, path))}`,
    );
    return Buffer.from(result.stdout, "base64");
  }

  private async must(command: string): Promise<ExecResult> {
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
    }
    return result;
  }

  async destroy(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    await (await provider?.catch(() => null))?.destroy?.();
  }
}
