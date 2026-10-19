import { assembleSurface, parseWizard, type SurfaceStep } from "@engenty/wizards-shared/definition";
import { fontFace, runTheme } from "@engenty/wizards-shared/projects";
import {
  chosenTheme,
  freeThemeId,
  lookColours,
  type Theme,
  themeContentKey,
  themedLook,
  themeIdFrom,
  themeIdProblem,
  themeOffered,
  themeSchema,
} from "@engenty/wizards-shared/theme";
import { bound, pointer, validateSurface, worded } from "@engenty/wizards-shared/surface";
import { describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ value: null }));
const llm = vi.hoisted(() => ({ output: undefined as unknown }));
vi.mock("../src/models.js", () => ({
  systemOneAccess: async () => access.value,
  textModel: async () => ({ model: "test", vendor: "test" }),
  costOf: () => 0,
}));
vi.mock("ai", () => ({
  generateText: async () => ({ output: llm.output, usage: {} }),
  Output: { object: (o: unknown) => o },
}));

const { runSurfaceStep, surfaceData } = await import("../src/engine/surface");

const facts = [
  { id: "root", component: "Column", children: ["title", "figures", "list"] },
  { id: "title", component: "Text", text: "Angebote", variant: "h3" },
  { id: "figures", component: "Grid", columns: 2, children: ["count"] },
  { id: "count", component: "Metric", label: "Anbieter", value: { path: "/count" } },
  { id: "list", component: "List", children: { path: "/suppliers", componentId: "row" } },
  { id: "row", component: "Row", title: { path: "name" }, meta: { path: "price" } },
];

describe("the surface catalog", () => {
  it("accepts a well-formed surface", () => {
    expect(validateSurface(facts, ["count", "suppliers"])).toEqual([]);
  });

  it("names what is wrong", () => {
    const messages = validateSurface(
      [
        { id: "root", component: "Column", children: ["a", "ghost"] },
        { id: "a", component: "Metric", label: "x" },
        { id: "a", component: "Text", text: { path: "/nowhere" } },
        { id: "b", component: "Button", label: "Go", action: "delete" },
      ],
      ["count"],
    ).map((i) => i.message);
    expect(messages).toContain('Duplicate component id "a".');
    expect(messages).toContain('"root" names a child "ghost" that is not there.');
    expect(messages).toContain('Metric "a" needs "value".');
    expect(messages).toContain('"a" reads "/nowhere", which no data provides.');
    expect(messages.some((m) => m.includes("action is one of"))).toBe(true);
    expect(validateSurface([{ id: "x", component: "Text", text: "t" }]).map((i) => i.message)).toContain(
      'A surface has a component with id "root".',
    );
    expect(validateSurface([{ id: "root", component: "Sparkle" }])).not.toEqual([]);
  });

  it("finds a loop", () => {
    const messages = validateSurface([
      { id: "root", component: "Column", children: ["a"] },
      { id: "a", component: "Column", children: ["root"] },
    ]).map((i) => i.message);
    expect(messages).toContain("Components hold each other in a loop.");
  });

  it("binds props to data and to the repeated row", () => {
    const data = { count: 2, suppliers: [{ name: "Huber", price: 12 }] };
    expect(pointer(data, "/suppliers/0/name")).toBe("Huber");
    expect(bound({ path: "/count" }, data)).toBe(2);
    expect(bound({ path: "price" }, data, data.suppliers[0])).toBe(12);
    expect(bound("literal", data)).toBe("literal");
  });
});

