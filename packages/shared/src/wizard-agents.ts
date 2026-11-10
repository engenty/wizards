import {
  type AgentStep,
  pluginToolOf,
  STEP_CLASSES,
  type StepClass,
  TOOL_IDS,
} from "./definition.js";
import { type ObjectSchema, outputSchemaSchema } from "./shape.js";
import { stepAgents, wizardAgentPath, wizardCodeOf, wizardToolsIn } from "./wizard-code.js";

/**
 * Agents a wizard brings in its workspace (docs/plans/wizard-code.md): `agents/<name>.md`,
 * Markdown with front matter, in the shape Claude Code's agents have.
 *
 * ```markdown
 * ---
 * description: Finds offers and scores them against the budget
 * model: standard
 * tools: [web_search, web_fetch, wizard.score]
 * output: { type: object, properties: { offers: { type: array, items: { type: string } } }, required: [offers] }
 * ---
 * You research offers and score them against the budget …
 * ```
 *
 * The body is the agent's instructions. A step uses the agent as its own (`"agent": "<name>"`)
 * or as a tool (`agent.<name>` in its tools). Read the same by the definition's checks, the
 * runtime and `wizards validate`.
 */

/** An agent as its file says. */
export interface WizardAgent {
  name: string;
  /** What it does, in a sentence: what a step's model reads where it is a tool. */
  description?: string;
  /** The model class it runs on; `standard` where the file names none. */
  model: StepClass;
  /** The tools it may use: built-in tools, plugin tools, the wizard's function tools. */
  tools: AgentStep["tools"];
  /** The JSON Schema of its answer where it is a tool, as a step's `output.schema` takes it. */
  output?: ObjectSchema;
  /** The body: its instructions, the system part of every call. */
  instructions: string;
}

/** Instructions an agent has at most, in characters. */
export const WIZARD_AGENT_MAX_CHARS = 20_000;

const BUILT_IN: ReadonlySet<string> = new Set(TOOL_IDS);
const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * An agent's file read: the agent, or what is wrong with it. `paths`: the workspace's paths, to
 * check the function tools it names; left out, they are not checked.
 */
export function parseWizardAgent(
  name: string,
  text: string,
  paths?: readonly string[],
): { ok: true; agent: WizardAgent } | { ok: false; issues: string[] } {
  const at = `Agent "${wizardAgentPath(name)}"`;
  const m = FRONTMATTER.exec(text);
  if (!m) {
    return { ok: false, issues: [`${at} has no front matter between --- lines.`] };
  }
  let front: Record<string, unknown>;
  try {
    front = parseYamlMap(m[1] ?? "");
  } catch (err) {
    return {
      ok: false,
      issues: [`${at}: the front matter can't be read: ${(err as Error).message}`],
    };
  }
  const issues: string[] = [];
  const known = new Set(["name", "description", "model", "tools", "output"]);
  for (const key of Object.keys(front)) {
    if (!known.has(key)) {
      issues.push(`${at}: "${key}" is no key of an agent: description, model, tools, output.`);
    }
  }
  if (front.name !== undefined && front.name !== name) {
    issues.push(`${at} is named "${String(front.name)}": name it "${name}", as its file.`);
  }
  if (
    front.description !== undefined &&
    (typeof front.description !== "string" || !front.description.trim())
  ) {
    issues.push(`${at}: "description" is a sentence of what it does.`);
  } else if (typeof front.description === "string" && front.description.length > 1000) {
    issues.push(`${at}: the description is longer than 1000 characters.`);
  }
  const model = front.model ?? "standard";
  if (!(STEP_CLASSES as readonly unknown[]).includes(model)) {
    issues.push(`${at}: "model" is one of ${STEP_CLASSES.join(", ")}, not "${String(model)}".`);
  }
  const tools = front.tools ?? [];
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
    issues.push(`${at}: "tools" is a list of tool ids.`);
  } else {
    issues.push(...agentToolIssues(at, tools as string[], paths));
  }
  let output: ObjectSchema | undefined;
  if (front.output !== undefined) {
    const parsed = outputSchemaSchema.safeParse(front.output);
    if (parsed.success) {
      output = parsed.data;
    } else {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      issues.push(`${at}: "output" is no output schema${where}: ${issue?.message ?? ""}`);
    }
  }
  const instructions = text.slice(m[0].length).trim();
  if (!instructions) {
    issues.push(`${at} has no instructions: the text below the front matter.`);
  } else if (instructions.length > WIZARD_AGENT_MAX_CHARS) {
    issues.push(`${at} has more than ${WIZARD_AGENT_MAX_CHARS} characters of instructions.`);
  }
  if (issues.length) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    agent: {
      name,
      ...(typeof front.description === "string"
        ? { description: front.description.replace(/\s+/g, " ").trim() }
        : {}),
      model: model as StepClass,
      tools: [...new Set(tools as AgentStep["tools"])],
      ...(output ? { output } : {}),
      instructions,
    },
  };
}

