import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";

/** What one run of a client printed, and how it ended. */
export interface ClientOutput {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a client once with the prompt on stdin; a client that is not there raises ENOENT. */
export function runClient(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string },
): Promise<ClientOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
      env: opts.env,
    }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.on("error", () => {
      // The client went away before reading the prompt; `close` reports it.
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** The last line of an output that is a JSON object. */
export function lastJson<T>(stdout: string): T | null {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") {
        return value as T;
      }
    } catch {
      // not it
    }
  }
  return null;
}
