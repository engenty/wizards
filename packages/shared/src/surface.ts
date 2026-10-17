// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import { type FieldShape, type ListShape, type ObjectShape, shapeAt } from "./shape.js";

/**
 * Surfaces: views composed from a small catalog of native components, bound to a run's data and
 * rendered by the runner itself — themed, on phones, no iframe and nothing to pay per run. A
 * surface is data, not code: only catalog components render, so it needs no sandbox. Between the
 * plain table a review shows and a widget, which is free HTML. As engenty-pro's A2UI catalog
 * (`engenty:core/v1`), kept to what a wizard's result needs.
 *
 * A surface is a flat list of components with ids; the one with id "root" is drawn, containers
 * name their children by id. A prop may be a literal or `{ "path": "/json/pointer" }` into the
 * surface's data. A `List`, `Table` or `Group` repeats over an array: inside a repeated row, a
 * path without a leading slash reads the row ("name"), one with a slash the whole data. A path
 * may turn what it reads into words: `map` looks the value up (`{ "true": "im Kühlschrank" }`),
 * `format` sets it into a text ("{} Min").
 */

export const SURFACE_COMPONENTS = [
  "Column",
  "Text",
  "List",
  "Row",
  "DetailGrid",
  "Badge",
  "Grid",
  "Metric",
  "Table",
  "Image",
  "BarChart",
  "LineChart",
  "DonutChart",
  "Actions",
  "Button",
  "Tabs",
  "Card",
  "Fold",
  "Group",
  "Chips",
  "Checklist",
  "Steps",
  "Link",
  "Callout",
] as const;
export type SurfaceComponentName = (typeof SURFACE_COMPONENTS)[number];

/** Components that hold others by id. */
const CONTAINERS: ReadonlySet<string> = new Set([
  "Column",
  "List",
  "Grid",
  "Actions",
  "Card",
  "Fold",
  "Group",
]);

/** The props each component needs. */
const REQUIRED: Partial<Record<SurfaceComponentName, string[]>> = {
  Text: ["text"],
  Row: ["title"],
  DetailGrid: ["rows"],
  Badge: ["label"],
  Metric: ["label", "value"],
  Table: ["rows"],
  Image: ["src"],
  BarChart: ["points"],
  LineChart: ["points"],
  DonutChart: ["slices"],
  Button: ["label", "action"],
  Tabs: ["tabs"],
  Card: ["title"],
  Fold: ["title", "children"],
  Group: ["children", "by"],
  Chips: ["items"],
  Checklist: ["items"],
  Steps: ["items"],
  Link: ["title", "items", "value", "view"],
  Callout: ["text"],
};

export const SURFACE_ACTIONS = ["regenerate", "open"] as const;

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/, "ids are letters, digits, _ and -");

/** One component: its id, its kind, its children (ids, or a template repeated over an array). */
export const surfaceComponentSchema = z.looseObject({
  id,
  component: z.enum(SURFACE_COMPONENTS),
  children: z
    .union([z.array(z.string()), z.object({ path: z.string(), componentId: z.string() })])
    .optional(),
});
export type SurfaceComponent = z.infer<typeof surfaceComponentSchema>;

export const surfaceComponentsSchema = z.array(surfaceComponentSchema).min(1).max(200);

/** What a run shows: the components and the data they are bound to. */
export interface Surface {
  components: SurfaceComponent[];
  data: Record<string, unknown>;
}

export interface SurfaceIssue {
  message: string;
}

const isPath = (v: unknown): v is { path: string } =>
  Boolean(v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).path === "string");

/**
 * The ids a component draws: its children, the views of its tabs. A Link's view is drawn only
 * when it is opened, so it is no part of the tree.
 */
function childIds(c: SurfaceComponent): string[] {
  const kids = c.children;
  const ids = Array.isArray(kids) ? [...kids] : kids ? [kids.componentId] : [];
  const tabs = (c as Record<string, unknown>).tabs;
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      const child = (tab as Record<string, unknown> | null)?.child;
      if (typeof child === "string") {
        ids.push(child);
      }
    }
  }
  return ids;
}

/** Every `{ path }` in a component's props, with whether it reads a repeated row. */
function pathsOf(c: SurfaceComponent): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (isPath(v)) {
      out.push(v.path);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  for (const [key, value] of Object.entries(c)) {
    if (key !== "id" && key !== "component") {
      walk(
        key === "children" && !Array.isArray(value) && isPath(value) ? { path: value.path } : value,
      );
    }
  }
  return out;
}

