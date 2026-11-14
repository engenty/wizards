import { readdir } from "node:fs/promises";
import { parse } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Run } from "./types";

/**
 * A wizard as a Worker of its own: the kernel, the wizard's file and its step files bundled into
 * one script for workerd, each run a Durable Object. Nothing is evaluated at run time. The model
 * is a stand-in that always writes an offer of 8,400.
 */
const here = new URL(".", import.meta.url).pathname;
const offer = new URL("../examples/offer/", import.meta.url).pathname;
let worker: Miniflare;
let size = 0;

beforeAll(async () => {
  const steps = (await readdir(`${offer}steps`)).map((name) => parse(name).name);
  const entry = `
    import { runObject } from "${here}edge";
    import file from "${offer}wizard.json";
    ${steps.map((id) => `import ${id} from "${offer}steps/${id}";`).join("\n")}
    import tone from "${offer}evals/offer/tone";
    import withinBudget from "${offer}evals/offer/within-budget";
    import signedAtEnd from "${offer}evals/end/signed";

    const WIZARDS = {
      offer: {
        file,
        steps: { ${steps.join(", ")} },
        evals: { offer: { tone, "within-budget": withinBudget }, end: { signed: signedAtEnd } },
      },
      nap: {
        file: { title: "Nap", start: "nap", edges: { nap: ["end"] }, output: { woke: "nap.timedOut" } },
        steps: { nap: async (run, ask) => ({ value: await ask({ type: "wait", timeout: "1s" }) }) },
      },
    };

    export const RunObject = runObject({
      wizards: (id) => WIZARDS[id],
      batteries: {
        agent: async (row) =>
          row.step === "offer" ? { text: "An offer", price: 8400 } : row.step === "offer/tone" ? { score: 0.8 } : { mail: "A reminder" },
      },
    });

    export default {
      fetch(request, env) {
        const [, run, ...rest] = new URL(request.url).pathname.split("/");
        const object = env.RUNS.get(env.RUNS.idFromName(run));
        return object.fetch(new Request("https://run/" + rest.join("/"), request));
      },
    };`;
  const out = await build({
    stdin: { contents: entry, resolveDir: here, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    conditions: ["workerd", "worker", "browser"],
  });
  size = out.outputFiles[0].text.length;
  worker = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.js", contents: out.outputFiles[0].text }],
    compatibilityDate: "2025-09-01",
    durableObjects: { RUNS: { className: "RunObject", useSQLite: true } },
  });
  await worker.ready;
});

afterAll(() => worker?.dispose());

const call = async (run: string, path = "", body?: unknown): Promise<Run & { error?: string }> => {
  const response = await worker.dispatchFetch(
    `https://kernel/${run}/${path}`,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  return (await response.json()) as Run;
};

const input = {
  customer: "Nordlicht GmbH",
  email: "einkauf@nordlicht.example",
  budget: 9000,
  items: [{ name: "Workshop", price: 1500, quantity: 2 }],
};
const waiting = (run: Run) =>
  run.rows.findIndex((row) => !("left" in row) && row.state === "waiting");

it("runs the offer wizard in a Durable Object, one request per answer", async () => {
  let run = await call("a", "start", { wizard: "offer", input });
  expect(run).toMatchObject({ status: "waiting", cursor: "legal" });
  expect(run.wakeAt).toBeGreaterThan(Date.now());

  run = await call("a", "answer", {
    row: waiting(run),
    value: { approved: false, note: "Add the liability clause." },
    by: "legal",
  });
  expect(run).toMatchObject({ status: "waiting", cursor: "legal" });
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "legal" });
  expect(run.cursor).toBe("check");
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "operator" });
  run = await call("a", "answer", { row: waiting(run), value: { approved: true }, by: "user" });
  expect(run.cursor).toBe("signed");
  run = await call("a", "answer", { row: waiting(run), value: { came: true } });

  expect(run).toMatchObject({
    status: "done",
    output: { offer: "An offer", price: 8400, signed: true },
  });
  expect(run.rows.filter((row) => "left" in row).map((row) => row.step)).toEqual([
    "offer",
    "legal",
    "offer",
    "legal",
    "check",
    "accept",
    "signed",
  ]);
  expect(await call("a")).toEqual(run); // read back from the object's storage

  const judged = await call("a", "judge", {});
  expect(judged.scores?.map((score) => [score.eval, score.score])).toEqual([
    ["offer/tone", 0.8],
    ["offer/within-budget", 1],
    ["offer/tone", 0.8],
    ["offer/within-budget", 1],
    ["end/signed", 1],
  ]);
});

it("keeps runs apart, and refuses what the kernel refuses", async () => {
  const b = await call("b", "start", { wizard: "offer", input });
  expect(b.rows).toHaveLength(3);
  expect((await call("b", "answer", { row: 0, value: {} })).error).toBe(
    "Row 0 does not wait for an answer.",
  );
  expect((await call("c", "start", { wizard: "offer", input: {} })).error).toBe(
    '"customer" is missing.',
  );
});

it("wakes a run by the object's alarm", async () => {
  const run = await call("n", "start", { wizard: "nap", input: {} });
  expect(run.status).toBe("waiting");
  await expect
    .poll(async () => (await call("n")).status, { timeout: 10_000, interval: 250 })
    .toBe("done");
  expect((await call("n")).output).toEqual({ woke: true });
});

it("is a small script: the kernel, the wizard and its steps", () => {
  expect(size).toBeGreaterThan(1000);
  expect(size).toBeLessThan(40_000);
});
