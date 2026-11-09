// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { type CalcNode, parseCalc } from "./calc.js";
import type { Condition, When, WizardDefinition } from "./definition.js";
import { SURFACE_COMPONENTS } from "./surface.js";

/**
 * The text form of a definition: what a model writes instead of JSON, compiled to the definition
 * (docs/plans/fast-creation.md, Part 2). It is never stored; the definition stays JSON.
 *
 * 1. A tag is an object, its attributes are its keys: a string in quotes, everything else in
 *    `{ }` as JSON, a bare name is true.
 * 2. Children are the object's list: steps in `<Wizard>`, fields and components in `<Page>`,
 *    `<Next>` rules in a step, output fields in `<Output>`.
 * 3. Text inside a tag is its text: an agent's instructions, a result's message, an image or
 *    document step's prompt, a motion-graphics step's brief, a component's `text`. In `<Page>`
 *    it is Markdown that becomes `Text` components (the page then gets `components`).
 * 4. `{ … }` that is not JSON is an expression: `when` compiles to conditions where they can say
 *    it, else to `{ "calc": … }`; a component prop to `{ "calc": … }`, a bare name to
 *    `{ "path": "/name" }`.
 * 5. Steps and fields carry their `id`. Components get `c1`, `c2` … by their place in the page,
 *    so a component keeps its id while the text streams in. One may carry an `id` of its own.
 * 6. No blocks: a field's `when` is an attribute.
 *
 * What the parser repairs or drops is in `cuts`, for the model to read.
 */

/** Something the parser repaired or dropped, with where it was in the text. */
export interface TextCut {
  at: number;
  what: string;
  /** The step it concerns, when it concerns one; "" for a step without an id. */
  step?: string;
  /** An element the text left open, closed at its end: with `step`, a step still being written. */
  open?: true;
}

export interface ParsedWizardText {
  /** Not checked against the schema: run it through `parseWizard` and `validateWizard`. */
  definition: WizardDefinition;
  cuts: TextCut[];
}

export const STEP_TAGS: Record<string, string> = {
  page: "Page",
  agent: "Agent",
  decision: "Decision",
  generate: "Generate",
  widget: "Widget",
  surface: "Surface",
  "motion-graphics": "MotionGraphics",
  review: "Review",
  wait: "Wait",
  result: "Result",
};
const TAG_STEPS: Record<string, string> = Object.fromEntries(
  Object.entries(STEP_TAGS).map(([type, tag]) => [tag, type]),
);

/** The key a step's text goes to. */
export const STEP_TEXT: Record<string, string> = {
  agent: "instructions",
  decision: "instructions",
  result: "message",
  generate: "prompt",
  "motion-graphics": "brief",
};

/** The output field kinds, by the tag inside `<Output>`. */
export const OUTPUT_TAGS: Record<string, string> = {
  Text: "text",
  Number: "number",
  List: "list",
  Table: "table",
  YesNo: "yesno",
  Choice: "choice",
  Score: "score",
};
const OUTPUT_KINDS: Record<string, string> = Object.fromEntries(
  Object.entries(OUTPUT_TAGS).map(([tag, kind]) => [kind, tag]),
);

const COMPONENTS: ReadonlySet<string> = new Set(SURFACE_COMPONENTS);

/**
 * What the schema fills in when a key is left out (and a result's empty deliverables, which the
 * schema needs): the parser adds them, the printer leaves them out.
 */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  wizard: { version: 1, description: "", avatar: "round" },
  agent: { instructions: "", tools: [], output: { format: "markdown" } },
  widget: { data: {} },
  surface: { data: {} },
  "motion-graphics": { skills: ["hyperframes"], inputs: {}, format: "16:9" },
  result: { deliverables: [] },
};

type Json = Record<string, unknown>;

// ---- Reading the text into tags ----

interface Attr {
  name: string;
  kind: "string" | "brace" | "bare";
  /** The quoted string with its quotes, or what stands between the braces. */
  text: string;
  at: number;
}

interface Elem {
  type: "elem";
  tag: string;
  attrs: Attr[];
  children: Node[];
  at: number;
}

