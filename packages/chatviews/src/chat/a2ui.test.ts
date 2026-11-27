import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { programToA2ui, surfaceToA2ui } from "./a2ui.js";

// A2UI's own v1.0 schemas, as @a2ui/web_core ships them: what a renderer checks a message with.
const schemas = join(import.meta.dirname, "../../node_modules/@a2ui/web_core/src/v1_0/schemas");
const read = (file: string) => JSON.parse(readFileSync(join(schemas, file), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(read("common_types.json"));
// The envelope names its catalog "catalog.json", next to itself.
ajv.addSchema({
  ...read("catalogs/basic/catalog.json"),
  $id: "https://a2ui.org/specification/v1_0/catalog.json",
});
const validate = ajv.compile(read("agent_to_renderer.json"));

const valid = (message: unknown) => {
  const ok = validate(message);
  return ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const program = [
  "root = Column([title, figures, days, form, ask])",
  'title = Text("Next week", "h3")',
  "figures = Grid([open], 2)",
  'open = Metric("Open", @Format(0.25, "{}", "percent"))',
  "days = List([mon])",
  'mon = Row("Monday", "Site visit", "9:00")',
  'form = Form([when, note], "Send", "When suits you?")',
  'when = Field("when", "select", "Day", true, ["Mon", "Tue"])',
  'note = Field("note", "textarea", "Note")',
  'ask = Button("Plan it", @ToAssistant("Plan Wednesday"))',
].join("\n");

describe("programToA2ui", () => {
  it("writes A2UI v1.0 with the basic catalog", () => {
    const message = programToA2ui(program, { surfaceId: "v1" });
    expect(valid(message)).toEqual([]);
    const { components, dataModel } = message.createSurface;
    expect(components.some((c) => c.id === "root")).toBe(true);
    expect(JSON.stringify(components)).toContain("### Next week");
    expect(JSON.stringify(components)).toContain("25%");
    expect(dataModel).toEqual({ form: { when: [], note: "" } });
    const ask = components.find(
      (c) => c.component === "Button" && JSON.stringify(c).includes('"ask"'),
    );
    expect(ask?.action).toEqual({ event: { name: "ask", context: { message: "Plan Wednesday" } } });
    const send = components.find((c) => JSON.stringify(c).includes('"submit"'));
    expect(send?.action).toEqual({
      event: { name: "submit", context: { form: "form", values: { "@path": "/form" } } },
    });
  });

  it("keeps our components with engenty:core", () => {
    const message = programToA2ui(program, { surfaceId: "v1", catalog: "engenty:core" });
    const names = new Set(message.createSurface.components.map((c) => c.component));
    expect(names).toContain("Metric");
    expect(names).toContain("Row");
    const root = message.createSurface.components.find((c) => c.id === "root");
    expect(root?.component).toBe("Column");
    expect(Array.isArray(root?.children)).toBe(true);
  });

  it("refuses what checkView refuses", () => {
    expect(() => programToA2ui("root = Column([x])", { surfaceId: "v" })).toThrow();
  });
});

describe("surfaceToA2ui", () => {
  it("writes an authored surface with its data worked out", () => {
    const message = surfaceToA2ui(
      {
        components: [
          { id: "root", component: "Column", children: ["title", "days", "pic"] },
          { id: "title", component: "Text", text: { path: "/title" }, variant: "h4" },
          { id: "days", component: "List", children: { path: "/days", componentId: "day" } },
          {
            id: "day",
            component: "Row",
            title: { path: "name" },
            meta: { path: "minutes", format: "{} min" },
          },
          { id: "pic", component: "Image", src: "a1" },
        ],
        data: {
          title: "Plan",
          days: [
            { name: "Mon", minutes: 20 },
            { name: "Tue", minutes: 5 },
          ],
        },
      },
      { surfaceId: "run", assetUrl: (id) => `https://example.org/f/${id}` },
    );
    expect(valid(message)).toEqual([]);
    const text = JSON.stringify(message);
    expect(text).toContain("#### Plan");
    expect(text).toContain("**Tue**");
    expect(text).toContain("5 min");
    expect(text).toContain("https://example.org/f/a1");
  });
});

describe("engentyCoreCatalog", () => {
  it("is an A2UI v1.0 catalog, and checks what engenty:core writes", async () => {
    const { engentyCoreCatalog } = await import("./a2ui.js");
    const catalog = engentyCoreCatalog();
    const definition = ajv.compile(read("catalog_definition.json"));
    expect(definition(catalog) ? [] : definition.errors).toEqual([]);
    // The envelope with our catalog in place of the basic one.
    const ours = new Ajv2020({ strict: false, allErrors: true });
    ours.addSchema(read("common_types.json"));
    ours.addSchema({ ...catalog, $id: "https://a2ui.org/specification/v1_0/catalog.json" });
    const check = ours.compile(read("agent_to_renderer.json"));
    const message = programToA2ui(program, { surfaceId: "v1", catalog: "engenty:core" });
    expect(
      check(message) ? [] : check.errors?.map((e) => `${e.instancePath} ${e.message}`),
    ).toEqual([]);
  });

  it("is the file the docs site serves", async () => {
    const { engentyCoreCatalog } = await import("./a2ui.js");
    const served = join(
      import.meta.dirname,
      "../../../../apps/docs/public/schema/chatviews/engenty-core-1.json",
    );
    expect(JSON.parse(readFileSync(served, "utf8"))).toEqual(engentyCoreCatalog());
  });
});