describe("the result components", () => {
  const plan = [
    { id: "root", component: "Column", children: ["lead", "tabs"] },
    { id: "lead", component: "Text", variant: "lead", text: { path: "/summary" } },
    {
      id: "tabs",
      component: "Tabs",
      tabs: [
        { label: "Plan", child: "days" },
        { label: "Einkauf", count: { path: "/shopping" }, child: "shop" },
      ],
    },
    { id: "days", component: "Grid", min: 14, children: { path: "/days", componentId: "day" } },
    { id: "day", component: "Card", title: { path: "theme" }, children: ["meals"] },
    { id: "meals", component: "Column", children: { path: "meals", componentId: "meal" } },
    {
      id: "meal",
      component: "Link",
      title: { path: "title" },
      items: { path: "/recipes" },
      value: { path: "recipe_id" },
      view: "recipe",
    },
    { id: "recipe", component: "Column", children: ["steps", "tip"] },
    { id: "steps", component: "Steps", items: { path: "steps" } },
    { id: "tip", component: "Callout", text: { path: "tip" } },
    { id: "shop", component: "Checklist", items: { path: "/shopping" }, groupKey: "category" },
  ];

  it("accepts a result made of them", () => {
    expect(validateSurface(plan, ["summary", "days", "recipes", "shopping"])).toEqual([]);
  });

  it("names what they lack", () => {
    const messages = validateSurface([
      { id: "root", component: "Column", children: ["t", "g", "l"] },
      { id: "t", component: "Tabs", tabs: [{ label: "One", child: "g" }] },
      { id: "g", component: "Group", by: "category", children: ["l"] },
      { id: "l", component: "Link", title: "x", items: { path: "/r" }, value: "1", view: "ghost" },
    ]).map((i) => i.message);
    expect(messages).toContain('Tabs "t" needs at least two tabs: [{ label, child }].');
    expect(messages).toContain('Group "g" repeats over a list: children { "path", "componentId" }.');
    expect(messages).toContain('"l" names a child "ghost" that is not there.');
  });

  it("finds a loop through a tab", () => {
    const messages = validateSurface([
      { id: "root", component: "Tabs", tabs: [{ label: "A", child: "a" }, { label: "B", child: "root" }] },
      { id: "a", component: "Text", text: "a" },
    ]).map((i) => i.message);
    expect(messages).toContain("Components hold each other in a loop.");
  });

  it("put values into words", () => {
    const row = { in_fridge: true, minutes: 7, for: ["Shakshuka", "Pasta"] };
    expect(bound({ path: "in_fridge", map: { true: "da", false: "einkaufen" } }, {}, row)).toBe("da");
    expect(bound({ path: "minutes", format: "{} Min" }, {}, row)).toBe("7 Min");
    expect(bound({ path: "for", format: "für {}" }, {}, row)).toBe("für Shakshuka, Pasta");
    expect(worded(undefined, { format: "{} Min" })).toBeUndefined();
    expect(worded("other", { map: { a: "b" } })).toBe("other");
  });
});

describe("the run's theme", () => {
  it("takes accent, ground, second colour and typefaces from the brand", () => {
    expect(
      runTheme({
        colors: [
          { name: "Primär – Buttons", value: "#2f5d50" },
          { name: "Text", value: "#1b2820" },
          { name: "Hintergrund", value: "#eff2ec" },
          { name: "Akzent warm", value: "#a8661b" },
          { name: "Illustration", value: "#ff00aa", section: "illu" },
        ],
        fonts: [
          { family: "Instrument Sans", role: "Fließtext" },
          { family: "Young Serif", role: "Überschriften" },
        ],
      }),
    ).toEqual({
      accent: "#2f5d50",
      second: "#a8661b",
      background: "#eff2ec",
      display: "Young Serif",
      body: "Instrument Sans",
      faces: [],
      dark: false,
      pinned: false,
      modes: null,
      prefer: null,
      shape: null,
      effects: [],
    });
  });

  it("is dark on a dark ground and empty without a brand", () => {
    expect(runTheme({ colors: [{ name: "Coral", value: "#ff6b4a" }, { name: "Background", value: "#121419" }] }).dark).toBe(true);
    expect(runTheme({})).toEqual({
      accent: null,
      second: null,
      background: null,
      display: null,
      body: null,
      faces: [],
      dark: false,
      pinned: false,
      modes: null,
      prefer: null,
      shape: null,
      effects: [],
    });
  });

  it("loads the brand's fonts from their source: our copy, the website's file or its stylesheet", () => {
    const look = runTheme({
      fonts: [
        { family: "Acme Display", role: "Headings", source: { file: "f1" } },
        { family: "Acme Text", role: "Body", source: { url: "https://acme.example/fonts.css?v=2" } },
        { family: "Acme Mono", role: "Code", source: { url: "https://acme.example/mono.woff2" } },
      ],
    });
    expect(look.faces).toEqual([
      { family: "Acme Display", url: "/api/public/fonts/f1", stylesheet: false },
      { family: "Acme Text", url: "https://acme.example/fonts.css?v=2", stylesheet: true },
    ]);
    expect(fontFace({ family: "Acme Mono", source: { url: "https://acme.example/mono.woff2?x" } })).toEqual({
      family: "Acme Mono",
      url: "https://acme.example/mono.woff2?x",
      stylesheet: false,
    });
    expect(fontFace({ family: "Acme Mono" })).toBeNull();
  });
});

