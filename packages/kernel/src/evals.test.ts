import { beforeAll, expect, it } from "vitest";
import { describe } from "./describe";
import { evaluate, reask } from "./evals";
import { createKernel } from "./kernel";
import { loadWizard } from "./load";
import { memoryStore } from "./memory";
import type { AskRow, Battery, Eval, Run, Wizard } from "./types";

let wizard: Wizard;

beforeAll(async () => {
  wizard = await loadWizard(new URL("../examples/offer/", import.meta.url).pathname);
});

/** A stand-in for the model: writes offers at the prices given, one after the other, and judges tone. */
const model = (prices: number[], tone = 0.8): Record<string, Battery> => {
  const left = [...prices];
  return {
    agent: async (row: AskRow) =>
      row.step === "offer"
        ? { text: `An offer at ${left[0]}`, price: left.shift() }
        : row.step === "offer/tone"
          ? { score: tone, why: "Clear, a little stiff." }
          : { mail: "A reminder" },
  };
};

const input = (budget: number) => ({
  customer: "Nordlicht GmbH",
  email: "einkauf@nordlicht.example",
  budget,
  items: [{ name: "Workshop", price: 1500, quantity: 2 }],
});
const people = {
  check: [{ approved: true }],
  accept: [{ approved: true }],
  signed: [{ came: true }],
};
const brief = (run: Run) =>
  (run.scores ?? []).map((score) => `${score.eval}@${score.row} ${score.score ?? score.error}`);

it("loads a wizard's evals by what they judge", () => {
  expect(
    Object.fromEntries(
      Object.entries(wizard.evals ?? {}).map(([of, evals]) => [of, Object.keys(evals)]),
    ),
  ).toEqual({
    end: ["signed"],
    offer: ["tone", "within-budget"],
  });
  expect(describe(wizard)).toEqual([]);
  expect(describe({ ...wizard, evals: { offr: {} } })).toEqual([
    "evals/offr judges a step there is none of.",
  ]);
});

it("judges every time a step returned, and the run once it is done", async () => {
  const kernel = createKernel({
    store: memoryStore(),
    wizards: () => wizard,
    batteries: model([3000, 2100]),
  });
  let run = await kernel.start("offer", input(2000)); // over budget once, then within
  const rows = run.rows.length;
  run = await kernel.judge(run.id);
  expect(brief(run)).toEqual([
    "offer/tone@1 0.8",
    "offer/within-budget@1 0",
    "offer/tone@3 0.8",
    "offer/within-budget@3 1",
  ]);
  expect(run.scores?.[1].why).toBe("3000 against a budget of 2000");
  expect(run.scores?.[0].asks?.[0]).toMatchObject({
    step: "offer/tone",
    state: "done",
    answer: { score: 0.8 },
  });
  expect(String(run.scores?.[0].asks?.[0].instructions)).toContain("An offer at 3000"); // the offer as it stood then
  expect(run.rows).toHaveLength(rows); // judging does not touch the rows
  expect(run).toMatchObject({ status: "waiting", cursor: "check" });

  expect(brief(await kernel.judge(run.id))).toHaveLength(4); // nothing is judged twice

  for (const step of ["check", "accept", "signed"] as const) {
    const row = run.rows.findLast((r) => !("left" in r)) as AskRow;
    run = await kernel.answer(run.id, row.n, people[step][0]);
  }
  run = await kernel.judge(run.id);
  expect(brief(run).at(-1)).toBe(`end/signed@${run.rows.length - 1} 1`);
});

it("drops the scores of what a rewind takes back", async () => {
  const kernel = createKernel({
    store: memoryStore(),
    wizards: () => wizard,
    batteries: model([3000, 2100, 1900]),
  });
  const first = await kernel.judge((await kernel.start("offer", input(2000))).id);
  const back = await kernel.rewind(first.id, 2); // the second offer, asked again
  expect(brief(back)).toEqual(["offer/tone@1 0.8", "offer/within-budget@1 0"]);
  expect(brief(await kernel.judge(back.id)).slice(2)).toEqual([
    "offer/tone@3 0.8",
    "offer/within-budget@3 1",
  ]);
});

it("lets an eval only judge: no person to ask, no way to give, no score out of range", async () => {
  const evals = (odd: Eval<any>) => ({
    ...wizard,
    evals: { offer: { odd } },
  });
  const score = async (body: (...args: any[]) => Promise<any>) => {
    const kernel = createKernel({
      store: memoryStore(),
      wizards: () => evals(body as Eval<any>),
      batteries: model([3000]),
    });
    return (await kernel.judge((await kernel.start("offer", input(4000))).id)).scores?.[0];
  };
  expect((await score((_run, ask) => ask({ type: "review", role: "operator" })))?.error).toBe(
    'An eval may only ask what answers at once, not "operator".',
  );
  expect((await score(async () => ({ score: 7 })))?.error).toBe(
    "The score must be a number from 0 to 1, it is 7.",
  );
  expect(
    (await score((_run, ask) => ask({ type: "agent", tools: ["gmail.send"] })))?.error,
  ).toContain("which the file does not grant");
  expect(await score(async () => ({ score: 1, to: "end" }))).toEqual({
    eval: "offer/odd",
    row: 1,
    score: 1,
  });
});

it("runs a wizard over a dataset, for two models to compare", async () => {
  const dataset = [
    { name: "small", input: input(4000), answers: people },
    { name: "tight", input: input(2000), answers: people },
    { name: "nobody answers", input: input(4000) },
  ];
  const careful = await evaluate({ wizard, batteries: model([3000, 2100, 3000], 0.9) }, dataset);
  const careless = await evaluate(
    { wizard, batteries: model([3000, 3000, 3000, 3000, 3000, 3000], 0.6) },
    dataset,
  );

  expect(careful.runs.map(({ name, run }) => [name, run.status])).toEqual([
    ["small", "done"],
    ["tight", "done"],
    ["nobody answers", "waiting"],
  ]);
  expect(careful.summary).toMatchInlineSnapshot(`
    {
      "end/signed": {
        "errors": 0,
        "mean": 1,
        "scores": 2,
      },
      "offer/tone": {
        "errors": 0,
        "mean": 0.9,
        "scores": 3,
      },
      "offer/within-budget": {
        "errors": 0,
        "mean": 1,
        "scores": 3,
      },
    }
  `);
  expect(careless.summary["offer/within-budget"].mean).toBeLessThan(
    careful.summary["offer/within-budget"].mean as number,
  );
  expect(careless.summary["offer/tone"].mean).toBeCloseTo(0.6);
});

it("asks one ask of a past run again, with another model, and scores both", async () => {
  const kernel = createKernel({
    store: memoryStore(),
    wizards: () => wizard,
    batteries: model([3000, 3000, 3000, 3000]),
  });
  const past = await kernel.start("offer", input(2000)); // stayed over budget four times
  const last = past.rows.findLast((row) => row.step === "offer" && !("left" in row)) as AskRow;

  const { before, after, run } = await reask(
    { wizard, batteries: model([1900], 0.9) },
    past,
    last.n,
  );
  // both are judged by the judge of now, so the two scores compare
  expect(before.map((score) => [score.eval, score.score])).toEqual([
    ["offer/tone", 0.9],
    ["offer/within-budget", 0],
  ]);
  expect(after.map((score) => [score.eval, score.score])).toEqual([
    ["offer/tone", 0.9],
    ["offer/within-budget", 1],
  ]);
  expect(String((run.rows[last.n] as AskRow).instructions)).toBe(String(last.instructions)); // the same ask
  expect((await kernel.read(past.id)).rows).toEqual(past.rows); // the past run is as it was
});
