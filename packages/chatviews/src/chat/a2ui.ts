// SPDX-License-Identifier: MIT
import { type ElementNode, evaluateElementProps } from "@openuidev/lang-core";
import { bound, type Surface, type SurfaceComponent } from "../surface.js";
import { checkView } from "./check.js";
import { CHAT_FUNCTIONS, chatLibrarySpec } from "./library.js";

/**
 * A view as A2UI v1.0 (a2ui.org): one `createSurface` message with its components and data, for
 * an agent or a host that speaks A2UI rather than OpenUI Lang. It is a snapshot of what the view
 * shows: every value is worked out (A2UI renderers know neither our calc nor our functions), a
 * repeat is drawn once per entry. A Form's answers are bound into the data model and come back
 * with its send button's action.
 *
 * Two catalogs: `basic` (the default) writes A2UI's basic catalog, which every A2UI renderer
 * draws, and our components it doesn't have become text; `engenty:core` keeps every component
 * ours, for a renderer that loaded our catalog (`engentyCoreCatalog`).
 */

export const A2UI_BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
export const ENGENTY_CORE_CATALOG = "https://engenty.ai/schema/chatviews/engenty-core-1.json";

export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;

export interface A2uiSurface {
  version: "1.0";
  createSurface: {
    surfaceId: string;
    catalogId: string;
    components: A2uiComponent[];
    dataModel?: Record<string, unknown>;
  };
}

export interface A2uiOptions {
  surfaceId: string;
  /** `basic` (default): A2UI's basic catalog; `engenty:core`: our components. */
  catalog?: "basic" | "engenty:core";
  /** Where a file of the space is read, by its id; without it, files are named, not shown. */
  assetUrl?: (id: string) => string;
  /** Where a Ref's `open` leads. */
  href?: (open: string) => string | null;
  /** The language numbers are written in (an authored surface's `as`). */
  locale?: string;
}

/** A component with its values worked out: what A2UI gets, before ids. */
interface Drawn {
  component: string;
  props: Record<string, unknown>;
}

const isDrawn = (v: unknown): v is Drawn =>
  Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as Drawn).component === "string" &&
      "props" in (v as object),
  );

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

// --- from a program -------------------------------------------------------------------------

const runtimeFunctions = () => {
  const schema = chatLibrarySpec.toJSONSchema() as { functions?: Record<string, object> };
  return Object.fromEntries(
    CHAT_FUNCTIONS.map((f) => [f.name, { ...(schema.functions?.[f.name] ?? {}), fn: f.fn }]),
  );
};