/** Props naming a key of the entries a component's `items` (or chart's points) holds. */
const ENTRY_KEYS = [
  "labelKey",
  "valueKey",
  "flagKey",
  "detailKey",
  "noteKey",
  "groupKey",
  "textKey",
  "minutesKey",
] as const;

type Shape = FieldShape | ListShape["of"];

/** A path as parts: "/days/0/label" from the data, "meals.slot" from the entry. */
const partsOf = (path: string) =>
  (path.startsWith("/") ? path.slice(1) : path)
    .split(/[./]/)
    .filter(Boolean)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

/**
 * The paths a surface reads, followed through the step's schema from "root": a repeated child
 * reads an entry of the list its path names, a Link's view the entry it opens. Every path has to
 * be in the schema, every key a component names in its entries.
 */
function shapeIssues(byId: Map<string, SurfaceComponent>, root: ObjectShape): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];
  /** The entry drawn: its shape, "any" where it can hold anything, undefined outside a list. */
  type Entry = Shape | "any" | undefined;
  const seen = new Map<string, Set<Entry>>();
  /** The shape a path reads where `entry` is drawn; "any": unchecked. */
  const resolve = (path: string, entry: Entry): Shape | "any" | undefined => {
    if (path.startsWith("/")) {
      return shapeAt(root, partsOf(path));
    }
    if (entry === "any") {
      return "any";
    }
    return entry ? shapeAt(entry, partsOf(path)) : undefined;
  };
  const say = (c: SurfaceComponent, path: string, entry: Entry) =>
    issues.push({
      message:
        !path.startsWith("/") && !entry
          ? `"${c.id}" reads "${path}" outside a repeated entry; from the data it is "/${path.replace(/\./g, "/")}".`
          : `"${c.id}" reads "${path}", which no data provides.`,
    });
  /** The entries of a list a prop binds, or undefined (and an issue) where it is no list. */
  const entriesOf = (c: SurfaceComponent, value: unknown, entry: Entry): Entry => {
    if (!isPath(value)) {
      return "any";
    }
    const at = resolve(value.path, entry);
    if (at === "any") {
      return "any";
    }
    if (at?.kind === "list") {
      return at.of;
    }
    if (at?.kind === "table") {
      return at.columns?.length
        ? {
            kind: "object",
            fields: Object.fromEntries(at.columns.map((k) => [k, { kind: "text" }])),
          }
        : "any";
    }
    if (at) {
      issues.push({ message: `"${c.id}" reads "${value.path}" as a list; it is ${at.kind}.` });
    } else {
      say(c, value.path, entry);
    }
    return undefined;
  };
  const hasKey = (shape: Entry, k: string) =>
    shape === "any" || shape === undefined || shape.kind !== "object" || k in shape.fields;

  const visit = (cid: string, entry: Entry) => {
    const c = byId.get(cid);
    const done = seen.get(cid) ?? new Set();
    if (!c || done.has(entry)) {
      return;
    }
    done.add(entry);
    seen.set(cid, done);
    const props = c as Record<string, unknown>;
    // What the component's items, rows or points hold, for the keys it names in them.
    const listProp = ["items", "rows", "points", "slices"].find((k) => isPath(props[k]));
    const items = listProp ? entriesOf(c, props[listProp], entry) : undefined;
    for (const k of ENTRY_KEYS) {
      const named = props[k];
      if (typeof named === "string" && items && !hasKey(items, named)) {
        issues.push({
          message: `"${c.id}": "${k}" names "${named}", which its entries do not have.`,
        });
      }
    }
    if (c.component === "Table" && Array.isArray(props.columns) && items) {
      for (const col of props.columns as { key?: unknown }[]) {
        if (typeof col?.key === "string" && !hasKey(items, col.key)) {
          issues.push({ message: `"${c.id}": no column "${col.key}" in its rows.` });
        }
      }
    }
    // A Link: title, subtitle and meta read the entry it opens, the rest the entry it sits in.
    const opened = c.component === "Link" ? items : undefined;
    if (c.component === "Link" && typeof props.key === "string" && !hasKey(opened, props.key)) {
      issues.push({ message: `"${c.id}": its items have no "${props.key}".` });
    }
    for (const [k, value] of Object.entries(props)) {
      if (k === "id" || k === "component" || k === "children" || k === listProp) {
        continue;
      }
      const reads = c.component === "Link" && (k === "title" || k === "subtitle" || k === "meta");
      const scope = reads ? opened : entry;
      const paths: string[] = [];
      const walk = (v: unknown) => {
        if (isPath(v)) {
          paths.push(v.path);
        } else if (Array.isArray(v)) {
          v.forEach(walk);
        } else if (v && typeof v === "object") {
          Object.values(v).forEach(walk);
        }
      };
      walk(value);
      for (const path of paths) {
        if (resolve(path, scope) === undefined) {
          say(c, path, scope);
        }
      }
    }
    const kids = c.children;
    if (Array.isArray(kids)) {
      for (const k of kids) {
        visit(k, entry);
      }
    } else if (kids) {
      const of = entriesOf(c, { path: kids.path }, entry);
      if (of !== undefined) {
        if (c.component === "Group" && typeof props.by === "string" && !hasKey(of, props.by)) {
          issues.push({
            message: `"${c.id}": "by" names "${props.by}", which its entries do not have.`,
          });
        }
        visit(kids.componentId, of);
      }
    }
    const tabs = props.tabs;
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        const child = (tab as Record<string, unknown> | null)?.child;
        if (typeof child === "string") {
          visit(child, entry);
        }
      }
    }
    if (c.component === "Link" && typeof props.view === "string" && opened !== undefined) {
      visit(props.view, opened);
    }
  };
  if (byId.has("root")) {
    visit("root", undefined);
  }
  return issues;
}

