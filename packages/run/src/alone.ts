/**
 * A run without an organization (docs/plans/runs-on-their-own.md, 5.5): no engenty wizards to
 * start it at, so no token, no tenant and no record but the run's folder. `wizards run` still
 * runs a wizard here when everything it needs is a model reached by fetch:
 *
 * - models: Ollama (`OLLAMA_URL`, its OpenAI-compatible API) first, else an own API key for an
 *   OpenAI-compatible API (`OPENAI_API_KEY`, `OPENAI_BASE_URL`). One model answers every class;
 *   a decision is one structured answer of it, `embed` answers null;
 * - files: in the run's folder (`files/`), the workspace the run started with in `workspace/`;
 * - the wizard's data and lists, tools, plugins, connections, whole steps of a service: not here.
 *   `aloneMissing` refuses a wizard that needs any of them before it starts (`hostFit` with
 *   `services: false`), so a call that still comes is refused plainly;
 * - notices to people: lines in the terminal.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prompt } from "@engenty/wizards-engine/prompts";
import type { AgentModel, StepServices, StepToolSet } from "@engenty/wizards-engine/types";
import { decisionSchema, readObject } from "@engenty/wizards-shared/decision";
import {
  type ModelClass,
  TEXT_CLASSES,
  type WizardDefinition,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { type HostOffers, hostFit, type ModelWay, needs } from "@engenty/wizards-shared/fit";
import { requiresOf } from "@engenty/wizards-shared/requires";
import type { AssetRef } from "@engenty/wizards-shared/run";
import {
  isServiceStep,
  ServiceError,
  type TurnMessage,
  type TurnPart,
  type TurnRequest,
} from "@engenty/wizards-shared/run-services";
import { z } from "zod";

// --- the model ---------------------------------------------------------------------------------

/** How a run without an organization reaches its model. */
export type AloneWay = Extract<ModelWay, "ollama" | "key">;

/** The model every step of the run calls, over an OpenAI-compatible API. */
export interface AloneModel {
  way: AloneWay;
  /** The API's base, with its `/v1`: `http://127.0.0.1:11434/v1`. */
  url: string;
  /** The model's name there. */
  name: string;
  /** The API key; none for Ollama. Never written to the run's folder. */
  key?: string;
}

/** Where Ollama answers when `OLLAMA_URL` names nothing. */
export const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

const OPENAI_DEFAULT = "https://api.openai.com/v1";

/** How long Ollama has to say which models it has. */
const OLLAMA_LOOK_MS = 3000;

