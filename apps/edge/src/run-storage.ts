/**
 * What one run's object keeps in its storage (a Durable Object's, SQLite-backed, through its
 * key-value calls). Every value is written whole; values written in one `put` land together.
 *
 * - `held`: what the hand-over gave: the run's id, its token, its definition and its files.
 * - `run`: its revision and its `FlowRun`.
 * - `error`: what the run's failure says, while it is failed.
 * - `turn:<id>`: an agent turn under way.
 * - `line:<id>`, `lines`: the run's log, one `RunEvent` a key, and the newest line's id.
 * - `replay`: the lines written since the flow last moved the run (see `ObjectHost`).
 * - `signal:<step>`: signals that came before the run's wait, until the wait takes them.
 * - `unreported`: the revision whose copy did not reach the tenant yet.
 * - `yielded`: the last call of the object stopped before a model call, for the next to go on.
 */
import type { AgentTurn } from "@engenty/wizards-engine/types";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { RunEvent, RunEventType, RunNote, Said } from "@engenty/wizards-shared/run";
import type { FlowRun } from "@engenty/wizards-shared/transition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";

/** The run as the hand-over gave it to the object. */
export interface Held {
  runId: string;
  /** The run's token: every service call carries it, and so does every call of a door here. */
  token: string;
  def: WizardDefinition;
  files: WorkspaceFile[];
}

export interface StoredRun {
  rev: number;
  run: FlowRun;
}

export interface KeptSignal {
  id: string;
  data: Record<string, unknown> | null;
}

/** A line of the log, written. */
export interface LineInput {
  stepId: string | null;
  type: RunEventType;
  message: string;
  note: RunNote | null;
  asset: string | null;
}

/** Line ids as keys sort as numbers. */
const lineKey = (id: number) => `line:${String(id).padStart(12, "0")}`;
const turnKey = (id: string) => `turn:${id}`;
const signalKey = (stepId: string) => `signal:${stepId}`;

/** At most this many lines in one answer of `GET changes`; the rest come in the next. */
const LINES_AT_ONCE = 200;

export class RunStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  // --- the run ----------------------------------------------------------------------------------

  held(): Promise<Held | undefined> {
    return this.storage.get<Held>("held");
  }

  async hold(held: Held, run: StoredRun): Promise<void> {
    await this.storage.put<unknown>({ held, run, lines: 0, replay: [] });
  }

  run(): Promise<StoredRun | undefined> {
    return this.storage.get<StoredRun>("run");
  }

  /**
   * Writes the run. `moved`: the flow moved it, so no line written before is one this visit
   * writes again.
   */
  async saveRun(stored: StoredRun, moved: boolean): Promise<void> {
    await this.storage.put<unknown>(moved ? { run: stored, replay: [] } : { run: stored });
  }

  async error(): Promise<Said | null> {
    return (await this.storage.get<Said>("error")) ?? null;
  }

  async setError(said: Said | null): Promise<void> {
    if (said === null) {
      await this.storage.delete("error");
    } else {
      await this.storage.put("error", said);
    }
  }

  // --- turns ------------------------------------------------------------------------------------

  async turn(id: string): Promise<AgentTurn | null> {
    return (await this.storage.get<AgentTurn>(turnKey(id))) ?? null;
  }

  async saveTurn(turn: AgentTurn): Promise<void> {
    await this.storage.put(turnKey(turn.id), turn);
  }

  /** The step's turns, an entry's and an agent's among them. */
  async dropTurns(stepId: string): Promise<void> {
    const turns = await this.storage.list<AgentTurn>({ prefix: "turn:" });
    const keys = [...turns].filter(([, t]) => t.stepId === stepId).map(([key]) => key);
    if (keys.length) {
      await this.storage.delete(keys);
    }
  }

  // --- the log ----------------------------------------------------------------------------------

  async lastLine(): Promise<number> {
    return (await this.storage.get<number>("lines")) ?? 0;
  }

  /** Appends a line; `replay` is what the visit has written so far, this line with it. */
  async append(line: LineInput, at: number, replay: string[]): Promise<RunEvent> {
    const id = (await this.lastLine()) + 1;
    const event: RunEvent = { id, at: new Date(at).toISOString(), ...line };
    await this.storage.put<unknown>({ [lineKey(id)]: event, lines: id, replay });
    return event;
  }

  /** The lines after `after`, oldest first, at most `LINES_AT_ONCE`. */
  async linesAfter(after: number): Promise<RunEvent[]> {
    const lines = await this.storage.list<RunEvent>({
      prefix: "line:",
      start: lineKey(after + 1),
      limit: LINES_AT_ONCE,
    });
    return [...lines.values()];
  }

  async replay(): Promise<string[]> {
    return (await this.storage.get<string[]>("replay")) ?? [];
  }

  // --- signals ----------------------------------------------------------------------------------

  async keepSignal(stepId: string, signal: KeptSignal): Promise<void> {
    const kept = (await this.storage.get<KeptSignal[]>(signalKey(stepId))) ?? [];
    if (!kept.some((s) => s.id === signal.id)) {
      await this.storage.put(signalKey(stepId), [...kept, signal]);
    }
  }

  /** The first signal kept for the wait at `stepId`, taken. */
  async takeSignal(stepId: string): Promise<KeptSignal | null> {
    const kept = (await this.storage.get<KeptSignal[]>(signalKey(stepId))) ?? [];
    const [first, ...rest] = kept;
    if (!first) {
      return null;
    }
    if (rest.length) {
      await this.storage.put(signalKey(stepId), rest);
    } else {
      await this.storage.delete(signalKey(stepId));
    }
    return first;
  }

  // --- the object's own marks -------------------------------------------------------------------

  async unreported(): Promise<number | null> {
    return (await this.storage.get<number>("unreported")) ?? null;
  }

  async setUnreported(rev: number | null): Promise<void> {
    if (rev === null) {
      await this.storage.delete("unreported");
    } else {
      await this.storage.put("unreported", rev);
    }
  }

  /** Whether the last call stopped before a model call; reading it takes it. */
  async takeYielded(): Promise<boolean> {
    const yielded = (await this.storage.get<boolean>("yielded")) ?? false;
    if (yielded) {
      await this.storage.delete("yielded");
    }
    return yielded;
  }

  async setYielded(): Promise<void> {
    await this.storage.put("yielded", true);
  }
}