/**
 * What can be wrong with a surface: an unknown or missing component, no root, a child that is
 * not there, an id twice, a loop, a prop missing, and — given the data keys a run will provide,
 * or the step's schema — a path into data nothing provides.
 */
export function validateSurface(raw: unknown, data?: string[] | ObjectShape): SurfaceIssue[] {
  const dataKeys = Array.isArray(data) ? data : undefined;
  const parsed = surfaceComponentsSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ message: `${i.path.join(".")}: ${i.message}` }));
  }
  const components = parsed.data;
  const issues: SurfaceIssue[] = [];
  const byId = new Map<string, SurfaceComponent>();
  for (const c of components) {
    if (byId.has(c.id)) {
      issues.push({ message: `Duplicate component id "${c.id}".` });
    }
    byId.set(c.id, c);
  }
  if (!byId.has("root")) {
    issues.push({ message: 'A surface has a component with id "root".' });
  }
  for (const c of components) {
    for (const prop of REQUIRED[c.component] ?? []) {
      if ((c as Record<string, unknown>)[prop] === undefined) {
        issues.push({ message: `${c.component} "${c.id}" needs "${prop}".` });
      }
    }
    const action = (c as Record<string, unknown>).action;
    if (action !== undefined && !(SURFACE_ACTIONS as readonly unknown[]).includes(action)) {
      issues.push({
        message: `"${c.id}": action is one of ${SURFACE_ACTIONS.join(", ")}.`,
      });
    }
    const children = c.children;
    if (children && !CONTAINERS.has(c.component) && c.component !== "Table") {
      issues.push({ message: `${c.component} "${c.id}" holds no children.` });
    }
    if (c.component === "Group" && (!children || Array.isArray(children))) {
      issues.push({
        message: `Group "${c.id}" repeats over a list: children { "path", "componentId" }.`,
      });
    }
    const tabs = (c as Record<string, unknown>).tabs;
    if (c.component === "Tabs" && !(Array.isArray(tabs) && tabs.length >= 2)) {
      issues.push({ message: `Tabs "${c.id}" needs at least two tabs: [{ label, child }].` });
    }
    const view = (c as Record<string, unknown>).view;
    const ids = [...childIds(c), ...(typeof view === "string" ? [view] : [])];
    for (const child of ids) {
      if (!byId.has(child)) {
        issues.push({ message: `"${c.id}" names a child "${child}" that is not there.` });
      }
    }
    if (dataKeys) {
      for (const path of pathsOf(c)) {
        const key = path.startsWith("/") ? path.split("/")[1] : null;
        if (key !== null && !dataKeys.includes(key)) {
          issues.push({ message: `"${c.id}" reads "${path}", which no data provides.` });
        }
      }
    }
  }
  // A child that holds its parent would draw forever.
  const seen = new Set<string>();
  const loops = (cid: string, stack: Set<string>): boolean => {
    if (stack.has(cid)) {
      return true;
    }
    if (seen.has(cid)) {
      return false;
    }
    seen.add(cid);
    const c = byId.get(cid);
    const kids = c ? childIds(c) : [];
    const next = new Set(stack).add(cid);
    return kids.some((k) => loops(k, next));
  };
  if (byId.has("root") && loops("root", new Set())) {
    issues.push({ message: "Components hold each other in a loop." });
    return issues;
  }
  return data && !Array.isArray(data) ? [...issues, ...shapeIssues(byId, data)] : issues;
}