/**
 * What is wrong with how the steps use the agents, by what their files say: a step that runs an
 * agent narrows its tools and never widens them; an agent a step lists as a tool has a
 * description, which is what that step's model reads. `agents`: the parsed files by name; an
 * agent missing there is not checked here.
 */
export function wizardAgentUseIssues(
  def: {
    steps: readonly { id: string; type: string; tools?: readonly string[]; agent?: string }[];
  },
  agents: ReadonlyMap<string, WizardAgent>,
): { stepId: string; message: string }[] {
  const issues: { stepId: string; message: string }[] = [];
  for (const step of def.steps) {
    const used = stepAgents(step);
    const own = used.own ? agents.get(used.own) : undefined;
    if (own) {
      const have: readonly string[] = own.tools;
      const wider = (step.tools ?? []).filter((id) => !have.includes(id));
      if (wider.length) {
        issues.push({
          stepId: step.id,
          message: `The step lists ${wider.map((id) => `"${id}"`).join(", ")}, which agent "${own.name}" doesn't: a step narrows an agent's tools, never widens them.`,
        });
      }
    }
    for (const name of used.tools) {
      const agent = agents.get(name);
      if (agent && !agent.description) {
        issues.push({
          stepId: step.id,
          message: `Agent "${name}" is a tool here and needs a "description" in its front matter: what the step's model reads.`,
        });
      }
    }
  }
  return issues;
}

/** What is wrong with the tools an agent lists: unknown ids, other agents, missing function tools. */
function agentToolIssues(at: string, tools: string[], paths?: readonly string[]): string[] {
  const issues: string[] = [];
  const files = paths ? wizardToolsIn(paths) : null;
  for (const id of tools) {
    const code = wizardCodeOf(id);
    if (code?.kind === "agent") {
      issues.push(`${at} lists "${id}": an agent can't call another agent.`);
    } else if (code?.kind === "tool") {
      if (files && !files.has(code.name)) {
        issues.push(`${at} lists "${id}", which has no file: tools/${code.name}.ts or .js.`);
      }
    } else if (!BUILT_IN.has(id) && !pluginToolOf(id)) {
      issues.push(`${at} lists "${id}", which is no tool.`);
    }
  }
  return issues;
}

// --- front matter -----------------------------------------------------------------------------

/**
 * The part of YAML an agent's front matter needs: mappings and lists by indentation, flow
 * mappings and lists (`{ type: object }`, `[a, b]`, JSON too), quoted and plain values, `|` and
 * `>` blocks, comments. Throws on what it can't read.
 */
export function parseYamlMap(text: string): Record<string, unknown> {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => ({ raw, indent: raw.length - raw.trimStart().length }));
  const reader = new BlockReader(lines);
  const value = reader.block(0);
  if (reader.at < lines.length) {
    throw new Error(`line ${reader.at + 1} is indented where nothing opens`);
  }
  if (value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("it is no mapping of keys");
  }
  return value as Record<string, unknown>;
}

interface Line {
  raw: string;
  indent: number;
}

const blank = (line: Line) => {
  const t = line.raw.trim();
  return !t || t.startsWith("#");
};

