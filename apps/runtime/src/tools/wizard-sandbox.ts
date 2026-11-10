import type { AssetRef } from "@engenty/wizards-shared/run";
import { mimeForPath } from "@engenty/wizards-shared/workspace";
import { createTool } from "@mastra/core/tools";
import type { z } from "zod";
import { summarizeInput, writeLog } from "../broker/log.js";
import { SANDBOX_TOOL_LIMITS, type SandboxTool, schemaZod } from "../engine/wizard-code.js";
import { prompt } from "../prompts.js";
import type { InProcessContext } from "../run-services/in-process.js";
import type { Sandbox } from "../sandbox/index.js";
import { snapshotFile } from "../services/files.js";
import { parseResultRef } from "../sharing/files.js";
import { clip } from "./shared.js";
import { resolveFile, type UploadRef } from "./store.js";
import { whoWhere } from "./wizard.js";

/**
 * A wizard's sandbox tools (docs/plans/wizard-code.md): `tools/<name>/TOOL.md` in its workspace,
 * its scripts beside it, named `wizard.<name>` in a step's `tools`. The front matter gives
 * `description`, `input` and `output` (JSON Schema), `run` (a command) and `hosts`.
 *
 * The code is untrusted: it runs in the run's sandbox, never in the runtime's process. The first
 * call copies the folder to `tools/<name>/` there; each call writes `input.json`, runs `run` in
 * that folder and reads `output.json`. Files it writes to `out/` become the step's assets; a file
 * the person gave, named in the input as `upload:<id>`, is copied to `in/` first. The sandbox
 * lasts the run, so what a call installs stays for the next. It reaches the hosts of the run's
 * grant, which holds the tool's: the step lists them in its `hosts` (checked when the step starts).
 */

const LIMITS = SANDBOX_TOOL_LIMITS;

/** Where a sandbox tool's folder goes, from the sandbox's working directory. */
export const sandboxToolFolder = (name: string) => `tools/${name}`;

/** A sandbox's tool folders written so far, each once per run and version of its files. */
const placed = new WeakMap<Sandbox, Map<string, Promise<void>>>();
/** The call of each tool in each sandbox that runs now: calls of one tool wait their turn. */
const turns = new WeakMap<Sandbox, Map<string, Promise<unknown>>>();

/** Copies the tool's folder from the workspace into the sandbox, unless it is there as it is. */
function placeTool(sandbox: Sandbox, tool: SandboxTool, ctx: InProcessContext): Promise<void> {
  let done = placed.get(sandbox);
  if (!done) {
    done = new Map();
    placed.set(sandbox, done);
  }
  const files = ctx.files.filter((f) => tool.files.includes(f.path));
  const key = `${tool.name}@${files.map((f) => `${f.path}:${f.hash}`).join(",")}`;
  let write = done.get(key);
  if (!write) {
    const map = done;
    write = (async () => {
      const folder = sandboxToolFolder(tool.name);
      await sandbox.exec(`rm -rf ${folder} && mkdir -p ${folder}`);
      // Each write is a request or two: eight go at once.
      for (let i = 0; i < files.length; i += 8) {
        await Promise.all(
          files.slice(i, i + 8).map(async (f) => {
            const found = await snapshotFile(ctx.files, f.path);
            if (found) {
              await sandbox.writeFile(f.path, new Uint8Array(found.data));
            }
          }),
        );
      }
    })();
    map.set(key, write);
    write.catch(() => map.delete(key));
  }
  return write;
}

/** Runs `call` after the calls of the same tool in the same sandbox that came before it. */
function inTurn<T>(sandbox: Sandbox, name: string, call: () => Promise<T>): Promise<T> {
  let byTool = turns.get(sandbox);
  if (!byTool) {
    byTool = new Map();
    turns.set(sandbox, byTool);
  }
  const before = byTool.get(name) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(call);
  byTool.set(name, mine);
  return mine;
}

/** A file's name as it may stand in the sandbox: letters, digits, `.`, `_` and `-`. */
const safeName = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "file";

/** Whether a value of the input names a file the run has: `upload:<id>` or `result:<step>.<format>`. */
const namesFile = (value: string) => value.startsWith("upload:") || Boolean(parseResultRef(value));

/**
 * The input with each file it names copied into `in/` of the tool's folder, the name replaced by
 * the file's path from there (`in/<name>`).
 */
async function withFilesIn(
  value: unknown,
  copy: (ref: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === "string") {
    return namesFile(value) ? copy(value) : value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => withFilesIn(v, copy)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = await withFilesIn(v, copy);
    }
    return out;
  }
  return value;
}

/** The tail of a command's output, for the model to see what went wrong. */
const tail = (text: string) =>
  text.length > LIMITS.logChars ? text.slice(-LIMITS.logChars) : text;

/**
 * The sandbox tool `id` as the step's model calls it. `sandbox` is the run's, made on the first
 * call; `assets` collects the step's files.
 */