/** A JSON pointer into data: "/suppliers/0/name". */
export function pointer(data: unknown, path: string): unknown {
  let at: unknown = data;
  for (const part of path.split("/").slice(1)) {
    if (at === null || typeof at !== "object") {
      return undefined;
    }
    at = (at as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}

/**
 * A prop's value: a literal as it is, a path read from the data — or, without a leading slash,
 * from the row a List or Table repeats over.
 */
export function bound(value: unknown, data: unknown, row?: unknown): unknown {
  if (!isPath(value)) {
    return value;
  }
  const raw = value.path.startsWith("/")
    ? pointer(data, value.path)
    : row === undefined
      ? undefined
      : pointer(row, `/${value.path.replace(/\./g, "/")}`);
  return worded(raw, value as { map?: unknown; format?: unknown });
}

/** A value turned into words as its path says: looked up in `map`, set into `format`. */
export function worded(raw: unknown, spec: { map?: unknown; format?: unknown }): unknown {
  let v = raw;
  const map = spec.map;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const key = String(v);
    if (Object.hasOwn(map, key)) {
      v = (map as Record<string, unknown>)[key];
    }
  }
  if (typeof spec.format === "string" && v !== undefined && v !== null && v !== "") {
    v = spec.format.replace("{}", Array.isArray(v) ? v.join(", ") : String(v));
  }
  return v;
}

/** What a model needs to compose a surface: the catalog, briefly. */
export const SURFACE_GUIDE = `A surface is a flat JSON array of components; the one with id "root" is drawn. Containers list their children by id.
Components and props (a prop may be a literal or {"path": "/key/..."} into the data):
- Column { children: [ids] } — vertical stack (use for root); Column and Grid may also repeat one component per entry: children {"path", "componentId"}
- Text { text, variant?: "h3"|"h4"|"lead"|"body"|"muted" } — "lead": the one opening line in the wizard's voice
- List { children: {"path": "/rows", "componentId": "<a Row id>"} } — one Row per array entry; inside, paths without "/" read the entry ("name")
- Row { title, subtitle?, meta?, badge?, image? }
- DetailGrid { rows: [{ label, value }] } — label/value facts
- Badge { label, tone?: "default"|"success"|"warning"|"accent" }
- Grid { children: [ids], columns?: 2|3|4, min?: rem } — tiles side by side; min: the narrowest a tile gets (14 for cards, so a phone shows one)
- Metric { label, value, caption? } — a key figure
- Table { rows: {"path": "/rows"}, columns?: [{ key, label }] }
- Image { src: an asset id or {"path": ...}, alt? }
- BarChart / LineChart { title?, points: [{ label, value }] or {"path": ...}, labelKey?, valueKey? }
- DonutChart { title?, slices: [{ label, value }] or {"path": ...}, labelKey?, valueKey? }
  (labelKey / valueKey: the columns of bound rows that hold the label and the number, e.g. "name", "price")
- Actions { children: [Button ids] } / Button { label, action: "regenerate"|"open" }
- Tabs { tabs: [{ label, count?, child: id }] } — two to four views of one result; count may bind a list (shows its length)
- Card { title, eyebrow?, subtitle?, meta?: [values], image?, children?: [ids] } — one thing: a day, a recipe, an offer
- Fold { title, open?, children: [ids] } — details that open on a tap
- Group { children: {"path", "componentId"}, by: "<key>", order?: [values] } — entries under a heading per value of a key
- Chips { items, labelKey?, flagKey?, flag? } — short things at a glance; flagKey marks some ("bald")
- Checklist { items, labelKey?, detailKey?, noteKey?, noteFormat?, noteMap?, groupKey?, groupOrder?, share? } — things to get or do; ticks are kept; a yes/no note needs noteMap: {"true": "da", "false": "einkaufen"}
- Steps { items, textKey?, minutesKey? } — ordered work, numbered, with times
- Link { title, subtitle?, eyebrow?, meta?, look?: "row"|"card", items: {"path": "/recipes"}, key?: "id", value: {"path": "recipe_id"}, view: id } — opens the entry of items whose key is value in a sheet, drawn by view; title, subtitle and meta read that entry, eyebrow the row the Link sits in
- Callout { text, title?, tone?: "tip"|"note"|"warning" }
A path may put its value into words: {"path": "in_fridge", "map": {"true": "da", "false": "einkaufen"}}, {"path": "minutes", "format": "{} Min"}.
Design it like an app, not a report: lead with a headline, the key figure or the chips; one Card per thing, never a Table of things; ordered work is Steps, things to get are a Checklist, sets are grouped by their key. A Table only for figures people compare across columns.
Keep it small: what the person needs to see first, then the details. Never invent numbers: bind them by path.`;
