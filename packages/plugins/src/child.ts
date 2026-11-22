import { registerHooks } from "node:module";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * The process a plugin's server half runs in (process.ts starts it). Node's permission model
 * holds it to its own folder and its data folder; it reaches the host only through these
 * messages. Erasable TypeScript only, no imports of this package's other files: Node runs this
 * file as it is.
 */

interface Start {
  type: "start";
  entry: string;
  root: string;
  manifest: { id: string; name: string; version: string; [field: string]: unknown };
  config: Record<string, string>;
}
interface CallMessage {
  type: "call";
  id: number;
  name: string;
  input: unknown;
}
type Incoming = Start | CallMessage | { type: "abort"; id: number } | { type: "stop" };

interface Tool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  readOnly?: boolean;
  execute(input: unknown, context: { signal: AbortSignal; emit(message: string): void }): unknown;
}

interface Zod {
  toJSONSchema(schema: unknown, options: Record<string, unknown>): Record<string, unknown>;
  prettifyError(error: unknown): string;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
// Built, the package's index. From source (this repository's tests), plugin.ts: the index there
// imports `.js` files that only the build makes, and plugin.ts imports types alone.
const index = new URL(
  import.meta.url.endsWith(".ts") ? "./plugin.ts" : "./index.js",
  import.meta.url,
).href;

// A plugin imports the contract and zod by name, wherever its files lie: they are this package's.
const aliases: Record<string, string> = {
  "@engenty/plugins": index,
  "@engenty/wizards/plugin": index,
  zod: import.meta.resolve("zod"),
};
registerHooks({
  resolve(specifier, context, next) {
    const url = aliases[specifier];
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
});

const send = (message: unknown) => process.send?.(message);
const tools = new Map<string, Tool>();
const unloads: (() => void | Promise<void>)[] = [];
const running = new Map<number, AbortController>();
let z: Zod;

const isZod = (schema: unknown): schema is { safeParse(value: unknown): unknown } =>
  typeof schema === "object" &&
  schema !== null &&
  "_zod" in schema &&
  typeof (schema as { safeParse?: unknown }).safeParse === "function";

function jsonSchemaOf(tool: Tool): Record<string, unknown> {
  if (isZod(tool.inputSchema)) {
    const { $schema: _, ...schema } = z.toJSONSchema(tool.inputSchema, {
      io: "input",
      unrepresentable: "any",
    });
    return schema;
  }
  const schema = tool.inputSchema as Record<string, unknown> | null;
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    throw new Error(
      `Tool "${tool.name}": inputSchema is neither a zod schema nor an object's JSON Schema.`,
    );
  }
  return schema;
}

const text = (args: unknown[]) =>
  args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");

async function start(message: Start): Promise<void> {
  z = (await import("zod")) as unknown as Zod;
  const root = message.root;
  const api = {
    plugin: message.manifest,
    config: { get: (key: string) => message.config[key] },
    log: {
      info: (...args: unknown[]) => send({ type: "log", level: "info", text: text(args) }),
      warn: (...args: unknown[]) => send({ type: "log", level: "warn", text: text(args) }),
      error: (...args: unknown[]) => send({ type: "log", level: "error", text: text(args) }),
    },
    resolvePath: (relative: string) => {
      const path = resolve(root, relative);
      if (path !== root && !path.startsWith(root + sep)) {
        throw new Error(`${relative} is not inside the plugin's folder.`);
      }
      return path;
    },
    server: {
      registerTool: (tool: Tool) => {
        if (!TOOL_NAME.test(tool?.name ?? "")) {
          throw new Error(`"${tool?.name}" is no tool name: lower case, digits and "_".`);
        }
        if (tools.has(tool.name)) {
          throw new Error(`The tool "${tool.name}" is registered twice.`);
        }
        if (typeof tool.execute !== "function" || !tool.description) {
          throw new Error(`The tool "${tool.name}" needs a description and execute().`);
        }
        tools.set(tool.name, tool);
      },
      onUnload: (dispose: () => void | Promise<void>) => {
        unloads.push(dispose);
      },
    },
  };
  try {
    const module = (await import(pathToFileURL(message.entry).href)) as { default?: unknown };
    if (typeof module.default !== "function") {
      throw new Error("The default export is not a function.");
    }
    await module.default(api);
    send({
      type: "ready",
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: jsonSchemaOf(tool),
        readOnly: tool.readOnly === true,
      })),
    });
  } catch (err) {
    send({ type: "failed", message: (err as Error)?.message ?? String(err) });
  }
}

/** What a tool returned, as it crosses to the host: JSON, `null` for nothing. */
function plain(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.parse(JSON.stringify(value));
}

async function call(message: CallMessage): Promise<void> {
  const tool = tools.get(message.name);
  if (!tool) {
    send({ type: "result", id: message.id, ok: false, error: `There is no tool ${message.name}.` });
    return;
  }
  const controller = new AbortController();
  running.set(message.id, controller);
  try {
    let input = message.input;
    if (isZod(tool.inputSchema)) {
      const parsed = tool.inputSchema.safeParse(input) as
        | { success: true; data: unknown }
        | { success: false; error: unknown };
      if (!parsed.success) {
        throw new Error(`Invalid input: ${z.prettifyError(parsed.error)}`);
      }
      input = parsed.data;
    }
    const value = await tool.execute(input, {
      signal: controller.signal,
      emit: (line: string) => send({ type: "emit", id: message.id, message: String(line) }),
    });
    send({ type: "result", id: message.id, ok: true, value: plain(value) });
  } catch (err) {
    send({
      type: "result",
      id: message.id,
      ok: false,
      error: (err as Error)?.message ?? String(err),
    });
  } finally {
    running.delete(message.id);
  }
}

async function stop(): Promise<void> {
  for (const controller of running.values()) {
    controller.abort();
  }
  for (const dispose of unloads) {
    try {
      await dispose();
    } catch {}
  }
  process.exit(0);
}

process.on("message", (message: Incoming) => {
  if (message.type === "start") {
    void start(message);
  } else if (message.type === "call") {
    void call(message);
  } else if (message.type === "abort") {
    running.get(message.id)?.abort();
  } else if (message.type === "stop") {
    void stop();
  }
});
// The host went away: so does the plugin.
process.on("disconnect", () => process.exit(0));
