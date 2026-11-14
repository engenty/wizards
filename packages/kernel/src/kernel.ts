import { type Grant, grantOf, type Host, lacking, needsLeave, outside } from "./grant.js";
import { turn as runTurn } from "./turn.js";
import type {
  AskRow,
  Battery,
  Eval,
  LeftRow,
  Replay,
  Row,
  Run,
  Score,
  Spec,
  Store,
  TurnFn,
  Wizard,
} from "./types.js";

/** Thrown by a battery: this action needs the user's leave before it is done. */
export class NeedsLeave extends Error {
  constructor(message = "This action needs the user's leave.") {
    super(message);
  }
}

const UNIT: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const ms = (text: string) => Number.parseInt(text, 10) * (UNIT[text.at(-1) ?? ""] ?? 0);
const isLeft = (row: Row): row is LeftRow => "left" in row;
const isAsk = (row: Row): row is AskRow => !("left" in row);
/** A step's own asks, in the order it made them: without the rows that ask the user's leave. */
const isOwn = (row: Row): row is AskRow =>
  isAsk(row) && row.approves == null && row.parent == null && row.step !== "input";
const read = (from: unknown, path: string) =>
  path.split(".").reduce<any>((at, key) => at?.[key], from);

/** The row that asks for a run's input, where the run began without one. Not a step. */
export const INPUT = "input";

/** A run as it begins. Without an input, and where the file has fields for one, it first asks. */
export function begin(
  file: Wizard["file"],
  run: Pick<Run, "id" | "wizard" | "startedAt">,
  input?: Record<string, unknown>,
): Run {
  const asks = input === undefined && (file.input?.fields.length ?? 0) > 0;
  return {
    ...run,
    input: input ?? {},
    status: "running",
    cursor: file.start,
    open: null,
    rows: asks
      ? [
          {
            n: 0,
            step: INPUT,
            type: "form",
            role: "user",
            fields: file.input?.fields,
            state: "waiting",
          },
        ]
      : [],
    rev: 0,
  };
}

/** What a step sees of the run. All of it is worked out from the rows. */
export function view(run: Run) {
  const left = run.rows.filter(isLeft);
  const counts: Record<string, number> = {};
  for (const row of left) counts[row.step] = (counts[row.step] ?? 0) + 1;
  if (run.cursor) counts[run.cursor] = (counts[run.cursor] ?? 0) + 1;
  const last = left.at(-1);
  return {
    input: run.input,
    today: new Date(run.startedAt).toISOString().slice(0, 10),
    steps: Object.fromEntries(left.map((row) => [row.step, row.value])),
    last: last && { step: last.step, value: last.value, to: last.to },
    counts,
  };
}

const answered = (rows: AskRow[]): Replay =>
  rows.map((row) =>
    row.state === "done"
      ? { answer: row.answer }
      : row.state === "failed"
        ? { error: row.error ?? "" }
        : null,
  );

export type KernelOptions = {
  store: Store;
  wizards: (id: string) => Wizard | Promise<Wizard>;
  batteries?: Record<string, Battery>;
  now?: () => number;
  /** How long a step may wait for something that is not an ask, in milliseconds. */
  patience?: number;
  /** What this host has. Given, a wizard that requires more is refused before it starts. */
  has?: Host;
  /** How a step's code is run: as ordinary code (the default), or in a sandbox. */
  turn?: TurnFn;
  /** Checks an answer against the fields of its ask; says what is wrong, or nothing. */
  check?: (fields: AskRow["fields"], value: unknown) => string | undefined;
};

/**
 * The engine: a cursor that stands at a step, and rows for every ask and every leaving. It knows
 * the file, the step interface and the rows; not HTTP, a database, a model or the studio.
 */
