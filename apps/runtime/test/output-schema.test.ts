import { declaredShape, parseWizard } from "@engenty/wizards-shared/definition";
import {
  MAX_SHAPE_KEYS,
  type ObjectSchema,
  shapeJsonSchema,
  shapeOfFields,
} from "@engenty/wizards-shared/shape";
import { bound, validateSurface } from "@engenty/wizards-shared/surface";
import { describe, expect, it, vi } from "vitest";
import { fridgeSchema, fridgeShape } from "../../web/src/dev/data-shape";
import { fridgePlan, fridgeView } from "../../web/src/dev/view-lab-sample";

// The model answers with the plan in a fenced block, as an agent mostly does.
const answer = vi.hoisted(() => ({ text: "", chunk: 120 }));
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    async generate() {
      return { text: answer.text, steps: [{ text: answer.text }], usage: {} };
    }
    // A json step streams: the answer arrives in pieces, as from a model.
    async stream() {
      const text = answer.text;
      async function* chunks() {
        for (let i = 0; i < text.length; i += answer.chunk) {
          yield { type: "text-delta", payload: { text: text.slice(i, i + answer.chunk) } };
        }
      }
      return {
        fullStream: chunks(),
        text: Promise.resolve(text),
        steps: Promise.resolve([{ text }]),
        usage: Promise.resolve({}),
        totalUsage: Promise.resolve({}),
      };
    }
  },
}));
vi.mock("../src/models.js", () => ({
  textModel: async () => ({ model: "test", vendor: "test" }),
  attachTools: () => {},
  takesTools: () => true,
  costOf: () => 0,
  isHarnessVendor: () => false,
  agentModel: (resolved: { model: unknown }) => resolved.model,
  totalUsage: async (out: { totalUsage?: unknown; usage?: unknown }) =>
    (await out.totalUsage) ?? (await out.usage),
}));
vi.mock("../src/tools/index.js", () => ({
  buildStepTools: async () => ({ tools: {}, assets: [] }),
}));
vi.mock("../src/tools/store.js", () => ({ personUploads: async () => [] }));
vi.mock("../src/tools/plugin.js", () => ({
  callPluginTool: async () => null,
  spaceContextOf: async () => ({ blocks: [] }),
}));
vi.mock("../src/services/knowledge.js", () => ({ knowledgeBlock: async () => "" }));
vi.mock("../src/services/skills.js", async (original) => ({
  ...(await original<typeof import("../src/services/skills.js")>()),
  activeSkills: async () => ({ always: [], demand: [] }),
}));

const { outputSchema, ownJson, runAgentStep } = await import("@engenty/wizards-engine/steps/index");
const { inProcessServices } = await import("../src/run-services/index.js");
const { shapedCsvRows, shapedMarkdown, shapedTables } = await import("../src/render/shaped");

const cook = {
  id: "cook",
  type: "agent",
  title: "Menüplan",
  instructions: "Plan three days from the photos of the fridge.",
  tools: [],
  output: { format: "json", schema: fridgeSchema, surface: fridgeView },
};

const wizard = (step: Record<string, unknown> = cook) => ({
  title: "Kühlschrank-Koch",
  steps: [
    {
      id: "photos",
      type: "form",
      title: "Fotos",
      fields: [{ id: "fridge", kind: "image", label: "Dein Kühlschrank" }],
    },
    step,
    {
      id: "done",
      type: "result",
      title: "Fertig",
      deliverables: [{ from: "cook", formats: ["pdf", "xlsx"] }],
    },
  ],
});

