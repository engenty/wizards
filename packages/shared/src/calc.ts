// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import { readNumber } from "./numbers.js";

/**
 * Calculated values: `demo / budget`, `servings * 100`. A closed little language this parser reads
 * and this evaluator works out, the same in the browser and on the server: never `eval`, no
 * assignment, no other calls, no property access but dotted names. A value that cannot be worked
 * out (an empty answer, a division by zero) is `undefined`.
 */

/** A value worked out from what the place knows. */
export const calcSchema = z.object({ calc: z.string().min(1).max(200) });

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  round: { min: 1, max: 2 },
  min: { min: 1, max: 20 },
  max: { min: 1, max: 20 },
  sum: { min: 1, max: 2 },
  count: { min: 1, max: 1 },
  if: { min: 3, max: 3 },
};

export type CalcNode =
  | { kind: "value"; value: number | string | boolean }
  | { kind: "name"; name: string }
  | { kind: "not" | "negative"; of: CalcNode }
  | { kind: "binary"; op: string; left: CalcNode; right: CalcNode }
  | { kind: "call"; name: string; args: CalcNode[] };

/** What a name reads at a place; undefined when it knows nothing of it. */
export type CalcScope = (name: string) => unknown;

type Token = { type: "number" | "string" | "name" | "op"; text: string };

const OPERATORS = ["==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "<", ">", "(", ")", ","];

function tokens(source: string): Token[] | { error: string } {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = rest.match(/^\s+/);
    if (space) {
      i += space[0].length;
      continue;
    }
    const number = rest.match(/^\d+(\.\d+)?/);
    if (number) {
      out.push({ type: "number", text: number[0] });
      i += number[0].length;
      continue;
    }
    const name = rest.match(/^[a-zA-Z_]\w*(\.[a-zA-Z0-9_]+)*/);
    if (name) {
      out.push({ type: "name", text: name[0] });
      i += name[0].length;
      continue;
    }
    if (rest[0] === '"') {
      const text = rest.match(/^"((?:[^"\\]|\\.)*)"/);
      if (!text) {
        return { error: "A text is missing its closing quote." };
      }
      out.push({ type: "string", text: text[1].replace(/\\(.)/g, "$1") });
      i += text[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (!op) {
      return { error: `"${rest[0]}" means nothing here.` };
    }
    out.push({ type: "op", text: op });
    i += op.length;
  }
  return out;
}

class CalcSyntax extends Error {}

/** Reads a calculation; an `error` says what is wrong with it. */
export function parseCalc(source: string): CalcNode | { error: string } {
  const read = tokens(source);
  if ("error" in read) {
    return read;
  }
  let at = 0;
  const peek = () => read[at];
  const isOp = (...ops: string[]) => peek()?.type === "op" && ops.includes(peek().text);
  const isWord = (word: string) => peek()?.type === "name" && peek().text === word;

  const binary = (ops: string[], next: () => CalcNode) => (): CalcNode => {
    let left = next();
    while (isOp(...ops)) {
      const op = read[at++].text;
      left = { kind: "binary", op, left, right: next() };
    }
    return left;
  };
  const word = (name: string, next: () => CalcNode) => (): CalcNode => {
    let left = next();
    while (isWord(name)) {
      at += 1;
      left = { kind: "binary", op: name, left, right: next() };
    }
    return left;
  };

  const primary = (): CalcNode => {
    const token = peek();
    if (!token) {
      throw new CalcSyntax("It ends too early.");
    }
    at += 1;
    if (token.type === "number") {
      return { kind: "value", value: Number(token.text) };
    }
    if (token.type === "string") {
      return { kind: "value", value: token.text };
    }
    if (token.type === "op") {
      if (token.text === "(") {
        const inner = or();
        if (!isOp(")")) {
          throw new CalcSyntax('A ")" is missing.');
        }
        at += 1;
        return inner;
      }
      throw new CalcSyntax(`"${token.text}" stands where a value belongs.`);
    }
    if (token.text === "true" || token.text === "false") {
      return { kind: "value", value: token.text === "true" };
    }
    if (["and", "or", "not"].includes(token.text)) {
      throw new CalcSyntax(`"${token.text}" stands where a value belongs.`);
    }
    if (!isOp("(")) {
      return { kind: "name", name: token.text };
    }
    return call(token.text);
  };

  const call = (name: string): CalcNode => {
    const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
    if (!fn) {
      throw new CalcSyntax(
        `There is no function "${name}"; there are ${Object.keys(FUNCTIONS).join(", ")}.`,
      );
    }
    at += 1;
    const args: CalcNode[] = [];
    if (!isOp(")")) {
      args.push(or());
      while (isOp(",")) {
        at += 1;
        args.push(or());
      }
    }
    if (!isOp(")")) {
      throw new CalcSyntax('A ")" is missing.');
    }
    at += 1;
    if (args.length < fn.min || args.length > fn.max) {
      throw new CalcSyntax(`"${name}" takes ${fn.min} to ${fn.max} values, not ${args.length}.`);
    }
    // `sum(items, price)`: the column of the list, which no name reads by itself.
    if (name === "sum" && args[1]?.kind === "name") {
      args[1] = { kind: "value", value: args[1].name };
    }
    return { kind: "call", name, args };
  };

  const unary = (): CalcNode => {
    if (isOp("-")) {
      at += 1;
      return { kind: "negative", of: unary() };
    }
    return primary();
  };
  const product = binary(["*", "/", "%"], unary);
  const added = binary(["+", "-"], product);
  const compared = binary(["==", "!=", "<=", ">=", "<", ">"], added);
  const negated = (): CalcNode => {
    if (isWord("not")) {
      at += 1;
      return { kind: "not", of: negated() };
    }
    return compared();
  };
  const and = word("and", negated);
  const or: () => CalcNode = word("or", and);

  try {
    const node = or();
    if (at < read.length) {
      throw new CalcSyntax(`"${read[at].text}" stands where nothing more belongs.`);
    }
    return node;
  } catch (err) {
    if (err instanceof CalcSyntax) {
      return { error: err.message };
    }
    throw err;
  }
}