/** A line's text with a trailing comment taken off, outside quotes and flow brackets alike. */
function uncommented(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

class BlockReader {
  at = 0;
  constructor(private readonly lines: Line[]) {}

  private skip() {
    while (this.at < this.lines.length && blank(this.lines[this.at])) {
      this.at++;
    }
  }

  /** The block that starts at the next line, indented at least `min`. */
  block(min: number): unknown {
    this.skip();
    const first = this.lines[this.at];
    if (!first || first.indent < min) {
      return null;
    }
    const text = first.raw.trim();
    return text === "-" || text.startsWith("- ") ? this.list(first.indent) : this.map(first.indent);
  }

  private list(indent: number): unknown[] {
    const out: unknown[] = [];
    for (this.skip(); this.at < this.lines.length; this.skip()) {
      const line = this.lines[this.at];
      const text = line.raw.trim();
      if (line.indent !== indent || !(text === "-" || text.startsWith("- "))) {
        break;
      }
      const rest = uncommented(text.slice(1)).trim();
      if (!rest) {
        this.at++;
        out.push(this.block(indent + 1));
      } else if (/^[^"'{[][^:]*:(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
        // An entry that is a mapping: its first key on the dash's line, the rest below it.
        this.lines[this.at] = { raw: `${" ".repeat(indent + 2)}${rest}`, indent: indent + 2 };
        out.push(this.map(indent + 2));
      } else {
        this.at++;
        out.push(this.inline(rest, indent));
      }
    }
    return out;
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (this.skip(); this.at < this.lines.length; this.skip()) {
      const line = this.lines[this.at];
      if (line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        throw new Error(`line ${this.at + 1} is indented more than the key before it`);
      }
      const text = uncommented(line.raw.trim());
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{}[\],][^:]*?)\s*:(?:\s+(.*))?$/.exec(
        text,
      );
      if (!m) {
        throw new Error(`line ${this.at + 1} is no "key: value"`);
      }
      const key = String(scalar(m[1]));
      if (key in out) {
        throw new Error(`"${key}" is there twice`);
      }
      const rest = (m[2] ?? "").trim();
      this.at++;
      if (!rest) {
        // The value is the block below: indented further, or a list at the key's own indent.
        this.skip();
        const next = this.lines[this.at];
        const nextText = next?.raw.trim() ?? "";
        const listHere = next && next.indent === indent && /^-(\s|$)/.test(nextText);
        out[key] = listHere ? this.list(indent) : this.block(indent + 1);
      } else if (/^[|>][+-]?$/.test(rest)) {
        out[key] = this.blockScalar(rest, indent);
      } else {
        out[key] = this.inline(rest, indent);
      }
    }
    return out;
  }

  /** A value on its line; a flow mapping or list goes on over the lines below until it closes. */
  private inline(rest: string, indent: number): unknown {
    let text = rest;
    if (/^[{[]/.test(text)) {
      while (!flowClosed(text) && this.at < this.lines.length) {
        text += ` ${uncommented(this.lines[this.at].raw.trim())}`;
        this.at++;
      }
      return parseFlow(text);
    }
    const parts = [text];
    // A plain value goes on over lines indented further.
    while (this.at < this.lines.length && !blank(this.lines[this.at])) {
      const next = this.lines[this.at];
      if (next.indent <= indent || /^["']/.test(text)) {
        break;
      }
      parts.push(uncommented(next.raw.trim()));
      this.at++;
    }
    return scalar(parts.join(" "));
  }

  private blockScalar(style: string, indent: number): string {
    const taken: string[] = [];
    while (this.at < this.lines.length) {
      const line = this.lines[this.at];
      if (line.raw.trim() && line.indent <= indent) {
        break;
      }
      taken.push(line.raw);
      this.at++;
    }
    while (taken.length && !taken[taken.length - 1].trim()) {
      taken.pop();
    }
    const cut = Math.min(
      ...taken.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
    );
    const plain = taken.map((l) => l.slice(Number.isFinite(cut) ? cut : 0));
    const text = style.startsWith("|")
      ? plain.join("\n")
      : plain
          .join("\n")
          .replace(/([^\n])\n(?!\n)/g, "$1 ")
          .replace(/\n\n/g, "\n");
    return style.includes("-") ? text : `${text}\n`;
  }
}

/** Whether a flow value's brackets are all closed, quotes taken into account. */
function flowClosed(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
    }
  }
  return depth <= 0;
}

/** A plain or quoted value: text, a number, true, false or null. */
function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) {
      throw new Error(`${v} is not closed`);
    }
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) {
      throw new Error(`${v} is not closed`);
    }
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v === "" || v === "~" || v === "null") {
    return null;
  }
  if (v === "true" || v === "false") {
    return v === "true";
  }
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
    return Number(v);
  }
  return v;
}

/** A flow value: `{ key: value, … }`, `[a, b]`, JSON as well. */
function parseFlow(text: string): unknown {
  let i = 0;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
  };
  const fail = (what: string): never => {
    throw new Error(`${what} at "${text.slice(i, i + 20)}"`);
  };
  const quoted = (): string => {
    const q = text[i];
    const start = i++;
    for (;;) {
      if (i >= text.length) {
        fail("a quote that is not closed");
      }
      if (q === '"' && text[i] === "\\") {
        i += 2;
      } else if (text[i] === q && q === "'" && text[i + 1] === "'") {
        i += 2;
      } else if (text[i] === q) {
        i++;
        return String(scalar(text.slice(start, i)));
      } else {
        i++;
      }
    }
  };
  const plain = (stops: RegExp): string => {
    const start = i;
    while (i < text.length && !stops.test(text[i])) {
      i++;
    }
    return text.slice(start, i).trim();
  };
  const value = (): unknown => {
    space();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        space();
        if (text[i] === "}") {
          i++;
          return out;
        }
        const key = text[i] === '"' || text[i] === "'" ? quoted() : plain(/[,{}[\]]|:/);
        if (!key) {
          fail("a key is missing");
        }
        space();
        if (text[i] !== ":") {
          fail(`"${key}" has no ":"`);
        }
        i++;
        out[key] = value();
        space();
        if (text[i] === ",") {
          i++;
        } else if (text[i] !== "}") {
          fail('a "," or "}" is missing');
        }
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      for (;;) {
        space();
        if (text[i] === "]") {
          i++;
          return out;
        }
        out.push(value());
        space();
        if (text[i] === ",") {
          i++;
        } else if (text[i] !== "]") {
          fail('a "," or "]" is missing');
        }
      }
    }
    if (c === '"' || c === "'") {
      return quoted();
    }
    const raw = plain(/[,{}[\]]/);
    if (!raw) {
      fail("a value is missing");
    }
    return scalar(raw);
  };
  const out = value();
  space();
  if (i < text.length) {
    fail("more after the value");
  }
  return out;
}
