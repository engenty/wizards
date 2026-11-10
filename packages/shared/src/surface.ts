// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import { calcNames, calcScope, evalCalc, parsedCalc } from "./calc.js";
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
 * `format` sets it into a text ("{} Min"). Next to `path`, a prop may be `{ "calc": "demo / budget" }`,
 * worked out from the data and the row (calc.ts); it takes the same `map` and `format`, and both
 * take `as` ("number", "percent") to write a number in the wizard's locale.
 *
 * A chat's view (Work, `show_view`) may also ask: a `Form` of `Field`s, a `Ref` to a thing of the
 * space, a Button that asks the AI. A wizard asks in its forms, so its views take none of them.
 * A wizard's views have `Choice`, `Toggle` and `Slider`: what the person sets there is view state,
 * kept with the run under the `state` name, which paths and calc read like a data key.
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
  "Markdown",
  "Sources",
  "File",
  "Video",
  "Audio",
  "Gallery",
  "Ref",
  "Form",
  "Field",
  // Views of a wizard only: a choice the person makes in the view, kept with the run.
  "Choice",
  "Toggle",
  "Slider",
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
  "Form",
]);

/**
 * Only a chat's view has these: a wizard asks in its forms, and its run has no space to open. A
 * form has `Field` too, as a place for one of its own fields (`name` only).
 */
const CHAT_ONLY: ReadonlySet<string> = new Set(["Form", "Ref"]);

/**
 * The kinds of a Field, the runner's own field kinds (definition.ts FIELD_KINDS) that need
 * nothing of a run: no kept list, connection, line items or free slots.
 */
export const FORM_FIELD_KINDS = [
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "date",
  "email",
  "url",
  "toggle",
  "color",
  "image",
  "file",
  "location",
  "audio",
  "signature",
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

/** The props each component needs. */
export const SURFACE_REQUIRED: Partial<Record<SurfaceComponentName, string[]>> = {
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
  Markdown: ["text"],
  Sources: ["items"],
  File: ["file"],
  Video: ["src"],
  Audio: ["src"],
  Gallery: ["items"],
  Ref: ["title", "open"],
  Form: ["children", "submit"],
  // A chat's view needs "kind" and "label" as well: askIssues checks by place.
  Field: ["name"],
  Choice: ["state", "options"],
  Toggle: ["state", "label"],
  Slider: ["state", "min", "max"],
};

/** `ask` (a chat's view only): the person asks the AI the button's `prompt`, or its label. */
export const SURFACE_ACTIONS = ["regenerate", "open", "ask"] as const;

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

const isCalc = (v: unknown): v is { calc: string; as?: unknown } =>
  Boolean(v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).calc === "string");

