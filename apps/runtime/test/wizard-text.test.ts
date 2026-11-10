import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wizardSchema, type WizardDefinition } from "@engenty/wizards-shared/definition";
import { parseWizardText, printWizardText } from "@engenty/wizards-shared/wizard-text";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

const examplesDir = fileURLToPath(new URL("../../../examples/wizards", import.meta.url));
const examples = readdirSync(examplesDir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".wizard"))
  .sort()
  .map((file) => {
    const pkg = unzipSync(readFileSync(join(examplesDir, file)));
    const manifest = JSON.parse(strFromU8(pkg["wizard.json"]));
    return { file, definition: manifest.definition as WizardDefinition };
  });

const normal = (def: unknown) => wizardSchema.parse(def);
const stepIds = (def: WizardDefinition) => def.steps.map((s) => s.id);
const page = (def: WizardDefinition, id: string) => def.steps.find((s) => s.id === id) as any;

// Part 1's example 1g with its diff applied (docs/plans/fast-creation.md). Its component ids are
// the compiler's (c1, c2, c3) instead of b, fit, n: rule 5.
const configurator1g = {
  version: 1,
  title: "Projektkonfigurator",
  lang: "de",
  steps: [
    {
      id: "type",
      type: "form",
      title: "Was möchtest du bauen?",
      section: "Projekttyp",
      fields: [
        {
          id: "type",
          label: "Projekttyp",
          kind: "select",
          required: true,
          options: ["Website", "Shop", "App"],
        },
      ],
    },
    {
      id: "needs",
      type: "form",
      title: "Wie groß ist dein Shop?",
      section: "Anforderungen",
      fields: [
        {
          id: "size",
          label: "Größe",
          kind: "select",
          required: true,
          options: [
            "Klein – bis 50 Produkte",
            "Mittel – bis 1.000 Produkte",
            "Groß – mehr als 1.000 Produkte",
          ],
          look: "list",
          when: { field: "type", op: "eq", value: "Shop" },
        },
        {
          id: "pages",
          label: "Wie viele Seiten?",
          kind: "number",
          when: { field: "type", op: "eq", value: "Website" },
        },
      ],
    },
    {
      id: "budget",
      type: "form",
      title: "Wie hoch ist dein Budget?",
      section: "Budget",
      fields: [
        {
          id: "budget",
          label: "Budget",
          kind: "number",
          unit: "€",
          required: true,
          min: 2000,
          max: 30000,
          increment: 500,
          default: 17000,
          look: "slider",
        },
        {
          id: "name",
          label: "Projektname (optional)",
          kind: "text",
          placeholder: "Mein neues Projekt",
        },
      ],
      components: [
        { id: "root", component: "Column", children: ["c1", "c2", "c3"] },
        { id: "c1", component: "Field", name: "budget" },
        {
          id: "c2",
          component: "Metric",
          label: "Davon für die Demo",
          value: { calc: "demo / budget", as: "percent" },
          caption: { calc: 'if(demo <= budget, "im Budgetrahmen", "über dem Budget")' },
        },
        { id: "c3", component: "Field", name: "name" },
      ],
      data: { demo: "steps.estimate.total" },
    },
    {
      id: "concept",
      type: "agent",
      title: "Projektkonzept",
      section: "Ergebnis",
      instructions: "Erstelle ein Projektkonzept für {{type}} …",
      output: { format: "markdown" },
    },
    { id: "done", type: "result", title: "Dein Konzept", deliverables: [] },
  ],
};

// The configurator of Part 2 with what it needs to say 1g: the budget field's label, the metric's
// caption, `as` inside the value it formats, 1g's instructions, and no `model` on the agent.
const configuratorText = `<Wizard title="Projektkonfigurator" lang="de">
<Page id="type" section="Projekttyp" title="Was möchtest du bauen?">
  <Field id="type" kind="select" label="Projekttyp" required options={["Website", "Shop", "App"]} />
</Page>
<Page id="needs" section="Anforderungen" title="Wie groß ist dein Shop?">
  <Field id="size" kind="select" label="Größe" required look="list" when={type == "Shop"}
    options={["Klein – bis 50 Produkte", "Mittel – bis 1.000 Produkte", "Groß – mehr als 1.000 Produkte"]} />
  <Field id="pages" kind="number" label="Wie viele Seiten?" when={type == "Website"} />
</Page>
<Page id="budget" section="Budget" title="Wie hoch ist dein Budget?" data={{"demo": "steps.estimate.total"}}>
  <Field id="budget" kind="number" label="Budget" unit="€" required min={2000} max={30000} increment={500} default={17000} look="slider" />
  <Metric label="Davon für die Demo" value={{"calc": "demo / budget", "as": "percent"}}
    caption={if(demo <= budget, "im Budgetrahmen", "über dem Budget")} />
  <Field id="name" kind="text" label="Projektname (optional)" placeholder="Mein neues Projekt" />
</Page>
<Agent id="concept" section="Ergebnis" title="Projektkonzept">
Erstelle ein Projektkonzept für {{type}} …
</Agent>
<Result id="done" title="Dein Konzept" />
</Wizard>
`;

