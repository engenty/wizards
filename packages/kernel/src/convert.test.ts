import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toKernel } from "@engenty/wizards-shared/convert-kernel";
import {
  kernelFileSchema,
  kernelIssues,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { afterAll, describe, expect, it } from "vitest";
import { compileStep } from "./compile.js";
import { createKernel } from "./kernel.js";
import { memoryStore } from "./memory.js";
import { quickjsTurn } from "./quickjs.js";
import type { AskRow, Battery, Field, Run, Wizard } from "./types.js";

/**
 * A wizard of version 1 converted to version 0.3.0 (docs/plans/kernel.md, item 22): the file fits its
 * step files, the step files compile, and the wizard runs in QuickJS with stand-ins.
 */
const turn = quickjsTurn();
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** The step files written to a folder and compiled, as a wizard the kernel takes. */
async function compiled(converted: ReturnType<typeof toKernel>): Promise<Wizard> {
  const dir = await mkdtemp(join(tmpdir(), "convert-"));
  dirs.push(dir);
  const steps: Record<string, string> = {};
  for (const [path, source] of Object.entries(converted.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), source);
    steps[path.slice("steps/".length, -".ts".length)] = await compileStep(join(dir, path));
  }
  return { file: converted.file as Wizard["file"], steps };
}

const convert = async (definition: unknown) => {
  const converted = toKernel(wizardSchema.parse(definition));
  expect(kernelFileSchema.safeParse(converted.file).error).toBeUndefined();
  expect(kernelIssues(converted.file, Object.keys(converted.files))).toEqual([]);
  return { ...converted, wizard: await compiled(converted) };
};

/** The row that waits for somebody: not one a battery answers once the user allowed it. */
const waiting = (run: Run, batteries: Record<string, Battery>) =>
  run.rows.find(
    (row): row is AskRow => !("left" in row) && row.state === "waiting" && !batteries[row.type],
  );
const pathOf = (run: Run) => run.rows.flatMap((row) => ("left" in row ? [row.step] : []));

/** Runs a wizard to its end: asks with a battery are answered by it, the others by `answer`. */
async function play(
  wizard: Wizard,
  input: Record<string, unknown> | undefined,
  batteries: Record<string, Battery>,
  answer: (row: AskRow) => unknown,
): Promise<Run> {
  const kernel = createKernel({ store: memoryStore(), wizards: () => wizard, batteries, turn });
  let run = await kernel.start("wizard", input);
  for (let asked = 0; asked < 300 && run.status === "waiting"; asked++) {
    const row = waiting(run, batteries);
    if (!row) break;
    run = await kernel.answer(run.id, row.n, answer(row));
  }
  return run;
}

const name = { id: "name", label: "Name", kind: "text", required: true };
const result = (more: object = {}) => ({
  id: "done",
  type: "result",
  title: "Done",
  deliverables: [],
  ...more,
});

