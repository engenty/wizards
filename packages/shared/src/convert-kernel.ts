// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { type CalcNode, parseCalc } from "./calc.js";
import {
  type Condition,
  dataRef,
  type Field,
  isOtherwise,
  type KernelFile,
  type NextRule,
  type Step,
  textClassOf,
  type When,
  type WizardDefinition,
  whenCalc,
  whenNames,
} from "./definition.js";
import { readNumber } from "./numbers.js";
import { stepClasses } from "./requires.js";

/**
 * A wizard of version 1 as a wizard of version 2 (docs/plans/kernel.md, item 22): the file, one
 * step file per step, and notes on what a person should look at. Nothing is run and nothing is
 * read but the definition.
 *
 * The steps
 * - Every step becomes `steps/<id>.ts` with one ask. The ask holds the step's own keys.
 * - An id is renamed where a file or the map cannot have it: `Offer` is `offer`, `end` is
 *   `end_step`. Every reference follows.
 * - The first step, when it is a form the run's own person answers, becomes the file's `input`.
 *   It has no step file. Later steps read `run.input.<field>`.
 * - A first form that has rules, or that a rule leads back to, stays a step as well. It takes
 *   `run.input` the first time and asks from the second time on.
 * - A later form stays a step. Its answers are read as `run.steps.<id>.<field>`.
 * - A result becomes the file's `output` and has no step file. Ways into it are `"end"`. Each
 *   entry of `data` is an output, and each download is an output named after its step.
 * - A result whose `data` reads an answer or the date stays a small step that collects them.
 * - A code step becomes a step that fails and says where its code is. A person moves it.
 *
 * The ways
 * - The order of the list is the default way. An "otherwise" rule replaces it.
 * - A rule with `when` becomes an `if` that returns its way. Every target is in `edges`.
 * - A rule back to an earlier step is taken ten times, or `max` times. The step counts with
 *   `run.count`. `limits` are raised for the steps inside such a loop.
 * - A rule with `ask` is not converted. Its target stays in `edges` and the default way is taken.
 * - `onFail` becomes a `try` around the ask that returns that way.
 * - A step no way leads to is left out.
 *
 * What a step reads
 * - `{{field}}`, `{{steps.id}}`, `{{steps.id.key}}` and `{{today}}` become template literals.
 * - `{{brand.…}}`, `{{facts.…}}` and `{{lists.…}}` stay in the text. The host fills them.
 * - A name nothing answers stays in the text, with a note.
 * - What a person typed is marked as data in an AI step's instructions, as version 1 does.
 * - AI steps get the person's answers below their instructions, by field id.
 * - Conditions and `calc` become code with small helpers at the top of the step file.
 * - Line items read as a table with totals. Money is written as `12.50 EUR`.
 *
 * People
 * - `who: "team"` becomes `role: "operator"`. The person and the owner are the user, the default.
 * - A review with `regenerate` goes back to a step it shows when the answer names it:
 *   `{ regenerate: "<step>", note }`. That step adds the note to its task.
 * - A review with `edit` keeps the edits in its value: `{ edits: { <step>: … } }`. Steps later in
 *   the list read the edited value. The file's `output` reads the step's own value.
 *
 * Several at once
 * - `foreach` becomes asks side by side with `Promise.all`. `concurrency` is not kept.
 * - An agent step gives `{ rows }`, a generate step `{ entries, assets }`.
 *
 * What it may reach
 * - The model classes the steps call become `requires.models`.
 * - An agent's tools and a tool step's plugin tool become `requires.tools`.
 * - A connection is named by its kind or its connector. Its actions keep their policy.
 * - An action without a policy asks first. A tool step calls `"<connection>.<action>"`.
 */
