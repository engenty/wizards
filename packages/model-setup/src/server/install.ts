import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** What installing came to. */
export interface Outcome {
  ok: boolean;
  message: string;
}

export function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first file of that name on a PATH that may be run. */
export function findOnPath(name: string, path: string): string | null {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return (
    path
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, file))
      .find(executable) ?? null
  );
}

interface Ran {
  code: number;
  /** The end of what the command printed. */
  tail: string;
}

/** Runs a command, what it prints into the log file; never rejects. */
export function logged(
  command: string,
  args: string[],
  { logs, onLine }: { logs: string; onLine?: (line: string) => void },
): Promise<Ran> {
  mkdirSync(logs, { recursive: true });
  const file = join(logs, "install.log");
  appendFileSync(file, `\n$ ${command} ${args.join(" ")}\n`);
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        tail = (tail + text).slice(-4000);
        appendFileSync(file, text);
        for (const line of text.split("\n").filter((l) => l.trim())) {
          onLine?.(line);
        }
      });
    }
    child.on("error", (err) => resolve({ code: 127, tail: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail: tail.trim() }));
  });
}

export const lastLine = (text: string) => text.split("\n").pop() ?? "";

/** Asks every half second until it is true or the time is over. */
export async function until(ready: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready()) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

/** Free space where the models are kept (the home folder), in GB. */
export async function freeGb(dir = homedir()): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Math.floor((stats.bavail * stats.bsize) / 2 ** 30);
  } catch {
    return null;
  }
}