// Part 2's text as the plan has it, word for word.
const planText = `<Wizard title="Projektkonfigurator" lang="de">
<Page id="type" section="Projekttyp" title="Was möchtest du bauen?">
  <Field id="type" kind="select" label="Projekttyp" required options={["Website", "Shop", "App"]} />
</Page>
<Page id="needs" section="Anforderungen" title="Wie groß ist dein Shop?">
  <Field id="size" kind="select" label="Größe" required look="list" when={type == "Shop"}
    options={["Klein – bis 50 Produkte", "Mittel – bis 1.000 Produkte", "Groß – mehr als 1.000 Produkte"]} />
  <Field id="pages" kind="number" label="Wie viele Seiten?" when={type == "Website"} />
</Page>
<Page id="budget" section="Budget" title="Wie hoch ist dein Budget?" data={{"demo": "steps.estimate.total"}}>
  <Field id="budget" kind="number" unit="€" required min={2000} max={30000} increment={500} default={17000} look="slider" />
  <Metric label="Davon für die Demo" value={demo / budget} as="percent" />
  <Field id="name" kind="text" label="Projektname (optional)" placeholder="Mein neues Projekt" />
</Page>
<Agent id="concept" section="Ergebnis" title="Projektkonzept" model="standard">
Erstelle ein Projektkonzept für {{type}} mit einem Budget von {{budget}} Euro …
</Agent>
<Result id="done" title="Dein Konzept" />
</Wizard>
`;

// What durable runs add, and the rest of Part 1, in one wizard: all go through rule 1.
const durable = {
  version: 1,
  title: "Rechnung freigeben",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "ask",
      type: "form",
      title: "Rechnung",
      section: "Eingang",
      who: "owner",
      timeout: "2d",
      remind: "1d",
      fields: [
        { id: "amount", label: "Betrag", kind: "number", unit: "€", min: 0, look: "stepper" },
        { id: "note", label: "Notiz", kind: "textarea", when: { calc: "amount > 1000 or amount < 0" } },
      ],
      components: [
        { id: "root", component: "Column", children: ["c1", "c2", "c3", "c4"] },
        { id: "c1", component: "Text", text: "Neue Rechnung", variant: "h3" },
        { id: "c2", component: "Text", text: "Prüf den Betrag.\nDann weiter." },
        { id: "c3", component: "Field", name: "amount" },
        { id: "c4", component: "Field", name: "note" },
      ],
      next: [
        { when: [{ field: "amount", op: "gt", value: -5 }, { field: "note", op: "exists" }], goto: "check" },
        { ask: "Die Rechnung ist doppelt", goto: "end" },
        { goto: "pay" },
      ],
    },
    {
      id: "check",
      type: "review",
      title: "Freigeben",
      show: ["ask"],
      approve: true,
      who: "team",
      onFail: "end",
    },
    {
      id: "pay",
      type: "agent",
      title: "Bezahlen",
      instructions: "Zahle {{amount}} <b>sofort</b>.",
      tools: [],
      durable: true,
      output: {
        format: "json",
        fields: [
          { id: "paid", kind: "yesno", description: "Bezahlt?" },
          { id: "level", kind: "score", options: ["low", "high"] },
        ],
      },
    },
    {
      id: "wait",
      type: "wait",
      title: "Auf Zahlung warten",
      signal: { name: "invoice.paid", key: "{{amount}}", timeout: "3d", fields: ["by"] },
    },
    { id: "remind", type: "wait", title: "Pause", for: "3d" },
    { id: "done", type: "result", title: "Fertig", message: "  Danke.  ", deliverables: [] },
  ],
};