export function sandboxTool(
  id: string,
  callName: string,
  tool: SandboxTool,
  ctx: InProcessContext,
  sandbox: () => Sandbox,
  { assets, uploads }: { assets: AssetRef[]; uploads: UploadRef[] },
) {
  const output = tool.output ? schemaZod(tool.output) : null;
  const folder = sandboxToolFolder(tool.name);
  const description = uploads.length
    ? `${tool.description} ${prompt("tools", "note.sandbox_tool_files", {
        uploads: uploads.map((u) => `${u.ref} (${u.name})`).join(", "),
      })}`
    : tool.description;
  return createTool({
    id: callName,
    description,
    inputSchema: schemaZod(tool.input) as z.ZodType<Record<string, unknown>>,
    execute: async (input) => {
      const started = Date.now();
      await ctx.emit("tool", { code: "runsTool", params: { name: id } });
      const finish = (result: string, answer?: unknown) =>
        writeLog({
          at: new Date(started),
          durationMs: Date.now() - started,
          ...whoWhere(ctx),
          connectionId: `tool:${id}`,
          actionId: id,
          kind: "run",
          inputSummary: summarizeInput(input),
          outcome: "allow",
          rule: null,
          reason: "The step lists the wizard's tool.",
          result,
          resultSize: answer === undefined ? null : (JSON.stringify(answer ?? null)?.length ?? 0),
        });
      if (JSON.stringify(input ?? null).length > LIMITS.inputChars) {
        await finish("too_long");
        return { error: `The arguments are longer than ${LIMITS.inputChars} characters.` };
      }
      const box = sandbox();
      return inTurn(box, tool.name, async () => {
        try {
          await placeTool(box, tool, ctx);
          await box.exec(`cd ${folder} && rm -rf in out input.json output.json && mkdir in out`);
          const given = new Map<string, string>();
          const args = await withFilesIn(input, async (ref) => {
            const known = given.get(ref);
            if (known) {
              return known;
            }
            const file = await resolveFile(ctx, ref);
            let path = `in/${safeName(file.name)}`;
            for (let n = 2; [...given.values()].includes(path); n++) {
              path = `in/${n}-${safeName(file.name)}`;
            }
            await box.writeFile(`${folder}/${path}`, file.data);
            given.set(ref, path);
            return path;
          });
          await box.writeFile(`${folder}/input.json`, JSON.stringify(args ?? {}));
          const ran = await box.exec(`cd ${folder} && ${tool.run}`, {
            timeoutMs: LIMITS.timeoutMs,
          });
          if (ran.exitCode !== 0) {
            await finish("failed");
            return {
              error: prompt("tools", "note.sandbox_tool_failed", {
                tool: id,
                code: ran.exitCode,
              }),
              ...(ran.stderr ? { stderr: tail(ran.stderr) } : {}),
              ...(ran.stdout ? { stdout: tail(ran.stdout) } : {}),
            };
          }
          const result = await readOutput(box, folder);
          if ("error" in result) {
            await finish("output_unfit");
            return {
              error:
                result.error === "size"
                  ? prompt("tools", "note.sandbox_tool_output_size", { tool: id })
                  : prompt("tools", "note.sandbox_tool_output_json", { tool: id }),
            };
          }
          if (output) {
            const checked = output.safeParse(result.value ?? null);
            if (!checked.success) {
              const issue = checked.error.issues[0];
              await finish("output_unfit", result.value);
              return {
                error: prompt("tools", "note.wizard_tool_output", {
                  tool: id,
                  where: issue?.path.join(".") || "the result",
                  problem: issue?.message ?? "",
                }),
              };
            }
          }
          const files = await keepOut(box, folder, ctx, assets);
          const answer =
            files.length === 0
              ? (result.value ?? null)
              : result.value === undefined
                ? { files }
                : { output: result.value, files };
          await finish("ok", answer);
          const text = JSON.stringify(answer) ?? "null";
          return text.length > LIMITS.resultChars
            ? { result: clip(text, LIMITS.resultChars) }
            : answer;
        } catch (err) {
          await finish((err as Error)?.constructor?.name || "Error");
          return { error: String((err as Error)?.message ?? err).slice(0, 500) };
        }
      });
    },
  });
}

/** `output.json` as JSON: undefined when the tool wrote none, an error when it is no JSON. */
async function readOutput(
  box: Sandbox,
  folder: string,
): Promise<{ value: unknown } | { error: "size" | "json" }> {
  const there = await box.exec(`cd ${folder} && test -f output.json && wc -c < output.json`);
  if (there.exitCode !== 0) {
    return { value: undefined };
  }
  if (Number(there.stdout.trim()) > LIMITS.outputBytes) {
    return { error: "size" };
  }
  const text = Buffer.from(await box.readFile(`${folder}/output.json`)).toString("utf8");
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "json" };
  }
}

/** The files the call wrote to `out/`, saved as the step's assets. */
async function keepOut(
  box: Sandbox,
  folder: string,
  ctx: InProcessContext,
  assets: AssetRef[],
): Promise<{ name: string; assetId: string }[]> {
  const found = await box.exec(
    `cd ${folder}/out && find . -type f | sort | head -n ${LIMITS.outFiles}`,
  );
  const paths = found.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  const kept: { name: string; assetId: string }[] = [];
  for (const path of paths) {
    const quoted = `'${path.replace(/'/g, "'\\''")}'`;
    const size = await box.exec(`cd ${folder}/out && wc -c < ${quoted}`);
    if (!(Number(size.stdout.trim()) <= LIMITS.outFileBytes)) {
      continue;
    }
    const data = await box.readFile(`${folder}/out/${path}`);
    const mime = mimeForPath(path);
    const ref = await ctx.saveAsset({
      kind: mime.startsWith("image/") ? "image" : "file",
      mime,
      name: path.split("/").pop() ?? path,
      data: Buffer.from(data),
    });
    assets.push(ref);
    kept.push({ name: path, assetId: ref.id });
  }
  return kept;
}
