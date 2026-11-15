import type {
  KernelOutline,
  OutlineAsk,
  OutlineValue,
  OutlineWay,
  StepOutline,
} from "@engenty/wizards-shared/kernel-file";
import { stepFilesOf } from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { type Node, parse } from "acorn";
import { transform } from "esbuild";
import { snapshotFile } from "../services/files.js";

/**
 * What the studio shows of a step without running it (docs/plans/kernel.md, F): each `ask` of the
 * step with what it passes, and each `return` with the way it names. Only what is written out is
 * read: a literal, a template, a constant of the same file. Anything worked out stays code.
 */

type N = Node & Record<string, any>;

const FUNCTIONS = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];
const read = new Map<string, StepOutline>();

/** The title and the lines below it from the comment at the top of a step file. */
function head(source: string): Pick<StepOutline, "title" | "description"> {
  const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1];
  if (!comment) return {};
  const lines = comment.split("\n").map((line) => line.replace(/^\s*\*? ?/, "").trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  const end = lines.indexOf("");
  const [title, ...rest] = end < 0 ? lines : lines.slice(0, end);
  const description = rest.join("\n").trim();
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

export async function stepOutline(source: string): Promise<StepOutline> {
  let code: string;
  let tree: N;
  try {
    code = (await transform(source, { loader: "ts", format: "esm", target: "esnext" })).code;
    tree = parse(code, { ecmaVersion: "latest", sourceType: "module" }) as N;
  } catch (err) {
    return { ...head(source), asks: [], ways: [], error: (err as Error).message.split("\n")[0] };
  }
  const text = (node: N) => code.slice(node.start, node.end);

  // The constants and functions of the file, by name.
  const named = new Map<string, N>();
  for (const node of tree.body as N[]) {
    const decl: N = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (decl?.type === "FunctionDeclaration" && decl.id) named.set(decl.id.name, decl);
    if (decl?.type === "VariableDeclaration")
      for (const one of decl.declarations as N[])
        if (one.id.type === "Identifier" && one.init) named.set(one.id.name, one.init);
  }

  const value = (node: N | null, depth = 0): OutlineValue => {
    if (!node) return null;
    switch (node.type) {
      case "Literal":
        return node.regex || typeof node.value === "bigint" ? { $code: text(node) } : node.value;
      case "TemplateLiteral": {
        if (!node.expressions.length) return node.quasis[0].value.cooked ?? "";
        const parts: (string | { $code: string })[] = [];
        (node.quasis as N[]).forEach((quasi, i) => {
          if (quasi.value.cooked) parts.push(quasi.value.cooked);
          if (node.expressions[i]) parts.push({ $code: text(node.expressions[i]) });
        });
        return { $text: parts };
      }
      case "ArrayExpression":
        return (node.elements as (N | null)[]).map((one) =>
          one && one.type !== "SpreadElement" ? value(one, depth) : { $code: one ? text(one) : "" },
        );
      case "ObjectExpression":
        return object(node, depth);
      case "UnaryExpression":
        if (node.operator === "-" && typeof node.argument.value === "number")
          return -node.argument.value;
        break;
      case "Identifier": {
        const init = named.get(node.name);
        if (init && depth < 4 && !FUNCTIONS.includes(init.type)) return value(init, depth + 1);
      }
    }
    return { $code: text(node) };
  };
  const object = (node: N, depth: number): Record<string, OutlineValue> => {
    const out: Record<string, OutlineValue> = {};
    for (const prop of node.properties as N[]) {
      if (prop.type !== "Property" || prop.computed) {
        out["…"] = { $code: text(prop) };
        continue;
      }
      const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
      out[key] = value(prop.value, depth);
    }
    return out;
  };

  // The step's function: what the file exports as its default.
  const exported = (tree.body as N[]).find((n) => n.type === "ExportDefaultDeclaration");
  let fn: N | undefined = exported?.declaration;
  // esbuild writes `export { name as default }` for a function without a name.
  for (const node of tree.body as N[])
    for (const spec of (node.type === "ExportNamedDeclaration" ? node.specifiers : []) as N[])
      if ((spec.exported.name ?? spec.exported.value) === "default") fn = spec.local;
  for (let hops = 0; fn?.type === "Identifier" && hops < 4; hops++) fn = named.get(fn.name);
  if (!fn || !FUNCTIONS.includes(fn.type)) {
    return { ...head(source), asks: [], ways: [], error: "A step exports one function." };
  }
  const askName = fn.params[1]?.type === "Identifier" ? fn.params[1].name : "ask";

  const asks: OutlineAsk[] = [];
  const ways: OutlineWay[] = [];
  const way = (to: N, conds: string[], why: string | undefined) => {
    if (to.type === "ConditionalExpression") {
      way(to.consequent, [...conds, text(to.test)], why);
      way(to.alternate, [...conds, `!(${text(to.test)})`], why);
      return;
    }
    const when = {
      ...(conds.length ? { when: conds.join(" && ") } : {}),
      ...(why ? { why } : {}),
    };
    ways.push(
      to.type === "Literal" && typeof to.value === "string"
        ? { to: to.value, ...when }
        : { code: text(to), ...when },
    );
  };
  /** `inner`: inside a function of the step's own, where a `return` is not the step's. */
  const walk = (node: N | null, conds: string[], inner: boolean) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "IfStatement") {
      walk(node.test, conds, inner);
      walk(node.consequent, [...conds, text(node.test)], inner);
      walk(node.alternate, [...conds, `!(${text(node.test)})`], inner);
      return;
    }
    if (node.type === "CallExpression" && node.callee.name === askName) {
      const spec = value(node.arguments[0] ?? null);
      asks.push(
        spec && typeof spec === "object" && !Array.isArray(spec) && !("$code" in spec)
          ? { spec: spec as Record<string, OutlineValue> }
          : { code: node.arguments[0] ? text(node.arguments[0]) : "" },
      );
    }
    if (node.type === "ReturnStatement" && !inner) {
      const prop = (name: string): N | undefined =>
        node.argument?.type === "ObjectExpression"
          ? (node.argument.properties as N[]).find(
              (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === name,
            )
          : undefined;
      const to = prop("to");
      const said = prop("why");
      const why = said ? value(said.value) : undefined;
      if (to) way(to.value, conds, typeof why === "string" ? why : undefined);
      else ways.push(conds.length ? { when: conds.join(" && ") } : {});
    }
    const within = inner || (node !== fn && FUNCTIONS.includes(node.type));
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) for (const one of child) walk(one, conds, within);
      else if (child && typeof child === "object") walk(child as N, conds, within);
    }
  };
  walk(fn, [], false);
  // A decision ask names the ways a model picks from, each with the statement that has to hold.
  for (const { spec } of asks) {
    const picks = spec?.type === "decision" ? spec.ways : undefined;
    if (!picks || typeof picks !== "object" || Array.isArray(picks)) continue;
    for (const [to, holds] of Object.entries(picks)) {
      if (typeof holds !== "string") continue;
      const named = ways.filter((one) => one.to === to);
      if (named.length) for (const one of named) Object.assign(one, { ask: holds });
      else ways.push({ to, ask: holds });
    }
  }
  return { ...head(source), asks, ways };
}

/** The outline of every step file of a workspace. A file is read once for each of its versions. */
export async function kernelOutline(files: WorkspaceFile[]): Promise<KernelOutline> {
  const outline: KernelOutline = {};
  for (const [id, path] of Object.entries(stepFilesOf(files.map((f) => f.path)))) {
    const hash = files.find((f) => f.path === path)?.hash ?? "";
    let step = read.get(hash);
    if (!step) {
      const got = await snapshotFile(files, path);
      step = await stepOutline(got?.data.toString("utf8") ?? "");
      read.set(hash, step);
      if (read.size > 500) read.delete(read.keys().next().value as string);
    }
    outline[id] = step;
  }
  return outline;
}