describe("printWizardText and parseWizardText", () => {
  it.each(examples.map((e) => [e.file, e.definition] as const))(
    "%s prints and parses back to the same definition",
    (_file, def) => {
      const parsed = parseWizardText(printWizardText(def));
      expect(parsed.cuts).toEqual([]);
      expect(parsed.definition).toEqual(def);
    },
  );

  it("round-trips 1g, durable keys, calc, conditions, Markdown and output fields", () => {
    for (const def of [configurator1g, durable] as unknown as WizardDefinition[]) {
      const parsed = parseWizardText(printWizardText(def));
      expect(parsed.cuts).toEqual([]);
      expect(normal(parsed.definition)).toEqual(normal(def));
    }
    const text = printWizardText(durable as unknown as WizardDefinition);
    expect(text).toContain("## Neue Rechnung");
    // notEmpty has no expression: that `when` stays JSON.
    expect(text).toContain('when={[{"field":"amount","op":"gt","value":-5},{"field":"note","op":"exists"}]}');
    expect(text).toContain('when={amount > 1000 or amount < 0}');
    expect(text).toContain('<Next ask="Die Rechnung ist doppelt" goto="end" />');
    expect(text).toContain('<YesNo id="paid" description="Bezahlt?" />');
    expect(text).toContain('instructions="Zahle {{amount}} <b>sofort</b>."');
    expect(text).toContain('message="  Danke.  "');
  });

  it("reads the configurator of Part 2 as 1g", () => {
    const parsed = parseWizardText(configuratorText);
    expect(parsed.cuts).toEqual([]);
    expect(normal(parsed.definition)).toEqual(normal(configurator1g));
  });

  it("reads Part 2's text as the plan writes it, apart from where it differs from 1g", () => {
    const parsed = parseWizardText(planText);
    expect(parsed.cuts).toEqual([]);
    const budget = page(parsed.definition, "budget");
    // No label on the budget field (the schema needs one); `as` lands on the Metric, not in its value.
    expect(budget.fields[0].label).toBeUndefined();
    expect(budget.components[2]).toEqual({
      id: "c2",
      component: "Metric",
      label: "Davon für die Demo",
      value: { calc: "demo / budget" },
      as: "percent",
    });
    expect(wizardSchema.safeParse(parsed.definition).success).toBe(false);
  });

  it("compiles expressions: conditions where they can say it, calc and paths otherwise", () => {
    const { definition, cuts } = parseWizardText(`<Wizard title="T">
<Page id="p" title="P">
  <Field id="a" kind="number" label="A" when={x == "Shop" and y > 2} />
  <Field id="b" kind="number" label="B" when={budget > demo * 2} />
  <Field id="c" kind="text" label="C" when={size == "Groß" or count(items) > 50} />
  <Metric label="M" value={budget} caption={budget * 2} />
  <Next when={a < -1} goto="end" />
</Page>
</Wizard>`);
    expect(cuts).toEqual([]);
    const p = page(definition, "p");
    expect(p.fields.map((f: any) => f.when)).toEqual([
      [
        { field: "x", op: "eq", value: "Shop" },
        { field: "y", op: "gt", value: 2 },
      ],
      { calc: "budget > demo * 2" },
      { calc: 'size == "Groß" or count(items) > 50' },
    ]);
    expect(p.components[4]).toMatchObject({ value: { path: "/budget" }, caption: { calc: "budget * 2" } });
    expect(p.next).toEqual([{ when: { field: "a", op: "lt", value: -1 }, goto: "end" }]);
  });

  it("names what it repairs and drops", () => {
    const { definition, cuts } = parseWizardText(`<Wizard title="T">
<Page id="p" title="P">
  <Field id="a" kind="number" label="A" default={nope} />
  <Bogus />
</Wizard>`);
    expect(page(definition, "p").fields).toEqual([{ id: "a", kind: "number", label: "A" }]);
    expect(cuts.map((c) => c.what)).toEqual([
      "<Page> was not closed; closed before </Wizard>.",
      "default={nope} is not JSON; left out.",
      "<Bogus> does not belong in a page; left out.",
    ]);
  });
});