/** The OpenAI-compatible base of an Ollama address, given with or without its `/v1`. */
export function ollamaBase(url: string | undefined): string {
  const root = (url?.trim() || OLLAMA_DEFAULT).replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1`;
}

/** What a model's name says it is for: one that only embeds answers no step. */
const EMBEDS = /embed/i;

/**
 * The model a run without an organization calls: Ollama's when it answers, else the one an own
 * API key reaches. A string says why there is none.
 */
export async function findModel(options: {
  env: Record<string, string | undefined>;
  /** `--model`: the model's name; left out, Ollama's first model. */
  model?: string | null;
  fetch?: typeof fetch;
}): Promise<AloneModel | string> {
  const fetchOf = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = ollamaBase(options.env.OLLAMA_URL);
  const listed = await fetchOf(`${base}/models`, { signal: AbortSignal.timeout(OLLAMA_LOOK_MS) })
    .then(async (res) => (res.ok ? ((await res.json()) as { data?: { id?: unknown }[] }) : null))
    .catch(() => null);
  if (listed) {
    const names = (listed.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
    if (options.model) {
      // Ollama answers a name without a tag as its `latest`.
      return names.includes(options.model) || names.includes(`${options.model}:latest`)
        ? { way: "ollama", url: base, name: options.model }
        : `Ollama has no model “${options.model}”. To get it: ollama pull ${options.model}`;
    }
    const name = names.find((n) => !EMBEDS.test(n));
    return name
      ? { way: "ollama", url: base, name }
      : "Ollama has no model to run the wizard with. Get one with ollama pull, then run it again.";
  }
  const key = options.env.OPENAI_API_KEY?.trim();
  if (key) {
    if (!options.model) {
      return "Name the model your API key reaches with --model.";
    }
    const url = (options.env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT).replace(/\/+$/, "");
    return { way: "key", url, name: options.model, key };
  }
  return "Nothing on this computer runs a model. Start Ollama, or set OPENAI_API_KEY to your own API key.";
}

/** How the terminal names the model: “llama3.2 on Ollama”. */
export function modelWords(model: AloneModel): string {
  return model.way === "ollama" ? `${model.name} on Ollama` : `${model.name} with your API key`;
}

// --- what a run without an organization can run ------------------------------------------------

/** What a host without an organization offers: models by fetch, and none of the run's services. */
export const ALONE_OFFERS: HostOffers = { ways: ["ollama", "key"], services: false };

/** The classes no text model answers, in words. */
const MEDIA_WORDS: Partial<Record<ModelClass, string>> = {
  image: "It makes images, and nothing here makes them.",
  video: "It makes videos, and nothing here makes them.",
  audio: "It listens to recordings, and nothing here listens to them.",
  speech: "It speaks, and nothing here makes speech.",
};

const LACK_WORDS: Record<string, (names: string) => string> = {
  tools: (names) => `Its steps use the tools ${names}. Only engenty wizards runs tools.`,
  sandbox: () => "A step works in a sandbox. Only engenty wizards has one.",
  plugins: (names) => `Its steps use the plugins ${names}. Only engenty wizards has plugins.`,
  connections: () => "It connects to accounts. Only engenty wizards keeps connections.",
  data: () => "It keeps data of its own. Only engenty wizards keeps it.",
  makers: (names) => `A step asks for a model by ${names}. Here one model answers every step.`,
};

/** What a step needs that no run without an organization has, in words. */
const NEED_WORDS: Record<string, string> = {
  lists: "It keeps lists. Only engenty wizards keeps them.",
  memory: "It remembers earlier runs. Only engenty wizards keeps that memory.",
  connections: LACK_WORDS.connections(""),
  "field:connection": "A page connects an account. Only engenty wizards connects accounts.",
  "field:slot": "A page offers times from a calendar. Only engenty wizards reads calendars.",
  "field:audio": "A page takes a voice note, and nothing here listens to it.",
  "field:file-read":
    "A page takes a file that a later step reads. Only engenty wizards reads files.",
};

/**
 * Why the wizard can't run without an organization, one sentence each; empty: it can. Decided
 * before the start, so nothing runs that would stop halfway. `paths`: the workspace's files.
 */
export function aloneMissing(def: WizardDefinition, paths: readonly string[] = []): string[] {
  const requires = requiresOf(def, undefined, paths);
  // Every text class goes to the one model; the ways are the same as far as the fit goes.
  const ways = Object.fromEntries(TEXT_CLASSES.map((cls) => [cls, "ollama"]));
  const fit = hostFit(requires, ALONE_OFFERS, ways);
  const out = new Set<string>();
  if (!fit.fits) {
    for (const gap of fit.missing) {
      out.add(MEDIA_WORDS[gap.cls] ?? `It needs a ${gap.cls} model, and nothing here has one.`);
    }
    for (const lack of fit.lacks ?? []) {
      out.add(LACK_WORDS[lack.need](lack.names.join(", ")));
    }
  }
  if (def.connections?.length) {
    out.add(NEED_WORDS.connections);
  }
  for (const step of def.steps) {
    if (isServiceStep(step)) {
      out.add(`“${step.title}” is made by engenty wizards. It can’t run on this computer alone.`);
    }
    for (const need of needs(step, def)) {
      const words = NEED_WORDS[need.need];
      if (words && need.hard) {
        out.add(words);
      }
    }
  }
  if (def.lists?.length) {
    out.add(NEED_WORDS.lists);
  }
  return [...out];
}

// --- the services ------------------------------------------------------------------------------

export interface AloneOptions {
  model: AloneModel;
  /** The run's folder: its files go in `files/`, the workspace it started with is `workspace/`. */
  dir: string;
  def: WizardDefinition;
  /** A line for the person at the terminal: what a notice says. */
  say(line: string): void;
  /** Left out: the global `fetch`. Reaches the model and the addresses a file is saved from. */
  fetch?: typeof fetch;
}

/** What a run without an organization has not: said where a call asks for it anyway. */
function notHere(what: string): ServiceError {
  return new ServiceError(
    { class: "final" },
    `${what} isn’t here: this run is on this computer only.`,
  );
}

/** A file's id in the run's folder. */
const FILE_ID = /^[a-z0-9]{16}$/;

/**
 * The run's services where there is no organization: the model by fetch, the files in the run's
 * folder, the person in the terminal. What only an organization has is refused.
 */
export function aloneServices(options: AloneOptions): StepServices {
  const { model, dir, def } = options;
  const fetchOf = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const filesDir = join(dir, "files");
  const workspaceDir = join(dir, "workspace");

  async function* turn(request: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnPart> {
    yield* chat(model, fetchOf, request, signal);
  }

  const agentModel = async (): Promise<AgentModel> => ({
    ownLoop: false,
    takesTools: true,
    seesImages: false,
    // The step's tools stay with the step: their calls come back as tool calls.
    attach: () => {},
    turn,
  });

  const noTools: StepToolSet = {
    list: () => [],
    call: async (request) => {
      throw notHere(`The tool ${request.name}`);
    },
    assets: [],
    sandbox: false,
  };

  async function readRef(ref: string): Promise<{ ref: AssetRef; data: Uint8Array } | null> {
    if (!FILE_ID.test(ref)) {
      return null;
    }
    try {
      const meta = JSON.parse(await readFile(join(filesDir, `${ref}.json`), "utf8")) as AssetRef;
      return { ref: meta, data: new Uint8Array(await readFile(join(filesDir, ref))) };
    } catch {
      return null;
    }
  }

  return {
    models: {
      turn,
      async decide(request, signal) {
        const deadline = request.deadlineMs ? AbortSignal.timeout(request.deadlineMs) : null;
        const within =
          signal && deadline
            ? AbortSignal.any([signal, deadline])
            : (signal ?? deadline ?? undefined);
        const state =
          typeof request.state === "string"
            ? request.state
            : JSON.stringify(request.state, null, 1);
        const { $schema: _, ...output } = z.toJSONSchema(decisionSchema(request.questions));
        let text = "";
        for await (const part of turn(
          {
            stepId: request.stepId,
            class: "classifier",
            messages: [{ role: "user", content: prompt("step", "decide.state", { state }) }],
            output,
          },
          within,
        )) {
          if (part.type === "text") {
            text += part.text;
          }
        }
        const answers = readObject(request.questions, jsonOf(text));
        if (!answers) {
          throw new ServiceError(
            { class: "final" },
            `${modelWords(model)} answered something that doesn’t fit the questions.`,
          );
        }
        return { answers, source: "llm" };
      },
      // Nothing here makes vectors: whoever asks goes on without them.
      embed: async () => null,
      agentModel,
    },
    tools: {
      list: async () => [],
      call: async (request) => {
        throw notHere(`The tool ${request.name}`);
      },
      async forStep(step) {
        if (step.tools.length || step.connections?.length) {
          throw notHere(`The tools of “${step.title}”`);
        }
        return noTools;
      },
      ofAgent: async (step) => {
        throw notHere(`The agent ${step.agent}`);
      },
    },
    context: {
      async forStep() {
        const lang = wizardLang(def);
        return {
          date: new Date().toLocaleDateString(lang, {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          lang,
          brand: {},
          files: [],
          knowledge: "",
          skills: "",
          plugins: { blocks: [], html: [] },
        };
      },
      // Voice notes are refused before the start: nothing to get ready.
      prepareInputs: async () => {},
    },
    files: {
      read: readRef,
      async save(file) {
        let data: Uint8Array;
        let mime: string;
        if ("url" in file) {
          const res = await fetchOf(file.url);
          if (!res.ok) {
            throw new ServiceError(
              { class: "final" },
              `${file.url} answered ${res.status} for the file “${file.name}”.`,
            );
          }
          data = new Uint8Array(await res.arrayBuffer());
          mime = file.mime ?? res.headers.get("content-type") ?? "application/octet-stream";
        } else {
          data = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
          mime = file.mime;
        }
        const ref: AssetRef = {
          id: randomBytes(8).toString("hex"),
          kind: file.kind,
          mime,
          name: file.name,
          ...(file.ai ? { ai: file.ai } : {}),
        };
        await mkdir(filesDir, { recursive: true, mode: 0o700 });
        await writeFile(join(filesDir, ref.id), data);
        await writeFile(join(filesDir, `${ref.id}.json`), JSON.stringify(ref));
        return ref;
      },
      async link(ref) {
        if (!(await readRef(ref))) {
          throw new ServiceError({ class: "final" }, `There’s no file ${ref} in this run.`);
        }
        return pathToFileURL(join(filesDir, ref)).href;
      },
      // A terminal gives no files: pages that take one a later step reads are refused before the start.
      uploads: async () => [],
      async workspace(path) {
        const at = resolve(workspaceDir, path);
        const inside = relative(workspaceDir, at);
        if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
          return null;
        }
        try {
          return new Uint8Array(await readFile(at));
        } catch {
          return null;
        }
      },
    },
    data: {
      query: async () => {
        throw notHere("The wizard’s data");
      },
      exec: async () => {
        throw notHere("The wizard’s data");
      },
      rows: async () => {
        throw notHere("The wizard’s lists");
      },
      counts: async () => ({}),
    },
    steps: {
      run: async (step) => {
        throw notHere(`What “${step.title}” makes`);
      },
    },
    people: {
      async tell(notice) {
        if (notice.detail) {
          options.say(notice.detail);
        }
      },
    },
  };
}

/** The workspace the run started with, written into its folder for the services to read. */
export async function keepWorkspace(
  dir: string,
  files: { path: string; data: Uint8Array }[],
): Promise<void> {
  const root = join(dir, "workspace");
  for (const file of files) {
    const at = resolve(root, file.path);
    const inside = relative(root, at);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      continue;
    }
    await mkdir(resolve(at, ".."), { recursive: true, mode: 0o700 });
    await writeFile(at, file.data);
  }
}

// --- the OpenAI-compatible API -----------------------------------------------------------------

/** JSON a model wrote, inside a Markdown fence or not; null where it is none. */
function jsonOf(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try {
    return JSON.parse((fenced ? fenced[1] : text).trim());
  } catch {
    return null;
  }
}

type ApiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** The conversation as the chat completions API takes it. Files don't go to a model here. */
function apiMessages(messages: TurnMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.role !== "tool") {
        out.push(
          m.role === "assistant"
            ? { role: "assistant", content: m.content }
            : { role: "user", content: m.content },
        );
      }
      continue;
    }
    if (m.content.some((p) => p.type === "file")) {
      throw notHere("A file for the model");
    }
    if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type === "tool-result") {
          out.push({
            role: "tool",
            tool_call_id: p.toolCallId,
            content: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null),
          });
        }
      }
      continue;
    }
    const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (m.role === "user") {
      out.push({ role: "user", content: text });
      continue;
    }
    const calls = m.content.flatMap((p) => (p.type === "tool-call" ? [p] : []));
    out.push({
      role: "assistant",
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.toolCallId,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
            })),
          }
        : {}),
    });
  }
  return out;
}

/** A streamed chunk of the chat completions API, as far as it is read here. */
interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** One model call over the chat completions API, streamed, as the run's `TurnPart`s. */
async function* chat(
  model: AloneModel,
  fetchOf: typeof fetch,
  request: TurnRequest,
  signal?: AbortSignal,
): AsyncIterable<TurnPart> {
  const body = {
    model: model.name,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...apiMessages(request.messages),
    ],
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
    ...(request.output
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", schema: request.output, strict: true },
          },
        }
      : {}),
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
  };
  const who = model.way === "ollama" ? "Ollama" : model.url;
  let res: Response;
  try {
    res = await fetchOf(`${model.url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(model.key ? { authorization: `Bearer ${model.key}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw new ServiceError(
      { class: "retry", retryAfterMs: null },
      `${who} didn’t answer: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    const said = await res.text().catch(() => "");
    let message = said.trim().slice(0, 300);
    try {
      const parsed = JSON.parse(said) as Chunk;
      message =
        typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? message);
    } catch {
      // Not JSON: its text as it is.
    }
    const after = Number(res.headers.get("retry-after"));
    throw new ServiceError(
      RETRY_STATUS.has(res.status)
        ? {
            class: "retry",
            retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : null,
          }
        : { class: "final" },
      `${who} answered ${res.status}${message ? `: ${message}` : ""}`,
    );
  }

  const calls = new Map<number, { id: string; name: string; args: string }>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let reason: string | null = null;
  let done = false;
  let rest = "";
  const decoder = new TextDecoder();
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ServiceError({ class: "retry", retryAfterMs: null }, `${who} sent nothing.`);
  }
  try {
    while (!done) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (err) {
        if (signal?.aborted) {
          throw signal.reason;
        }
        throw new ServiceError(
          { class: "retry", retryAfterMs: null },
          `${who} broke off: ${(err as Error).message}`,
        );
      }
      rest += decoder.decode(read.value, { stream: !read.done });
      const lines = rest.split("\n");
      rest = read.done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
          throw new ServiceError({ class: "final" }, `${who}: ${message ?? "an error"}`);
        }
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }
        const delta = choice.delta ?? {};
        if (delta.reasoning) {
          yield { type: "reasoning", text: delta.reasoning };
        }
        if (delta.content) {
          yield { type: "text", text: delta.content };
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? calls.size;
          const had = calls.get(index) ?? { id: "", name: "", args: "" };
          calls.set(index, {
            id: call.id ?? had.id,
            name: had.name + (call.function?.name ?? ""),
            args: had.args + (call.function?.arguments ?? ""),
          });
        }
        reason = choice.finish_reason ?? reason;
      }
      if (read.done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!(done || reason)) {
    throw new ServiceError({ class: "retry", retryAfterMs: null }, `${who} broke off the answer.`);
  }
  for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
    let input: unknown = {};
    try {
      input = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
      input = call.args;
    }
    yield {
      type: "tool-call",
      toolCallId: call.id || `call_${index}_${randomBytes(4).toString("hex")}`,
      name: call.name,
      input,
    };
  }
  yield {
    type: "finish",
    reason: reason ?? "stop",
    usage,
    model: `${model.way}/${model.name}`,
  };
}