function fromElement(node: ElementNode): Drawn {
  const evaluated = evaluateElementProps(node, {
    ctx: {
      getState: () => undefined,
      resolveRef: () => undefined,
      functions: runtimeFunctions() as never,
    },
    library: chatLibrarySpec as never,
    store: null,
  });
  const walk = (v: unknown): unknown => {
    if (v && typeof v === "object" && (v as ElementNode).type === "element") {
      return fromElement(v as ElementNode);
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { component: node.typeName, props: walk(evaluated.props) as Record<string, unknown> };
}

// --- from an authored surface ----------------------------------------------------------------

function fromSurface(surface: Surface, locale?: string): Drawn | null {
  const byId = new Map(surface.components.map((c) => [c.id, c]));
  const draw = (id: string, row: unknown, depth: number): Drawn | null => {
    const c = byId.get(id);
    if (!c || depth > 40) {
      return null;
    }
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(c)) {
      if (key === "id" || key === "component" || key === "children") {
        continue;
      }
      props[key] = bound(value, surface.data, row, locale);
    }
    const kids = (c as SurfaceComponent).children;
    if (Array.isArray(kids)) {
      props.children = kids.map((k) => draw(k, row, depth + 1)).filter(Boolean);
    } else if (kids) {
      const items = bound({ path: kids.path }, surface.data, row, locale);
      props.children = (Array.isArray(items) ? items : [])
        .map((item) => draw(kids.componentId, item, depth + 1))
        .filter(Boolean);
    }
    if (Array.isArray(props.tabs)) {
      props.tabs = props.tabs.map((tab) => {
        const t = tab as Record<string, unknown>;
        return { ...t, child: typeof t.child === "string" ? draw(t.child, row, depth + 1) : null };
      });
    }
    if (c.component === "Form") {
      props.form = c.id;
    }
    return { component: c.component, props };
  };
  return draw("root", undefined, 0);
}

// --- writing A2UI ----------------------------------------------------------------------------

class Writer {
  components: A2uiComponent[] = [];
  data: Record<string, unknown> = {};
  #n = 0;
  constructor(private readonly options: A2uiOptions) {}

  id() {
    const id = this.#n === 0 ? "root" : `c${this.#n}`;
    this.#n += 1;
    return id;
  }

  add(component: string, props: Record<string, unknown>, id = this.id()): string {
    this.components.push({ id, component, ...props });
    return id;
  }

  text(text: string, variant: "body" | "caption" = "body"): string {
    return this.add("Text", { text, variant });
  }

  column(ids: string[], id = this.id()): string {
    return this.add("Column", { children: ids }, id);
  }

  file(id: unknown): string | null {
    const s = str(id);
    return s && this.options.assetUrl ? this.options.assetUrl(s.replace(/^f:/, "")) : null;
  }

  /** Our component kept as it is, with what it holds as ids. */
  core(d: Drawn): string {
    const id = this.id();
    const holds = (v: unknown): unknown =>
      isDrawn(v)
        ? this.core(v)
        : Array.isArray(v)
          ? v.map(holds)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, holds(x)]))
            : v;
    // A Form's name for its answers is A2UI's data model, which our components don't take.
    const { form: _form, ...own } = d.props;
    const props = holds(d.component === "Form" ? own : d.props) as Record<string, unknown>;
    this.components.push({ id, component: d.component, ...props });
    return id;
  }

  /** Our component in A2UI's basic catalog. */
  basic(d: Drawn): string {
    const p = d.props;
    const kids = () => (Array.isArray(p.children) ? p.children.filter(isDrawn) : []);
    const id = this.id();
    const many = (ids: string[]) => this.column(ids, id);
    const rows = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
    const cell = (item: unknown, key: string) =>
      item && typeof item === "object" ? (item as Record<string, unknown>)[key] : item;
    switch (d.component) {
      case "Column":
      case "Group":
        return many(kids().map((k) => this.basic(k)));
      case "List":
        return this.add("List", { children: kids().map((k) => this.basic(k)) }, id);
      case "Grid":
      case "Actions":
        return this.add("Row", { children: kids().map((k) => this.basic(k)) }, id);
      case "Text": {
        const v = str(p.variant);
        const heading = v === "h3" ? "### " : v === "h4" ? "#### " : "";
        return this.add(
          "Text",
          { text: `${heading}${str(p.text)}`, variant: v === "muted" ? "caption" : "body" },
          id,
        );
      }
      case "Markdown":
        return this.add("Text", { text: str(p.text), variant: "body" }, id);
      case "Badge":
        return this.add("Text", { text: str(p.label), variant: "caption" }, id);
      case "Row": {
        const lines = [this.text(`**${str(p.title)}**`)];
        const under = [p.subtitle, p.meta, p.badge].map(str).filter(Boolean).join(" · ");
        if (under) {
          lines.push(this.text(under, "caption"));
        }
        return many(lines);
      }
      case "DetailGrid":
        return this.add(
          "Text",
          {
            text: rows(p.rows)
              .map((r) => `**${str(r.label)}:** ${str(r.value)}`)
              .join("  \n"),
          },
          id,
        );
      case "Metric": {
        const lines = [this.text(str(p.label), "caption"), this.text(`### ${str(p.value)}`)];
        if (str(p.caption)) {
          lines.push(this.text(str(p.caption), "caption"));
        }
        return many(lines);
      }
      case "Table": {
        const all = rows(p.rows);
        const columns = Array.isArray(p.columns)
          ? (p.columns as { key: string; label?: string }[])
          : Object.keys(all[0] ?? {}).map((key) => ({ key, label: key }));
        const line = (cells: string[]) =>
          `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
        const table = [
          line(columns.map((c) => str(c.label ?? c.key))),
          line(columns.map(() => "---")),
          ...all.map((r) => line(columns.map((c) => str(r[c.key])))),
        ];
        return this.add("Text", { text: table.join("\n") }, id);
      }
      case "BarChart":
      case "LineChart":
      case "DonutChart": {
        const points = rows(p.points ?? p.slices);
        const label = str(p.labelKey) || "label";
        const value = str(p.valueKey) || "value";
        const list = points.map((r) => `- ${str(r[label])}: ${str(r[value])}`).join("\n");
        return this.add(
          "Text",
          { text: [p.title ? `**${str(p.title)}**` : "", list].filter(Boolean).join("\n\n") },
          id,
        );
      }
      case "Callout":
        return this.add(
          "Card",
          {
            child: this.text(
              [p.title ? `**${str(p.title)}**` : "", str(p.text)].filter(Boolean).join("\n\n"),
            ),
          },
          id,
        );
      case "Chips": {
        const key = str(p.labelKey);
        return this.add(
          "Text",
          {
            text: rows(p.items)
              .map((i) => str(key ? cell(i, key) : i))
              .join(" · "),
          },
          id,
        );
      }
      case "Steps": {
        const key = str(p.textKey) || "text";
        return this.add(
          "Text",
          {
            text: rows(p.items)
              .map((i, n) => `${n + 1}. ${str(cell(i, key))}`)
              .join("\n"),
          },
          id,
        );
      }
      case "Checklist": {
        const key = str(p.labelKey) || "label";
        return this.add(
          "Text",
          {
            text: rows(p.items)
              .map((i) => `- ${str(cell(i, key))}`)
              .join("\n"),
          },
          id,
        );
      }
      case "Sources": {
        const titleKey = str(p.titleKey) || "title";
        const urlKey = str(p.urlKey) || "url";
        const links = rows(p.items).map((i) => {
          const url = str(cell(i, urlKey));
          return /^https?:\/\//.test(url)
            ? `[${str(cell(i, titleKey))}](${url})`
            : str(cell(i, titleKey));
        });
        return this.add("Text", { text: links.join(" · "), variant: "caption" }, id);
      }
      case "Tabs":
        return this.add(
          "Tabs",
          {
            tabs: rows(p.tabs).map((t) => ({
              title: str(t.label),
              child: isDrawn(t.child) ? this.basic(t.child) : this.text(""),
            })),
          },
          id,
        );
      case "Card":
      case "Fold": {
        const lines: string[] = [];
        if (str(p.eyebrow)) {
          lines.push(this.text(str(p.eyebrow), "caption"));
        }
        lines.push(this.text(`**${str(p.title)}**`));
        if (str(p.subtitle)) {
          lines.push(this.text(str(p.subtitle), "caption"));
        }
        const image = this.file(p.image);
        if (image) {
          lines.push(this.add("Image", { url: image }));
        }
        lines.push(...kids().map((k) => this.basic(k)));
        return d.component === "Card"
          ? this.add("Card", { child: this.column(lines) }, id)
          : many(lines);
      }
      case "Image": {
        const url = this.file(p.src);
        return url
          ? this.add("Image", { url, ...(p.alt ? { description: str(p.alt) } : {}) }, id)
          : this.add("Text", { text: str(p.alt), variant: "caption" }, id);
      }
      case "Gallery": {
        const key = str(p.srcKey);
        const urls = rows(p.items)
          .map((i) => this.file(key ? cell(i, key) : i))
          .filter((u): u is string => Boolean(u));
        return this.add("Row", { children: urls.map((url) => this.add("Image", { url })) }, id);
      }
      case "Video":
      case "Audio": {
        const url = this.file(p.src);
        return url
          ? this.add(d.component === "Video" ? "Video" : "AudioPlayer", { url }, id)
          : this.add("Text", { text: str(p.title), variant: "caption" }, id);
      }
      case "File": {
        const url = this.file(p.file);
        return this.add("Text", { text: url ? `[${str(p.name)}](${url})` : str(p.name) }, id);
      }
      case "Ref":
      case "Link": {
        const href = p.open && this.options.href ? this.options.href(str(p.open)) : null;
        return this.add("Text", { text: href ? `[${str(p.title)}](${href})` : str(p.title) }, id);
      }
      case "Button":
        return this.add(
          "Button",
          { child: this.text(str(p.label)), action: { event: buttonEvent(p) } },
          id,
        );
      case "Form":
        return this.form(d, id);
      case "Choice":
      case "Toggle":
      case "Slider":
        return this.add("Text", { text: str(p.label ?? p.state) }, id);
    }
    return this.add("Text", { text: "" }, id);
  }

  /** A Form: its Fields bound into the data model under the form's name, and its send button. */
  form(d: Drawn, id: string): string {
    const name = str(d.props.form) || "form";
    const values: Record<string, unknown> = {};
    const lines: string[] = [];
    if (str(d.props.title)) {
      lines.push(this.text(`**${str(d.props.title)}**`));
    }
    for (const f of (Array.isArray(d.props.children) ? d.props.children : []).filter(isDrawn)) {
      const p = f.props;
      const field = str(p.name);
      const path = `/${name}/${field}`;
      const label = str(p.label) || field;
      const options = (Array.isArray(p.options) ? p.options : []).map((o) => ({
        label: str(o),
        value: str(o),
      }));
      switch (str(p.kind)) {
        case "select":
        case "multiselect":
          values[field] = Array.isArray(p.value) ? p.value.map(str) : p.value ? [str(p.value)] : [];
          lines.push(
            this.add("ChoicePicker", {
              label,
              options,
              value: { "@path": path },
              variant: p.kind === "select" ? "mutuallyExclusive" : "multipleSelection",
            }),
          );
          break;
        case "toggle":
          values[field] = p.value === true;
          lines.push(this.add("CheckBox", { label, value: { "@path": path } }));
          break;
        case "date":
          values[field] = str(p.value);
          lines.push(
            this.add("DateTimeInput", { label, value: { "@path": path }, enableDate: true }),
          );
          break;
        default:
          values[field] = p.value === undefined ? "" : str(p.value);
          lines.push(
            this.add("TextField", {
              label,
              value: { "@path": path },
              variant:
                p.kind === "textarea" ? "longText" : p.kind === "number" ? "number" : "shortText",
            }),
          );
      }
    }
    this.data[name] = values;
    lines.push(
      this.add("Button", {
        child: this.text(str(d.props.submit) || "Send"),
        variant: "primary",
        action: {
          event: { name: "submit", context: { form: name, values: { "@path": `/${name}` } } },
        },
      }),
    );
    return this.column(lines, id);
  }
}

/** A button's action as an A2UI event: ask the assistant, open a thing or a page. */
function buttonEvent(p: Record<string, unknown>): {
  name: string;
  context: Record<string, unknown>;
} {
  const action = p.action;
  if (typeof action === "string") {
    // An authored surface: regenerate, open, ask.
    return {
      name: action,
      context:
        action === "ask" ? { message: str(p.prompt) || str(p.label) } : { target: str(p.target) },
    };
  }
  const steps = (action as { steps?: Record<string, unknown>[] } | null)?.steps ?? [];
  const step = steps[0] ?? (action as Record<string, unknown> | null) ?? {};
  switch (step.type) {
    case "continue_conversation":
      return {
        name: "ask",
        context: {
          message: str(step.message) || str(p.label),
          ...(step.context ? { context: step.context } : {}),
        },
      };
    case "open_url":
      return { name: "open_url", context: { url: str(step.url) } };
    default:
      return {
        name: str(step.name ?? step.type) || "ask",
        context: (step.params as Record<string, unknown>) ?? {},
      };
  }
}

function written(root: Drawn | null, options: A2uiOptions): A2uiSurface {
  const writer = new Writer(options);
  const core = options.catalog === "engenty:core";
  if (root) {
    if (core) {
      writer.core(root);
    } else {
      writer.basic(root);
    }
  } else {
    writer.add("Column", { children: [] });
  }
  return {
    version: "1.0",
    createSurface: {
      surfaceId: options.surfaceId,
      catalogId: core ? ENGENTY_CORE_CATALOG : A2UI_BASIC_CATALOG,
      components: writer.components,
      ...(Object.keys(writer.data).length ? { dataModel: writer.data } : {}),
    },
  };
}

/** A program a model wrote, as A2UI; one `checkView` refuses is refused here too. */
export function programToA2ui(program: string, options: A2uiOptions): A2uiSurface {
  const check = checkView(program);
  if (check.issues.length || !check.parsed?.root) {
    throw new Error(`The view can't be written as A2UI: ${check.issues.join(" ")}`);
  }
  const root = fromElement(check.parsed.root);
  if (root.component === "Form" || JSON.stringify(root).includes('"component":"Form"')) {
    markForms(root);
  }
  return written(root, options);
}

/** A program's Forms get a name for their answers in the data model. */
function markForms(d: Drawn) {
  let n = 0;
  const walk = (v: unknown) => {
    if (isDrawn(v)) {
      if (v.component === "Form") {
        v.props.form = n === 0 ? "form" : `form${n}`;
        n += 1;
      }
      Object.values(v.props).forEach(walk);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(d);
}

/** An authored surface with its data (a run's result view), as A2UI. */
export function surfaceToA2ui(surface: Surface, options: A2uiOptions): A2uiSurface {
  return written(fromSurface(surface, options.locale), options);
}

/** A prop that holds components: in A2UI, their ids. */
function withIds(schema: Record<string, unknown>): Record<string, unknown> {
  const items = schema.items as Record<string, unknown> | undefined;
  if (schema.type === "array" && items && Object.keys(items).length === 0) {
    return { $ref: "common_types.json#/$defs/ChildList", description: schema.description };
  }
  if (schema.type === "array" && items?.type === "object") {
    return { ...schema, items: withIds(items) };
  }
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(props).map(([k, v]) => [
          k,
          k === "child" ? { $ref: "common_types.json#/$defs/ComponentId" } : withIds(v),
        ]),
      ),
    };
  }
  return schema;
}