export function toKernel(definition: WizardDefinition): {
  file: KernelFile;
  files: Record<string, string>;
  notes: string[];
} {
  const steps = definition.steps;
  const notes: string[] = [];
  const say = (text: string, step?: string) => {
    const line = step ? `${step}: ${text}` : text;
    if (!notes.includes(line)) notes.push(line);
  };

  // --- ids -----------------------------------------------------------------------------------

  const newIds: string[] = [];
  for (const step of steps) {
    let id = step.id.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[A-Z]+/, (m) => m.toLowerCase());
    if (!/^[a-z]/.test(id)) id = `s${id}`;
    if (id === "input" || id === "end") id = `${id}_step`;
    const base = id;
    for (let n = 2; newIds.includes(id); n++) id = `${base}_${n}`;
    if (id !== step.id) say(`The step "${step.id}" is now "${id}".`);
    newIds.push(id);
  }
  const indexOf = (id: string | undefined) => steps.findIndex((step) => step.id === id);

  // --- what stays a step ---------------------------------------------------------------------

  const targeted = new Set<number>();
  for (const step of steps) {
    for (const rule of step.next ?? []) targeted.add(indexOf(rule.goto));
    if (step.onFail) targeted.add(indexOf(step.onFail));
  }
  const first = steps[0];
  /** The first step, where it is a form the run's own person answers: the file's input. */
  const opening = first.type === "form" && first.who !== "team" ? first : undefined;
  const hoisted = opening !== undefined;
  let inputOnly = hoisted && !first.next?.length && !first.onFail && !targeted.has(0);
  /** Results that stay a step: their `data` reads what no step's value holds. */
  const forced = new Set<number>();

  const gone = (index: number) =>
    (index === 0 && inputOnly) || (steps[index]?.type === "result" && !forced.has(index));
  const wayAt = (index: number): string =>
    index >= steps.length || gone(index) ? "end" : newIds[index];
  /** Whether a result's `data` entry is read straight from a step's value. */
  const direct = (ref: string): string | undefined => {
    const [head, id, ...rest] = dataRef(ref).split(".");
    const index = indexOf(id);
    if (head !== "steps" || index < 0 || gone(index) || steps[index].type === "result")
      return undefined;
    return [newIds[index], ...rest].join(".");
  };
  const settle = () => {
    forced.clear();
    steps.forEach((step, index) => {
      if (step.type === "result" && Object.values(step.data ?? {}).some((ref) => !direct(ref)))
        forced.add(index);
    });
  };
  settle();
  let start = inputOnly ? wayAt(1) : wayAt(0);
  if (start === "end" && inputOnly) {
    inputOnly = false;
    settle();
    start = wayAt(0);
  }
  if (start === "end") {
    forced.add(0);
    start = wayAt(0);
  }

  // --- answers, edits, loops -----------------------------------------------------------------

  const owners = new Map<string, { index: number; field: Field }[]>();
  steps.forEach((step, index) => {
    if (step.type !== "form") return;
    for (const field of step.fields)
      owners.set(field.id, [...(owners.get(field.id) ?? []), { index, field }]);
  });
  const forms = steps.flatMap((step, index) => (step.type === "form" ? [index] : []));

  /** What a review may send back: the steps it shows that work by themselves. */
  const redone = (index: number): number[] => {
    const step = steps[index];
    if (step.type !== "review" || !step.regenerate) return [];
    return step.show
      .map(indexOf)
      .filter(
        (shown) =>
          shown >= 0 &&
          shown < index &&
          !gone(shown) &&
          !["form", "review", "result", "wait"].includes(steps[shown].type),
      );
  };
  const capOf = (index: number, rule: NextRule): number | undefined => {
    const to = rule.goto === "end" ? steps.length : indexOf(rule.goto);
    return rule.max ?? (to >= 0 && to <= index ? 10 : undefined);
  };
  const loops = steps.map(() => 0);
  /** Steps that run again and build on what they made: a review's or a rule's way back. */
  const revised = new Set<number>();
  steps.forEach((step, index) => {
    for (const rule of step.next ?? []) {
      const to = indexOf(rule.goto);
      if (to < 0 || to > index || rule.ask) continue;
      for (let at = to; at <= index; at++) loops[at] += capOf(index, rule) ?? 10;
      revised.add(to);
    }
    for (const to of redone(index)) {
      for (let at = to; at <= index; at++) loops[at] += 20;
      revised.add(to);
    }
  });

  // --- printing ------------------------------------------------------------------------------

  /** Code that stands where a value would: printed as it is. */
  class Code {
    constructor(readonly at: (pad: string) => string) {}
  }
  const code = (text: string) => new Code(() => text);
  const q = (value: unknown) => JSON.stringify(value);
  const NAME = /^[a-zA-Z_$][\w$]*$/;
  const inTicks = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const fits = (text: string, pad: string) => !text.includes("\n") && pad.length + text.length < 92;

  function print(value: unknown, pad = ""): string {
    if (value instanceof Code) return value.at(pad);
    if (typeof value === "string") return value.includes("\n") ? `\`${inTicks(value)}\`` : q(value);
    if (value === null || typeof value !== "object") return String(q(value));
    const inner = `${pad}  `;
    if (Array.isArray(value)) {
      const parts = value.map((one) => print(one, inner));
      const flat = `[${parts.join(", ")}]`;
      return fits(flat, pad) ? flat : `[\n${parts.map((p) => `${inner}${p},\n`).join("")}${pad}]`;
    }
    const parts = Object.entries(value)
      .filter(([, one]) => one !== undefined)
      .map(([key, one]) => `${NAME.test(key) ? key : q(key)}: ${print(one, inner)}`);
    const flat = parts.length ? `{ ${parts.join(", ")} }` : "{}";
    return fits(flat, pad) ? flat : `{\n${parts.map((p) => `${inner}${p},\n`).join("")}${pad}}`;
  }

  const path = (base: string, keys: string[]) =>
    keys.reduce(
      (at, key) =>
        NAME.test(key)
          ? `${at}${at === "run.input" || at === "run.steps" ? "." : "?."}${key}`
          : `${at}${at === "run.input" || at === "run.steps" ? "" : "?."}[${q(key)}]`,
      base,
    );

  // --- one step file -------------------------------------------------------------------------

  type Scope = {
    /** The step being written, by its place in the list. */
    index: number;
    /** After the step's ask: the step's own value is the local `value`. */
    after?: boolean;
    /** Inside `foreach`: `item`, `index` and `count` are there. */
    entry?: boolean;
  };
  let helpers = new Set<string>();
  let consts = new Map<string, string>();
  const use = (name: string) => {
    for (const need of HELPERS[name].needs ?? []) use(need);
    helpers.add(name);
  };
  const here = (scope: Scope) => newIds[scope.index];
  /** Names the host fills in a text it is handed. */
  const kept = new Set<string>();

  /** A step's value as code; nothing for a step that left no file. */
  function stepValue(index: number, scope: Scope): string | undefined {
    if (index === 0 && inputOnly) return "run.input";
    if (gone(index)) return undefined;
    if (index === scope.index && scope.after) return "value";
    const review = steps.findLastIndex(
      (step, at) =>
        at < scope.index &&
        at > index &&
        step.type === "review" &&
        step.edit === true &&
        step.show.includes(steps[index].id),
    );
    if (review >= 0) {
      use("edited");
      return `edited(run, ${q(newIds[review])}, ${q(newIds[index])})`;
    }
    return path("run.steps", [newIds[index]]);
  }

  /** A field's answer as code: the form that asked last comes first. */
  function fieldValue(name: string, scope: Scope): string | undefined {
    const found = (owners.get(name) ?? [])
      .toReversed()
      .map((owner) => stepValue(owner.index, scope))
      .filter((base) => base !== undefined)
      .map((base) => path(base, [name]));
    return found.length > 1 ? `(${found.join(" ?? ")})` : found[0];
  }

  /** A name as the value it stands for; nothing where no step or answer has it. */
  function raw(ref: string, scope: Scope): string | undefined {
    const [head, ...rest] = ref.split(".");
    if (head === "today" && !rest.length) return "run.today";
    if (head === "item" || head === "index" || head === "count") {
      if (!scope.entry) return undefined;
      return head === "item" ? path("item", rest) : head === "index" ? "(index + 1)" : "count";
    }
    if (head === "steps") {
      const index = indexOf(rest[0]);
      const base = index < 0 ? undefined : stepValue(index, scope);
      return base && path(base, rest.slice(1));
    }
    const own = fieldValue(head, scope);
    return own && path(own, rest);
  }

  /** A name read as data. One nothing has is `undefined`, with a note. */
  function value(ref: string, scope: Scope, where: string): string {
    const found = raw(dataRef(ref), scope);
    if (found) return found;
    say(
      `${where} reads "${dataRef(ref)}", which a step of version 2 cannot read. It is undefined.`,
      here(scope),
    );
    return "undefined";
  }

  const HOST = new Set(["brand", "facts", "lists"]);

  /** A name as the text a template shows for it; nothing where the text stays as it is. */
  function shown(ref: string, scope: Scope, wrap: boolean): string | undefined {
    const [head, ...rest] = ref.split(".");
    const unknown = (why: string) => {
      say(`The text keeps "{{${ref}}}": ${why}`, here(scope));
      return undefined;
    };
    if (head === "today" && !rest.length) return "run.today";
    if (HOST.has(head)) {
      kept.add(head);
      return undefined;
    }
    if (head === "item" || head === "index" || head === "count") {
      const found = raw(ref, scope);
      if (!found) return unknown("it is only there in a step with foreach.");
      use("text");
      return head === "item" ? `text(${found})` : found;
    }
    if (head === "steps") {
      const found = raw(ref, scope);
      if (!found) return unknown("no step with that id leaves a value.");
      use("text");
      const from = steps[indexOf(rest[0])];
      if (wrap && from?.type === "wait" && (rest.length === 1 || rest[1] === "data")) {
        use("asData");
        return `asData(${q(rest[2] ?? rest[1] ?? rest[0])}, ${found})`;
      }
      return `text(${found})`;
    }
    const field = owners.get(head)?.at(-1)?.field;
    const answer = fieldValue(head, scope);
    if (!field || !answer) return unknown("no step or answer has that name.");
    use("text");
    const marked = (expr: string) => {
      if (!wrap) return expr.startsWith("text(") ? expr : `text(${expr})`;
      use("asData");
      return `asData(${q(head)}, ${expr.replace(/^text\((.*)\)$/s, "$1")})`;
    };
    switch (field.kind) {
      case "items": {
        use("itemsOf");
        const name = `${head}Field`;
        consts.set(
          name,
          print({
            columns: field.columns ?? [],
            currency: field.currency ?? "EUR",
            vat: field.vat?.rate ?? 0,
          }),
        );
        const vat = field.vat?.field ? fieldValue(field.vat.field, scope) : undefined;
        const totals = `itemsOf(${answer}, ${name}${vat ? `, ${vat}` : ""})`;
        return marked(rest.length ? path(totals, rest).replace("?.", ".") : `${totals}.table`);
      }
      case "image":
      case "file":
        if (rest[0] === "speech")
          return unknown("what is said in a recording is not handed to a step.");
        use("uploads");
        return `uploads(${answer})`;
      case "location":
        use("place");
        if (rest[0] === "map") return marked(`place(${answer}, true)`);
        return marked(rest.length ? path(answer, rest) : `place(${answer})`);
      case "audio":
        use("said");
        return marked(rest[0] === "seconds" ? path(answer, rest) : `said(${answer})`);
      case "signature":
        return `(${answer} ? \`asset://\${${answer}}\` : "")`;
      case "list":
        kept.add("lists");
        return undefined;
      case "toggle":
        return marked(`(${answer} ? "yes" : "no")`);
      default:
        return marked(path(answer, rest));
    }
  }

  const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;

  /**
   * A text with `{{names}}` as a template literal. `tail` is more of the literal, already
   * written as code. A text without names stays a plain string.
   */
  function template(source: string, scope: Scope, wrap = false, tail = ""): string | Code {
    let out = "";
    let at = 0;
    let filled = tail !== "";
    for (const match of source.matchAll(TEMPLATE)) {
      const field = owners.get(match[1].split(".")[0])?.at(-1)?.field;
      const expr = shown(match[1].trim(), scope, wrap);
      out += inTicks(source.slice(at, match.index));
      if (expr === undefined && field?.kind === "list" && field.list)
        out += `{{lists.${field.list}}}`;
      else if (expr === undefined) out += inTicks(match[0]);
      else out += `\${${expr}}`;
      filled ||= expr !== undefined;
      at = match.index + match[0].length;
    }
    if (!filled) return source;
    out += inTicks(source.slice(at)) + tail;
    // A text that is one name and nothing else is that value's text, without the literal.
    const only = out.match(/^\$\{(text\([^`]*\))\}$/);
    return code(only && !/[}]|\$\{/.test(only[1]) ? only[1] : `\`${out}\``);
  }

  /** Every text in a value as a template; other values stay as they are. */
  function templated(input: unknown, scope: Scope): unknown {
    if (typeof input === "string") return template(input, scope);
    if (Array.isArray(input)) return input.map((one) => templated(one, scope));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, one]) => [key, templated(one, scope)]),
      );
    return input;
  }
  const hasCode = (input: unknown): boolean =>
    input instanceof Code ||
    (Array.isArray(input)
      ? input.some(hasCode)
      : Boolean(input && typeof input === "object" && Object.values(input).some(hasCode)));

  /** A path for the raw value, or a template for text: what `data`, `inputs` and `params` take. */
  const pathOrText = (ref: string, scope: Scope, where: string): unknown =>
    ref.includes("{{") && dataRef(ref).includes("{{")
      ? template(ref, scope)
      : code(value(ref, scope, where));
  const dataOf = (data: Record<string, string> | undefined, scope: Scope, where: string) =>
    data && Object.keys(data).length
      ? Object.fromEntries(
          Object.entries(data).map(([key, ref]) => [key, pathOrText(ref, scope, where)]),
        )
      : undefined;

  // --- conditions ----------------------------------------------------------------------------

  function condition(c: Condition, scope: Scope): string {
    const [head, list] = c.field.split(".");
    if (head === "lists") {
      say(`A rule reads "${c.field}". A step cannot count a stored list.`, here(scope));
    }
    const v = head === "lists" && list ? "undefined" : value(c.field, scope, "A rule");
    const number = readNumber(c.value);
    const compare = (op: string) => {
      use("num");
      return number === null ? "false" : `num(${v}) ${op} ${number}`;
    };
    const among = Array.isArray(c.value) ? q(c.value.map(String)) : undefined;
    switch (c.op) {
      case "eq":
        return `String(${v}) === ${q(String(c.value))}`;
      case "ne":
        return `String(${v}) !== ${q(String(c.value))}`;
      case "in":
        return among ? `${among}.includes(String(${v}))` : "false";
      case "notIn":
        return among ? `!${among}.includes(String(${v}))` : "false";
      case "gt":
        return compare(">");
      case "gte":
        return compare(">=");
      case "lt":
        return compare("<");
      case "lte":
        return compare("<=");
      case "contains":
        use("contains");
        return `contains(${v}, ${q(c.value)})`;
      case "exists":
        use("empty");
        return `!empty(${v})`;
      case "notExists":
        use("empty");
        return `empty(${v})`;
      case "truthy":
        use("truthy");
        return `truthy(${v})`;
      case "falsy":
        use("truthy");
        return `!truthy(${v})`;
    }
  }

  function calc(node: CalcNode, scope: Scope): string {
    switch (node.kind) {
      case "value":
        return q(node.value);
      case "name":
        return value(node.name, scope, "A calculation");
      case "not":
        use("truthy");
        return `!truthy(${calc(node.of, scope)})`;
      case "negative":
        use("op");
        return `op("neg", ${calc(node.of, scope)})`;
      case "binary": {
        const [left, right] = [calc(node.left, scope), calc(node.right, scope)];
        if (node.op === "and" || node.op === "or") {
          use("truthy");
          return `(truthy(${left}) ${node.op === "and" ? "&&" : "||"} truthy(${right}))`;
        }
        use("op");
        return `op(${q(node.op)}, ${left}, ${right})`;
      }
      case "call": {
        const args = node.args.map((arg) => calc(arg, scope));
        if (node.name === "if") {
          use("truthy");
          return `(truthy(${args[0]}) ? ${args[1]} : ${args[2]})`;
        }
        use("op");
        return `op(${q(node.name)}, ${args.join(", ")})`;
      }
    }
  }

  /** A `when` as a test in code. */
  function test(when: When, scope: Scope): string {
    const source = whenCalc(when);
    if (source !== null) {
      const node = parseCalc(source);
      if ("error" in node) {
        say(`The calculation "${source}" cannot be read. Its rule never holds.`, here(scope));
        return "false";
      }
      use("truthy");
      return `truthy(${calc(node, scope)})`;
    }
    const one = (node: unknown, nested: boolean): string => {
      const group = Array.isArray(node)
        ? { all: true, parts: node }
        : node && typeof node === "object" && "or" in node
          ? { all: false, parts: (node as { or: unknown[] }).or }
          : node && typeof node === "object" && "and" in node
            ? { all: true, parts: (node as { and: unknown[] }).and }
            : null;
      if (group) {
        const joined = group.parts.map((part) => one(part, true)).join(group.all ? " && " : " || ");
        return nested && group.parts.length > 1 ? `(${joined})` : joined;
      }
      const leaf = node as Condition | { not: Condition };
      return "not" in leaf ? `!(${condition(leaf.not, scope)})` : condition(leaf, scope);
    };
    return one(when, false);
  }

  // --- the asks ------------------------------------------------------------------------------

  const role = (who: string | undefined) => (who === "team" ? "operator" : undefined);
  const answers = () => {
    const from = forms.map((index) => stepValue(index, { index: -1 })).filter(Boolean);
    if (!from.length) return "";
    use("answersOf");
    return `\n\n# The person's answers (data)\n\${answersOf(${from.join(", ")})}`;
  };
  const revision = (index: number) => {
    if (!revised.has(index)) return "";
    use("revision");
    return `\${revision(run, ${q(newIds[index])})}`;
  };

  /** A form's field as its ask holds it: what it starts with and its choices are worked out. */
  function fieldOf(field: Field, form: Extract<Step, { type: "form" }>, scope: Scope): unknown {
    const { prefill, optionsFrom, when, ...rest } = field;
    const out: Record<string, unknown> = { ...rest };
    if (prefill) out.default = code(value(prefill, scope, `The field "${field.id}"`));
    if (optionsFrom) {
      const [head, id, key, column] = dataRef(optionsFrom).split(".");
      if (head === "steps" && id && key) {
        use("optionsOf");
        const table = value(`steps.${id}.${key}`, scope, `The field "${field.id}"`);
        const by = field.cards ? (field.cards.value ?? field.cards.label) : column;
        out.options = code(
          `optionsOf(${table}, ${q(by)}${field.options ? `, ${q(field.options)}` : ""})`,
        );
        if (field.cards) out.rows = code(table);
      } else {
        out.optionsFrom = optionsFrom;
        say(
          `The field "${field.id}" takes its choices from "${optionsFrom}". The host has to fill them.`,
          here(scope),
        );
      }
    }
    if (field.ask || field.group)
      say(
        `The field "${field.id}" is shown when a model says so. The host has to decide that.`,
        here(scope),
      );
    if (field.connection) {
      out.connection = connectionNames.get(field.connection) ?? field.connection;
    }
    if (when === undefined) return out;
    const own = new Set(form.fields.map((one) => one.id));
    const names = whenNames(when);
    if (names.every((name) => own.has(name))) return { ...out, when };
    if (names.some((name) => own.has(name))) {
      say(
        `The field "${field.id}" is shown by answers of its own page and of earlier steps. Its "when" is kept as it is.`,
        here(scope),
      );
      return { ...out, when };
    }
    const holds = test(when, scope);
    return new Code((pad) => `...(${holds} ? [${print(out, pad)}] : [])`);
  }

  function formSpec(step: Extract<Step, { type: "form" }>, scope: Scope) {
    return {
      type: "form",
      role: role(step.who),
      title: step.title,
      description: step.description,
      fields: step.fields.map((field) => fieldOf(field, step, scope)),
      groups: step.groups,
      cta: step.cta,
      components: step.components,
      data: dataOf(step.data, scope, "The form"),
      timeout: step.timeout,
      remind: step.remind,
    };
  }

  /** The statements of a step up to its value. `decl` begins the line that sets `value`. */
  function build(index: number, pad: string, decl: string): string[] {
    const step = steps[index];
    const id = newIds[index];
    const scope: Scope = { index };
    const ask = (spec: unknown, at = pad) => `await ask(${print(spec, at)})`;
    const line = (text: string) => `${pad}${text}`;
    switch (step.type) {
      case "form": {
        const asked = ask(formSpec(step, scope));
        return [
          index === 0 && hoisted
            ? line(`${decl}run.count(${q(id)}) === 1 ? run.input : ${asked};`)
            : line(`${decl}${asked};`),
        ];
      }
      case "review": {
        const show = step.show.flatMap((old) => {
          const at = indexOf(old);
          if (at === 0 && inputOnly) return ["input"];
          if (at >= 0 && !gone(at)) return [newIds[at]];
          say(`The review shows "${old}", which is not a step of version 2.`, id);
          return [];
        });
        return [
          line(
            `${decl}${ask({
              type: "review",
              role: role(step.who),
              title: step.title,
              description: step.description,
              show,
              edit: step.edit,
              regenerate: step.regenerate,
              approve: step.approve,
              timeout: step.timeout,
              remind: step.remind,
            })};`,
          ),
        ];
      }
      case "agent": {
        const each = step.foreach !== undefined;
        const inner: Scope = { index, entry: each };
        const tools: string[] = [...step.tools];
        for (const old of step.connections ?? []) {
          const name = connectionNames.get(old);
          const actions = Object.keys((name && connections[name]) || {});
          if (!actions.length)
            say(
              `The step may use the connection "${old}", which names no action. Add its actions to the file's connections and to the step's tools.`,
              id,
            );
          tools.push(...actions.map((action) => `${name}.${action}`));
        }
        if (step.agent)
          say(
            `The step is run by the wizard's agent "${step.agent}". Its file is not read here: check the model and the tools.`,
            id,
          );
        if (step.model === "highest") say('The model class "highest" is "high" in version 2.', id);
        if (step.output.schema)
          say("The step's output is a schema. The ask carries it as `schema`.", id);
        const spec = {
          type: "agent",
          title: step.title,
          agent: step.agent,
          model: textClassOf(step.model ?? "standard"),
          maker: step.maker,
          effort: step.effort,
          instructions: template(step.instructions, inner, true, revision(index) + answers()),
          tools: tools.length ? tools : undefined,
          hosts: step.hosts,
          fields: step.output.fields,
          format: step.output.fields ? undefined : step.output.format,
          schema: step.output.schema,
          surface: step.output.surface,
          durable: step.durable,
          working: step.working,
          retries: step.retries,
        };
        if (!each) return [line(`${decl}${ask(spec)};`)];
        use("listOf");
        const from = dataRef(step.foreach ?? "");
        if (from.startsWith("lists."))
          say(`The step runs for each row of "${from}". A step cannot read a stored list.`, id);
        const list = from.startsWith("lists.") ? "undefined" : value(from, scope, "foreach");
        return [
          line(`const entries = listOf(${list}).slice(0, 20);`),
          line(`if (!entries.length) throw new Error("There is nothing to work on.");`),
          line("const count = entries.length;"),
          line("const made = await Promise.all("),
          line(`  entries.map((item: any, index: number) => ${ask(spec, `${pad}  `).slice(6)}),`),
          line(");"),
          line(`${decl}{`),
          line("  rows: entries.map((item: any, index: number) => ({"),
          line(`    ...(item && typeof item === "object" ? item : { item }),`),
          line(`    ...(made[index] && typeof made[index] === "object" ? made[index] : {}),`),
          line("  })),"),
          line("};"),
        ];
      }
      case "decision":
        return [
          line(
            `${decl}${ask({
              type: "decision",
              title: step.title,
              instructions: template(step.instructions, scope, true, answers()),
              fields: step.output.fields,
              working: step.working,
              retries: step.retries,
            })};`,
          ),
        ];
      case "tool": {
        const base = { type: "tool", title: step.title };
        const more = { fields: step.output.fields, working: step.working, retries: step.retries };
        if (!step.call) {
          say(
            "The step runs a statement on the wizard's database. The ask carries it as `data`, and a host has to answer it.",
            id,
          );
          const data = step.data && {
            ...step.data,
            params: dataOf(step.data.params, scope, "The statement"),
          };
          return [line(`${decl}${ask({ ...base, data, ...more })};`)];
        }
        let call: string;
        if ("tool" in step.call) call = step.call.tool;
        else {
          const { connection, action } = step.call;
          let name = connectionNames.get(connection);
          if (!name) {
            say(
              `The step calls the connection "${connection}", which the wizard does not have.`,
              id,
            );
            name = connection;
            connections[name] ??= {};
          }
          if (!connections[name][action]) {
            connections[name][action] = "ask";
            say(`The action "${name}.${action}" has no policy. It asks the user first.`, id);
          }
          call = `${name}.${action}`;
        }
        const input = templated(step.call.input, scope);
        if (hasCode(input)) use("filled");
        return [
          line(
            `${decl}${ask({
              ...base,
              call,
              input: hasCode(input)
                ? new Code((at) => `filled(${print(input, at)})`)
                : settled(step.call.input),
              ...more,
            })};`,
          ),
        ];
      }
      case "code": {
        say(
          `The step runs the wizard's code in "${step.code.entry}". Move that function into steps/${id}.ts: the step fails until then.`,
          id,
        );
        return [
          line(`// This was a code step. Its function is in ${step.code.entry}: move it into this`),
          line("// file, call it with `input` and give back what it returns."),
          line(`const input = ${print(dataOf(step.code.input, scope, "The code") ?? {}, pad)};`),
          line(`${decl}await Promise.reject(`),
          line(`  new Error(${q(`The code of "${id}" is still in ${step.code.entry}.`)}),`),
          line(");"),
        ];
      }
      case "generate": {
        const each = step.foreach !== undefined;
        const inner: Scope = { index, entry: each };
        const written = step.asset === "document" || step.asset === "dashboard";
        if (step.model === "highest") say('The model class "highest" is "high" in version 2.', id);
        /** An image field, a step that made images, or a path into a step's value. */
        const images = (ref: string, where: string) => {
          const name = dataRef(ref);
          if (owners.has(name) || name.includes(".")) return value(name, scope, where);
          return value(`steps.${name}`, scope, where);
        };
        const reference = step.referenceImage && images(step.referenceImage, "referenceImage");
        if (reference || each) use("listOf");
        const spec = (referenceImage: string | undefined) => ({
          type: "generate",
          title: step.title,
          asset: step.asset,
          prompt: template(step.prompt, inner, false, revision(index) + (written ? answers() : "")),
          options: step.options && {
            ...step.options,
            style: step.options.style && template(step.options.style, inner),
          },
          referenceImage: referenceImage ? code(referenceImage) : undefined,
          model: step.model && textClassOf(step.model),
          maker: step.maker,
          effort: step.effort,
          working: step.working,
          retries: step.retries,
        });
        if (!each) return [line(`${decl}${ask(spec(reference && `listOf(${reference})[0]`))};`)];
        const from = dataRef(step.foreach ?? "");
        const table = from.startsWith("steps.") && from.split(".").length > 2;
        const own = !table;
        return [
          line(`const entries = listOf(${images(from, "foreach")}).slice(0, 8);`),
          ...(reference ? [line(`const references = listOf(${reference});`)] : []),
          line("const count = entries.length;"),
          line("const made = await Promise.all("),
          line(
            `  entries.map((item: any, index: number) => ${ask(
              spec(
                reference
                  ? `references.length > 1 ? (references[index] ?? references[0]) : ${own ? "(references[0] ?? item)" : "references[0]"}`
                  : table
                    ? undefined
                    : "item",
              ),
              `${pad}  `,
            ).slice(6)}),`,
          ),
          line(");"),
          line(`${decl}{ entries: made, assets: made.flatMap((one: any) => one?.assets ?? []) };`),
        ];
      }
      case "widget":
        return [
          line(
            `${decl}${ask({
              type: "widget",
              title: step.title,
              entry: step.entry,
              data: dataOf(step.data, scope, "The widget") ?? {},
              sample: step.sample,
              layout: step.layout,
              size: step.size,
              video: step.video,
              working: step.working,
              retries: step.retries,
            })};`,
          ),
        ];
      case "surface":
        if (step.candidates)
          say("A model picks the pieces of this surface. The host has to decide that.", id);
        return [
          line(
            `${decl}${ask({
              type: "surface",
              title: step.title,
              components: step.components,
              candidates: step.candidates,
              groups: step.groups,
              data: dataOf(step.data, scope, "The surface") ?? {},
              working: step.working,
              retries: step.retries,
            })};`,
          ),
        ];
      case "motion-graphics":
        if (step.model === "highest") say('The model class "highest" is "high" in version 2.', id);
        return [
          line(
            `${decl}${ask({
              type: "motion-graphics",
              title: step.title,
              brief: template(step.brief, scope, false, revision(index)),
              skills: step.skills,
              kit: step.kit,
              inputs: dataOf(step.inputs, scope, "The video") ?? {},
              format: step.format,
              from: step.from ? code(value(step.from, scope, "The video")) : undefined,
              seconds: step.seconds,
              model: step.model && textClassOf(step.model),
              maker: step.maker,
              effort: step.effort,
              working: step.working,
              retries: step.retries,
            })};`,
          ),
        ];
      case "wait": {
        if (step.signal) {
          const { name, key, timeout, fields } = step.signal;
          const spec = {
            type: "wait",
            title: step.title,
            signal: name,
            key: template(key, scope),
            timeout,
            fields,
          };
          return [
            line(`const signal = ${ask(spec)};`),
            line(`${decl}{`),
            line("  came: signal?.came === true,"),
            line("  timedOut: signal?.came !== true,"),
            line("  data: signal?.data ?? {},"),
            line("};"),
          ];
        }
        if (step.for)
          return [
            line(`${ask({ type: "wait", title: step.title, timeout: step.for })};`),
            line(`${decl}{ waited: true };`),
          ];
        if (step.until) {
          use("daysUntil");
          say(
            "The step waits until a date. In version 2 it waits whole days, counted from the day the run began.",
            id,
          );
          return [
            line(`const days = daysUntil(run.today, ${print(template(step.until, scope), pad)});`),
            line(
              `if (days > 0) ${ask({ type: "wait", title: step.title, timeout: code("`$" + "{days}d`") })};`,
            ),
            line(`${decl}{ waited: true };`),
          ];
        }
        return [line(`${decl}{ waited: true };`)];
      }
      case "result": {
        const data = Object.fromEntries(
          Object.entries(step.data ?? {})
            .filter(([, ref]) => !direct(ref))
            .map(([key, ref]) => {
              const [head] = dataRef(ref).split(".");
              if (HOST.has(head)) {
                say(`The result gives "${key}" from "${ref}". A step cannot read that.`, id);
                return [key, code("undefined")];
              }
              return [key, code(value(ref, scope, "The result"))];
            }),
        );
        return [line(`${decl}${print(data, pad)};`)];
      }
    }
  }

  /** A fixed input as version 1 sends it: trimmed, numbers and yes or no as such, nothing left out. */
  function settled(input: unknown): unknown {
    if (typeof input === "string") {
      const text = input.trim();
      if (!text) return undefined;
      if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
      return text === "true" ? true : text === "false" ? false : text;
    }
    if (Array.isArray(input)) return input.map(settled).filter((one) => one !== undefined);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .map(([key, one]) => [key, settled(one)] as const)
          .filter(([, one]) => one !== undefined),
      );
    return input;
  }

  // --- connections ---------------------------------------------------------------------------

  const connections: Record<string, Record<string, "allow" | "ask">> = {};
  const connectionNames = new Map<string, string>();
  for (const connection of definition.connections ?? []) {
    let name = connection.kind ?? connection.connector ?? connection.id;
    if (connections[name] || name.includes(".") || !name) {
      say(`The connection "${connection.id}" keeps its id as its name in the file.`);
      name = connection.id;
    }
    if (connection.spaceConnection)
      say(
        `The connection "${connection.id}" is a connection of the space. The file names it "${name}", and the space's rules still decide.`,
      );
    connectionNames.set(connection.id, name);
    connections[name] ??= {};
    const actions = [...(connection.actions ?? []), ...Object.keys(connection.policy ?? {})];
    for (const action of actions) {
      if (!connection.policy?.[action])
        say(`The action "${name}.${action}" has no policy. It asks the user first.`);
      connections[name][action] = connection.policy?.[action] ?? "ask";
    }
  }

  // --- the ways and the files ----------------------------------------------------------------

  const edges: Record<string, string[]> = {};
  const files: Record<string, string> = {};

  const target = (goto: string, from: string): string | undefined => {
    if (goto === "end") return "end";
    const index = indexOf(goto);
    if (index < 0) {
      say(`A rule leads to "${goto}", which is not a step. It is left out.`, from);
      return undefined;
    }
    return wayAt(index);
  };

  steps.forEach((step, index) => {
    if (gone(index)) return;
    const id = newIds[index];
    helpers = new Set();
    consts = new Map();
    const after: Scope = { index, after: true };
    const next = step.type === "result" ? "end" : wayAt(index + 1);
    const rules = step.type === "result" ? [] : (step.next ?? []);
    const other = rules.find(isOtherwise);
    const otherTo = other && target(other.goto, id);
    const ways = [otherTo ?? next];
    const leave: string[] = [];
    const asked: string[] = [];

    const failTo = step.onFail ? target(step.onFail, id) : undefined;
    const body = failTo
      ? [
          "  let value: any;",
          "  try {",
          ...build(index, "    ", "value = "),
          "  } catch (error: any) {",
          `    return { value: { failed: true, error: String(error?.message ?? error) }, to: ${q(failTo)} };`,
          "  }",
        ]
      : build(index, "  ", "const value: any = ");

    for (const to of redone(index)) {
      leave.push(
        `if (value?.regenerate === ${q(newIds[to])}) return { value, to: ${q(newIds[to])} };`,
      );
      ways.push(newIds[to]);
    }
    for (const rule of rules) {
      if (rule.ask) {
        const to = target(rule.goto, id);
        if (to) asked.push(to);
        say(
          `A model decided the way "${rule.ask}". The step takes its default way. The target stays in the map.`,
          id,
        );
        continue;
      }
      if (rule.when === undefined) continue;
      const to = target(rule.goto, id);
      if (!to) continue;
      const cap = capOf(index, rule);
      const holds = test(rule.when, after);
      const open = cap ? ` && run.count(${q(id)}) <= ${cap}` : "";
      leave.push(
        `if (${cap && holds.includes(" || ") ? `(${holds})` : holds}${open}) return { value, to: ${q(to)} };`,
      );
      ways.push(to);
    }
    let last = ways[0];
    const cap = other && otherTo ? capOf(index, other) : undefined;
    if (cap && otherTo) {
      leave.push(`if (run.count(${q(id)}) <= ${cap}) return { value, to: ${q(otherTo)} };`);
      ways.push(next);
      last = next;
    }
    if (failTo) ways.push(failTo);
    ways.push(...asked);
    edges[id] = [...new Set(ways)];
    leave.push(edges[id].length > 1 ? `return { value, to: ${q(last)} };` : "return { value };");

    const head = [step.title, step.description]
      .filter(Boolean)
      .join("\n")
      .replaceAll("*/", "* /")
      .split("\n")
      .map((text) => ` * ${text}`.trimEnd());
    const top = [
      ...[...consts].map(([name, text]) => `const ${name} = ${text};`),
      ...Object.keys(HELPERS)
        .filter((name) => helpers.has(name))
        .map((name) => HELPERS[name].source),
    ];
    files[`steps/${id}.ts`] = [
      "/**",
      ...head,
      " *",
      ` * Converted from the ${step.type} step "${step.id}" of version 1.`,
      " */",
      ...top.flatMap((text) => ["", text]),
      "",
      "export default async function (run: any, ask: any) {",
      ...body,
      ...leave.map((text) => `  ${text}`),
      "}",
      "",
    ].join("\n");
  });

  // A step no way leads to has no place in the map.
  const reached = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const id = todo.pop() as string;
    if (id === "end" || reached.has(id)) continue;
    reached.add(id);
    todo.push(...(edges[id] ?? []));
  }
  for (const id of Object.keys(edges)) {
    if (reached.has(id)) continue;
    say(`No way leads to the step "${id}". It is left out.`);
    delete edges[id];
    delete files[`steps/${id}.ts`];
  }

  // --- the file ------------------------------------------------------------------------------

  const output: Record<string, string> = {};
  steps.forEach((step, index) => {
    if (step.type !== "result") return;
    for (const deliverable of step.deliverables) {
      const at = indexOf(dataRef(deliverable.from).replace(/^steps\./, ""));
      if (at >= 0 && edges[newIds[at]]) output[newIds[at]] = newIds[at];
      else
        say(`The result offers "${deliverable.from}", which is not a step of version 2.`, step.id);
    }
    for (const [key, ref] of Object.entries(step.data ?? {})) {
      const from = direct(ref) ?? `${newIds[index]}.${key}`;
      if (edges[from.split(".")[0]]) output[key] = from;
    }
    const dropped = [
      step.message && "its message",
      step.share && "its share targets",
      step.deliverables.length && "the formats of its downloads",
    ].filter(Boolean);
    if (dropped.length)
      say(`The result is the file's output. Not kept: ${dropped.join(", ")}.`, step.id);
  });

  const limits: Record<string, number> = {};
  steps.forEach((_step, index) => {
    if (loops[index] > 0 && edges[newIds[index]])
      limits[newIds[index]] = Math.min(1000, loops[index] + 1);
  });

  const agents = definition.requires?.agents;
  const models = [...new Set(steps.flatMap((step) => stepClasses(step, agents)))].sort();
  const tools = new Set<string>();
  const hosts = new Set<string>();
  steps.forEach((step, index) => {
    if (!edges[newIds[index]]) return;
    if (step.type === "agent") {
      for (const tool of step.tools) tools.add(tool);
      for (const host of step.hosts ?? []) hosts.add(host);
      for (const tool of (step.agent && agents?.[step.agent]?.tools) || []) tools.add(tool);
    }
    if (step.type === "tool" && step.call && "tool" in step.call) tools.add(step.call.tool);
  });
  const requires = {
    ...(models.length ? { models } : {}),
    ...(tools.size ? { tools: [...tools].sort() } : {}),
    ...(hosts.size ? { hosts: [...hosts].sort() } : {}),
  };

  if (kept.size)
    say(
      `Texts keep ${[...kept]
        .sort()
        .map((name) => `{{${name}.…}}`)
        .join(", ")} as written. The host fills them when it answers the ask.`,
    );
  if (hoisted && !inputOnly)
    say(
      `The first form "${newIds[0]}" is the file's input and a step: it takes the input the first time and asks from the second time on.`,
    );
  if (opening?.timeout || opening?.remind)
    say("The first form's timeout and reminder do not apply to the file's input.");
  if (inputOnly && (opening?.components || opening?.cta || opening?.groups))
    say("The first form's layout, button and groups are not part of the file's input.");
  const left = (
    [
      ["intro", definition.intro],
      ["label", definition.label],
      ["lists", definition.lists?.length],
      ["data", definition.data],
      ["themes", definition.themes?.length],
      ["costume", definition.costume],
    ] as const
  ).flatMap(([name, there]) => (there ? [name] : []));
  if (left.length) say(`The file of version 2 has no place for: ${left.join(", ")}.`);
  if (steps.some((step) => step.type === "review" && step.edit))
    say(
      "A review's edits are in its value. Steps later in the list read them. The file's output reads the step's own value.",
    );

  const file: KernelFile = {
    version: 2,
    title: definition.title,
    description: definition.description ?? "",
    avatar: definition.avatar ?? "round",
    ...(definition.lang ? { lang: definition.lang } : {}),
    ...(Object.keys(requires).length ? { requires } : {}),
    ...(Object.keys(connections).length ? { connections } : {}),
    ...(opening ? { input: { fields: opening.fields } } : {}),
    ...(Object.keys(output).length ? { output } : {}),
    start,
    edges,
    ...(Object.keys(limits).length ? { limits } : {}),
  };
  return { file, files, notes };
}