describe("parseWizardText with partial", () => {
  // The configurator with Markdown and a card between the fields, so components stream in too.
  const streamed = configuratorText.replace(
    '  <Metric label="Davon',
    '  ## Was es kostet\n  Die Demo zuerst.\n  <Card title="Demo">\n    <Badge label="neu" />\n  </Card>\n  <Metric label="Davon',
  );

  /** Where each step's text ends: its closing tag and the line break after it. */
  function stepEnds(text: string): number[] {
    const starts = [...text.matchAll(/^<(Page|Agent|Result|Generate|Review|Widget|Wait|Surface|MotionGraphics)\b/gm)].map(
      (m) => m.index,
    );
    return starts.map((_s, i) => (i + 1 < starts.length ? starts[i + 1] : text.lastIndexOf("</Wizard>")));
  }

  function checkEveryPrefix(text: string) {
    const full = parseWizardText(text).definition;
    const ends = stepEnds(text);
    expect(ends).toHaveLength(full.steps.length);
    const firstSeen: number[] = full.steps.map(() => -1);
    for (let n = 0; n <= text.length; n++) {
      const { definition } = parseWizardText(text.slice(0, n), { partial: true });
      const ids = stepIds(definition);
      // The steps so far, in their order.
      expect(stepIds(full).slice(0, ids.length)).toEqual(ids);
      definition.steps.forEach((step, i) => {
        if (firstSeen[i] === -1) {
          firstSeen[i] = n;
        }
        // A step whose tag closed is the step it will be.
        if (n >= ends[i]) {
          expect(step).toEqual(full.steps[i]);
        }
        // A component keeps its id, its kind and the field it places.
        const comps = (step as any).components as any[] | undefined;
        const final = new Map(((full.steps[i] as any).components ?? []).map((c: any) => [c.id, c]));
        for (const c of comps ?? []) {
          const f = final.get(c.id) as any;
          expect(f?.component).toBe(c.component);
          if (c.component === "Field") {
            expect(c.name).toBe(f.name);
          }
        }
      });
      ends.forEach((end, i) => {
        if (n >= end) {
          expect(ids).toContain(full.steps[i].id);
        }
      });
    }
    return firstSeen;
  }

  it("reads every prefix of the configurator without throwing; steps and ids hold", () => {
    expect(parseWizardText(streamed).cuts).toEqual([]);
    const budget = page(parseWizardText(streamed).definition, "budget");
    expect(budget.components.map((c: any) => `${c.id}:${c.component}`)).toEqual([
      "root:Column",
      "c1:Field",
      "c2:Text",
      "c3:Text",
      "c4:Card",
      "c5:Badge",
      "c6:Metric",
      "c7:Field",
    ]);
    // Halfway into the budget page: it shows as far as written, and the cuts say it is open.
    const half = parseWizardText(streamed.slice(0, streamed.indexOf("<Card")), { partial: true });
    expect(page(half.definition, "budget").components.map((c: any) => c.id)).toEqual([
      "root",
      "c1",
      "c2",
      "c3",
    ]);
    expect(half.cuts.filter((c) => c.step).map((c) => c.step)).toEqual(["budget"]);
    const firstSeen = checkEveryPrefix(streamed);
    // An open step shows once something in it is complete: before its closing tag.
    const ends = stepEnds(streamed);
    expect(firstSeen.every((n, i) => n > 0 && n <= ends[i])).toBe(true);
  });

  it("reads every prefix of the largest example without throwing", () => {
    const largest = examples.reduce((a, b) =>
      JSON.stringify(a.definition).length >= JSON.stringify(b.definition).length ? a : b,
    );
    checkEveryPrefix(printWizardText(largest.definition));
  });
});

describe("timing", () => {
  it("parses and prints the largest example in well under a millisecond or so", () => {
    const largest = examples.reduce((a, b) =>
      JSON.stringify(a.definition).length >= JSON.stringify(b.definition).length ? a : b,
    );
    const text = printWizardText(largest.definition);
    const runs = 200;
    for (let i = 0; i < 20; i++) {
      parseWizardText(text);
      printWizardText(largest.definition);
    }
    let at = performance.now();
    for (let i = 0; i < runs; i++) {
      parseWizardText(text);
    }
    const parseMs = (performance.now() - at) / runs;
    at = performance.now();
    for (let i = 0; i < runs; i++) {
      printWizardText(largest.definition);
    }
    const printMs = (performance.now() - at) / runs;
    console.info(
      `[timing] wizard-text ${largest.file} chars=${text.length} json=${JSON.stringify(largest.definition).length} parseMs=${parseMs.toFixed(3)} printMs=${printMs.toFixed(3)}`,
    );
    expect(parseMs).toBeLessThan(20);
    expect(printMs).toBeLessThan(20);
  });
});