interface Txt {
  type: "text";
  text: string;
  at: number;
}

type Node = Elem | Txt;

const TAG_NAME = /[A-Za-z][A-Za-z0-9]*/y;
const ATTR_NAME = /[A-Za-z_$][\w$-]*/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)\s*>/y;
const SPACE = /\s*/y;

const tagAt = (src: string, i: number) =>
  src[i] === "<" &&
  (/[A-Za-z]/.test(src[i + 1] ?? "") || (src[i + 1] === "/" && /[A-Za-z]/.test(src[i + 2] ?? "")));

function nextTag(src: string, from: number): number {
  for (let i = src.indexOf("<", from); i !== -1; i = src.indexOf("<", i + 1)) {
    if (tagAt(src, i)) {
      return i;
    }
  }
  return -1;
}

function sticky(re: RegExp, src: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(src);
}

const skipSpace = (src: string, at: number) => {
  sticky(SPACE, src, at);
  return SPACE.lastIndex;
};

/** Where a quoted string that starts at `at` ends (after its quote); -1 when the text ends first. */
function stringEnd(src: string, at: number): number {
  for (let k = at + 1; k < src.length; k++) {
    if (src[k] === "\\") {
      k++;
    } else if (src[k] === '"') {
      return k + 1;
    }
  }
  return -1;
}

/** Where `{ … }` that starts at `at` ends (after its brace); -1 when the text ends first. */
function braceEnd(src: string, at: number): number {
  let depth = 0;
  for (let k = at; k < src.length; k++) {
    const c = src[k];
    if (c === '"') {
      const end = stringEnd(src, k);
      if (end === -1) {
        return -1;
      }
      k = end - 1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return k + 1;
      }
    }
  }
  return -1;
}

type StartTag =
  | { elem: Elem; end: number; closed: boolean }
  | { unfinished: true }
  | { error: string; end: number };

function readStartTag(src: string, at: number, cuts: TextCut[]): StartTag {
  const name = sticky(TAG_NAME, src, at + 1);
  if (!name) {
    return { error: "A tag without a name.", end: at + 1 };
  }
  const elem: Elem = { type: "elem", tag: name[0], attrs: [], children: [], at };
  let j = at + 1 + name[0].length;
  for (;;) {
    j = skipSpace(src, j);
    if (j >= src.length) {
      return { unfinished: true };
    }
    if (src.startsWith("/>", j)) {
      return { elem, end: j + 2, closed: true };
    }
    if (src[j] === ">") {
      return { elem, end: j + 1, closed: false };
    }
    const attr = sticky(ATTR_NAME, src, j);
    if (!attr) {
      cuts.push({ at: j, what: `"${src[j]}" in <${elem.tag}> means nothing; left out.` });
      j++;
      continue;
    }
    const attrAt = j;
    j = skipSpace(src, j + attr[0].length);
    if (src[j] !== "=") {
      elem.attrs.push({ name: attr[0], kind: "bare", text: "", at: attrAt });
      continue;
    }
    j = skipSpace(src, j + 1);
    if (j >= src.length) {
      return { unfinished: true };
    }
    if (src[j] === '"' || src[j] === "{") {
      const end = src[j] === '"' ? stringEnd(src, j) : braceEnd(src, j);
      if (end === -1) {
        return { unfinished: true };
      }
      const brace = src[j] === "{";
      elem.attrs.push({
        name: attr[0],
        kind: brace ? "brace" : "string",
        text: brace ? src.slice(j + 1, end - 1) : src.slice(j, end),
        at: attrAt,
      });
      j = end;
      continue;
    }
    cuts.push({
      at: attrAt,
      what: `${attr[0]} in <${elem.tag}> has no value in quotes or braces; left out.`,
    });
  }
}

const hasContent = (elem: Elem) =>
  elem.children.some((c) => c.type === "elem" || c.text.trim() !== "");