/**
 * Our catalog as an A2UI v1.0 catalog document (`catalog_definition.json`), for a renderer that
 * draws `engenty:core`: the chat library's components, the props that hold components as ids.
 * Served at `ENGENTY_CORE_CATALOG` (apps/docs/public/schema/chatviews/engenty-core-1.json).
 */
export function engentyCoreCatalog(): Record<string, unknown> {
  const library = chatLibrarySpec.toJSONSchema() as {
    $defs: Record<string, Record<string, unknown>>;
  };
  const components = Object.fromEntries(
    Object.entries(library.$defs).map(([name, def]) => {
      const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
      return [
        name,
        {
          type: "object",
          description: def.description,
          allOf: [{ $ref: "common_types.json#/$defs/ComponentCommon" }],
          properties: {
            component: { const: name },
            ...Object.fromEntries(Object.entries(props).map(([k, v]) => [k, withIds(v)])),
          },
          required: ["component", ...((def.required as string[]) ?? [])],
          unevaluatedProperties: false,
        },
      ];
    }),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ENGENTY_CORE_CATALOG,
    catalogId: ENGENTY_CORE_CATALOG,
    protocolVersion: "1.0",
    title: "engenty:core",
    description:
      "The views of engenty wizards and wizards.bot (@engenty/chatviews): their components with what they show worked out.",
    components,
    functions: {},
    $defs: {
      anyComponent: { oneOf: Object.keys(components).map((n) => ({ $ref: `#/components/${n}` })) },
      anyFunction: false,
    },
  };
}