describe("a hand-written wizard", () => {
  it("in a line: the first form is the input, the result is the output", async () => {
    const { file, files, wizard } = await convert({
      title: "Letter",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        {
          id: "write",
          type: "agent",
          title: "Write",
          model: "low",
          instructions: "Write to {{name}} on {{today}}. {{nothing}}",
          output: { format: "markdown" },
        },
        { id: "check", type: "review", title: "Check", show: ["write"] },
        result({
          deliverables: [{ from: "write", formats: ["pdf"] }],
          data: { letter: "steps.write" },
        }),
      ],
    });
    expect(file).toMatchObject({
      version: "0.3.0",
      requires: { models: ["low"] },
      input: { fields: [name] },
      start: "write",
      edges: { write: ["check"], check: ["end"] },
      output: { write: "write", letter: "write" },
    });
    expect(Object.keys(files)).toEqual(["steps/write.ts", "steps/check.ts"]);

    const asked: AskRow[] = [];
    const run = await play(
      wizard,
      { name: "Ada" },
      {
        agent: async (row) => {
          asked.push(row);
          return "Dear Ada";
        },
      },
      () => ({}),
    );
    expect(run.status).toBe("done");
    expect(pathOf(run)).toEqual(["write", "check"]);
    expect(run.output).toEqual({ write: "Dear Ada", letter: "Dear Ada" });
    expect(asked[0]).toMatchObject({ type: "agent", model: "low", format: "markdown" });
    expect(asked[0].instructions).toContain('Write to <data field="name">Ada</data> on ');
    expect(asked[0].instructions).toContain("{{nothing}}");
    expect(asked[0].instructions).toContain("### name\nAda");
  });

  it("a rule with a way back is taken as often as it may be", async () => {
    const { file, wizard } = await convert({
      title: "Offer",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        { id: "Draft", type: "agent", title: "Draft", instructions: "Offer for {{name}}." },
        {
          id: "check",
          type: "review",
          title: "Check",
          show: ["Draft"],
          approve: true,
          next: [
            {
              when: { field: "steps.check.approved", op: "eq", value: false },
              goto: "Draft",
              max: 2,
            },
          ],
        },
        result(),
      ],
    });
    expect(file.edges).toEqual({ draft: ["check"], check: ["end", "draft"] });
    expect(file.limits).toEqual({ draft: 3, check: 3 });

    const tasks: string[] = [];
    const agent: Battery = async (row) => {
      tasks.push(String(row.instructions));
      return `Version ${tasks.length}`;
    };
    const declined = await play(wizard, { name: "Ada" }, { agent }, () => ({ approved: false }));
    expect(declined.status).toBe("done");
    expect(pathOf(declined)).toEqual(["draft", "check", "draft", "check", "draft", "check"]);
    expect(tasks[1]).toContain("Build on what it made before");
    expect(tasks[1]).toContain("Version 1");

    const approved = await play(wizard, { name: "Ada" }, { agent }, () => ({ approved: true }));
    expect(pathOf(approved)).toEqual(["draft", "check"]);
  });

  it("onFail is the way a failed ask takes", async () => {
    const { file, wizard } = await convert({
      title: "Lookup",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        {
          id: "lookup",
          type: "tool",
          title: "Look up",
          call: { tool: "crm.find", input: { name: "{{name}}", limit: "3", note: " " } },
          onFail: "sorry",
          next: [{ goto: "done" }],
        },
        { id: "sorry", type: "agent", title: "Sorry", instructions: "Say sorry." },
        result({ data: { found: "steps.lookup.id", sorry: "steps.sorry" } }),
      ],
    });
    expect(file.edges).toEqual({ lookup: ["end", "sorry"], sorry: ["end"] });
    expect(file.requires).toEqual({ models: ["standard"], tools: ["crm.find"] });

    const calls: AskRow[] = [];
    const agent: Battery = async () => "Sorry.";
    const found = await play(
      wizard,
      { name: "Ada" },
      {
        agent,
        tool: async (row) => {
          calls.push(row);
          return { id: 7 };
        },
      },
      () => ({}),
    );
    expect(pathOf(found)).toEqual(["lookup"]);
    expect(found.output).toEqual({ found: 7, sorry: undefined });
    expect(calls[0]).toMatchObject({ call: "crm.find", input: { name: "Ada", limit: 3 } });

    const failed = await play(
      wizard,
      { name: "Ada" },
      {
        agent,
        tool: async () => {
          throw new Error("The CRM is down.");
        },
      },
      () => ({}),
    );
    expect(failed.status).toBe("done");
    expect(pathOf(failed)).toEqual(["lookup", "sorry"]);
    expect(failed.output).toEqual({ found: undefined, sorry: "Sorry." });
  });

  it("foreach asks side by side and gives one row per entry", async () => {
    const { wizard } = await convert({
      title: "Rooms",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        {
          id: "plan",
          type: "agent",
          title: "Plan",
          instructions: "Plan the rooms.",
          output: { format: "json", fields: [{ id: "rooms", kind: "table", columns: ["room"] }] },
        },
        {
          id: "describe",
          type: "agent",
          title: "Describe",
          instructions: "Describe {{item.room}}, {{index}} of {{count}}.",
          foreach: "steps.plan.rooms",
          output: { format: "json", fields: [{ id: "words", kind: "text" }] },
        },
        result({ data: { rows: "steps.describe.rows" } }),
      ],
    });
    const run = await play(
      wizard,
      { name: "Ada" },
      {
        agent: async (row) =>
          row.step === "plan"
            ? { rooms: [{ room: "Kitchen" }, { room: "Bath" }] }
            : { words: String(row.instructions).split("\n")[0] },
      },
      () => ({}),
    );
    expect(run.status).toBe("done");
    expect(run.rows.filter((row) => !("left" in row) && row.step === "describe")).toHaveLength(2);
    expect(run.output).toEqual({
      rows: [
        { room: "Kitchen", words: "Describe Kitchen, 1 of 2." },
        { room: "Bath", words: "Describe Bath, 2 of 2." },
      ],
    });
  });

  it("a result that gives answers back stays a step that collects them", async () => {
    const { file, files, wizard } = await convert({
      title: "Echo",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        { id: "write", type: "agent", title: "Write", instructions: "Write." },
        result({ data: { who: "name", day: "today", text: "steps.write" } }),
      ],
    });
    expect(file.edges).toEqual({ write: ["done"], done: ["end"] });
    expect(file.output).toEqual({ who: "done.who", day: "done.day", text: "write" });
    expect(Object.keys(files)).toContain("steps/done.ts");
    const run = await play(wizard, { name: "Ada" }, { agent: async () => "Hello" }, () => ({}));
    expect(run.output).toMatchObject({ who: "Ada", text: "Hello" });
    expect(run.output?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("a tool step calls its connection's action, and the user is asked where the policy says so", async () => {
    const { file, wizard } = await convert({
      title: "Contact",
      connections: [
        {
          id: "crm",
          connector: "hubspot",
          actions: ["find_contact", "create_contact"],
          policy: { find_contact: "allow", create_contact: "ask" },
        },
      ],
      steps: [
        {
          id: "who",
          type: "form",
          title: "Who",
          fields: [name, { id: "email", label: "E-mail", kind: "email" }],
        },
        {
          id: "save",
          type: "tool",
          title: "Save",
          call: {
            connection: "crm",
            action: "create_contact",
            input: { email: "{{email}}", name: "{{name}}", source: "wizard" },
          },
        },
        result({ data: { id: "steps.save.id" } }),
      ],
    });
    expect(file.connections).toEqual({
      hubspot: { find_contact: "allow", create_contact: "ask" },
    });
    const calls: AskRow[] = [];
    const seen: string[] = [];
    const run = await play(
      wizard,
      { name: "Ada", email: "ada@example.com" },
      {
        tool: async (row) => {
          calls.push(row);
          return { id: "c_1" };
        },
      },
      (row) => {
        seen.push(row.type);
        return { allow: true };
      },
    );
    expect(seen).toEqual(["approval"]);
    expect(calls[0]).toMatchObject({
      call: "hubspot.create_contact",
      input: { email: "ada@example.com", name: "Ada", source: "wizard" },
    });
    expect(run.output).toEqual({ id: "c_1" });
  });

  it("a review by the team asks the operator, and sends a step back with a note", async () => {
    const { file, wizard } = await convert({
      title: "Post",
      steps: [
        { id: "who", type: "form", title: "Who", fields: [name] },
        { id: "write", type: "agent", title: "Write", instructions: "Write a post." },
        {
          id: "check",
          type: "review",
          title: "Check",
          who: "team",
          show: ["write"],
          regenerate: true,
          timeout: "2d",
        },
        result({ deliverables: [{ from: "write", formats: ["md"] }] }),
      ],
    });
    expect(file.edges).toEqual({ write: ["check"], check: ["end", "write"] });
    const tasks: string[] = [];
    const reviews: AskRow[] = [];
    const run = await play(
      wizard,
      { name: "Ada" },
      {
        agent: async (row) => {
          tasks.push(String(row.instructions));
          return `Post ${tasks.length}`;
        },
      },
      (row) => {
        reviews.push(row);
        return reviews.length === 1 ? { regenerate: "write", note: "Shorter." } : {};
      },
    );
    expect(reviews[0]).toMatchObject({ type: "review", role: "operator", show: ["write"] });
    expect(reviews[0].due).toBeGreaterThan(0);
    expect(pathOf(run)).toEqual(["write", "check", "write", "check"]);
    expect(tasks[1]).toContain("The person asked for a change: Shorter.");
    expect(run.output).toEqual({ write: "Post 2" });
  });

  it("ids are renamed, and a calculation and a later form decide the way", async () => {
    const { file, notes, wizard } = await convert({
      title: "Budget",
      steps: [
        {
          id: "input",
          type: "form",
          title: "Budget",
          fields: [{ id: "budget", label: "Budget", kind: "number" }],
        },
        {
          id: "more",
          type: "form",
          title: "More",
          fields: [
            { id: "size", label: "Size", kind: "select", options: ["S", "L"] },
            {
              id: "extras",
              label: "Extras",
              kind: "items",
              columns: [
                { id: "what", label: "What", kind: "text" },
                { id: "price", label: "Price", kind: "money" },
              ],
            },
          ],
          next: [
            {
              when: { calc: 'budget > 100 * 2 and (size == "L" or sum(extras, price) >= 50)' },
              goto: "big",
            },
            { when: [{ field: "size", op: "in", value: ["S"] }], goto: "end" },
          ],
        },
        { id: "small", type: "agent", title: "Small", instructions: "Small: {{extras}}" },
        { id: "end", type: "agent", title: "End", instructions: "Big.", next: [{ goto: "end" }] },
        { id: "big", type: "agent", title: "Big", instructions: "Big: {{extras.gross}}" },
        result({ data: { small: "steps.small", big: "steps.big" } }),
      ],
    });
    expect(file.edges).toEqual({
      more: ["small", "big", "end"],
      small: ["end_step"],
      end_step: ["end"],
      big: ["end"],
    });
    expect(notes).toContain('The step "end" is now "end_step".');

    const agent: Battery = async (row) => String(row.instructions).split("\n\n#")[0];
    const answer = (value: object) => () => value;
    const extras = [{ what: "Wheels", price: "60,50" }];
    const big = await play(wizard, { budget: 500 }, { agent }, answer({ size: "S", extras }));
    expect(pathOf(big)).toEqual(["more", "big"]);
    expect(big.output?.big).toBe('Big: <data field="extras">60.5</data>');
    const small = await play(wizard, { budget: 100 }, { agent }, answer({ size: "L", extras }));
    expect(pathOf(small)).toEqual(["more", "small", "end_step"]);
    expect(small.output?.small).toContain("| Wheels | 60.50 EUR | 60.50 EUR |");
    const none = await play(wizard, { budget: 100 }, { agent }, answer({ size: "S" }));
    expect(pathOf(none)).toEqual(["more"]);
  });

  it("the other kinds of step: a first form with a way back, waits, files, edits and choices", async () => {
    const { file, files, notes, wizard } = await convert({
      title: "All",
      steps: [
        {
          id: "who",
          type: "form",
          title: "Who",
          fields: [name, { id: "photo", label: "Photo", kind: "image" }],
        },
        {
          id: "sort",
          type: "decision",
          title: "Sort",
          instructions: "Is {{name}} a company?",
          output: { fields: [{ id: "company", kind: "yesno" }] },
        },
        { id: "pause", type: "wait", title: "Pause", for: "2d" },
        {
          id: "paid",
          type: "wait",
          title: "Paid",
          signal: { name: "invoice.paid", key: "{{name}}", timeout: "7d", fields: ["amount"] },
        },
        {
          id: "plan",
          type: "agent",
          title: "Plan",
          instructions: "Paid: {{steps.paid.data.amount}}. Company: {{steps.sort.company}}.",
          output: {
            format: "json",
            fields: [
              { id: "times", kind: "table", columns: ["start"] },
              { id: "summary", kind: "text" },
            ],
          },
        },
        {
          id: "pick",
          type: "form",
          title: "Pick",
          fields: [
            { id: "time", label: "Time", kind: "select", optionsFrom: "steps.plan.times.start" },
            { id: "words", label: "Words", kind: "textarea", prefill: "steps.plan.summary" },
            {
              id: "vat",
              label: "VAT number",
              kind: "text",
              when: { field: "steps.sort.company", op: "truthy" },
            },
          ],
        },
        {
          id: "picture",
          type: "generate",
          title: "Picture",
          asset: "image",
          prompt: "{{words}}",
          referenceImage: "photo",
        },
        {
          id: "letter",
          type: "generate",
          title: "Letter",
          asset: "document",
          prompt: "A letter for {{time}}.",
        },
        {
          id: "card",
          type: "widget",
          title: "Card",
          entry: "card.html",
          data: { time: "time", picture: "steps.picture" },
        },
        {
          id: "view",
          type: "surface",
          title: "View",
          components: [{ id: "root", component: "Text", text: "Hello" }],
          data: { summary: "steps.plan.summary" },
        },
        { id: "check", type: "review", title: "Check", show: ["plan", "letter"], edit: true },
        {
          id: "send",
          type: "agent",
          title: "Send",
          instructions: "Send this: {{steps.plan.summary}}",
          next: [
            { when: { field: "steps.send", op: "contains", value: "again" }, goto: "who", max: 1 },
          ],
        },
        {
          id: "sum",
          type: "code",
          title: "Sum",
          code: { entry: "sum.ts", input: { n: "steps.plan.times" } },
          output: {},
        },
        result({ data: { sent: "steps.send" } }),
      ],
    });
    expect(file.start).toBe("who");
    expect(file.edges.send).toEqual(["sum", "who"]);
    expect(file.edges.sum).toEqual(["end"]);
    expect(file.requires?.models).toEqual(["classifier", "image", "low", "standard"]);
    expect(files["steps/sum.ts"]).toContain("sum.ts");
    expect(notes.join("\n")).toContain("Move that function into steps/sum.ts");

    const asked: AskRow[] = [];
    const seen: AskRow[] = [];
    const battery: Battery = async (row) => {
      asked.push(row);
      if (row.step === "sort") return { company: true };
      if (row.step === "plan")
        return { times: [{ start: "09:00" }, { start: "10:00" }], summary: "The plan." };
      if (row.step === "send")
        return asked.filter((one) => one.step === "send").length === 1 ? "Once again" : "Sent";
      return row.type === "agent" ? "Made." : { assets: [{ id: `asset_${row.n}` }] };
    };
    const run = await play(
      wizard,
      { name: "Ada", photo: "upload_1" },
      { agent: battery, decision: battery, generate: battery, widget: battery, surface: battery },
      (row) => {
        seen.push(row);
        if (row.step === "who") return { name: "Bea", photo: "upload_2" };
        if (row.step === "pause") return { timedOut: true };
        if (row.step === "paid") return { came: true, data: { amount: 12 } };
        if (row.step === "pick") return { time: "10:00", words: "A dog" };
        return { edits: { plan: { summary: "The better plan." } } };
      },
    );
    // The code step fails until its code is moved: the run stops there, after one way back.
    expect(run.status).toBe("failed");
    expect(run.error).toContain("sum.ts");
    const once = [
      "who",
      "sort",
      "pause",
      "paid",
      "plan",
      "pick",
      "picture",
      "letter",
      "card",
      "view",
      "check",
      "send",
    ];
    expect(pathOf(run)).toEqual([...once, ...once]);

    const of = (step: string) => asked.filter((row) => row.step === step);
    const pick = seen.filter((row) => row.step === "pick")[0];
    expect(pick.fields?.map((field) => field.id)).toEqual(["time", "words", "vat"]);
    expect(pick.fields?.[0].options).toEqual(["09:00", "10:00"]);
    expect(pick.fields?.[1].default).toBe("The plan.");
    expect(seen.filter((row) => row.step === "paid")[0]).toMatchObject({
      type: "wait",
      signal: "invoice.paid",
      key: "Ada",
      timeout: "7d",
    });
    expect(of("plan")[0].instructions).toContain(
      'Paid: <data field="amount">12</data>. Company: true.',
    );
    expect(of("picture")[0]).toMatchObject({ prompt: "A dog", referenceImage: "upload_1" });
    expect(of("letter")[0].prompt).toContain(
      "A letter for 10:00.\n\n# The person's answers (data)",
    );
    expect(of("card")[0].data).toMatchObject({ time: "10:00", picture: { assets: [{}] } });
    expect(of("view")[0].data).toEqual({ summary: "The plan." });
    expect(of("send")[0].instructions).toContain("Send this: The better plan.");
    // The second time round the first form asked again, and later steps read the new answers.
    expect(seen.filter((row) => row.step === "who")).toHaveLength(1);
    expect(of("sort")[1].instructions).toContain('Is <data field="name">Bea</data> a company?');
    expect(of("picture")[1].referenceImage).toBe("upload_2");
  });
});

