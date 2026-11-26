import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskRow, Row } from "@engenty/wizards-kernel";
import { type KernelFile, kernelShell } from "@engenty/wizards-shared/kernel-file";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "wizards-kernel-views-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "runner";
process.env.FEATURES = "durableRuns=on,kernel=on";
process.env.RUNNER_CLOCK_MS = "100";
process.env.KERNEL_STEPS = "quickjs";

/**
 * Views of a run in version 0.3.0 (docs/plans/kernel.md, C.11): an ask carries components and the
 * values they read, and the run's page gets both.
 */
const summary = [
  { id: "root", component: "Column", children: ["sum"] },
  { id: "sum", component: "Text", text: { path: "/total" } },
];
const asked: { id: string; type: string; output?: unknown; data?: unknown }[] = [];
vi.mock("../src/engine/steps.js", async (original) => {
  const real = await original<typeof import("../src/engine/steps.js")>();
  return {
    ...real,
    runAutomaticStep: async (step: { id: string; type: string; output?: unknown; data?: unknown }, ctx: never) => {
      asked.push({ id: step.id, type: step.type, output: step.output, data: step.data });
      // A surface is the engine's own work: it reads its data and checks its components.
      if (step.type === "surface") {
        return real.runAutomaticStep(step as never, ctx);
      }
      return { json: { total: 12 }, surface: { components: summary, data: { total: 12 } }, at: new Date().toISOString() };
    },
  };
});
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
  missingConnectionsSaid: async () => [],
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

let client: typeof import("../src/db/client");
let runner: typeof import("../src/engine/runner");
let wizards: typeof import("../src/services/wizards");
let files: typeof import("../src/services/files");
let views: typeof import("../src/kernel/views");
let page: typeof import("../src/kernel/page");

const T = "tenant-kernel-views";
const layout = `[
    { id: "root", component: "Column", children: ["sum", "ok"] },
    { id: "sum", component: "Text", text: { path: "/total" } },
    { id: "ok", component: "Field", name: "ok" },
  ]`;
const file = (edges: Record<string, string[]>, start: string) => ({
  version: "0.3.0",
  title: "Views",
  description: "",
  requires: { models: ["standard"] },
  start,
  edges,
  output: {},
});

type Made = { id: string; files: unknown[]; file: unknown };
async function wizard(its: unknown, steps: Record<string, string>): Promise<Made> {
  return client.withTenant(T, async () => {
    const created = await wizards.createWizard("u", { definition: kernelShell(its as never) as never });
    await files.seedFiles(created.id, steps);
    return { id: created.id, files: await files.draftFiles(created.id), file: its };
  });
}
const start = (w: Made) =>
  client.withTenant(T, () =>
    runner.createRun({ wizardId: w.id, definition: kernelShell(w.file as never) as never, files: w.files as never, version: null, mode: "test", userId: "u", input: {} }),
  );
const run = (id: string) =>
  client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
