import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { type Case, check, play } from "./check.js";
import { compileWizard } from "./compile.js";
import { createKernel } from "./kernel.js";
import { memoryStore } from "./memory.js";
import { quickjsTurn } from "./quickjs.js";
import type { AskRow, Wizard } from "./types.js";

/**
 * The second way to run a step: the same wizards, their steps compiled and run in QuickJS. A
 * step that only computes and asks behaves the same in both.
 */
let offer: Wizard;
let mail: Wizard;
let cases: Case[];
const turn = quickjsTurn();

beforeAll(async () => {
  offer = await compileWizard(new URL("../examples/offer/", import.meta.url).pathname);
  mail = await compileWizard(new URL("../examples/mail/", import.meta.url).pathname);
  cases = JSON.parse(await readFile(new URL("../test/offer.cases.json", import.meta.url), "utf8"));
});

const script = (body: string) => `var __step = { default: ${body} };`;
const one = (body: string): Wizard => ({
  file: { title: "One", start: "only", edges: { only: ["end"] }, output: { out: "only" } },
  steps: { only: script(body) },
});
const run = async (body: string, batteries = {}) => {
  const kernel = createKernel({ store: memoryStore(), wizards: () => one(body), batteries, turn });
  return { kernel, run: await kernel.start("one", {}) };
};

it("passes the offer wizard's ten tests, and they take every edge", async () => {
  const { results, untaken } = await check(offer, cases, turn);
  expect(results.map((r) => [r.name, r.why])).toEqual(cases.map((c) => [c.name, undefined]));
  expect(untaken).toEqual([]);
});

it("runs the mail wizard, the message built inside the sandbox", async () => {
  const sent: unknown[] = [];
  const kernel = createKernel({
    store: memoryStore(),
    wizards: () => mail,
    turn,
    batteries: {
      agent: async () => ({
        to: "a@b.example",
        subject: "Re: Hi",
        threadId: "thr_1",
        draft: "Dear",
      }),
      tool: async (row: AskRow) => {
        sent.push(row.input);
        return { id: "msg_2" };
      },
    },
  });
  let r = await kernel.start("mail", { customer: "N" });
  const waiting = () => (r.rows as AskRow[]).findLast((row) => row.state === "waiting") as AskRow;
  r = await kernel.answer(r.id, waiting().n, { approved: true });
  r = await kernel.answer(r.id, waiting().n, { allow: true });
  expect(r).toMatchObject({ status: "done", output: { sent: "msg_2" } });
  const raw = (sent[0] as { body: { raw: string } }).body.raw;
  expect(Buffer.from(raw, "base64url").toString()).toBe(
    "To: a@b.example\r\nSubject: Re: Hi\r\n\r\nDear",
  );
});

it("gives a step that runs again the same clock and the same chance", async () => {
  const body =
    "async (run, ask) => { const before = [Date.now(), Math.random()]; await ask({ type: 'form' }); return { value: { before, after: [Date.now(), Math.random()] } }; }";
  const first = await run(body);
  const done = await first.kernel.answer(first.run.id, 0, {});
  const { before, after } = done.output?.out as { before: number[]; after: number[] };
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]); // the second draw of the same series
  const again = await first.kernel.rewind(done.id, 0, {});
  expect(again.output?.out).toEqual({ before, after });
});

it("has btoa and atob, as every other place a step runs in", async () => {
  const { run: done } = await run(
    "async () => ({ value: ['', 'a', 'ab', 'abc', 'Dear \\u00e4'].map((t) => [btoa(t), atob(btoa(t)) === t]) })",
  );
  expect(done.output?.out).toEqual(
    ["", "a", "ab", "abc", "Dear \u00e4"].map((t) => [
      Buffer.from(t, "latin1").toString("base64"),
      true,
    ]),
  );
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

it("stops a step that never ends, and one that takes all the memory", async () => {
  const { run: loop } = await run("async () => { for (;;) {} }");
  expect(loop).toMatchObject({ status: "failed", error: "interrupted" });
  const { run: greedy } = await run(
    "async () => { const all = []; for (;;) all.push(new Array(1e5).fill(1)); }",
  );
  expect(greedy.status).toBe("failed");
  // the sandbox is still good for the next run
  expect((await run("async () => ({ value: 1 })")).run.output?.out).toBe(1);
});

it("refuses a step that is not compiled, and ordinary code refuses a compiled one", async () => {
  const plain = createKernel({ store: memoryStore(), wizards: () => one("async () => ({})") });
  expect((await plain.start("one", {})).error).toContain("compiled script");
  const boxed = createKernel({
    store: memoryStore(),
    turn,
    wizards: () => ({ ...one(""), steps: { only: async () => ({}) } }),
  });
  expect((await boxed.start("one", {})).error).toContain("not compiled");
});

it("does not compile a step that imports one of Node's own modules", async () => {
  const { compileStep } = await import("./compile.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp("/tmp/kernel-compile-");
  await writeFile(
    `${dir}/bad.ts`,
    'import { readFileSync } from "node:fs";\nexport default async () => ({ value: readFileSync("/etc/passwd", "utf8") });\n',
  );
  await expect(compileStep(`${dir}/bad.ts`)).rejects.toThrow(/node:fs/);
});
