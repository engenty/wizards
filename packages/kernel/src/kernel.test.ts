import { readFile } from "node:fs/promises";
import { beforeAll, expect, it, describe as suite } from "vitest";
import { type Case, check, play } from "./check";
import { loadWizard } from "./compile";
import { describe } from "./describe";
import { createKernel } from "./kernel";
import { memoryStore } from "./memory";
import { nodeSandbox } from "./node";
import type { AskRow, Sandbox, Wizard } from "./types";

const dir = new URL("../examples/offer/", import.meta.url).pathname;
let wizard: Wizard;
let sandbox: Sandbox;
let cases: Case[];

beforeAll(async () => {
  wizard = await loadWizard(dir);
  sandbox = nodeSandbox();
  cases = JSON.parse(await readFile(`${dir}cases.json`, "utf8"));
});

const named = (name: string) => cases.find((c) => c.name === name) as Case;
const withStep = (id: string, body: string): Wizard => ({
  ...wizard,
  steps: { ...wizard.steps, [id]: `var __step = { default: ${body} };` },
});

suite("the offer wizard", () => {
  it("fits its map", () => {
    expect(describe(wizard)).toEqual([]);
  });

  it("passes its ten cases, and they take every edge of the map", async () => {
    const { results, untaken } = await check(wizard, sandbox, cases);
    expect(results.map((r) => [r.name, r.why])).toEqual(cases.map((c) => [c.name, undefined]));
    expect(untaken).toEqual([]);
    expect(
      Object.fromEntries(results.map((r) => [r.name, r.path.join(" > ")])),
    ).toMatchInlineSnapshot(`
      {
        "Always over budget": "offer > offer > offer > offer > check > accept > signed",
        "Large, within budget": "offer > legal > check > accept > signed",
        "Legal says no once": "offer > legal > offer > legal > check > accept > signed",
        "Legal says no three times": "offer > legal > offer > legal > offer > legal > offer > legal",
        "Operator says no once": "offer > check > offer > check > accept > signed",
        "Operator says no three times": "offer > check > offer > check > offer > check > offer > check",
        "Over budget once": "offer > offer > check > accept > signed",
        "Small, no signature": "offer > check > accept > signed > chase",
        "Small, signed": "offer > check > accept > signed",
        "User declines": "offer > check > accept",
      }
    `);
  });

  it("stops a step that is reached more often than the file allows", async () => {
    const { run } = await play(wizard, sandbox, named("Legal says no three times"));
    expect(run).toMatchObject({
      status: "failed",
      error: '"legal" was reached more than 3 times.',
    });
  });

  it("tells a rewrite why it is one", async () => {
    const { run } = await play(wizard, sandbox, named("Legal says no once"));
    const offers = run.rows.filter((row) => row.step === "offer" && !("left" in row)) as AskRow[];
    expect(String(offers[1].instructions).split("\n").at(-1)).toBe(
      "The legal step said: Add the liability clause.",
    );
  });
});

suite("the map", () => {
  it("is checked without a run", () => {
    const broken: Wizard = {
      file: { ...wizard.file, edges: { ...wizard.file.edges, legal: ["check", "offr"] } },
      steps: { ...wizard.steps, extra: wizard.steps.chase },
    };
    expect(describe(broken)).toEqual([
      'The map names "offr", there is no steps/offr.',
      "No way leads to steps/extra.",
    ]);
  });

  it("fails a run that leaves a step by a way it does not have", async () => {
    const { run } = await play(
      withStep("accept", 'async () => ({ to: "chase" })'),
      sandbox,
      named("Small, signed"),
    );
    expect(run).toMatchObject({ status: "failed", error: '"accept" may not go to "chase".' });
  });
});

suite("the grant", () => {
  it("fails an ask for a tool the file does not list", async () => {
    const greedy = withStep("offer", '(run, ask) => ask({ type: "agent", tools: ["gmail.send"] })');
    const { run } = await play(greedy, sandbox, { ...named("Small, signed"), answers: [] });
    expect(run).toMatchObject({
      status: "failed",
      error: '"offer" reached for "gmail.send", which the file does not grant.',
    });
  });

  it("fails an ask to a role the file does not have", async () => {
    const { run } = await play(
      withStep("offer", '(run, ask) => ask({ type: "review", role: "finance" })'),
      sandbox,
      { ...named("Small, signed"), answers: [] },
    );
    expect(run.error).toBe('"offer" reached for "finance", which the file does not grant.');
  });
});

