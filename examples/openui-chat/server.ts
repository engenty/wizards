import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addWizard,
  loadWizards,
  type WizardInfo,
  wizardRules,
} from "@engenty/wizards/openui/server";
import { openuiChatLibrary, openuiChatPromptOptions } from "@openuidev/react-ui/genui-lib";

/**
 * The chat's server half: `POST /api/chat` takes the thread, puts OpenUI's system prompt and the
 * wizards in front of it and streams the model's answer back as it comes (OpenAI's chat
 * completions format). Any OpenAI-compatible endpoint works: OpenAI, the Vercel AI Gateway,
 * Anthropic's compatibility endpoint, Ollama.
 */

export interface ChatConfig {
  /** Where the wizards runtime answers, from this server. */
  runtimeUrl: string;
  /** Share tokens of the published wizards the chat may start. */
  wizards: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
}

const library = addWizard(openuiChatLibrary);

let cached: { at: number; wizards: WizardInfo[] } | null = null;

/** The wizards, read again at most once a minute: a wizard published meanwhile shows up. */
async function wizardsOf(config: ChatConfig): Promise<WizardInfo[]> {
  if (!cached || Date.now() - cached.at > 60_000) {
    cached = { at: Date.now(), wizards: await loadWizards(config.runtimeUrl, config.wizards) };
  }
  return cached.wizards;
}

export async function systemPrompt(config: ChatConfig): Promise<string> {
  return library.prompt({
    ...openuiChatPromptOptions,
    additionalRules: [
      ...(openuiChatPromptOptions.additionalRules ?? []),
      ...wizardRules(await wizardsOf(config)),
    ],
  });
}

async function body(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Answers `/api/chat` and `/api/wizards`; anything else goes on to `next`. */
export function chatHandler(config: ChatConfig) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split("?")[0];
    try {
      if (req.method === "GET" && path === "/api/wizards") {
        return json(res, 200, await wizardsOf(config));
      }
      if (req.method !== "POST" || path !== "/api/chat") {
        return next();
      }
      const { messages = [] } = (await body(req)) as { messages?: unknown[] };
      const upstream = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: [{ role: "system", content: await systemPrompt(config) }, ...messages],
        }),
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        return json(res, 502, {
          error: `The model answered ${upstream.status}: ${text.slice(0, 500)}`,
        });
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        res.write(value);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        json(res, 500, { error: (err as Error).message });
      } else {
        res.end();
      }
    }
  };
}