describe("an agent step's output schema", () => {
  it("takes Kühlschrank-Koch's nested plan and its view", () => {
    const parsed = parseWizard(wizard());
    expect(parsed.issues).toEqual([]);
    expect(parsed.ok).toBe(true);
  });

  it("says what is wrong with one", () => {
    const messages = (step: Record<string, unknown>) =>
      parseWizard(wizard(step))
        .issues.map((i) => i.message)
        .join("\n");
    const output = (o: Record<string, unknown>) => ({ ...cook, output: { ...cook.output, ...o } });
    expect(
      messages(output({ fields: [{ id: "summary", kind: "text" }] })),
    ).toContain('"fields" or "schema", not both');
    expect(messages({ ...cook, output: { format: "markdown", schema: fridgeSchema } })).toContain(
      'output format "json"',
    );
    // A ref points at a top-level list whose entries have an id.
    const noId = structuredClone(fridgeSchema);
    const recipes = noId.properties.recipes;
    if (recipes.type === "array" && recipes.items.type === "object") {
      delete recipes.items.properties.id;
    }
    expect(messages(output({ schema: noId, surface: undefined }))).toContain(
      'its items need an "id" string',
    );
    // Objects nest four deep at most.
    const leaf = { type: "string" } as const;
    const nest = (n: number): ObjectSchema =>
      n === 1
        ? { type: "object", properties: { name: leaf } }
        : { type: "object", properties: { more: { type: "array", items: nest(n - 1) } } };
    expect(messages(output({ schema: nest(4), surface: undefined }))).not.toContain("deep");
    expect(messages(output({ schema: nest(5), surface: undefined }))).toContain(
      "objects nest at most 4 deep",
    );
    const wide: ObjectSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: MAX_SHAPE_KEYS + 1 }, (_, i) => [`k${i}`, leaf]),
      ),
    };
    expect(messages(output({ schema: wide, surface: undefined }))).toContain(
      `at most ${MAX_SHAPE_KEYS} keys`,
    );
  });

  it("is written in JSON Schema and read as the shape everything goes by", () => {
    const parsed = parseWizard(wizard());
    const step = parsed.ok ? parsed.wizard.steps.find((x) => x.id === "cook") : undefined;
    expect(step && declaredShape(step as never)).toEqual(fridgeShape);
    const recipe = fridgeShape.fields.recipes;
    expect(recipe.kind === "list" && recipe.of.kind === "object" && recipe.of.fields.time_minutes)
      .toEqual({ kind: "number", label: "Zeit", unit: "Min" });
    // "required" names every key or none: a model fills each one.
    const some = { ...fridgeSchema, required: ["summary"] };
    expect(
      parseWizard(wizard({ ...cook, output: { ...cook.output, schema: some } }))
        .issues.map((i) => i.message)
        .join("\n"),
    ).toContain('"required" names every property');
  });

  it("checks the view's paths into nested lists", () => {
    expect(validateSurface(fridgeView, fridgeShape)).toEqual([]);
    const wrong = fridgeView.map((c) =>
      c.id === "ing" ? { ...c, title: { path: "zutat" } } : c.id === "found" ? { ...c, labelKey: "titel" } : c,
    );
    expect(validateSurface(wrong, fridgeShape).map((i) => i.message)).toEqual([
      '"found": "labelKey" names "titel", which its entries do not have.',
      '"ing" reads "zutat", which no data provides.',
    ]);
  });

  it("is a strict JSON Schema for the model and for developers", () => {
    const schema = shapeJsonSchema(fridgeShape) as any;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("Menüplan");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(fridgeShape.fields));
    const recipe = schema.properties.recipes.items;
    expect(recipe.required).toContain("steps");
    expect(recipe.properties.steps.items.properties.minutes).toMatchObject({
      type: "number",
      title: "Dauer",
    });
    expect(recipe.properties.difficulty.enum).toEqual(["leicht", "mittel", "anspruchsvoll"]);
    expect(JSON.stringify(schema)).not.toContain("$ref");
  });

  it("is the same code path for the short form", () => {
    const step = {
      ...cook,
      output: { format: "json", fields: [{ id: "items", kind: "table", columns: ["a"] }] },
    } as any;
    expect(declaredShape(step)).toEqual(
      shapeOfFields([{ id: "items", kind: "table", columns: ["a"] }]),
    );
    expect(ownJson('{"items": [{"a": ["x", "y"]}]}', outputSchema(step).schema, outputSchema(step).shape)).toEqual(
      { items: [{ a: "x y" }] },
    );
  });
});