// --- the starters ----------------------------------------------------------------------------

/** The marketplace's starters: a checkout of engenty-wizards-manage beside this repository. */
const STARTERS =
  process.env.WIZARD_STARTERS ??
  [
    new URL("../../../../engenty-wizards-manage/apps/marketplace/entries", import.meta.url)
      .pathname,
    "/home/user/engenty-wizards-manage/apps/marketplace/entries",
  ].find((dir) => existsSync(dir)) ??
  "";

/** A plausible answer for a field of a form. */
function answerFor(field: Field): unknown {
  const options = (field.options as string[] | undefined) ?? [];
  switch (field.kind) {
    case "number":
      return 2;
    case "toggle":
      return true;
    case "select":
      return options[0] ?? "One";
    case "slot":
      return options[0] ?? "2026-12-01T09:00:00+01:00";
    case "multiselect":
      return options.slice(0, 1);
    case "date":
      return "2026-12-01";
    case "email":
      return "person@example.com";
    case "url":
      return "https://example.com";
    case "items":
      return [
        Object.fromEntries(
          ((field.columns as { id: string; kind: string }[]) ?? []).map((column) => [
            column.id,
            column.kind === "text" ? "Thing" : 2,
          ]),
        ),
      ];
    case "image":
    case "file":
      return field.multiple ? ["upload_1", "upload_2"] : "upload_1";
    case "location":
      return { label: "Hauptplatz 1, Graz", lat: 47.07, lng: 15.44 };
    case "audio":
      return { asset: "audio_1", transcript: "What I said.", seconds: 4 };
    case "signature":
      return "signature_1";
    case "list":
      return [];
    default:
      return "Words";
  }
}