/** The text as tags, repaired: tags closed in the wrong order, and at the end what is still open. */
function readTags(src: string, partial: boolean, cuts: TextCut[]): Node[] {
  const top: Elem = { type: "elem", tag: "", attrs: [], children: [], at: 0 };
  const stack: Elem[] = [top];
  const current = () => stack[stack.length - 1];
  let i = 0;
  while (i < src.length) {
    const lt = nextTag(src, i);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > i) {
      let text = src.slice(i, textEnd);
      if (partial && lt === -1) {
        // "<" or "</" at the very end may be the start of a tag.
        text = text.replace(/<\/?$/, "");
      }
      current().children.push({ type: "text", text, at: i });
    }
    if (lt === -1) {
      break;
    }
    if (src[lt + 1] === "/") {
      const end = sticky(END_TAG, src, lt);
      if (!end) {
        if (src.indexOf(">", lt) === -1) {
          cuts.push({ at: lt, what: "The text ends inside a closing tag; cut there." });
          break;
        }
        cuts.push({ at: lt, what: "A closing tag that cannot be read; left out." });
        i = src.indexOf(">", lt) + 1;
        continue;
      }
      const open = stack.map((e) => e.tag).lastIndexOf(end[1]);
      if (open < 1) {
        cuts.push({ at: lt, what: `</${end[1]}> closes nothing; left out.` });
      } else {
        for (let k = stack.length - 1; k > open; k--) {
          cuts.push({
            at: stack[k].at,
            what: `<${stack[k].tag}> was not closed; closed before </${end[1]}>.`,
          });
        }
        stack.length = open;
      }
      i = lt + end[0].length;
      continue;
    }
    const start = readStartTag(src, lt, cuts);
    if ("unfinished" in start) {
      cuts.push({ at: lt, what: "The text ends inside a tag; cut there." });
      break;
    }
    if ("error" in start) {
      cuts.push({ at: lt, what: start.error });
      i = start.end;
      continue;
    }
    current().children.push(start.elem);
    if (!start.closed) {
      stack.push(start.elem);
    }
    i = start.end;
  }
  for (let k = stack.length - 1; k >= 1; k--) {
    const elem = stack[k];
    const parent = stack[k - 1];
    // A step still open says which, so a caller keeps only the steps whose tag closed.
    const id = elem.attrs.find((a) => a.name === "id");
    const step = !TAG_STEPS[elem.tag]
      ? undefined
      : id?.kind === "string"
        ? decodeString(id.text)
        : "";
    if (partial && k > 1 && !hasContent(elem)) {
      parent.children.splice(parent.children.indexOf(elem), 1);
      cuts.push({ at: elem.at, what: `<${elem.tag}> has nothing in it yet; left out.`, step });
    } else {
      cuts.push({
        at: elem.at,
        what: `<${elem.tag}> was not closed; closed at the end.`,
        step,
        open: true,
      });
    }
  }
  return top.children;
}

// ---- Values ----

function decodeString(quoted: string): string {
  try {
    const value = JSON.parse(quoted);
    if (typeof value === "string") {
      return value;
    }
  } catch {
    // A model's string with a raw line break or a stray backslash: read it by hand.
  }
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
  return quoted
    .slice(1, -1)
    .replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_, c: string) =>
      c.length > 1 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : (escapes[c] ?? c),
    );
}

