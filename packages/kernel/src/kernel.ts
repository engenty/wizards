import { turn as runTurn } from "./turn";
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
  Wizard,
} from "./types";

const UNIT: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const ms = (text: string) => Number.parseInt(text, 10) * (UNIT[text.at(-1) ?? ""] ?? 0);
const isLeft = (row: Row): row is LeftRow => "left" in row;
const isAsk = (row: Row): row is AskRow => !("left" in row);
const read = (from: unknown, path: string) =>
  path.split(".").reduce<any>((at, key) => at?.[key], from);

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
}: KernelOptions) {
  const fail = (run: Run, error: string) =>
    Object.assign(run, { status: "failed" as const, error });

  async function move(run: Run): Promise<Run> {
    const { file, steps } = await wizards(run.wizard);
    const roles = ["user", "operator", ...Object.keys(file.roles ?? {})];
    run.status = "running";

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
      const mine = run.rows.slice(run.open).filter(isAsk);
      const turn = await runTurn(source, view(run), answered(mine), patience);

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
        const row = ask(run, id, spec, roles, file.tools ?? []);
        run.rows.push(row);
        moved ||= row.state === "failed";
      }
      const answerable = run.rows
        .slice(run.open)
        .filter(isAsk)
        .filter((row) => row.state === "waiting" && batteries[row.type]);
      await Promise.all(
        answerable.map(async (row) => {
          try {
            row.answer = await batteries[row.type](row, run);
            row.state = "done";
          } catch (error) {
            Object.assign(row, {
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
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
  function ask(run: Run, step: string, spec: Spec, roles: string[], tools: string[]): AskRow {
    const role = spec.role ?? (spec.type === "form" || spec.type === "review" ? "user" : spec.type);
    const outside =
      (spec.tools ?? []).find((tool) => !tools.includes(tool)) ??
      [spec.role, spec.asks].find((name) => name && !roles.includes(name));
    return {
      ...spec,
      n: run.rows.length,
      step,
      role,
      state: outside ? "failed" : "waiting",
      ...(outside && {
        error: `"${step}" reached for "${outside}", which the file does not grant.`,
      }),
      ...(spec.timeout && { due: now() + ms(spec.timeout) }),
    };
  }

  async function open(runId: string): Promise<Run> {
    const run = await store.load(runId);
    if (!run) throw new Error(`There is no run "${runId}".`);
    return run;
  }

  const missing = (fields: AskRow["fields"], value: unknown) =>
    (fields ?? []).find(
      (field) => field.required && (value as Record<string, unknown> | null)?.[field.id] == null,
    );

  return {
    async start(
      wizard: string,
      input: Record<string, unknown>,
      id: string = crypto.randomUUID(),
    ): Promise<Run> {
      const { file } = await wizards(wizard);
      const lacks = missing(file.input?.fields, input);
      if (lacks) throw new Error(`"${lacks.id}" is missing.`);
      return move({
        id,
        wizard,
        input,
        startedAt: now(),
        status: "running",
        cursor: file.start,
        open: null,
        rows: [],
        rev: 0,
      });
    },

    /** An answer to a waiting row, from a person, a signal or another run. */
    async answer(runId: string, n: number, value: unknown, by?: string): Promise<Run> {
      const run = await open(runId);
      const row = run.rows[n];
      if (!row || isLeft(row) || row.state !== "waiting")
        throw new Error(`Row ${n} does not wait for an answer.`);
      const lacks = missing(row.fields, value);
      if (lacks) throw new Error(`"${lacks.id}" is missing.`);
      Object.assign(row, { state: "done", answer: value, by });
      return move(run);
    },

    /** A host calls this at `run.wakeAt`: a row whose time has come is answered with `timedOut`. */
    async wake(runId: string): Promise<Run> {
      const run = await open(runId);
      const due = run.rows
        .filter(isAsk)
        .filter((row) => row.state === "waiting" && row.due != null && row.due <= now());
      if (!due.length) return run;
      for (const row of due) Object.assign(row, { state: "done", answer: { timedOut: true } });
      return move(run);
    },

    /** Back to row `n`: asked again, or with a value answered differently. Later rows are dropped. */
    async rewind(runId: string, n: number, value?: unknown): Promise<Run> {
      const run = await open(runId);
      const row = run.rows[n];
      if (!row || isLeft(row)) throw new Error(`Row ${n} is not an ask.`);
      run.rows.length = n + 1;
      run.scores = run.scores?.filter((score) => score.row < n);
      Object.assign(
        row,
        value === undefined
          ? { state: "waiting", answer: undefined, by: undefined }
          : { state: "done", answer: value },
      );
      let from = n; // the step's rows begin after the last row that left a step
      while (from > 0 && !isLeft(run.rows[from - 1])) from--;
      return move(
        Object.assign(run, { cursor: row.step, open: from, error: undefined, output: undefined }),
      );
    },

    /**
     * Runs the evals that have not judged yet: a step's, for every time it returned, and those of
     * `end` once the run is done. It changes nothing but `run.scores`.
     */
    async judge(runId: string): Promise<Run> {
      const run = await open(runId);
      const { file, evals = {} } = await wizards(run.wizard);
      const roles = ["user", "operator", ...Object.keys(file.roles ?? {})];
      const scores = run.scores ?? [];
      const targets = run.rows.filter(isLeft).map((row) => ({ at: row.n, step: row.step }));
      if (run.status === "done") targets.push({ at: run.rows.length - 1, step: "end" });
      for (const { at, step } of targets) {
        for (const [name, source] of Object.entries(evals[step] ?? {})) {
          const id = `${step}/${name}`;
          if (scores.some((score) => score.eval === id && score.row === at)) continue;
          scores.push(await judgeOne(run, id, at, source, roles, file.tools ?? []));
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
    source: Eval<any>,
    roles: string[],
    tools: string[],
  ): Promise<Score> {
    const seen = view({ ...run, rows: run.rows.slice(0, at + 1), cursor: null });
    const asks: AskRow[] = [];
    for (let turns = 0; turns < 20; turns++) {
      const turn = await runTurn(source, seen, answered(asks), patience);
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
      for (const spec of asked) asks.push({ ...ask(run, id, spec, roles, tools), n: asks.length });
      const waiting = asks.filter((row) => row.state === "waiting");
      if (!waiting.length && !asked.length) break;
      await Promise.all(
        waiting.map(async (row) => {
          const battery = batteries[row.type];
          try {
            if (!battery)
              throw new Error(`An eval may only ask what answers at once, not "${row.role}".`);
            row.answer = await battery(row, run);
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