suite("the sandbox", () => {
  const one = (body: string): Wizard => ({
    file: { title: "One", start: "only", edges: { only: ["end"] }, output: { out: "only" } },
    steps: { only: `var __step = { default: ${body} };` },
  });
  const run = async (body: string, batteries = {}) => {
    const kernel = createKernel({
      store: memoryStore(),
      sandbox,
      wizards: () => one(body),
      batteries,
    });
    return { kernel, run: await kernel.start("one", {}) };
  };

  it("gives a step that runs again the same clock and the same chance", async () => {
    const body =
      "async (run, ask) => { const before = [Date.now(), Math.random()]; await ask({ type: 'form' }); return { value: { before, after: [Date.now(), Math.random()] } }; }";
    const first = await run(body);
    const done = await first.kernel.answer(first.run.id, 0, {});
    const { before, after } = done.output?.out as { before: number[]; after: number[] };
    expect(before[0]).toBe(done.startedAt);
    expect(after[0]).toBe(done.startedAt);
    expect(after[1]).not.toBe(before[1]); // the second draw of the same series
    const again = await first.kernel.rewind(done.id, 0, {});
    expect(again.output?.out).toEqual({ before, after });
  });

  it("has no way out: no fetch, no process, no require, no timers", async () => {
    const { run: done } = await run(
      "async () => ({ value: [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof globalThis.Deno] })",
    );
    expect(done.output?.out).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  it("stops a step that never ends", async () => {
    const started = Date.now();
    const { run: lost } = await run("async () => { for (;;) {} }");
    expect(lost).toMatchObject({ status: "failed", error: "interrupted" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops a step that takes all the memory", async () => {
    const { run: lost } = await run(
      "async () => { const all = []; for (;;) all.push(new Array(1e5).fill(1)); }",
    );
    expect(lost).toMatchObject({ status: "failed" });
    // the sandbox is still good for the next run
    expect((await run("async () => ({ value: 1 })")).run.output?.out).toBe(1);
  });

  it("fails the run when a step throws", async () => {
    const { run: lost } = await run("async () => { throw new Error('no'); }");
    expect(lost).toMatchObject({ status: "failed", error: "no" });
  });

  it("asks side by side and waits for all of them", async () => {
    const body =
      "async (run, ask) => ({ value: await Promise.all(['a', 'b', 'c'].map((name) => ask({ type: name === 'b' ? 'form' : 'agent', name }))) })";
    const { kernel, run: first } = await run(body, {
      agent: async (row: AskRow) => `${row.name}!`,
    });
    expect(first.status).toBe("waiting");
    expect(first.rows.map((row) => (row as AskRow).state)).toEqual(["done", "waiting", "done"]);
    const done = await kernel.answer(first.id, 1, "b?");
    expect(done.output?.out).toEqual(["a!", "b?", "c!"]);
  });

  it("lets a step catch a failed ask", async () => {
    const body =
      "async (run, ask) => { try { await ask({ type: 'agent' }); } catch (error) { return { value: 'caught: ' + error.message }; } }";
    const { run: done } = await run(body, {
      agent: async () => {
        throw new Error("the model is down");
      },
    });
    expect(done.output?.out).toBe("caught: the model is down");
  });
});

suite("a run", () => {
  it("resumes from its cursor and rows alone, on a kernel that never saw it", async () => {
    const store = memoryStore();
    const make = () =>
      createKernel({
        store,
        sandbox,
        wizards: () => wizard,
        batteries: { agent: async () => ({ text: "…", price: 3000 }) },
      });
    const first = await make().start("offer", named("Small, signed").input);
    expect(first).toMatchObject({ status: "waiting", cursor: "check" });
    const second = await make().answer(first.id, 2, { approved: true }, "operator");
    expect(second).toMatchObject({ status: "waiting", cursor: "accept" });
  });

  it("refuses a second answer to the same row, and a save over someone else's", async () => {
    const store = memoryStore();
    const kernel = createKernel({
      store,
      sandbox,
      wizards: () => wizard,
      batteries: { agent: async () => ({ text: "…", price: 3000 }) },
    });
    const run = await kernel.start("offer", named("Small, signed").input);
    await kernel.answer(run.id, 2, { approved: true });
    await expect(kernel.answer(run.id, 2, { approved: false })).rejects.toThrow(
      "Row 2 does not wait for an answer.",
    );
    await expect(store.save(run)).rejects.toThrow("Someone else moved this run.");
  });

  it("refuses an answer that lacks a required field", async () => {
    const one: Wizard = {
      file: { title: "One", start: "only", edges: { only: ["end"] } },
      steps: {
        only: "var __step = { default: (run, ask) => ask({ type: 'form', fields: [{ id: 'topic', kind: 'text', required: true }] }) };",
      },
    };
    const kernel = createKernel({ store: memoryStore(), sandbox, wizards: () => one });
    const run = await kernel.start("one", {});
    await expect(kernel.answer(run.id, 0, {})).rejects.toThrow('"topic" is missing.');
    expect(await kernel.answer(run.id, 0, { topic: "replay" })).toMatchObject({ status: "done" });
    await expect(
      createKernel({ store: memoryStore(), sandbox, wizards: () => wizard }).start("offer", {}),
    ).rejects.toThrow('"customer" is missing.');
  });

  it("rewinds: an answer changed on a finished run, and the run goes on from there", async () => {
    const { run: done, kernel } = await play(wizard, sandbox, named("Small, signed"));
    expect(done.status).toBe("done");
    const yes = done.rows.find((row) => row.step === "check" && !("left" in row)) as AskRow;
    const back = await kernel
      .rewind(done.id, yes.n, { approved: false, note: "Shorter." })
      .catch((error) => error);
    // the case has no further answer for the model, so the rewritten offer's ask fails the run there
    expect(
      back.rows.filter((row: { left?: true }) => row.left).map((row: { step: string }) => row.step),
    ).toEqual(["offer", "check"]);
    expect(back.cursor).toBe("offer");
  });

  it("answers a row whose time has come with a timeout", async () => {
    let clock = Date.parse("2026-11-14");
    const kernel = createKernel({
      store: memoryStore(),
      sandbox,
      wizards: () => wizard,
      now: () => clock,
      batteries: { agent: async () => ({ text: "…", price: 8400 }) },
    });
    const first = await kernel.start("offer", { ...named("Large, within budget").input });
    expect(first).toMatchObject({
      status: "waiting",
      cursor: "legal",
      wakeAt: clock + 3 * 86400e3,
    });
    expect((await kernel.wake(first.id)).rows).toHaveLength(first.rows.length); // too early: nothing moves
    clock += 4 * 86400e3;
    const later = await kernel.wake(first.id);
    expect(later.rows.filter((row) => "left" in row).map((row) => row.step)).toEqual([
      "offer",
      "legal",
      "offer",
    ]);
    expect(later).toMatchObject({ status: "waiting", cursor: "legal" });
    const rewrite = later.rows.filter(
      (row) => row.step === "offer" && !("left" in row),
    )[1] as AskRow;
    expect(String(rewrite.instructions).split("\n").at(-1)).toBe(
      "The legal step said: no answer in time",
    );
  });

  it("takes new code at its next step", async () => {
    const store = memoryStore();
    let current = wizard;
    const kernel = createKernel({
      store,
      sandbox,
      wizards: () => current,
      batteries: { agent: async () => ({ text: "…", price: 3000 }) },
    });
    const run = await kernel.start("offer", named("Small, signed").input);
    current = withStep(
      "accept",
      'async (run, ask) => { await ask({ type: "review", title: "New wording" }); return { to: "end" }; }',
    );
    const next = await kernel.answer(run.id, 2, { approved: true });
    expect(next.rows.at(-1)).toMatchObject({
      step: "accept",
      title: "New wording",
      state: "waiting",
    });
  });
});