/** Every `{ calc }` in a prop's value. */
function calcsIn(value: unknown): { calc: string; as?: unknown }[] {
  if (isCalc(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(calcsIn);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(calcsIn) : [];
}

/** What a calculation names at the top: `row.total` reads the key `row`. */
const headOf = (name: string) => name.split(".")[0];

/** The components drawn for each entry of a list: their calculations read that entry too. */
function repeatedIds(components: SurfaceComponent[]): Set<string> {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out = new Set<string>();
  const mark = (cid: string) => {
    if (!out.has(cid)) {
      out.add(cid);
      const c = byId.get(cid);
      if (c) {
        childIds(c).forEach(mark);
      }
    }
  };
  for (const c of components) {
    if (c.children && !Array.isArray(c.children)) {
      mark(c.children.componentId);
    }
    const view = (c as Record<string, unknown>).view;
    if (c.component === "Link" && typeof view === "string") {
      mark(view);
    }
  }
  return out;
}

/** What can be wrong with the calculations of a component: their text, `as`, and given what the place holds, their names. */
function componentCalcIssues(c: SurfaceComponent, given: Set<string> | null): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (key === "id" || key === "component" || key === "children") {
      continue;
    }
    // A Checklist's `detail` is worked out per entry: it reads the entry's columns too.
    const allowed = c.component === "Checklist" && key === "detail" ? null : given;
    for (const spec of calcsIn(value)) {
      const node = parsedCalc(spec.calc);
      if ("error" in node) {
        issues.push({ message: `"${c.id}": "${spec.calc}" cannot be worked out: ${node.error}` });
        continue;
      }
      if (spec.as !== undefined && spec.as !== "number" && spec.as !== "percent") {
        issues.push({ message: `"${c.id}": "as" is "number" or "percent".` });
      }
      if (allowed) {
        for (const name of calcNames(node)) {
          if (!allowed.has(headOf(name))) {
            issues.push({ message: `"${c.id}" reads "${name}", which no data provides.` });
          }
        }
      }
    }
  }
  return issues;
}

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
  "srcKey",
  "captionKey",
  "titleKey",
  "urlKey",
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
      const perEntry = c.component === "Checklist" && k === "detail";
      const scope = reads ? opened : perEntry ? items : entry;
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
      for (const spec of calcsIn(value)) {
        const node = parsedCalc(spec.calc);
        for (const name of "error" in node ? [] : calcNames(node)) {
          const head = headOf(name);
          if (!(head in root.fields) && !(scope !== undefined && hasKey(scope, head))) {
            issues.push({ message: `"${c.id}" reads "${name}", which no data provides.` });
          }
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
 * or the step's schema — a path into data nothing provides. `chat`: a chat's view, which may ask
 * (one Form, its Fields, Refs, `ask`). `form`: a form's layout, with the ids of its fields.
 */
export function validateSurface(
  raw: unknown,
  data?: string[] | ObjectShape,
  options: { chat?: boolean; form?: string[] } = {},
): SurfaceIssue[] {
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
  issues.push(...askIssues(components, byId, options));
  const repeated = repeatedIds(components);
  const states = stateNames(components);
  issues.push(...viewInputIssues(components, new Set(dataKeys ?? shapeKeys(data)), options));
  const keys = dataKeys ? new Set([...dataKeys, ...states]) : null;
  for (const c of components) {
    issues.push(...componentCalcIssues(c, repeated.has(c.id) ? null : keys));
    for (const prop of SURFACE_REQUIRED[c.component] ?? []) {
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
        if (key !== null && !dataKeys.includes(key) && !states.includes(key)) {
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
  return data && !Array.isArray(data)
    ? [
        ...issues,
        ...shapeIssues(byId, {
          ...data,
          fields: {
            ...data.fields,
            ...Object.fromEntries(states.map((s) => [s, { kind: "text" as const, label: s }])),
          },
        }),
      ]
    : issues;
}

const VIEW_INPUTS: ReadonlySet<string> = new Set(["Choice", "Toggle", "Slider"]);

/** The names a view's inputs keep their values under. */
function stateNames(components: SurfaceComponent[]): string[] {
  return components.flatMap((c) => {
    const state = (c as Record<string, unknown>).state;
    return VIEW_INPUTS.has(c.component) && typeof state === "string" ? [state] : [];
  });
}

const shapeKeys = (data: string[] | ObjectShape | undefined) =>
  data && !Array.isArray(data) ? Object.keys(data.fields) : [];

/**
 * A view's inputs: never on a form, whose inputs are its fields and answers, nor in a chat's view.
 * A `state` name is one of its own, and what each needs has the right form.
 */
function viewInputIssues(
  components: SurfaceComponent[],
  dataKeys: Set<string>,
  { chat, form }: { chat?: boolean; form?: string[] },
): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];
  const seen = new Set<string>();
  const repeated = repeatedIds(components);
  const checklists = new Set(
    components.filter((c) => c.component === "Checklist").map((c) => c.id),
  );
  for (const c of components) {
    if (!VIEW_INPUTS.has(c.component)) {
      continue;
    }
    const props = c as Record<string, unknown>;
    if (form) {
      issues.push({
        message: `${c.component} "${c.id}" is for a wizard's views; on a form, a field asks.`,
      });
    }
    if (chat) {
      issues.push({ message: `${c.component} "${c.id}" is for a wizard's views, not a chat's.` });
    }
    if (repeated.has(c.id)) {
      issues.push({ message: `${c.component} "${c.id}" stands in a repeat; it has one value.` });
    }
    const state = props.state;
    if (typeof state === "string") {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(state)) {
        issues.push({ message: `${c.component} "${c.id}": state is letters, digits and _.` });
      }
      if (seen.has(state)) {
        issues.push({ message: `The state "${state}" is named twice in this view.` });
      }
      if (dataKeys.has(state)) {
        issues.push({ message: `The state "${state}" is also a data key of this view.` });
      }
      // Ticks are kept under their component's id, next to the view's state.
      if (checklists.has(state)) {
        issues.push({ message: `The state "${state}" is also the id of a Checklist.` });
      }
      seen.add(state);
    }
    if (c.component === "Choice") {
      const options = props.options;
      const fits = (o: unknown) =>
        typeof o === "string" ||
        typeof o === "number" ||
        (Boolean(o) &&
          typeof o === "object" &&
          "value" in (o as object) &&
          "label" in (o as object));
      if (!(Array.isArray(options) && options.length && options.every(fits))) {
        issues.push({
          message: `Choice "${c.id}" needs "options": values, or { label, value }.`,
        });
      }
      if (props.look !== undefined && props.look !== "list") {
        issues.push({ message: `Choice "${c.id}": look is "list".` });
      }
    }
    if (c.component === "Slider") {
      const { min, max, increment } = props;
      if (typeof min !== "number" || typeof max !== "number" || min >= max) {
        issues.push({ message: `Slider "${c.id}": min and max are numbers, min below max.` });
      } else if (typeof increment === "number" && (increment <= 0 || increment > max - min)) {
        issues.push({ message: `Slider "${c.id}": increment does not fit from min to max.` });
      }
    }
  }
  return issues;
}

/** What a view may ask, and how: a chat's only, one Form, its Fields in it and named once. */
function askIssues(
  components: SurfaceComponent[],
  byId: Map<string, SurfaceComponent>,
  { chat, form }: { chat?: boolean; form?: string[] },
): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];
  if (!chat) {
    if (form) {
      issues.push(...formFieldIssues(components, form));
    }
    for (const c of components) {
      if (CHAT_ONLY.has(c.component) || (c.component === "Field" && !form)) {
        issues.push({
          message: `${c.component} "${c.id}" is for a chat's view; a wizard asks on its forms.`,
        });
      }
      if ((c as Record<string, unknown>).action === "ask") {
        issues.push({ message: `"${c.id}": "ask" is for a chat's view.` });
      }
    }
    return issues;
  }
  const forms = components.filter((c) => c.component === "Form");
  if (forms.length > 1) {
    issues.push({ message: "A view holds at most one Form." });
  }
  const inForm = new Set<string>();
  for (const form of forms) {
    const kids = Array.isArray(form.children) ? form.children : [];
    if (!Array.isArray(form.children)) {
      issues.push({ message: `Form "${form.id}" names its Fields: children [ids].` });
    }
    const names = new Set<string>();
    for (const kid of kids) {
      const field = byId.get(kid);
      if (field && field.component !== "Field") {
        issues.push({ message: `Form "${form.id}" holds Fields only, not ${field.component}.` });
      }
      inForm.add(kid);
      const name = (field as Record<string, unknown> | undefined)?.name;
      if (typeof name === "string") {
        if (names.has(name)) {
          issues.push({ message: `Form "${form.id}" names the field "${name}" twice.` });
        }
        names.add(name);
      }
    }
  }
  for (const c of components) {
    if (c.component !== "Field") {
      continue;
    }
    const f = c as Record<string, unknown>;
    if (!inForm.has(c.id)) {
      issues.push({ message: `Field "${c.id}" sits in a Form.` });
    }
    for (const prop of ["kind", "label"]) {
      if (f[prop] === undefined) {
        issues.push({ message: `Field "${c.id}" needs "${prop}".` });
      }
    }
    if (typeof f.kind === "string" && !(FORM_FIELD_KINDS as readonly string[]).includes(f.kind)) {
      issues.push({
        message: `Field "${c.id}": kind is one of ${FORM_FIELD_KINDS.join(", ")}.`,
      });
    }
    const options = f.options;
    if (
      (f.kind === "select" || f.kind === "multiselect") &&
      !(Array.isArray(options) && options.length && options.every((o) => typeof o === "string"))
    ) {
      issues.push({ message: `Field "${c.id}" (${f.kind}) needs "options": [texts].` });
    }
    if (typeof f.name === "string" && !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(f.name)) {
      issues.push({ message: `Field "${c.id}": name is letters, digits and _.` });
    }
  }
  return issues;
}