function json(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

const COMPARED: Record<string, Condition["op"]> = {
  "==": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

function literalOf(node: CalcNode): string | number | boolean | undefined {
  if (node.kind === "value") {
    return node.value;
  }
  if (node.kind === "negative" && node.of.kind === "value" && typeof node.of.value === "number") {
    return -node.of.value;
  }
  return undefined;
}

/** The conditions an expression says, when conditions can say it all. */
function conditionsIn(node: CalcNode): Condition[] | null {
  if (node.kind !== "binary") {
    return null;
  }
  if (node.op === "and") {
    const left = conditionsIn(node.left);
    const right = conditionsIn(node.right);
    return left && right ? [...left, ...right] : null;
  }
  const op = COMPARED[node.op];
  const value = literalOf(node.right);
  if (!op || node.left.kind !== "name" || value === undefined) {
    return null;
  }
  return [{ field: node.left.name, op, value }];
}

function whenOf(source: string, at: number, cuts: TextCut[]): When {
  const text = source.trim();
  const node = parseCalc(text);
  if ("error" in node) {
    cuts.push({ at, what: `when={${text}}: ${node.error}` });
    return { calc: text };
  }
  const conditions = conditionsIn(node);
  if (!conditions) {
    return { calc: text };
  }
  return conditions.length === 1 ? conditions[0] : conditions;
}

const BARE_NAME = /^[a-zA-Z_]\w*$/;
const WORDS: ReadonlySet<string> = new Set(["and", "or", "not", "true", "false"]);

/** An attribute's value; undefined when it is left out. */
function attrValue(attr: Attr, component: boolean, cuts: TextCut[]): unknown {
  if (attr.kind === "bare") {
    return true;
  }
  if (attr.kind === "string") {
    return decodeString(attr.text);
  }
  const parsed = json(attr.text);
  if (parsed) {
    return parsed.value;
  }
  if (attr.name === "when") {
    return whenOf(attr.text, attr.at, cuts);
  }
  const text = attr.text.trim();
  if (component) {
    if (BARE_NAME.test(text) && !WORDS.has(text)) {
      return { path: `/${text}` };
    }
    const node = parseCalc(text);
    if ("error" in node) {
      cuts.push({ at: attr.at, what: `${attr.name}={${text}}: ${node.error}` });
    }
    return { calc: text };
  }
  cuts.push({ at: attr.at, what: `${attr.name}={${text}} is not JSON; left out.` });
  return undefined;
}

function attrsOf(elem: Elem, component: boolean, cuts: TextCut[]): Json {
  const out: Json = {};
  for (const attr of elem.attrs) {
    const value = attrValue(attr, component, cuts);
    if (value === undefined) {
      continue;
    }
    if (Object.hasOwn(out, attr.name)) {
      cuts.push({
        at: attr.at,
        what: `${attr.name} is given twice in <${elem.tag}>; the last counts.`,
      });
    }
    out[attr.name] = value;
  }
  return out;
}

const textOf = (elem: Elem) =>
  elem.children
    .filter((c): c is Txt => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

function withDefaults(kind: string, obj: Json): Json {
  for (const [key, value] of Object.entries(DEFAULTS[kind] ?? {})) {
    if (obj[key] === undefined) {
      obj[key] = structuredClone(value);
    }
  }
  return obj;
}

/** Keys in this order first, the rest as they came. */
function ordered(obj: Json, first: string[]): Json {
  const out: Json = {};
  for (const key of first) {
    if (obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!first.includes(key) && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// ---- Markdown in a page ----

interface Block {
  text: string;
  variant?: "h3" | "h4";
}

/** Markdown as blocks: a heading per line, paragraphs between blank lines. */
function markdownBlocks(text: string): Block[] {
  const out: Block[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) {
      out.push({ text: lines.join("\n") });
      lines = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ text: heading[2], variant: heading[1].length <= 2 ? "h3" : "h4" });
    } else if (line === "") {
      flush();
    } else {
      lines.push(line);
    }
  }
  flush();
  return out;
}

// ---- Compiling tags to the definition ----

function compileField(elem: Elem, cuts: TextCut[], step: string): Json {
  for (const child of elem.children) {
    if (child.type === "elem" || child.text.trim()) {
      cuts.push({
        at: child.at,
        what: "A <Field> holds nothing; what is in it is left out.",
        step,
      });
    }
  }
  return ordered(attrsOf(elem, false, cuts), ["id", "kind", "label"]);
}

function compileRule(elem: Elem, cuts: TextCut[]): Json {
  return ordered(attrsOf(elem, false, cuts), ["when", "ask", "goto"]);
}

function compilePage(elem: Elem, step: Json, cuts: TextCut[]) {
  const id = String(step.id ?? "");
  const fields: Json[] = [];
  const components: Json[] = [];
  const rules: Json[] = [];
  const given = step.components !== undefined;
  let count = 0;

  const place = (nodes: Node[], into: string[], depth: number) => {
    for (const node of nodes) {
      if (node.type === "text") {
        if (!node.text.trim()) {
          continue;
        }
        if (given) {
          cuts.push({ at: node.at, what: "Text next to components={…}; left out.", step: id });
          continue;
        }
        for (const block of markdownBlocks(node.text)) {
          const cid = `c${++count}`;
          components.push({
            id: cid,
            component: "Text",
            text: block.text,
            ...(block.variant ? { variant: block.variant } : {}),
          });
          into.push(cid);
        }
      } else if (node.tag === "Next" && depth === 0) {
        rules.push(compileRule(node, cuts));
      } else if (node.tag === "Field") {
        const field = compileField(node, cuts, id);
        fields.push(field);
        const cid = `c${++count}`;
        components.push({ id: cid, component: "Field", name: field.id });
        into.push(cid);
      } else if (COMPONENTS.has(node.tag)) {
        if (given) {
          cuts.push({
            at: node.at,
            what: `<${node.tag}> next to components={…}; left out.`,
            step: id,
          });
          continue;
        }
        const props = attrsOf(node, true, cuts);
        const own = typeof props.id === "string" ? props.id : undefined;
        delete props.id;
        const cid = own ?? `c${++count}`;
        if (own) {
          count++;
        }
        const component: Json = { id: cid, component: node.tag, ...props };
        const text = textOf(node);
        if (text) {
          component.text = text;
        }
        components.push(component);
        into.push(cid);
        const kids: string[] = [];
        place(
          node.children.filter((c) => c.type === "elem"),
          kids,
          depth + 1,
        );
        if (kids.length) {
          if (component.children !== undefined) {
            cuts.push({
              at: node.at,
              what: `<${node.tag}> has children={…} and tags inside; the tags count.`,
              step: id,
            });
          }
          component.children = kids;
        }
      } else {
        cuts.push({
          at: node.at,
          what: `<${node.tag}> does not belong in a page; left out.`,
          step: id,
        });
      }
    }
  };
  const top: string[] = [];
  place(elem.children, top, 0);

  if (fields.length) {
    step.fields = fields;
  }
  if (!given && components.some((c) => c.component !== "Field")) {
    step.components = [{ id: "root", component: "Column", children: top }, ...components];
  }
  if (rules.length) {
    step.next = rules;
  }
}

function compileOutput(elem: Elem, cuts: TextCut[], step: string): Json {
  const output = attrsOf(elem, false, cuts);
  const fields: Json[] = [];
  for (const child of elem.children) {
    if (child.type === "text") {
      if (child.text.trim()) {
        cuts.push({ at: child.at, what: "Text in <Output>; left out.", step });
      }
      continue;
    }
    const kind = OUTPUT_TAGS[child.tag];
    if (!kind) {
      cuts.push({ at: child.at, what: `<${child.tag}> is not an output field; left out.`, step });
      continue;
    }
    fields.push(ordered({ ...attrsOf(child, false, cuts), kind }, ["id", "kind"]));
  }
  if (fields.length) {
    output.fields = fields;
  }
  return ordered(output, ["format", "fields"]);
}

function compileStep(elem: Elem, cuts: TextCut[]): Json | null {
  const type = TAG_STEPS[elem.tag];
  if (!type) {
    cuts.push({ at: elem.at, what: `<${elem.tag}> is not a step; left out.` });
    return null;
  }
  const step: Json = { ...attrsOf(elem, false, cuts), type };
  const id = typeof step.id === "string" ? step.id : undefined;
  if (type === "page") {
    compilePage(elem, step, cuts);
  } else {
    const rules: Json[] = [];
    for (const child of elem.children) {
      if (child.type === "text") {
        continue;
      }
      if (child.tag === "Next") {
        rules.push(compileRule(child, cuts));
      } else if (child.tag === "Output" && (type === "agent" || type === "decision")) {
        const output = compileOutput(child, cuts, id ?? "");
        // A decision's output is its questions: no format.
        if (type === "decision") {
          delete output.format;
        }
        step.output = output;
      } else {
        cuts.push({
          at: child.at,
          what: `<${child.tag}> does not belong in <${elem.tag}>; left out.`,
          step: id,
        });
      }
    }
    if (rules.length) {
      step.next = rules;
    }
    const text = textOf(elem);
    const key = STEP_TEXT[type];
    if (text && key) {
      step[key] = text;
    } else if (text) {
      cuts.push({ at: elem.at, what: `<${elem.tag}> takes no text; left out.`, step: id });
    }
  }
  return ordered(withDefaults(type, step), ["id", "type", "title"]);
}

function compileWizard(nodes: Node[], cuts: TextCut[]): Json {
  const elems = nodes.filter((n): n is Elem => n.type === "elem");
  for (const node of nodes) {
    if (node.type === "text" && node.text.trim()) {
      cuts.push({ at: node.at, what: "Text outside <Wizard>; left out." });
    }
  }
  const wizard = elems.find((e) => e.tag === "Wizard");
  let attrs: Json = {};
  let stepTags: Node[];
  if (wizard) {
    attrs = attrsOf(wizard, false, cuts);
    stepTags = wizard.children;
    for (const e of elems) {
      if (e !== wizard) {
        cuts.push({ at: e.at, what: `<${e.tag}> outside <Wizard>; left out.` });
      }
    }
  } else {
    if (elems.length) {
      cuts.push({ at: 0, what: "No <Wizard> around the steps." });
    }
    stepTags = elems;
  }
  const steps: Json[] = [];
  for (const node of stepTags) {
    if (node.type === "text") {
      if (node.text.trim()) {
        cuts.push({ at: node.at, what: "Text between steps; left out." });
      }
      continue;
    }
    const step = compileStep(node, cuts);
    if (step) {
      steps.push(step);
    }
  }
  return ordered(withDefaults("wizard", { ...attrs, steps }), ["version", "title", "description"]);
}

/**
 * The definition a text says. With `partial`, for a text still streaming in: it stops at the
 * last complete tag, closes what is open and has something in it, and leaves out the rest, so a
 * step is there as soon as its tag closes (and before, as far as it is written).
 */
export function parseWizardText(text: string, opts: { partial?: true } = {}): ParsedWizardText {
  const cuts: TextCut[] = [];
  const nodes = readTags(text, Boolean(opts.partial), cuts);
  const definition = compileWizard(nodes, cuts) as unknown as WizardDefinition;
  cuts.sort((a, b) => a.at - b.at);
  return { definition, cuts };
}

// ---- Printing ----

/** Equal as JSON: keys in any order, undefined the same as missing. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

const CALC_NAME = /^[a-zA-Z_]\w*(\.[a-zA-Z0-9_]+)*$/;
const OP_TEXT: Partial<Record<Condition["op"], string>> = {
  eq: "==",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function literalText(value: unknown): string | null {
  if (typeof value === "string") {
    return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function conditionText(c: unknown): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return null;
  }
  const { field, op, value, ...rest } = c as Json;
  const sign = OP_TEXT[op as Condition["op"]];
  const literal = literalText(value);
  if (
    Object.keys(rest).length ||
    !sign ||
    literal === null ||
    typeof field !== "string" ||
    !CALC_NAME.test(field) ||
    WORDS.has(field)
  ) {
    return null;
  }
  return `${field} ${sign} ${literal}`;
}

/** An expression for a value, when there is one: `when`, or a component's calc or path. */
function expressionText(value: unknown, key: string, component: boolean): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof (value as Json).calc === "string") {
    return (value as Json).calc as string;
  }
  if (key === "when") {
    const parts = Array.isArray(value) ? value.map(conditionText) : [conditionText(value)];
    return parts.length && parts.every(Boolean) ? parts.join(" and ") : null;
  }
  const path = (value as Json).path;
  if (component && keys.length === 1 && typeof path === "string" && /^\/[a-zA-Z_]\w*$/.test(path)) {
    return path.slice(1);
  }
  return null;
}

/** One attribute as text; null for a value the text form leaves out. */
function attrText(key: string, value: unknown, component: boolean): string | null {
  if (value === undefined) {
    return null;
  }
  if (value === true) {
    return key;
  }
  if (typeof value === "string") {
    return `${key}=${JSON.stringify(value)}`;
  }
  const expression = expressionText(value, key, component);
  if (expression !== null) {
    const attr: Attr = { name: key, kind: "brace", text: expression, at: 0 };
    const cuts: TextCut[] = [];
    if (!json(expression) && sameJson(attrValue(attr, component, cuts), value) && !cuts.length) {
      return `${key}={${expression}}`;
    }
  }
  return `${key}={${JSON.stringify(value)}}`;
}

function openTag(tag: string, obj: Json, first: string[], component = false): string {
  const parts = Object.entries(ordered(obj, first))
    .map(([key, value]) => attrText(key, value, component))
    .filter((p): p is string => p !== null);
  return parts.length ? `<${tag} ${parts.join(" ")}` : `<${tag}`;
}

/** The keys a kind fills in by itself, left out when they hold just that. */
function withoutDefaults(kind: string, obj: Json): Json {
  const out: Json = { ...obj };
  for (const [key, value] of Object.entries(DEFAULTS[kind] ?? {})) {
    if (sameJson(out[key], value)) {
      delete out[key];
    }
  }
  return out;
}

/** Text a tag can hold as it is: no tag inside it, nothing the parser would trim. */
const plainText = (text: unknown): text is string =>
  typeof text === "string" && text !== "" && text.trim() === text && !/<\/?[A-Za-z]/.test(text);

const indent = (lines: string[], by = "  ") => lines.map((l) => (l ? by + l : l));

function fieldTag(field: Json): string {
  return `${openTag("Field", field, ["id", "kind", "label"])} />`;
}

function ruleTag(rule: Json): string {
  return `${openTag("Next", rule, ["when", "ask", "goto"])} />`;
}

/** A Text component as Markdown, when it reads back the same. */
function markdownOf(c: Json): string | null {
  const { id: _id, component: _component, text, variant, ...rest } = c;
  if (Object.keys(rest).length || typeof text !== "string" || !plainText(text)) {
    return null;
  }
  const md =
    variant === "h3" ? `## ${text}` : variant === "h4" ? `### ${text}` : variant ? null : text;
  if (md === null) {
    return null;
  }
  const blocks = markdownBlocks(md);
  return blocks.length === 1 && sameJson(blocks[0], { text, ...(variant ? { variant } : {}) })
    ? md
    : null;
}

/** A page's components as tags under the page, or null when they do not form one tree. */
function pageBody(step: Json): string[] | null {
  const fields = (step.fields as Json[] | undefined) ?? [];
  const components = step.components as Json[] | undefined;
  if (!components) {
    return fields.map(fieldTag);
  }
  const byId = new Map(components.map((c) => [c.id as string, c]));
  const root = byId.get("root");
  if (
    !root ||
    byId.size !== components.length ||
    !sameJson(Object.keys(root).sort(), ["children", "component", "id"]) ||
    root.component !== "Column" ||
    !Array.isArray(root.children)
  ) {
    return null;
  }
  const fieldById = new Map(fields.map((f) => [f.id as string, f]));
  const seen = new Set<string>(["root"]);
  const placed: string[] = [];
  let count = 0;
  let previousText = false;

  const walk = (ids: unknown[]): string[] | null => {
    const lines: string[] = [];
    for (const cid of ids) {
      const c = typeof cid === "string" ? byId.get(cid) : undefined;
      if (!c || seen.has(cid as string)) {
        return null;
      }
      seen.add(cid as string);
      const auto = `c${++count}`;
      if (c.component === "Field") {
        const field = fieldById.get(c.name as string);
        if (!field || c.id !== auto || Object.keys(c).length !== 3) {
          return null;
        }
        placed.push(c.name as string);
        lines.push(fieldTag(field));
        previousText = false;
        continue;
      }
      const md = c.component === "Text" && c.id === auto ? markdownOf(c) : null;
      if (md !== null) {
        if (previousText) {
          lines.push("");
        }
        lines.push(...md.split("\n"));
        previousText = true;
        continue;
      }
      previousText = false;
      const { id, component, children, ...props } = c;
      if (children !== undefined && !Array.isArray(children)) {
        return null;
      }
      const head = openTag(
        component as string,
        { ...(id === auto ? {} : { id }), ...props },
        ["id"],
        true,
      );
      if (!children?.length) {
        lines.push(`${head} />`);
        continue;
      }
      const inner = walk(children);
      if (!inner) {
        return null;
      }
      lines.push(`${head}>`, ...indent(inner), `</${component}>`);
      previousText = false;
    }
    return lines;
  };
  const body = walk(root.children);
  if (
    !body ||
    seen.size !== components.length ||
    !sameJson(
      placed,
      fields.map((f) => f.id),
    )
  ) {
    return null;
  }
  return body;
}

function niceStep(step: Json): string {
  const type = step.type as string;
  const tag = STEP_TAGS[type];
  const rest: Json = withoutDefaults(type, step);
  delete rest.type;
  const children: string[] = [];
  let text: string | null = null;

  if (type === "page") {
    const body = pageBody(rest);
    if (body) {
      delete rest.components;
      delete rest.fields;
      children.push(...body);
    } else {
      const fields = (rest.fields as Json[] | undefined) ?? [];
      delete rest.fields;
      children.push(...fields.map(fieldTag));
    }
  }
  const textKey = STEP_TEXT[type];
  if (textKey && plainText(rest[textKey])) {
    text = rest[textKey] as string;
    delete rest[textKey];
  }
  if ((type === "agent" || type === "decision") && rest.output && typeof rest.output === "object") {
    const { fields, ...output } = rest.output as Json;
    const kinds = Array.isArray(fields) ? fields : [];
    if (kinds.every((f) => OUTPUT_KINDS[(f as Json).kind as string])) {
      delete rest.output;
      const head = openTag("Output", output, ["format"]);
      if (kinds.length) {
        children.push(
          `${head}>`,
          ...indent(
            kinds.map((f) => {
              const { kind, ...attrs } = f as Json;
              return `${openTag(OUTPUT_KINDS[kind as string], attrs, ["id"])} />`;
            }),
          ),
          "</Output>",
        );
      } else {
        children.push(`${head} />`);
      }
    }
  }
  if (Array.isArray(rest.next)) {
    children.push(...(rest.next as Json[]).map(ruleTag));
    delete rest.next;
  }
  const head = openTag(tag, rest, ["id", "title"]);
  if (text === null && !children.length) {
    return `${head} />`;
  }
  return [`${head}>`, ...(text !== null ? [text] : []), ...indent(children), `</${tag}>`].join(
    "\n",
  );
}

/** Every key as an attribute: what reads back for any step. */
function plainStep(step: Json): string {
  const type = step.type as string;
  const rest = withoutDefaults(type, step);
  delete rest.type;
  return `${openTag(STEP_TAGS[type], rest, ["id", "title"])} />`;
}

function readsBack(text: string, step: Json): boolean {
  const cuts: TextCut[] = [];
  const nodes = readTags(text, false, cuts).filter((n): n is Elem => n.type === "elem");
  const compiled = nodes.length === 1 ? compileStep(nodes[0], cuts) : null;
  return !cuts.length && sameJson(compiled, withDefaults(step.type as string, { ...step }));
}

function printStep(step: Json): string {
  if (!STEP_TAGS[step.type as string]) {
    throw new Error(`A step of type "${String(step.type)}" has no tag.`);
  }
  const nice = niceStep(step);
  return readsBack(nice, step) ? nice : plainStep(step);
}

/** A definition as text: how a model reads an existing wizard in the form it writes one. */
export function printWizardText(def: WizardDefinition): string {
  const { steps, ...top } = def as unknown as Json & { steps: Json[] };
  const head = openTag("Wizard", withoutDefaults("wizard", top), ["title", "description"]);
  return [`${head}>`, ...steps.map(printStep), "</Wizard>", ""].join("\n");
}
