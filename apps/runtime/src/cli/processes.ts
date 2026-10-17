import { execFileSync } from "node:child_process";
import { sep } from "node:path";

/**
 * Every process that runs from the install folder: the runtime, each `wizards start` (also an
 * older `start --no-open` whose note in running.json another overwrote) and `wizards mcp`.
 * `stop` and `uninstall` stop them all, not only the one in running.json.
 */

export interface WizardsProcess {
  pid: number;
  kind: "runtime" | "start" | "mcp" | "other";
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process, as `ps` lists it; empty where there is no `ps` (Windows). */
function listProcesses(): ProcessEntry[] {
  try {
    return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .filter((match) => match !== null)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
  } catch {
    return [];
  }
}

/**
 * The processes in `list` that run from `home`, apart from `self` and the processes that started
 * it (npx, a shell).
 */
export function wizardsProcesses(
  home: string,
  list: ProcessEntry[],
  self = process.pid,
): WizardsProcess[] {
  const parents = new Map(list.map((entry) => [entry.pid, entry.ppid]));
  const skip = new Set<number>();
  for (let at: number | undefined = self; at && !skip.has(at); at = parents.get(at)) {
    skip.add(at);
  }
  return list
    .filter((entry) => !skip.has(entry.pid) && entry.command.includes(home + sep))
    .map(({ pid, command }) => {
      const args = command.split(/\s+/);
      const kind = /apps[\\/]runtime[\\/]dist[\\/]index\.js/.test(command)
        ? "runtime"
        : args.includes("mcp")
          ? "mcp"
          : args.includes("start")
            ? "start"
            : "other";
      return { pid, kind };
    });
}

export const findWizardsProcesses = (home: string) => wizardsProcesses(home, listProcesses());

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** SIGTERM, then SIGKILL after 8 seconds; the processes still there after that. */
export async function stopProcesses(pids: number[]): Promise<number[]> {
  const signal = (name: NodeJS.Signals) => {
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, name);
      } catch {
        // gone meanwhile, or not ours: the check below tells
      }
    }
  };
  const wait = async (ms: number) => {
    for (let waited = 0; waited < ms && pids.some(alive); waited += 100) {
      await new Promise((done) => setTimeout(done, 100));
    }
  };
  signal("SIGTERM");
  await wait(8000);
  signal("SIGKILL");
  await wait(2000);
  return pids.filter(alive);
}