/** What a model would give for a field of its output. */
function madeFor(field: Field): unknown {
  const options = (field.options as string[] | undefined) ?? [];
  switch (field.kind) {
    case "number":
      return 3;
    case "list":
      return ["One", "Two"];
    case "table": {
      const columns = (field.columns as string[] | undefined) ?? ["name"];
      return [1, 2].map((n) => Object.fromEntries(columns.map((id) => [id, `${id} ${n}`])));
    }
    case "yesno":
      return true;
    case "choice":
    case "score":
      return options[0];
    default:
      return "Made.";
  }
}

const filledIn = (fields: Field[] = []) =>
  Object.fromEntries(fields.map((field) => [field.id, answerFor(field)]));
const made: Battery = async (row) =>
  row.fields?.length
    ? Object.fromEntries(row.fields.map((field) => [field.id, madeFor(field)]))
    : "Made.";
const asset: Battery = async (row) => ({
  assets: [{ id: `asset_${row.n}`, mime: row.asset === "video" ? "video/mp4" : "image/png" }],
});
const standIns: Record<string, Battery> = {
  agent: made,
  decision: made,
  tool: made,
  generate: asset,
  widget: asset,
  surface: asset,
  "motion-graphics": asset,
};
const person = (row: AskRow): unknown => {
  if (row.type === "form") return filledIn(row.fields);
  if (row.type === "review") return { approved: true };
  if (row.type === "approval") return { allow: true };
  return row.type === "wait" ? { came: true, data: {} } : {};
};