export function createKernel({
  store,
  wizards,
  batteries = {},
  now = Date.now,
  patience,
  has,
  turn: runStep = runTurn as TurnFn,
  check,
}: KernelOptions) {
  const fail = (run: Run, error: string) =>
    Object.assign(run, { status: "failed" as const, error });

  async function move(run: Run): Promise<Run> {
    if (run.status === "stopped") return run;
    const { file, steps } = await wizards(run.wizard);
    run.grant ??= grantOf(file);
    const grant = run.grant;
    run.status = "running";
    // A run that began without its input asks for it first: the answer of row 0 is the input.
    const first = run.rows[0];
    if (first && isAsk(first) && first.step === INPUT) {
      if (first.state === "waiting") {
        run.status = "waiting";
        await store.save(run);
        return run;
      }
      run.input = first.answer as Record<string, unknown>;
    }

    while (run.cursor && run.status === "running") {
      const id = run.cursor;
      const source = steps[id];
      const limit = file.limits?.[id] ?? 10;
      if (!source) {
        fail(run, `There is no step "${id}".`);
        break;
      }
      if (run.open == null) {
        // arrive
        if ((view(run).counts[id] ?? 0) > limit) {
          fail(run, `"${id}" was reached more than ${limit} times.`);
          break;
        }
        run.open = run.rows.length;
      }

      // Run the step from its top. Asks that have an answered row get the answer back.
      const mine = run.rows.slice(run.open).filter(isOwn);
      const turn = await runStep(source, view(run), answered(mine), patience);

      if (turn.end && "error" in turn.end) {
        fail(run, turn.end.error);
        break;
      }
      if (turn.end) {
        // leave
        const ways = file.edges[id] ?? [];
        const to = turn.end.done.to ?? ways[0] ?? "end";
        if (!ways.includes(to)) {
          fail(run, `"${id}" may not go to "${to}".`);
          break;
        }
        run.rows.push({ n: run.rows.length, step: id, left: true, value: turn.end.done.value, to });
        Object.assign(run, { cursor: to === "end" ? null : to, open: null });
        await store.save(run);
        continue;
      }

      // The step stands at asks without an answer.
      const changed = turn.asks.findIndex((spec, i) => mine[i] && mine[i].type !== spec.type);
      if (changed >= 0) {
        fail(run, `"${id}" asks something else than it did when the run stopped here.`);
        break;
      }
      let moved = false;
      for (const spec of turn.asks.slice(mine.length)) {
        const row = ask(run, id, spec, grant);
        run.rows.push(row);
        moved ||= row.state === "failed";
      }
      // An action set to "ask" waits for the user's leave, a row of its own.
      const here = run.rows.slice(run.open).filter(isOwn);
      for (const row of here) {
        if (row.state !== "waiting" || !(needsLeave(grant, row) || row.asksLeave)) continue;
        const leave = run.rows.filter(isAsk).find((other) => other.approves === row.n);
        if (!leave) {
          run.rows.push({
            n: run.rows.length,
            step: id,
            type: "approval",
            role: "user",
            approves: row.n,
            call: row.call,
            input: row.input,
            state: "waiting",
          });
        } else if (
          leave.state === "done" &&
          (leave.answer as { allow?: unknown })?.allow !== true
        ) {
          Object.assign(row, { state: "failed", error: `The user did not allow "${row.call}".` });
          moved = true;
        }
      }
      const allowed = (row: AskRow) =>
        !(needsLeave(grant, row) || row.asksLeave) ||
        run.rows.filter(isAsk).some((other) => other.approves === row.n && other.state === "done");
      const answerable = here.filter(
        (row) => row.state === "waiting" && batteries[row.type] && allowed(row),
      );
      await Promise.all(
        answerable.map(async (row) => {
          const note = (spec: Spec & { answer?: unknown }) =>
            void run.rows.push({
              ...spec,
              n: run.rows.length,
              step: id,
              role: spec.role ?? spec.type,
              parent: row.n,
              state: "done",
            });
          for (;;) {
            row.tries = (row.tries ?? 0) + 1;
            try {
              row.answer = await batteries[row.type](row, run, { note });
              row.state = "done";
              return;
            } catch (error) {
              if (error instanceof NeedsLeave && !row.asksLeave) {
                row.asksLeave = true; // the next pass asks the user, then comes back here
                return;
              }
              if (row.tries <= Number(row.retries ?? 0)) continue;
              Object.assign(row, {
                state: "failed",
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }
          }
        }),
      );
      await store.save(run);
      if (!moved && answerable.length === 0) run.status = "waiting"; // a person, a signal, a time
    }

    if (!run.cursor && run.status === "running") {
      const { steps: values } = view(run);
      run.output = Object.fromEntries(
        Object.entries(file.output ?? {}).map(([name, from]) => [name, read(values, from)]),
      );
      run.status = "done";
    }
    const due = run.rows
      .filter(isAsk)
      .filter((row) => row.state === "waiting" && row.due)
      .map((row) => row.due as number);
    run.wakeAt = run.status === "waiting" && due.length ? Math.min(...due) : undefined;
    await store.save(run);
    return run;
  }

  /** A new row for an ask, failed at once when it reaches past the file. */
  function ask(run: Run, step: string, spec: Spec, grant: Grant): AskRow {
    const role = spec.role ?? (spec.type === "form" || spec.type === "review" ? "user" : spec.type);
    const reached = outside(grant, spec);
    return {
      ...spec,
      n: run.rows.length,
      step,
      role,
      state: reached ? "failed" : "waiting",
      ...(reached && {
        error: `"${step}" reached for "${reached}", which the file does not grant.`,
      }),
      ...(spec.timeout && { due: now() + ms(spec.timeout) }),
    };
  }

  async function open(runId: string): Promise<Run> {
    const run = await store.load(runId);
    if (!run) throw new Error(`There is no run "${runId}".`);
    return run;
  }

  /** What is wrong with a value for these fields; nothing when it fits. */
  const wrong = (fields: AskRow["fields"], value: unknown): string | undefined => {
    if (check) return check(fields, value);
    const lacks = (fields ?? []).find(
      (field) => field.required && (value as Record<string, unknown> | null)?.[field.id] == null,
    );
    return lacks && `"${lacks.id}" is missing.`;
  };

  /** Takes a run back to row `n` and writes that. The run does not move yet. */
  async function back(runId: string, n: number, value?: unknown): Promise<Run> {
    const run = await open(runId);
    const row = run.rows[n];
    if (!row || isLeft(row)) throw new Error(`Row ${n} is not an ask.`);
    run.rows.length = n + 1;
    run.scores = run.scores?.filter((score) => score.row < n);
    Object.assign(
      row,
      value === undefined
        ? { state: "waiting", answer: undefined, by: undefined, error: undefined, tries: undefined }
        : { state: "done", answer: value },
    );
    let from = n; // the step's rows begin after the last row that left a step
    while (from > 0 && !isLeft(run.rows[from - 1])) from--;
    const input = row.step === INPUT;
    Object.assign(run, {
      status: "running" as const,
      cursor: input ? run.cursor : row.step,
      open: input ? null : from,
      error: undefined,
      output: undefined,
    });
    await store.save(run);
    return run;
  }

  /** Writes an answer into its waiting row. The run does not move yet. */
  async function record(runId: string, n: number, value: unknown, by?: string): Promise<Run> {
    const run = await open(runId);
    const row = run.rows[n];
    if (!row || isLeft(row) || row.state !== "waiting")
      throw new Error(`Row ${n} does not wait for an answer.`);
    const said = wrong(row.fields, value);
    if (said) throw new Error(said);
    Object.assign(row, { state: "done", answer: value, by });
    await store.save(run);
    return run;
  }

  return {
    async start(
      wizard: string,
      input?: Record<string, unknown>,
      id: string = crypto.randomUUID(),
    ): Promise<Run> {
      const { file } = await wizards(wizard);
      const said = input === undefined ? undefined : wrong(file.input?.fields, input);
      if (said) throw new Error(said);
      const without = has ? lacking(file, has) : [];
      if (without.length)
        throw new Error(`This wizard cannot run here. It lacks ${without.join(", ")}.`);
      return move(begin(file, { id, wizard, startedAt: now() }, input));
    },

    /** An answer to a waiting row, from a person, a signal or another run. */
    async answer(runId: string, n: number, value: unknown, by?: string): Promise<Run> {
      return move(await record(runId, n, value, by));
    },

    /** The two halves of `answer`, for a host that moves runs in a line of its own. */
    record,
    move: async (runId: string) => move(await open(runId)),

    /** Ends a run where it stands. Nothing moves it again; its rows stay. */
    async stop(runId: string): Promise<Run> {
      const run = await open(runId);
      if (run.status === "done" || run.status === "failed") return run;
      Object.assign(run, { status: "stopped", wakeAt: undefined });
      await store.save(run);
      return run;
    },

    /** A host calls this at `run.wakeAt`: a row whose time has come is answered with `timedOut`. */
    async wake(runId: string): Promise<Run> {
      const run = await open(runId);
      const due = run.rows
        .filter(isAsk)
        .filter((row) => row.state === "waiting" && row.due != null && row.due <= now());
      if (!due.length || run.status === "stopped") return run;
      for (const row of due) Object.assign(row, { state: "done", answer: { timedOut: true } });
      return move(run);
    },

    /** Back to row `n`: asked again, or with a value answered differently. Later rows are dropped. */
    async rewind(runId: string, n: number, value?: unknown): Promise<Run> {
      return move(await back(runId, n, value));
    },

    /** The first half of `rewind`, for a host that moves runs in a line of its own. */
    back,

    /**
     * Runs the evals that have not judged yet: a step's, for every time it returned, and those of
     * `end` once the run is done. It changes nothing but `run.scores`.
     */
    async judge(runId: string): Promise<Run> {
      const run = await open(runId);
      const { file, evals = {} } = await wizards(run.wizard);
      const grant = run.grant ?? grantOf(file);
      const scores = run.scores ?? [];
      const targets = run.rows.filter(isLeft).map((row) => ({ at: row.n, step: row.step }));
      if (run.status === "done") targets.push({ at: run.rows.length - 1, step: "end" });
      for (const { at, step } of targets) {
        for (const [name, source] of Object.entries(evals[step] ?? {})) {
          const id = `${step}/${name}`;
          if (scores.some((score) => score.eval === id && score.row === at)) continue;
          scores.push(await judgeOne(run, id, at, source, grant));
        }
      }
      run.scores = scores;
      await store.save(run);
      return run;
    },

    read: open,
  };

  /** One eval on the run as it stood at row `at`. Its asks are answered at once or fail. */
  async function judgeOne(
    run: Run,
    id: string,
    at: number,
    source: Eval<any> | string,
    grant: Grant,
  ): Promise<Score> {
    const seen = view({ ...run, rows: run.rows.slice(0, at + 1), cursor: null });
    const asks: AskRow[] = [];
    for (let turns = 0; turns < 20; turns++) {
      const turn = await runStep(source, seen, answered(asks), patience);
      const kept = asks.length ? { asks } : {};
      if (turn.end && "error" in turn.end)
        return { eval: id, row: at, error: turn.end.error, ...kept };
      if (turn.end) {
        const { score, why } = turn.end.done as { score?: unknown; why?: unknown };
        if (typeof score !== "number" || !(score >= 0 && score <= 1))
          return {
            eval: id,
            row: at,
            error: `The score must be a number from 0 to 1, it is ${JSON.stringify(score)}.`,
            ...kept,
          };
        return { eval: id, row: at, score, ...(typeof why === "string" && { why }), ...kept };
      }
      const asked = turn.asks.slice(asks.length);
      for (const spec of asked) asks.push({ ...ask(run, id, spec, grant), n: asks.length });
      const waiting = asks.filter((row) => row.state === "waiting");
      if (!waiting.length && !asked.length) break;
      await Promise.all(
        waiting.map(async (row) => {
          const battery = batteries[row.type];
          try {
            if (needsLeave(grant, row))
              throw new Error(
                `An eval may not ask for "${row.call}", which needs the user's leave.`,
              );
            if (!battery)
              throw new Error(`An eval may only ask what answers at once, not "${row.role}".`);
            row.answer = await battery(row, run, { note: () => undefined });
            row.state = "done";
          } catch (error) {
            Object.assign(row, {
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
    return { eval: id, row: at, error: "The eval did not come to an end.", asks };
  }
}

export type Kernel = ReturnType<typeof createKernel>;
