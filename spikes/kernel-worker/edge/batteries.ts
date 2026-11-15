import { env } from "cloudflare:workers";
import type { AskRow, Battery } from "@engenty/wizards-kernel";
import { NeedsLeave } from "@engenty/wizards-kernel/edge";

/**
 * What this Worker reads from its bindings. Connected: `HOME_URL` and the secret `DEPLOY_KEY`.
 * On its own: `MODEL_API_KEY` (a secret), `MODEL_BASE_URL` and `MODELS`.
 */
type Env = {
  /** The organization's runtime this deployment belongs to. Set, every ask goes there. */
  HOME_URL?: string;
  /** Says to the home which deployment calls: its organization, space and wizard. */
  DEPLOY_KEY?: string;
  /** An OpenAI-compatible endpoint, up to `/v1`. */
  MODEL_BASE_URL?: string;
  MODEL_API_KEY?: string;
  /** Each model class the wizard requires, as a model name of that endpoint: `{"low":"gpt-4.1-mini"}`. */
  MODELS?: string;
};

/** Asks a person, a signal or the time answers over HTTP: they wait, no battery answers them. */
const WAITS = new Set(["form", "review", "approval", "wait", "signal"]);

/** The text of a field list, for a prompt that wants JSON back. */
const shape = (fields: NonNullable<AskRow["fields"]>) =>
  `Answer with one JSON object and nothing else. Its keys: ${fields
    .map((field) => `"${field.id}" (${field.kind}${field.required ? ", required" : ""})`)
    .join(", ")}.`;

/**
 * An agent ask as one chat completion. No tools: an agent that names tools fails, since this
 * Worker has none. Without a key it echoes, so a run can be walked through without a model.
 */
const agent: Battery = async (row) => {
  const e = env as Env;
  if (row.tools?.length)
    throw new Error(`This Worker has no tools for an agent: ${row.tools.join(", ")}.`);
  const json = Boolean(row.fields?.length);
  if (!e.MODEL_API_KEY) {
    const text = `Echo (${String(row.model ?? "no model")}): ${String(row.title ?? row.step)}`;
    return json
      ? Object.fromEntries((row.fields ?? []).map((field) => [field.id, text]))
      : { text };
  }
  const models = JSON.parse(e.MODELS ?? "{}") as Record<string, string>;
  const model = models[String(row.model)];
  if (!model) throw new Error(`MODELS names no model for the class "${String(row.model)}".`);
  const response = await fetch(
    `${e.MODEL_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${e.MODEL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [String(row.instructions ?? ""), json ? shape(row.fields ?? []) : ""]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        ...(json && { response_format: { type: "json_object" } }),
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `The model endpoint said ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = body.choices[0]?.message.content ?? "";
  return json ? JSON.parse(content) : { text: content };
};

/**
 * Connected: the ask goes home, to the organization's runtime, which answers it through the
 * broker: models, tools, Wissen, Daten, connections. This Worker holds no key but `DEPLOY_KEY`.
 * The home says no with a sentence, or that the action needs the user's leave first.
 */
const home: Battery = async (row, run) => {
  const e = env as Env;
  const response = await fetch(`${e.HOME_URL}/v1/asks`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.DEPLOY_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ run: { id: run.id, wizard: run.wizard, input: run.input }, row }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    answer?: unknown;
    error?: string;
    needsLeave?: boolean;
  };
  if (response.status === 409 && body.needsLeave) throw new NeedsLeave(body.error);
  if (!response.ok) throw new Error(body.error ?? `The home said ${response.status}.`);
  return body.answer;
};

const OWN: Record<string, Battery> = { agent };

/**
 * The batteries of this Worker. Connected, every ask no person answers goes home. On its own, a
 * type it has no battery for gets one that fails at once with a sentence: the run fails at that
 * ask, instead of waiting forever.
 */
export const batteries = new Proxy(OWN, {
  get(own, type: string) {
    if (WAITS.has(type)) return undefined;
    if ((env as Env).HOME_URL) return home;
    if (own[type]) return own[type];
    return (async () => {
      throw new Error(`This Worker has no battery for "${type}" asks.`);
    }) satisfies Battery;
  },
}) as Record<string, Battery>;