const known = new Map<string, CalcNode | { error: string }>();

/** `parseCalc`, kept: a view works out the same few calculations on every change. */
export function parsedCalc(source: string): CalcNode | { error: string } {
  let node = known.get(source);
  if (!node) {
    if (known.size >= 500) {
      known.clear();
    }
    node = parseCalc(source);
    known.set(source, node);
  }
  return node;
}

/** The names a calculation reads, each once, for the validator. */
export function calcNames(node: CalcNode): string[] {
  const out = new Set<string>();
  const walk = (n: CalcNode) => {
    if (n.kind === "name") {
      out.add(n.name);
    } else if (n.kind === "not" || n.kind === "negative") {
      walk(n.of);
    } else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === "call") {
      n.args.forEach(walk);
    }
  };
  walk(node);
  return [...out];
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

const number = (v: unknown): number | undefined => {
  if (typeof v === "boolean" || isEmpty(v)) {
    return undefined;
  }
  return readNumber(v) ?? undefined;
};

/** Whether a worked-out value counts as yes: nothing, "", 0, false and an empty list do not. */
export function calcTruthy(v: unknown): boolean {
  return !isEmpty(v) && v !== false && v !== 0;
}

function equal(a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) {
    return isEmpty(a) && isEmpty(b);
  }
  const x = number(a);
  const y = number(b);
  return x !== undefined && y !== undefined ? x === y : String(a) === String(b);
}

const numbersOf = (values: unknown[]): (number | undefined)[] =>
  values.flatMap((v) => (Array.isArray(v) ? v : [v])).map(number);

function work(node: CalcNode, scope: CalcScope): unknown {
  switch (node.kind) {
    case "value":
      return node.value;
    case "name":
      return scope(node.name);
    case "not":
      return !calcTruthy(work(node.of, scope));
    case "negative": {
      const n = number(work(node.of, scope));
      return n === undefined ? undefined : -n;
    }
    case "binary":
      return binary(node.op, node.left, node.right, scope);
    case "call":
      return call(node.name, node.args, scope);
  }
}

function binary(op: string, left: CalcNode, right: CalcNode, scope: CalcScope): unknown {
  if (op === "and") {
    return calcTruthy(work(left, scope)) && calcTruthy(work(right, scope));
  }
  if (op === "or") {
    return calcTruthy(work(left, scope)) || calcTruthy(work(right, scope));
  }
  const a = work(left, scope);
  const b = work(right, scope);
  if (op === "==") {
    return equal(a, b);
  }
  if (op === "!=") {
    return !equal(a, b);
  }
  const x = number(a);
  const y = number(b);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  switch (op) {
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
  }
  return undefined;
}

function call(name: string, args: CalcNode[], scope: CalcScope): unknown {
  if (name === "if") {
    return work(calcTruthy(work(args[0], scope)) ? args[1] : args[2], scope);
  }
  const values = args.map((a) => work(a, scope));
  switch (name) {
    case "round": {
      const n = number(values[0]);
      const digits = values[1] === undefined ? 0 : number(values[1]);
      if (n === undefined || digits === undefined) {
        return undefined;
      }
      const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)));
      return Math.round(n * factor) / factor;
    }
    case "min":
    case "max": {
      const all = numbersOf(values);
      if (all.some((n) => n === undefined)) {
        return undefined;
      }
      return (name === "min" ? Math.min : Math.max)(...(all as number[]));
    }
    case "count":
      return Array.isArray(values[0]) ? values[0].length : 0;
    case "sum": {
      if (!Array.isArray(values[0])) {
        return undefined;
      }
      const column = typeof values[1] === "string" ? values[1] : null;
      let total = 0;
      for (const entry of values[0]) {
        const n = number(
          column === null
            ? entry
            : entry && typeof entry === "object" && Object.hasOwn(entry, column)
              ? (entry as Record<string, unknown>)[column]
              : undefined,
        );
        if (n !== undefined) {
          total += n;
        }
      }
      return total;
    }
  }
  return undefined;
}

/** What a calculation comes to; undefined where it cannot be worked out. */
export function evalCalc(node: CalcNode, scope: CalcScope): unknown {
  const value = work(node, scope);
  if (typeof value !== "number") {
    return value;
  }
  // 0.1 + 0.2 is 0.3 to a person.
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : undefined;
}

/** A name read from records, the first that has it: as a key ("steps.a.b"), then key by key. */
export function calcScope(...records: unknown[]): CalcScope {
  return (name) => {
    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }
      if (Object.hasOwn(record, name)) {
        return (record as Record<string, unknown>)[name];
      }
      let at: unknown = record;
      for (const part of name.split(".")) {
        at =
          at && typeof at === "object" && Object.hasOwn(at, part)
            ? (at as Record<string, unknown>)[part]
            : undefined;
      }
      if (at !== undefined) {
        return at;
      }
    }
    return undefined;
  };
}

/** What a calculation's text comes to at a place; undefined where it does not read or work out. */
export function calcValue(source: string, scope: CalcScope): unknown {
  const node = parsedCalc(source);
  return "error" in node ? undefined : evalCalc(node, scope);
}