/** The helpers a step file may need, in the order they are written. `needs` come with them. */
const HELPERS: Record<string, { source: string; needs?: string[] }> = {
  text: {
    source: `/** A value as a text shows it: nothing is "", a list of words is joined, data is JSON. */
const text = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((one) => typeof one !== "object")) return value.join(", ");
  return JSON.stringify(value, null, 2);
};`,
  },
  asData: {
    needs: ["text"],
    source: `/** What a person typed, marked as data: a model tells it from the wizard's own words. */
const asData = (field: string, value: unknown): string => {
  const said = text(value);
  return said === "" ? "" : \`<data field="\${field}">\${said.replaceAll("</data>", "")}</data>\`;
};`,
  },
  empty: {
    source: `/** Nothing, "" and an empty list are empty. */
const empty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);`,
  },
  truthy: {
    needs: ["empty"],
    source: `/** Whether a value counts as yes: empty values, 0 and false do not. */
const truthy = (value: unknown): boolean => !empty(value) && value !== false && value !== 0;`,
  },
  num: {
    source: `/** A number as a person types it, with a point or a comma. NaN where it is none. */
const num = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string" || !/^-?(\\d+([.,]\\d*)?|[.,]\\d+)$/.test(value.trim())) return Number.NaN;
  return Number(value.trim().replace(",", "."));
};`,
  },
  contains: {
    source: `/** Whether a list has the entry, or a text has the words, in any case. */
const contains = (value: unknown, part: unknown): boolean =>
  Array.isArray(value)
    ? value.map(String).includes(String(part))
    : typeof value === "string" && part !== undefined && value.toLowerCase().includes(String(part).toLowerCase());`,
  },
  op: {
    needs: ["empty", "num"],
    source: `/** One operation of a calculation of version 1. What cannot be worked out is undefined. */
const op = (name: string, ...of: any[]): any => {
  const [a, b] = of;
  if (name === "==" || name === "!=") {
    const numbers = !Number.isNaN(num(a)) && !Number.isNaN(num(b));
    const same = empty(a) || empty(b) ? empty(a) && empty(b) : numbers ? num(a) === num(b) : String(a) === String(b);
    return name === "==" ? same : !same;
  }
  if (name === "count") return Array.isArray(a) ? a.length : 0;
  if (name === "sum") {
    if (!Array.isArray(a)) return undefined;
    const all = a.map((one) => num(typeof b === "string" ? one?.[b] : one));
    return all.filter((n) => !Number.isNaN(n)).reduce((sum, n) => sum + n, 0);
  }
  if (name === "round" && b === undefined) of.push(0);
  const all = (name === "min" || name === "max" ? of.flat() : of).map(num);
  if (all.some(Number.isNaN)) return undefined;
  const [x, y] = all;
  switch (name) {
    case "neg":
      return -x;
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? undefined : x / y;
    case "%":
      return y === 0 ? undefined : x % y;
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    case "min":
      return Math.min(...all);
    case "max":
      return Math.max(...all);
    case "round": {
      const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(y)));
      return Math.round(x * factor) / factor;
    }
  }
};`,
  },
  itemsOf: {
    needs: ["num"],
    source: `/** Line items with their amounts and totals, and as a table a model reads. */
const itemsOf = (
  value: unknown,
  field: { columns: { id: string; label: string; kind: string }[]; currency: string; vat: number },
  vatFrom?: unknown,
) => {
  const round = (n: number) => Math.round(n * 100) / 100;
  const amount = (v: unknown) => (Number.isNaN(num(v)) ? 0 : num(v));
  const money = (n: number) => \`\${n.toFixed(2)} \${field.currency}\`;
  const numeric = field.columns.filter((column) => column.kind !== "text");
  const rows = (Array.isArray(value) ? value : []).map((row: any) => ({
    ...row,
    amount: round(numeric.length ? numeric.reduce((all, column) => all * amount(row?.[column.id]), 1) : 0),
  }));
  const net = round(rows.reduce((sum: number, row: any) => sum + row.amount, 0));
  const typed = num(String(vatFrom ?? "").replace(/[^\\d,.-]/g, ""));
  const vatRate = Number.isNaN(typed) ? field.vat : typed;
  const vat = round((net * vatRate) / 100);
  const gross = round(net + vat);
  const lines = rows.map(
    (row: any) =>
      \`| \${field.columns
        .map((column) => (column.kind === "money" ? money(amount(row[column.id])) : String(row[column.id] ?? "")))
        .join(" | ")} | \${money(row.amount)} |\`,
  );
  const table = !rows.length
    ? "(no line items)"
    : [
        \`| \${field.columns.map((column) => column.label).join(" | ")} | Amount |\`,
        \`|\${field.columns.map(() => " --- ").join("|")}| ---: |\`,
        ...lines,
        "",
        \`Net: \${money(net)}\`,
        ...(vatRate ? [\`VAT \${vatRate}%: \${money(vat)}\`] : []),
        \`Total: \${money(gross)}\`,
      ].join("\\n");
  return { rows, net, vatRate, vat, gross, currency: field.currency, table };
};`,
  },
  uploads: {
    source: `/** Uploaded files as the names a tool reads them by. */
const uploads = (value: unknown): string =>
  (Array.isArray(value) ? value : [value])
    .filter((id) => typeof id === "string" && id.length > 0)
    .map((id) => \`upload:\${id}\`)
    .join(", ");`,
  },
  place: {
    source: `/** A place as a person reads it, or as a link to a map. */
const place = (value: any, map = false): string => {
  const at = typeof value?.lat === "number" && typeof value?.lng === "number";
  if (map) return at ? \`https://www.openstreetmap.org/?mlat=\${value.lat}&mlon=\${value.lng}#map=17/\${value.lat}/\${value.lng}\` : "";
  const accuracy = at && value.accuracy ? \`, ±\${Math.round(value.accuracy)} m\` : "";
  const point = at ? \`\${value.lat.toFixed(5)}, \${value.lng.toFixed(5)}\${accuracy}\` : "";
  const label = typeof value?.label === "string" ? value.label.trim() : "";
  return label && point ? \`\${label} (\${point})\` : label || point;
};`,
  },
  said: {
    source: `/** A voice note as what is said in it. */
const said = (value: any): string =>
  typeof value?.asset === "string" && value.asset
    ? value.transcript?.trim() || "(voice note without intelligible speech)"
    : "";`,
  },
  answersOf: {
    needs: ["text"],
    source: `/** What the person answered so far, as lines a model reads. */
const answersOf = (...forms: any[]): string =>
  forms
    .flatMap((form) => Object.entries(form ?? {}))
    .filter(([, value]) => text(value) !== "")
    .map(([name, value]) => \`### \${name}\\n\${text(value)}\`)
    .join("\\n\\n") || "(none)";`,
  },
  listOf: {
    source: `/** The entries of a value: a list itself, a step's files or rows, or the one value. */
const listOf = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value.assets)) return value.assets;
  return Array.isArray(value.rows) ? value.rows : [value];
};`,
  },
  filled: {
    source: `/** A call's input as it is sent: texts trimmed, numbers and yes or no as such, nothing left out. */
const filled = (value: any): any => {
  if (typeof value === "string") {
    const said = value.trim();
    if (!said) return undefined;
    if (/^-?\\d+(\\.\\d+)?$/.test(said)) return Number(said);
    return said === "true" ? true : said === "false" ? false : said;
  }
  if (Array.isArray(value)) return value.map(filled).filter((one) => one !== undefined);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, one]) => [key, filled(one)])
        .filter(([, one]) => one !== undefined),
    );
  return value;
};`,
  },
  edited: {
    source: `/** A step's value with what the person changed in a review. */
const edited = (run: any, review: string, step: string): any => {
  const value = run.steps[step];
  const edit = run.steps[review]?.edits?.[step];
  if (edit === undefined || edit === null) return value;
  if (typeof edit === "string") return typeof value === "object" && value !== null ? value : edit;
  return { ...value, ...edit };
};`,
  },
  revision: {
    needs: ["text"],
    source: `/** What a review asked to change, or that the step runs again, with what it made before. */
const revision = (run: any, step: string): string => {
  const before = run.steps[step];
  if (run.last?.value?.regenerate === step)
    return \`\\n\\nThe person asked for a change: \${text(run.last.value.note)}\\nThe result before:\\n"""\\n\${text(before)}\\n"""\`;
  return run.count(step) > 1 && before !== undefined
    ? \`\\n\\nThis step runs again. Build on what it made before:\\n"""\\n\${text(before)}\\n"""\`
    : "";
};`,
  },
  optionsOf: {
    source: `/** The choices a field takes from earlier data. \`otherwise\` stands in while there are none. */
const optionsOf = (from: unknown, column?: string, otherwise: string[] = []): string[] => {
  const found = (Array.isArray(from) ? from : [])
    .map((one: any) => (column ? one?.[column] : one))
    .filter((one) => one !== null && one !== undefined && typeof one !== "object")
    .map((one) => String(one).trim().slice(0, 200))
    .filter(Boolean);
  const unique = [...new Set(found)].slice(0, 100);
  return unique.length ? unique : otherwise;
};`,
  },
  daysUntil: {
    source: `/** Whole days from one date to another. 0 where the date has gone by or is none. */
const daysUntil = (today: string, date: string): number => {
  const days = Math.ceil((Date.parse(date) - Date.parse(today)) / 86400e3);
  return Number.isFinite(days) && days > 0 ? days : 0;
};`,
  },
};