describe("themes", () => {
  const brand = runTheme({
    colors: [
      { name: "Primär", value: "#2f5d50" },
      { name: "Hintergrund", value: "#eff2ec" },
    ],
    fonts: [
      { family: "Instrument Sans", role: "Fließtext" },
      { family: "Young Serif", role: "Überschriften" },
    ],
  });
  const halloween: Theme = {
    id: "halloween",
    name: "Halloween",
    version: "1.0.0",
    base: "brand",
    dark: { accent: "#ff7a1a", background: "#140b1f" },
    fonts: { heading: "Creepster", text: "brand" },
    effects: [{ id: "glow" }, { id: "corners", kind: "webs" }],
  };

  it("is the brand while the wizard names none the space has", () => {
    expect(themedLook(brand, chosenTheme(undefined, [halloween]))).toBe(brand);
    expect(themedLook(brand, chosenTheme(["gone"], [halloween]))).toBe(brand);
    expect(themedLook(brand, chosenTheme(["brand", "halloween"], [halloween]))).toBe(brand);
  });

  it("takes the first theme of the chain the space has, built on the brand", () => {
    const look = themedLook(brand, chosenTheme(["gone", "halloween"], [halloween]));
    expect(look).toMatchObject({
      accent: "#2f5d50",
      display: "Creepster",
      body: "Instrument Sans",
      dark: true,
      pinned: true,
      modes: { light: null, dark: { accent: "#ff7a1a", background: "#140b1f" } },
      effects: [{ id: "glow" }, { id: "corners", kind: "webs" }],
    });
    expect(lookColours(look, "dark")).toEqual({
      accent: "#ff7a1a",
      background: "#140b1f",
      text: null,
    });
  });

  it("leaves light and dark to the person when it has both, showing what it prefers first", () => {
    const both = themedLook(brand, {
      ...halloween,
      light: { accent: "#e8630a" },
      prefer: "light",
    });
    expect(both).toMatchObject({ pinned: false, prefer: "light", dark: false });
    expect(lookColours(both, "light").accent).toBe("#e8630a");
    expect(lookColours(both, "light").background).toBe("#eff2ec");
  });

  it("names the brand's fonts by role, whatever it builds on, and loads only those it shows", () => {
    const sourced = runTheme({
      fonts: [
        { family: "Acme Display", role: "Headings", source: { file: "f1" } },
        { family: "Acme Text", role: "Body", source: { file: "f2" } },
      ],
    });
    const look = themedLook(sourced, {
      ...halloween,
      base: "default",
      fonts: { heading: "Creepster", text: "brand" },
    });
    expect(look).toMatchObject({ display: "Creepster", body: "Acme Text" });
    expect(look.faces.map((f) => f.family)).toEqual(["Acme Text"]);
    expect(themedLook(sourced, { ...halloween, base: "default", fonts: undefined })).toMatchObject({
      display: null,
      body: null,
      faces: [],
    });
  });

  it("holds fonts by name or role, never an address", () => {
    expect(themeSchema.safeParse({ ...halloween, fonts: { heading: "Fraunces" } }).success).toBe(true);
    expect(
      themeSchema.safeParse({ ...halloween, fonts: { heading: "https://x.example/f.woff2" } }).success,
    ).toBe(false);
  });

  it("shows what the place asks for where the wizard offers it, else the first of the chain", () => {
    const calm: Theme = { ...halloween, id: "calm", effects: [] };
    const chain = ["halloween", "calm"];
    expect(chosenTheme(chain, [halloween, calm], "calm")).toBe(calm);
    expect(chosenTheme(chain, [halloween, calm], "host")).toBe("host");
    expect(chosenTheme(chain, [halloween, calm], "default")).toBe("default");
    // A theme of the space the wizard does not name, or one the space lacks: the wizard's first.
    expect(chosenTheme(["halloween"], [halloween, calm], "calm")).toBe(halloween);
    expect(chosenTheme(["gone", "halloween"], [halloween], "gone")).toBe(halloween);
    expect(themeOffered("brand", undefined)).toBe(true);
    expect(themeOffered("calm", chain)).toBe(true);
    expect(themeOffered("other", chain)).toBe(false);
  });

  it("shows engenty wizards' own look for default", () => {
    expect(themedLook(brand, "default")).toMatchObject({ accent: null, display: null });
  });

  it("refuses reserved ids and scopes, and takes the catalog's", () => {
    expect(themeIdProblem("halloween")).toBeNull();
    expect(themeIdProblem("@wizards/halloween")).toBeNull();
    expect(themeIdProblem("@someone/halloween")).toBeNull();
    expect(themeIdProblem("brand")).toMatch(/reserved/);
    expect(themeIdProblem("wizards")).toMatch(/reserved/);
    expect(themeIdProblem("@engenty/x")).toMatch(/reserved/);
    expect(themeIdProblem("Halloween!")).toMatch(/no theme id/);
  });

  it("knows the same content in another order, and finds a free id", () => {
    const shuffled = { ...halloween, effects: halloween.effects, fonts: { text: "brand", heading: "Creepster" } };
    expect(themeContentKey(shuffled)).toBe(themeContentKey(halloween));
    expect(themeContentKey({ ...halloween, name: "Other" })).not.toBe(themeContentKey(halloween));
    expect(freeThemeId("halloween", new Set(["halloween", "halloween-2"]))).toBe("halloween-3");
    expect(themeIdFrom("Spukhaus-Exposé")).toBe("spukhaus-expose");
    expect(themeIdFrom("Brand")).toBe("look");
  });
});

