import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { prompt } from "../prompts.js";

type V3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type CallOptions = Parameters<V3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<V3["doGenerate"]>>;
export type Message = CallOptions["prompt"][number];
export type Warning = GenerateResult["warnings"][number];

/** The extension a saved attachment gets, so the client reads it as what it is. */
export function extensionOf(mediaType: string, filename?: string): string {
  const own = filename?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  if (own) {
    return own.toLowerCase();
  }
  const sub = mediaType.split("/")[1] ?? "bin";
  return { jpeg: "jpg", "svg+xml": "svg", plain: "txt", markdown: "md" }[sub] ?? sub;
}

/**
 * The conversation as a client takes it: one system prompt and one prompt on stdin. A single
 * user message goes as it is; a longer thread is written out with its speakers, and the client
 * is asked to answer its last message. Attachments are saved to `dir` and named in the prompt.
 */
export function renderPrompt(
  messages: Message[],
  dir?: string,
): { system: string; prompt: string; files: string[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const files: string[] = [];
  const system: string[] = [];
  const turns: { role: string; text: string }[] = [];
  const saveFile = (input: { data: unknown; mediaType: string; filename?: string }): string => {
    // A file's content comes tagged: { type: "data", data } | { type: "url", url } | { type: "text", text }.
    const tagged = input.data as { type?: string; data?: unknown; url?: URL; text?: string } | null;
    const data =
      tagged && typeof tagged === "object" && typeof tagged.type === "string"
        ? tagged.type === "url"
          ? tagged.url
          : tagged.type === "text"
            ? Buffer.from(tagged.text ?? "", "utf8")
            : tagged.data
        : input.data;
    const part = { ...input, data };
    if (part.data instanceof URL) {
      return `[Attachment at ${part.data.href} (${part.mediaType})]`;
    }
    if (typeof part.data !== "string" && !(part.data instanceof Uint8Array)) {
      warnings.push({ type: "unsupported", feature: "file parts" });
      return `[Attachment: ${part.filename ?? part.mediaType}]`;
    }
    if (!dir) {
      warnings.push({ type: "unsupported", feature: "file parts" });
      return `[Attachment: ${part.filename ?? part.mediaType}]`;
    }
    const path = join(dir, `${files.length + 1}.${extensionOf(part.mediaType, part.filename)}`);
    const bytes =
      typeof part.data === "string" ? Buffer.from(part.data, "base64") : (part.data as Uint8Array);
    writeFileSync(path, bytes);
    files.push(path);
    return prompt("services", "harness.attached_file", { path });
  };
  for (const m of messages) {
    if (m.role === "system") {
      system.push(m.content);
      continue;
    }
    const text = m.content
      .map((part) => {
        switch (part.type) {
          case "text":
            return part.text;
          case "file":
            return saveFile(part);
          case "reasoning":
            return "";
          case "tool-call":
            return `[Called ${part.toolName} with ${JSON.stringify(part.input)}]`;
          case "tool-result": {
            const out = part.output as { type: string; value?: unknown; reason?: string };
            const value =
              out.type === "text" || out.type === "error-text"
                ? String(out.value)
                : out.type === "json" || out.type === "error-json"
                  ? JSON.stringify(out.value)
                  : out.type === "execution-denied"
                    ? `denied${out.reason ? `: ${out.reason}` : ""}`
                    : JSON.stringify(out.value ?? out);
            return `[Result of ${part.toolName}: ${value}]`;
          }
          default:
            return "";
        }
      })
      .filter(Boolean)
      .join("\n");
    turns.push({ role: m.role, text });
  }
  const request =
    turns.length === 1 && turns[0].role === "user"
      ? turns[0].text
      : turns
          .map(
            (t) =>
              `${t.role === "user" ? "User" : t.role === "tool" ? "Tool" : "Assistant"}:\n${t.text}`,
          )
          .join("\n\n");
  if (turns.length > 1) {
    system.push(prompt("services", "harness.conversation_note"));
  }
  return { system: system.join("\n\n"), prompt: request, files, warnings };
}

/** What a client without a schema option is told so its answer parses. */
export function jsonInstruction(schema: unknown): string {
  return prompt("services", "harness.json_instruction", {
    schema: JSON.stringify(schema ?? { type: "object" }),
  });
}

/** A client's answer as JSON: the fences and prose some wrap around it are taken off. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // Prose around the value: take the outermost object or array.
    const start = unfenced.search(/[{[]/);
    const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw new Error("The answer is not JSON.");
  }
}