/**
 * A form's layout places its fields: each by exactly one `Field`, which names it and says nothing
 * else, since the field itself says how it asks.
 */
function formFieldIssues(components: SurfaceComponent[], fields: string[]): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];
  const placed = new Map<string, number>();
  const repeated = repeatedIds(components);
  for (const c of components) {
    if (c.component !== "Field") {
      continue;
    }
    const f = c as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name : "";
    if (f.kind !== undefined || f.label !== undefined) {
      issues.push({
        message: `Field "${c.id}" only places a field of this form: "name" and nothing else.`,
      });
    }
    if (name && !fields.includes(name)) {
      issues.push({ message: `Field "${c.id}" names "${name}", which this form does not have.` });
    }
    if (repeated.has(c.id)) {
      issues.push({ message: `Field "${c.id}" stands in a repeat; a field is placed once.` });
    }
    if (name) {
      placed.set(name, (placed.get(name) ?? 0) + 1);
    }
  }
  for (const field of fields) {
    const times = placed.get(field) ?? 0;
    if (times !== 1) {
      issues.push({
        message:
          times === 0
            ? `The field "${field}" has no place: each field of the form is placed by one Field.`
            : `The field "${field}" is placed ${times} times; each is placed once.`,
      });
    }
  }
  return issues;
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
export function bound(value: unknown, data: unknown, row?: unknown, locale?: string): unknown {
  if (isCalc(value)) {
    const node = parsedCalc(value.calc);
    const raw = "error" in node ? undefined : evalCalc(node, calcScope(row, data));
    // What cannot be worked out is empty, and says so.
    return raw === undefined ? "–" : worded(raw, value, { row, locale });
  }
  if (!isPath(value)) {
    return value;
  }
  const raw = value.path.startsWith("/")
    ? pointer(data, value.path)
    : row === undefined
      ? undefined
      : pointer(row, `/${value.path.replace(/\./g, "/")}`);
  return worded(raw, value as { as?: unknown; map?: unknown; format?: unknown }, { row, locale });
}

/**
 * A value turned into words as its path or calc says: written as `as` says ("number" with the
 * locale's separators, "percent"), looked up in `map`, set into `format`, whose `{}` is the value
 * and `{column}` a column of the row it is drawn in.
 */
export function worded(
  raw: unknown,
  spec: { as?: unknown; map?: unknown; format?: unknown },
  at: { row?: unknown; locale?: string } = {},
): unknown {
  let v = raw;
  if (typeof v === "number" && (spec.as === "number" || spec.as === "percent")) {
    v = new Intl.NumberFormat(at.locale, spec.as === "percent" ? { style: "percent" } : {}).format(
      v,
    );
  }
  const map = spec.map;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const key = String(v);
    if (Object.hasOwn(map, key)) {
      v = (map as Record<string, unknown>)[key];
    }
  }
  if (typeof spec.format === "string" && v !== undefined && v !== null && v !== "") {
    const row = at.row;
    v = spec.format
      .replace("{}", Array.isArray(v) ? v.join(", ") : String(v))
      .replace(/\{(\w+)\}/g, (whole, column: string) =>
        row && typeof row === "object" && Object.hasOwn(row, column)
          ? String((row as Record<string, unknown>)[column] ?? "")
          : whole,
      );
  }
  return v;
}
