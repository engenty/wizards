import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InstalledModel, ServerOptions } from "../servers/server.js";

/**
 * MLX's models on this computer: a folder per model, as Hugging Face names it
 * (`mlx-community/Qwen3-4B-4bit`), shared by every app of engenty. Only weights as safetensors and
 * the files beside them are taken, never code.
 */

const HUB = "https://huggingface.co";

/** Where the models are for this process: MLX_MODELS, else a folder of engenty's. */
export function mlxFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.MLX_MODELS?.trim() || join(homedir(), ".engenty", "models", "mlx");
}

/** A model as Hugging Face names it: `organization/name`. */
const NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

export function modelFolder(root: string, model: string): string {
  if (!NAME.test(model)) {
    throw new Error("A model of MLX is named as on Hugging Face: organization/name.");
  }
  return join(root, ...model.split("/"));
}

/** Written last: the model is whole. */
const DONE = ".engenty.json";

const FILE = /\.(safetensors|json|jinja|txt|model)$/;

interface HubFile {
  rfilename: string;
  size?: number;
  lfs?: { sha256?: string };
}

/** The models in the folder, each with what it can do. */
export async function mlxModels(root: string, loaded?: string): Promise<InstalledModel[]> {
  const models: InstalledModel[] = [];
  for (const org of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, org)).catch(() => [])) {
      const dir = join(root, org, name);
      const done = await readFile(join(dir, DONE), "utf8").catch(() => null);
      if (!done) {
        continue;
      }
      const { size, sha } = JSON.parse(done) as { size: number; sha: string };
      const { tools, vision, thinking, quantization } = await traits(dir);
      models.push({
        name: `${org}/${name}`,
        size,
        digest: sha,
        capabilities: [
          "completion",
          ...(tools ? ["tools"] : []),
          ...(vision ? ["vision"] : []),
          ...(thinking ? ["thinking"] : []),
        ],
        completion: true,
        tools,
        vision,
        thinking,
        runner: "mlx",
        quantization,
        running: loaded === dir,
      });
    }
  }
  return models;
}

/** What a model can do, as its own files say: the chat template and the configuration. */
async function traits(dir: string) {
  const json = async (file: string) =>
    JSON.parse(await readFile(join(dir, file), "utf8").catch(() => "{}")) as Record<
      string,
      unknown
    >;
  const [config, tokenizer] = await Promise.all([
    json("config.json"),
    json("tokenizer_config.json"),
  ]);
  const template =
    (await readFile(join(dir, "chat_template.jinja"), "utf8").catch(() => null)) ??
    JSON.stringify(
      tokenizer.chat_template ?? (await json("chat_template.json")).chat_template ?? "",
    );
  const bits = (config.quantization as { bits?: number } | undefined)?.bits;
  return {
    tools: /\btools\b/.test(template),
    vision: "vision_config" in config && existsSync(join(dir, "preprocessor_config.json")),
    thinking: /enable_thinking/.test(template),
    quantization: bits ? `${bits}bit` : null,
  };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Downloads a model from Hugging Face. A download that broke off goes on where it stopped; each
 * weights file is checked against the hash Hugging Face names.
 */
export async function downloadModel(
  root: string,
  model: string,
  onProgress: (done: number, total: number) => void,
  {
    fetch: doFetch = fetch,
    signal,
    hub = HUB,
  }: ServerOptions & { signal?: AbortSignal; hub?: string } = {},
): Promise<void> {
  const dir = modelFolder(root, model);
  const res = await doFetch(`${hub}/api/models/${model}?blobs=true`, { signal });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 404
        ? `Hugging Face has no open model ${model}.`
        : `Hugging Face answered ${res.status}.`,
    );
  }
  const info = (await res.json()) as { sha?: string; siblings?: HubFile[] };
  const files = (info.siblings ?? []).filter(
    (f) => FILE.test(f.rfilename) && !f.rfilename.includes(".."),
  );
  if (!files.some((f) => f.rfilename.endsWith(".safetensors"))) {
    throw new Error(`${model} has no weights MLX can read.`);
  }
  const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  let before = 0;
  let told = 0;
  for (const file of files) {
    const target = join(dir, ...file.rfilename.split("/"));
    const part = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    const there = await stat(target).catch(() => null);
    if (!(there && there.size === file.size)) {
      const have = (await stat(part).catch(() => null))?.size ?? 0;
      let at = have;
      if (file.size === undefined || have < file.size) {
        const got = await doFetch(
          `${hub}/${model}/resolve/${info.sha ?? "main"}/${file.rfilename}`,
          { signal, ...(have ? { headers: { range: `bytes=${have}-` } } : {}) },
        );
        if (!(got.ok && got.body)) {
          throw new Error(`Hugging Face answered ${got.status}.`);
        }
        const goesOn = have > 0 && got.status === 206;
        at = goesOn ? have : 0;
        const body = Readable.fromWeb(got.body as Parameters<typeof Readable.fromWeb>[0]);
        body.on("data", (bytes: Buffer) => {
          at += bytes.length;
          if (Date.now() - told > 250) {
            told = Date.now();
            onProgress(before + at, total);
          }
        });
        await pipeline(body, createWriteStream(part, { flags: goesOn ? "a" : "w" }), { signal });
      }
      const size = (await stat(part)).size;
      const hash = file.lfs?.sha256;
      if (
        (file.size !== undefined && size !== file.size) ||
        (hash && (await sha256(part)) !== hash)
      ) {
        await rm(part, { force: true });
        throw new Error(`${file.rfilename} arrived damaged. Try again.`);
      }
      await rename(part, target);
    }
    before += file.size ?? 0;
    onProgress(before, total);
  }
  await writeFile(join(dir, DONE), JSON.stringify({ sha: info.sha ?? "", size: total }));
}

/** Removes a model and what its folder held. */
export async function removeModel(root: string, model: string): Promise<void> {
  const dir = modelFolder(root, model);
  if (!existsSync(dir)) {
    throw new Error(`There is no model ${model}.`);
  }
  await rm(dir, { recursive: true });
  // The organization's folder goes with its last model.
  await rmdir(dirname(dir)).catch(() => undefined);
}