describe("a step with a schema, run", () => {
  const ctx = () => {
    const c: Record<string, unknown> = {
    def: wizard(),
    space: { id: "p" },
    dataSpace: { id: "p", name: "" },
    spaceFiles: [],
    // Who holds the run, and its wizard: what a step reads Knowledge as.
    holder: { kind: "guest", id: "v" },
    store: { wizardId: "w", holder: "g:v" },
    call: {},
    signal: new AbortController().signal,
    state: { values: {}, outputs: {}, notes: {} },
    scope: {
      def: wizard(),
      state: { values: {}, outputs: {}, notes: {} },
      brand: {},
    },
    emit: async () => {},
    };
    c.services = inProcessServices(
      { id: "r", definition: wizard() } as never,
      () => c as never,
      runAgentStep,
    );
    return c;
  };

  it("stores the model's nested answer as it is, numbers fitted, lists not joined", async () => {
    // A number written as text, and a step's minutes as text: fitted, not refused.
    const written = structuredClone(fridgePlan) as any;
    written.recipes[0].time_minutes = "25";
    answer.text = `Hier ist der Plan.\n\n\`\`\`json\n${JSON.stringify(written)}\n\`\`\``;
    const out = await runAgentStep(cook as any, ctx() as any);
    expect(out.json).toEqual(fridgePlan);
    expect((out.json as any).shopping_list[0].for_recipes).toEqual(
      fridgePlan.shopping_list[0].for_recipes,
    );
    // The view written once is bound to the run's data.
    expect(out.surface?.components).toEqual(fridgeView);
    const day = (out.json as any).days[0];
    expect(bound({ path: "theme" }, out.json, day)).toBe("Levantinischer Abend");
    expect(bound({ path: "/recipes/0/steps/1/minutes", format: "{} Min" }, out.json)).toBe(
      "7 Min",
    );
  });

  it("tells what it has written while it writes, every entry once", async () => {
    answer.text = `Los geht's.\n\n\`\`\`json\n${JSON.stringify(fridgePlan)}\n\`\`\``;
    const notes: { code: string; params?: Record<string, unknown> }[] = [];
    await runAgentStep(cook as any, {
      ...ctx(),
      emit: async (_type: string, note: unknown) => {
        if (note && typeof note === "object") {
          notes.push(note as never);
        }
      },
    } as any);
    const found = notes.filter((n) => n.code === "found").map((n) => n.params);
    expect(found).toContainEqual({ label: "Rezepte", name: "Shakshuka mit Feta" });
    expect(found).toContainEqual({ label: "Im Kühlschrank erkannt", name: "Eier" });
    const names = found.map((f) => `${f?.label}/${f?.name}`);
    expect(new Set(names).size).toBe(names.length);
    expect(found.length).toBeLessThanOrEqual(40);
  });

  it("tells nothing when the answer comes in one piece", async () => {
    answer.text = `\`\`\`json\n${JSON.stringify(fridgePlan)}\n\`\`\``;
    answer.chunk = 1_000_000;
    const notes: { code: string }[] = [];
    try {
      await runAgentStep(cook as any, {
        ...ctx(),
        emit: async (_type: string, note: unknown) => {
          if (note && typeof note === "object") {
            notes.push(note as never);
          }
        },
      } as any);
    } finally {
      answer.chunk = 120;
    }
    expect(notes.filter((n) => n.code === "found")).toEqual([]);
  });

  it("downloads as sheets per list, a CSV of flat entries and a document", () => {
    const data = fridgePlan as unknown as Record<string, unknown>;
    const tables = shapedTables(fridgeShape, data);
    expect(tables.map((t) => t.name)).toEqual([
      "Im Kühlschrank erkannt",
      "Tage",
      "Rezepte",
      "Einkaufsliste",
    ]);
    expect(tables[2].rows[0]).toMatchObject({
      Titel: "Shakshuka mit Feta",
      Zeit: 25,
      Zutaten: expect.stringContaining("Eier; Paprika, rot"),
    });
    expect(shapedCsvRows(fridgeShape, data)?.[2]).toEqual({
      Name: "Spinat",
      Menge: "1 Beutel",
      Abteilung: "Obst & Gemüse",
      "Bald verbrauchen": "✓",
    });
    const md = shapedMarkdown(fridgeShape, data);
    expect(md).toContain("## Rezepte");
    expect(md).toContain("### Shakshuka mit Feta");
    expect(md).toContain("| Zutat | Menge | Im Kühlschrank |");
    expect(md).toContain("| Feta | 100 g | da |");
    // A meal's recipe by its title, not its id.
    expect(md).toContain("| Abend | Shakshuka mit Feta |");
  });

  it("takes the admin's edits only where they fit the schema", async () => {
    const { editedJson } = await import("../src/engine/runner");
    const parsed = parseWizard(wizard());
    const def = parsed.ok ? parsed.wizard : null;
    const output = { json: fridgePlan, surface: { components: fridgeView, data: fridgePlan } };
    const edited = structuredClone(fridgePlan) as any;
    edited.days[0].theme = "Levante am Abend";
    edited.recipes[0].servings = "3";
    const out = editedJson(def as any, "cook", output as any, edited);
    expect((out.json as any).days[0].theme).toBe("Levante am Abend");
    expect((out.json as any).recipes[0].servings).toBe(3);
    expect(out.surface?.data).toBe(out.json);
    const broken = structuredClone(fridgePlan) as any;
    broken.recipes[0].difficulty = "mörderisch";
    expect(() => editedJson(def as any, "cook", output as any, broken)).toThrow(/difficulty/);
  });
});