const shown = async (id: string) => {
  const row = await run(id);
  return client.withTenant(T, () => runner.runView(row as never, { name: "Test" } as never));
};
async function rests(id: string, ...statuses: string[]) {
  for (let i = 0; i < 200; i++) {
    const row = await run(id);
    if (row && statuses.includes(row.status) && !row.driving) {
      return row;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const row = await run(id);
  throw new Error(`Run ${id} is ${row?.status} (${row?.error ?? "no error"}), not ${statuses.join(" or ")}.`);
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  runner = await import("../src/engine/runner");
  wizards = await import("../src/services/wizards");
  files = await import("../src/services/files");
  views = await import("../src/kernel/views");
  page = await import("../src/kernel/page");
  runner.startRunner();
});
afterAll(async () => {
  await runner.stopRunner();
});

describe("the view of an ask, checked when it is asked for", () => {
  const fields = [{ id: "ok", label: "OK", kind: "text" }];
  const form = { type: "form", fields, components: [{ id: "root", component: "Column", children: ["ok"] }, { id: "ok", component: "Field", name: "ok" }] };

  it("takes a form's layout that places its fields and reads its data", () => {
    expect(views.viewIssue(form)).toBeUndefined();
    expect(views.viewIssue({ type: "form", fields })).toBeUndefined();
    const reads = [...form.components.slice(0, 1).map((c) => ({ ...c, children: ["ok", "sum"] })), form.components[1], summary[1]];
    expect(views.viewIssue({ ...form, components: reads, data: { total: 12 } })).toBeUndefined();
    expect(views.viewIssue({ ...form, components: reads })).toContain("total");
  });

  it("takes a number worked out from the form's fields while the person types", () => {
    const priced = [
      { id: "amount", label: "Amount", kind: "number" },
      { id: "rate", label: "Rate", kind: "number" },
    ];
    const components = [
      { id: "root", component: "Column", children: ["amount", "rate", "total"] },
      { id: "amount", component: "Field", name: "amount" },
      { id: "rate", component: "Field", name: "rate" },
      { id: "total", component: "Text", text: { calc: "amount * rate * (1 + vat / 100)" } },
    ];
    expect(views.viewIssue({ type: "form", fields: priced, components, data: { vat: 20 } })).toBeUndefined();
    expect(views.viewIssue({ type: "form", fields: priced, components })).toContain("vat");
  });

  it("says what is wrong with a view", () => {
    expect(views.viewIssue({ ...form, components: [{ id: "root", component: "Nope" }] })).toContain("The view:");
    expect(views.viewIssue({ type: "form", fields, data: { total: 1 } })).toBe('An ask reads "data" only with "components".');
    expect(views.viewIssue({ ...form, data: { ok: 1 } })).toContain('"ok" is also a field');
    expect(views.viewIssue({ type: "review", components: summary })).toContain("total");
    expect(views.viewIssue({ type: "review", components: summary, data: { total: 3 } })).toBeUndefined();
  });

  it("leaves an ask a machine answers to its step executor", () => {
    expect(views.viewIssue({ type: "agent", components: [{ id: "x", component: "Nope" }] })).toBeUndefined();
  });
});

describe("a run of version 0.3.0 on its page, with views", () => {
  const its = { version: "0.3.0", title: "V", description: "", start: "sum", edges: { sum: ["check"], check: ["end"] } } as unknown as KernelFile;
  const row = { id: "r", definition: kernelShell(its), updatedAt: new Date(0) } as never;
  const of = (rows: Row[], cursor: string) => ({
    id: "r",
    status: "waiting_input" as const,
    cursor,
    rows,
    waiting: rows.filter((r): r is AskRow => !("left" in r) && r.state === "waiting"),
    scores: [],
    rev: 0,
  });

  it("shows the view a step returned with its data in place of a table", () => {
    const left = { n: 0, step: "sum", left: true, value: { total: 12, surface: { components: summary, data: { total: 12 } } }, to: "check" } as unknown as Row;
    const projected = page.kernelPage(row, of([left], "check"));
    expect(projected.state.outputs.sum).toMatchObject({ json: { total: 12 }, surface: { components: summary, data: { total: 12 } } });
  });

  it("puts a review's own view first among what it shows", () => {
    const review = { n: 0, step: "check", role: "user", type: "review", approve: true, components: summary, data: { total: 7 }, state: "waiting" } as unknown as AskRow;
    const projected = page.kernelPage(row, of([review], "check"));
    const step = projected.definition.steps.find((s) => s.id === "check") as { show: string[] };
    expect(step.show).toEqual(["check__view"]);
    expect(projected.state.outputs.check__view.surface).toEqual({ components: summary, data: { total: 7 } });
  });

  it("leaves the file's first page its references", () => {
    const first = { n: 0, step: "input", role: "user", type: "form", fields: [{ id: "a", label: "A", kind: "text" }], components: [], data: { name: "brand.name" }, state: "waiting" } as unknown as AskRow;
    const projected = page.kernelPage(row, of([first], "input"));
    expect((projected.definition.steps.find((s) => s.id === "input") as { data: unknown }).data).toEqual({ name: "brand.name" });
  });
});

describe("a run of version 0.3.0 whose steps carry views", () => {
  it("gives the page a form's layout and the values it reads", async () => {
    const w = await wizard(file({ confirm: ["end"] }, "confirm"), {
      "steps/confirm.ts": `export default async (run, ask) => ({
  value: await ask({ type: "form", title: "Confirm", fields: [{ id: "ok", label: "OK", kind: "text", required: true }], components: ${layout}, data: { total: 3 * 14, lines: [{ name: "Workshop", price: 42 }] } }),
});
`,
    });
    const id = await start(w);
    await rests(id, "waiting_input");
    const view = await shown(id);
    expect((view.step as { components?: unknown[] }).components).toHaveLength(3);
    // the values the step worked out, not the names of where to read them
    expect(view.pageData).toEqual({ total: 42, lines: [{ name: "Workshop", price: 42 }] });
  });

  it("fails a step that asks with a view the catalog does not know, and says why", async () => {
    const w = await wizard(file({ confirm: ["end"] }, "confirm"), {
      "steps/confirm.ts": `export default async (run, ask) => ({
  value: await ask({ type: "form", title: "Confirm", fields: [{ id: "ok", label: "OK", kind: "text" }], components: [{ id: "root", component: "Column", children: ["gone"] }] }),
});
`,
    });
    const id = await start(w);
    const failed = await rests(id, "failed");
    expect(failed.error).toContain('"confirm" asked for what cannot be shown or done here. The view:');
  });

  it("keeps the view an agent's answer brings, for the review that shows the step", async () => {
    asked.length = 0;
    const w = await wizard(file({ sum: ["check"], check: ["end"] }, "sum"), {
      "steps/sum.ts": `export default async (run, ask) => ({
  value: await ask({ type: "agent", model: "standard", instructions: "Add it up.", fields: [{ id: "total", label: "Total", kind: "number", required: true }], surface: ${JSON.stringify(summary)} }),
});
`,
      "steps/check.ts": `export default async (run, ask) => ({ value: await ask({ type: "review", show: ["sum"], approve: true }) });
`,
    });
    const id = await start(w);
    await rests(id, "waiting_input");
    // the ask became an agent step whose output has the view
    expect(asked.find((s) => s.id === "sum")?.output).toMatchObject({ format: "json", surface: summary });
    const view = await shown(id);
    expect(view.shown[0]?.output).toMatchObject({ json: { total: 12 }, surface: { components: summary, data: { total: 12 } } });
  });

  it("gives a surface the values its step worked out", async () => {
    asked.length = 0;
    const w = await wizard(file({ sheet: ["check"], check: ["end"] }, "sheet"), {
      "steps/sheet.ts": `export default async (run, ask) => ({
  value: await ask({ type: "surface", title: "Sheet", components: ${JSON.stringify(summary)}, data: { total: 2 + 3 } }),
});
`,
      "steps/check.ts": `export default async (run, ask) => ({ value: await ask({ type: "review", show: ["sheet"], approve: true }) });
`,
    });
    const id = await start(w);
    await rests(id, "waiting_input");
    const view = await shown(id);
    expect(view.shown[0]?.output?.surface).toEqual({ components: summary, data: { total: 5 } });
  });
});
