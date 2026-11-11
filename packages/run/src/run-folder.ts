/**
 * A run's folder: everything the run keeps on the machine that hosts it.
 *
 * - `run.json`: the run's id, its revision and its `FlowRun`, written whole each time (a temporary
 *   file, then a rename), so a process that dies in the middle leaves the run as it was or as it
 *   is now, never half of it.
 * - `turns/<id>.json`: an agent turn that is under way, one file each, written the same way.
 * - `events.ndjson`: the run's log, one `RunEvent` a line, appended.
 * - `signals.json`: signals that came before the run's wait, until the wait takes them.
 *
 * One process works on a folder at a time; a second one on the same folder would be refused by
 * no lock, only by the revision a write holds on.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTurn } from "@engenty/wizards-engine/types";
import type { RunEvent, RunEventType, RunNote } from "@engenty/wizards-shared/run";
import type { FlowRun } from "@engenty/wizards-shared/transition";

/** What `run.json` holds. */
export interface StoredRun {
  runId: string;
  rev: number;
  run: FlowRun;
}

/** A signal kept for the run's wait at `stepId`. `id`: its delivery. */
export interface KeptSignal {
  stepId: string;
  id: string;
  data: Record<string, unknown> | null;
}

export class RunFolder {
  private events: RunEvent[] = [];

  private constructor(readonly dir: string) {}

  /** The folder at `dir`, made if it is not there, with its log read. */
  static async open(dir: string): Promise<RunFolder> {
    await mkdir(join(dir, "turns"), { recursive: true });
    const folder = new RunFolder(dir);
    const text = await readText(join(dir, "events.ndjson"));
    folder.events = (text ?? "")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          // A line a dying process cut off.
          return [];
        }
      });
    return folder;
  }

  // --- the run --------------------------------------------------------------------------------

  /** The run as `run.json` has it; null before the run's first write. */
  async load(): Promise<StoredRun | null> {
    const text = await readText(join(this.dir, "run.json"));
    return text === null ? null : (JSON.parse(text) as StoredRun);
  }

  async save(stored: StoredRun): Promise<void> {
    await writeWhole(join(this.dir, "run.json"), stored);
  }

  // --- turns ----------------------------------------------------------------------------------

  async turn(id: string): Promise<AgentTurn | null> {
    const text = await readText(this.turnPath(id));
    return text === null ? null : (JSON.parse(text) as AgentTurn);
  }

  async saveTurn(turn: AgentTurn): Promise<void> {
    await writeWhole(this.turnPath(turn.id), turn);
  }

  /** Lets go of every turn of the step: its own, its entries', its agent's. */
  async dropTurns(stepId: string): Promise<void> {
    const dir = join(this.dir, "turns");
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const text = await readText(join(dir, name));
      if (text !== null && (JSON.parse(text) as AgentTurn).stepId === stepId) {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  private turnPath(id: string) {
    return join(this.dir, "turns", `${encodeURIComponent(id)}.json`);
  }

  // --- the log --------------------------------------------------------------------------------

  /** The newest line's id; 0 when the log is empty. */
  get lastEvent(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  /** The lines after `id`, oldest first. */
  eventsAfter(id: number): RunEvent[] {
    return this.events.filter((e) => e.id > id);
  }

  async append(
    stepId: string | null,
    type: RunEventType,
    message: string,
    note: RunNote | null,
    asset: string | null,
  ): Promise<RunEvent> {
    const event: RunEvent = {
      id: this.lastEvent + 1,
      at: new Date().toISOString(),
      stepId,
      type,
      message: message.slice(0, 2000),
      note,
      asset,
    };
    this.events.push(event);
    await appendFile(join(this.dir, "events.ndjson"), `${JSON.stringify(event)}\n`);
    return event;
  }

  // --- signals --------------------------------------------------------------------------------

  async keepSignal(signal: KeptSignal): Promise<void> {
    await writeWhole(join(this.dir, "signals.json"), [...(await this.signals()), signal]);
  }

  /** The first signal kept for the wait at `stepId`, taken: it is there once. */
  async takeSignal(stepId: string): Promise<KeptSignal | null> {
    const kept = await this.signals();
    const i = kept.findIndex((s) => s.stepId === stepId);
    if (i < 0) {
      return null;
    }
    const [taken] = kept.splice(i, 1);
    await writeWhole(join(this.dir, "signals.json"), kept);
    return taken;
  }

  private async signals(): Promise<KeptSignal[]> {
    const text = await readText(join(this.dir, "signals.json"));
    return text === null ? [] : (JSON.parse(text) as KeptSignal[]);
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** The file as a whole or not at all: written beside it, then renamed over it. */
async function writeWhole(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}