describe("surface steps", () => {
  const research = {
    id: "research",
    type: "agent",
    title: "Research",
    instructions: "find",
    tools: [],
    output: { format: "json", fields: [{ id: "suppliers", kind: "table", columns: ["name", "price"] }, { id: "count", kind: "number" }] },
  };

  it("are checked against their data", () => {
    const parsed = parseWizard({
      title: "x",
      steps: [
        research,
        { id: "view", type: "surface", title: "View", components: facts, data: { count: "steps.research.count", suppliers: "steps.research.suppliers" } },
        { id: "r", type: "result", title: "R", deliverables: [{ from: "view", formats: ["json"] }] },
      ],
    });
    expect(parsed.issues).toEqual([]);
    const broken = parseWizard({
      title: "x",
      steps: [
        research,
        { id: "view", type: "surface", title: "View", components: facts, data: { count: "steps.research.count" } },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    expect(broken.issues.map((i) => i.message).join()).toContain('reads "/suppliers"');
    const both = parseWizard({
      title: "x",
      steps: [{ id: "view", type: "surface", title: "V", data: {} }, { id: "r", type: "result", title: "R", deliverables: [] }],
    });
    expect(both.ok).toBe(false);
  });

  it("carry a view written once on an AI step", () => {
    const step = (surface: unknown) => ({
      title: "x",
      steps: [
        { ...research, output: { ...research.output, surface } },
        { id: "r", type: "result", title: "R", deliverables: [{ from: "research", formats: ["json"] }] },
      ],
    });
    expect(parseWizard(step(facts)).issues).toEqual([]);
    const broken = parseWizard(step([{ id: "root", component: "Text", text: { path: "/nowhere" } }]));
    expect(broken.issues.map((i) => i.message)).toContain('View: "root" reads "/nowhere", which no data provides.');
    expect(parseWizard(step(true)).issues).toEqual([]);
  });

  it("read their data from the run", async () => {
    const parsed = parseWizard({
      title: "x",
      lists: [{ id: "seen", title: "Seen", columns: [{ id: "name", name: "Name", type: "text" }] }],
      steps: [
        { id: "p", type: "page", title: "P", fields: [{ id: "who", label: "Who", kind: "text" }] },
        research,
        { id: "view", type: "surface", title: "View", components: facts, data: { count: "steps.research.count", suppliers: "steps.research.suppliers", seen: "lists.seen", who: "who" } },
        { id: "r", type: "result", title: "R", deliverables: [] },
      ],
    });
    if (!parsed.ok) throw new Error("invalid");
    const state = {
      values: { who: "Ada" },
      outputs: { research: { json: { suppliers: [{ name: "Huber", price: 12 }], count: 1 }, at: "" } },
      history: [],
      notes: {},
    };
    const scope = { def: parsed.wizard, state, brand: {}, lists: { seen: { def: parsed.wizard.lists![0], rows: [{ id: "1", cells: { name: "Ben" }, updatedAt: "" }] } } };
    const view = parsed.wizard.steps[2] as SurfaceStep;
    const data = surfaceData(view.data, { def: parsed.wizard, state, scope } as never);
    expect(data).toEqual({ count: 1, suppliers: [{ name: "Huber", price: 12 }], seen: [{ name: "Ben" }], who: "Ada" });
    const out = await runSurfaceStep(view, { def: parsed.wizard, state, scope } as never);
    expect(out.surface?.components).toHaveLength(facts.length);
  });

  it("keep the pieces a decision chose", async () => {
    const step: SurfaceStep = {
      id: "view",
      type: "surface",
      title: "View",
      data: { suppliers: "steps.research.suppliers" },
      candidates: [
        { id: "head", description: "Title", required: true, components: [{ id: "head", component: "Text", text: "Angebote" }] },
        { id: "chart", description: "Prices as bars", components: [{ id: "chart", component: "BarChart", points: { path: "/suppliers" } }] },
        { id: "table", description: "All suppliers", components: [{ id: "table", component: "Table", rows: { path: "/suppliers" } }] },
      ],
    };
    llm.output = { p_chart: false, p_table: true };
    const ctx = {
      def: { title: "x", steps: [step] },
      state: { values: {}, outputs: { research: { json: { suppliers: [] }, at: "" } }, history: [], notes: {} },
      scope: { def: { title: "x", steps: [step] }, state: { values: {}, outputs: {}, history: [], notes: {} }, brand: {} },
      call: {},
      signal: new AbortController().signal,
      chargeUsd: async () => {},
    };
    const out = await runSurfaceStep(step, ctx as never);
    expect(out.surface?.components[0]).toEqual({ id: "root", component: "Column", children: ["head", "table"] });
  });

  it("assemble under one root column", () => {
    const parts = [
      { id: "a", components: [{ id: "a", component: "Text" as const, text: "A" }] },
      { id: "b", components: [{ id: "b", component: "Text" as const, text: "B" }] },
    ];
    expect(assembleSurface(parts, ["b"])).toEqual([
      { id: "root", component: "Column", children: ["b"] },
      { id: "b", component: "Text", text: "B" },
    ]);
  });
});
