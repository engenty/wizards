import type { AskRow, Row } from "@engenty/wizards-kernel";
import type { WaitStep } from "@engenty/wizards-shared/definition";
import { withMailText } from "../engine/mail-watch.js";
import { dropWait, findSignal, registerWait } from "../engine/signals.js";
import type { RunRow } from "../engine/types.js";

/**
 * Signals for a run of version 0.3.0 (docs/plans/kernel.md, C.10): a row that waits for a signal
 * is found by the signal's address, as a wait of the engine's own runs is. The wait is written
 * where senders look (`run_wait`) before the run looks for a signal, so one that came first is
 * found and one that comes later finds the wait and wakes the run. The answered row keeps which
 * signal it took: no signal answers two waits of one run.
 */

/** What a step gets back from a wait a signal ended. */
export interface SignalAnswer {
  came: true;
  data: Record<string, unknown>;
  /** The signal's id. */
  signal: string;
}

type WaitRow = AskRow & { signal: string };

const isAsk = (row: Row): row is AskRow => !("left" in row);

/** The names a wait's `fields` lists: a signal must bring each. A step may write them as fields. */
const namesOf = (fields: unknown): string[] =>
  (Array.isArray(fields) ? fields : []).flatMap((field) =>
    typeof field === "string"
      ? [field]
      : typeof (field as { id?: unknown })?.id === "string"
        ? [(field as { id: string }).id]
        : [],
  );

/**
 * The row of a run that waits for a signal now, as an address: the signal's name, the key, and
 * the data it must bring. A run has one such address at a time, as `run_wait` holds one per run.
 */
export function signalWait(rows: Row[]) {
  const row = rows
    .filter(isAsk)
    .find(
      (one): one is WaitRow =>
        one.state === "waiting" && one.type === "wait" && typeof one.signal === "string",
    );
  return (
    row && {
      n: row.n,
      name: row.signal,
      key: row.key == null ? "" : String(row.key),
      fields: namesOf(row.fields),
    }
  );
}

/** The signals the run's waits took already. */
const taken = (rows: Row[]): string[] =>
  rows.filter(isAsk).flatMap((row) => {
    const id = (row.answer as Partial<SignalAnswer> | undefined)?.signal;
    return row.type === "wait" && typeof id === "string" ? [id] : [];
  });

/**
 * The run as it stands, looked at for a signal: the answer to its waiting row where a signal for
 * it is there, nothing where none is. A run that waits for no signal has no wait written.
 */
export async function signalFor(
  run: RunRow,
  spaceId: string,
  rows: Row[],
): Promise<{ n: number; answer: SignalAnswer } | undefined> {
  const wait = signalWait(rows);
  if (!wait) {
    await dropWait(run.id);
    return undefined;
  }
  const step = { signal: { name: wait.name, fields: wait.fields } } as WaitStep;
  await registerWait(run, spaceId, step, wait.key);
  const signal = await findSignal(
    { ...run, state: { ...run.state, signals: taken(rows) } },
    spaceId,
    step,
    wait.key,
  );
  if (!signal) {
    return undefined;
  }
  await dropWait(run.id);
  return {
    n: wait.n,
    answer: { came: true, data: (await withMailText(signal)) ?? {}, signal: signal.id },
  };
}