/** A note without its names, so notes of one kind count together. */
const kindOf = (note: string) =>
  note
    .replace(/^[a-zA-Z0-9_]+: /, "")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/Not kept: .*/, "Not kept: …")
    .replace(/no place for: .*/, "no place for: …")
    .replace(/Texts keep .* as written/, "Texts keep … as written");

describe("the starters", () => {
  const names = existsSync(STARTERS)
    ? readdirSync(STARTERS).filter((entry) => existsSync(join(STARTERS, entry, "wizard.en.json")))
    : [];

  it.skipIf(names.length === 0)(
    "all convert, fit their map, compile and run through with stand-ins",
    async () => {
      const table: Record<string, string | number>[] = [];
      const kinds = new Map<string, number>();
      const broken: string[] = [];
      for (const starter of names.sort()) {
        const raw = JSON.parse(readFileSync(join(STARTERS, starter, "wizard.en.json"), "utf8"));
        const definition: WizardDefinition = wizardSchema.parse(raw.definition ?? raw);
        const row: Record<string, string | number> = { starter, steps: definition.steps.length };
        table.push(row);
        try {
          const converted = toKernel(definition);
          row.files = Object.keys(converted.files).length;
          row.notes = converted.notes.length;
          for (const note of converted.notes)
            kinds.set(kindOf(note), (kinds.get(kindOf(note)) ?? 0) + 1);
          const parsed = kernelFileSchema.safeParse(converted.file);
          if (!parsed.success) throw new Error(`the file: ${parsed.error.message}`);
          const issues = kernelIssues(converted.file, Object.keys(converted.files));
          if (issues.length) throw new Error(issues.map((issue) => issue.message).join(" "));
          const wizard = await compiled(converted);
          try {
            const run = await play(wizard, undefined, standIns, person);
            const at = run.cursor ? ` at "${run.cursor}"` : "";
            row.smoke =
              run.status === "done"
                ? `done, ${pathOf(run).length} steps, ${Object.keys(run.output ?? {}).length} outputs`
                : `${run.status}${at}: ${run.error ?? "still asking"}`;
          } catch (error) {
            row.smoke = `stopped: ${error instanceof Error ? error.message : error}`;
          }
        } catch (error) {
          row.smoke = `not converted: ${error instanceof Error ? error.message : error}`;
          broken.push(`${starter}: ${row.smoke}`);
        }
      }
      // Written straight to the output, so the table shows with every reporter.
      const lines = [
        "",
        "starter                 steps  files  notes  smoke",
        ...table.map((row) =>
          [
            String(row.starter).padEnd(22),
            String(row.steps).padStart(5),
            String(row.files ?? "-").padStart(5),
            String(row.notes ?? "-").padStart(5),
            row.smoke,
          ].join("  "),
        ),
        "",
        "notes by kind",
        ...[...kinds]
          .sort((a, b) => b[1] - a[1])
          .map(([note, count]) => `${String(count).padStart(4)}  ${note}`),
        "",
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      expect(names.length).toBe(31);
      expect(broken).toEqual([]);
      expect(
        table
          .filter((row) => !String(row.smoke).startsWith("done"))
          .map((row) => `${row.starter}: ${row.smoke}`),
      ).toEqual([]);
    },
    120_000,
  );
});
