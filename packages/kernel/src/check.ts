import { describe } from "./describe";
import { createKernel } from "./kernel";
import { memoryStore } from "./memory";
import type { AskRow, Row, Run, Sandbox, Wizard } from "./types";

/**
 * Tooling for tests of a wizard. It is not part of a wizard and the kernel does not use it.
 *
 * A case: an input, an answer for each ask in the order the run makes them, what to expect.
 */
export type Case = {
  name: string;
  input: Record<string, unknown>;
  answers: Record<string, unknown>[];
  expect?: Record<string, unknown>;
  fails?: boolean;
};

export type CaseResult = { name: string; ok: boolean; path: string[]; run: Run; why?: string };

const waiting = (run: Run) =>
  run.rows.find((row: Row): row is AskRow => !("left" in row) && row.state === "waiting");

/** Runs one case: every ask, a model's as well as a person's, is answered from the case. */
export async function play(wizard: Wizard, sandbox: Sandbox, c: Case) {
  const left = [...c.answers];
  const take = (step: string) => {
    const [[id, answer]] = Object.entries(left.shift() ?? { "nothing more": {} });
    if (id !== step) throw new Error(`The case answers "${id}", the run asks "${step}".`);
    return answer;
  };
  const types = new Set<string>();
  const batteries = new Proxy(
    {},
    {
      get: (_, type: string) =>
        types.has(type) ? async (row: AskRow) => take(row.step) : undefined,
    },
  );
  for (const type of ["agent", "tool", "generate"]) types.add(type);
  const kernel = createKernel({ store: memoryStore(), sandbox, wizards: () => wizard, batteries });
  let run = await kernel.start("case", c.input);
  for (let row = waiting(run); run.status === "waiting" && row; row = waiting(run)) {
    run = await kernel.answer(run.id, row.n, take(row.step), row.role);
  }
  return { run, kernel, left };
}

/** Runs the cases, and lists the edges of the map none of them takes. */
export async function check(wizard: Wizard, sandbox: Sandbox, cases: Case[]) {
  const taken = new Set<string>();
  const results: CaseResult[] = [];
  for (const c of cases) {
    try {
      const { run, left } = await play(wizard, sandbox, c);
      const leaves = run.rows.filter((row) => "left" in row);
      for (const row of leaves) taken.add(`${row.step} > ${row.to}`);
      const path = [
        ...leaves.map((row) => row.step),
        ...(run.status === "failed" && run.cursor ? [run.cursor] : []),
      ];
      const why =
        left.length > 0
          ? `${left.length} answers were never asked for.`
          : c.fails
            ? run.status !== "failed"
              ? `It should fail and is ${run.status}.`
              : undefined
            : run.status !== "done"
              ? `It is ${run.status}: ${run.error}`
              : Object.entries(c.expect ?? {})
                  .filter(([name, value]) => run.output?.[name] !== value)
                  .map(([name]) => `"${name}" is ${JSON.stringify(run.output?.[name])}.`)[0];
      results.push({ name: c.name, ok: !why, path, run, why });
    } catch (error) {
      results.push({
        name: c.name,
        ok: false,
        path: [],
        run: undefined as never,
        why: String(error),
      });
    }
  }
  const edges = Object.entries(wizard.file.edges).flatMap(([from, tos]) =>
    tos.map((to) => `${from} > ${to}`),
  );
  return { issues: describe(wizard), results, untaken: edges.filter((edge) => !taken.has(edge)) };
}
