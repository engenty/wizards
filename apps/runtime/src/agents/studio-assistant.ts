import { anthropic } from "@ai-sdk/anthropic";
import type {
  AssistantPage,
  AssistantPrompt,
  AssistantSignal,
  AssistantStep,
  BrowserTool,
} from "@engenty/wizards-shared/assistant";
import type { Lang } from "@engenty/wizards-shared/definition";
import {
  cleanAssetSections,
  cleanLogoSections,
  FACT_TYPES,
  FONT_USES,
  factKey,
  gradientCss,
  parseGradient,
  RULE_MARKS,
  SPACE_FILE_KINDS,
  SPACE_LIMITS,
  textStyleLine,
} from "@engenty/wizards-shared/spaces";
import { createTool } from "@mastra/core/tools";
import { nanoid } from "nanoid";
import { z } from "zod";
import { knowsTools } from "../assistant/knows.js";
import type { SessionUser } from "../auth/index.js";
import type { AssistantCardRecord, AssistantToolCallRecord } from "../db/schema.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import {
  chatModel,
  contextWindowOf,
  costOf,
  gatewayTools,
  totalUsage,
  usageOf,
} from "../models.js";
import { prompt } from "../prompts.js";
import { contentPolicy } from "../safety.js";
import type { ChatRow, TurnHistory } from "../services/assistant-chats.js";
import { knowledgeCounts } from "../services/knowledge.js";
import { activeSkills, skillList } from "../services/skills.js";
import { categoryRows } from "../services/space-categories.js";
import {
  addSpaceFileFromUrl,
  spaceFileContent,
  spaceFiles,
  updateSpaceFile,
} from "../services/space-files.js";
import { documentText } from "../services/space-index.js";
import { ownedSpace, type SpaceRow, updateSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import { type ServerKey, serverText } from "../texts.js";
import { assistantPageOf, assistantToolsOf } from "../tools/plugin.js";
import { attempt as attemptTool, imageOutput } from "../tools/shared.js";
import { skillToolsOf } from "../tools/skills.js";
import { spaceAgent } from "./space-agent.js";
import { chatTurnWay } from "./subscription.js";
import { readWebsite } from "./website.js";

export interface AssistantInput {
  user: SessionUser;
  /** The open chat: its earlier messages, running summary and the last chats' summaries. */
  chat: ChatRow;
  history: TurnHistory;
  /** The space the studio shows; null where it has none. */
  space: SpaceRow | null;
  /** The space may be changed: its tools and the plugins' tools are there. */
  writable: boolean;
  message: string;
  /** Extra effort: the more capable model of the way. */
  extra?: boolean;
  /** What the page the person writes from shows. */
  page: AssistantPage | null;
  /** Tools the browser runs (AG-UI's `tools`): the built-in six and what the page adds. */
  browserTools: BrowserTool[];
  lang: Lang;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  /** A short line about what the assistant is doing right now. */
  onActivity?: (label: string) => void;
  /** The space or a plugin's data changed: the page shows it. */
  onChanged?: () => void;
  /** A card for the chat: what a plugin's tool returned, or the studio's own (templates). */
  onCard?: (card: AssistantCardRecord) => void;
  onToolCall?: (call: { toolCallId: string; toolCallName: string; args: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; content: string }) => void;
  /** Runs a browser tool: sent on the open stream, its result awaited. */
  callBrowser: (call: {
    toolCallId: string;
    toolCallName: string;
    args: unknown;
  }) => Promise<unknown>;
  /** Messages the person wrote meanwhile, taken before each step after the first. */
  takeSignals?: () => AssistantSignal[];
  /**
   * The turn took messages written meanwhile; `before` is what the answer said and did up to
   * them, which the result no longer holds.
   */
  onSignal?: (taken: AssistantSignal[], before: AnswerPart) => Promise<void>;
  /** Developer mode: what went to the model, and each step. */
  onPrompt?: (prompt: AssistantPrompt) => void;
  onStep?: (step: Omit<AssistantStep, "step">) => void;
}

/** What an answer said and did: all of it, or the part since the last message written meanwhile. */
export interface AnswerPart {
  reply: string;
  changed: boolean;
  cards: AssistantCardRecord[];
  toolCalls: AssistantToolCallRecord[];
}

export interface AssistantResult extends AnswerPart {
  costUsd: number;
}

/** How a message written meanwhile reaches the model. */
export function signalText(taken: AssistantSignal[]): string {
  return prompt("goose", "signal", { messages: taken.map((s) => s.message).join("\n\n") });
}

const MAX_STEPS = 24;

/** The system prompt: these sections of prompts/goose.md, in this order. */
function system(): string {
  return [
    prompt("goose", "persona"),
    prompt("goose", "voice"),
    prompt("goose", "primer"),
    prompt("goose", "knows"),
    prompt("goose", "page"),
    prompt("goose", "space"),
    prompt("goose", "work"),
    contentPolicy(),
  ].join("\n\n");
}

const LABELS: Record<string, ServerKey> = {
  save_logo: "doingSaveLogo",
  save_file: "doingSaveFile",
  set_logo_sections: "doingSetLogoSections",
  set_asset_sections: "doingSetAssetSections",
  set_typography: "doingSetTypography",
  set_gradients: "doingSetGradients",
  set_rules: "doingSetRules",
  set_profile: "doingSetProfile",
  set_facts: "doingSetFacts",
  set_colors: "doingSetColors",
  look_at_file: "doingLookAtFile",
  describe_file: "doingDescribeFile",
  web_search: "doingWebSearch",
};

function activity(tool: string, args: Record<string, unknown>, lang: Lang): string | null {
  const host = (u: unknown) => {
    try {
      return new URL(/^https?:/i.test(String(u)) ? String(u) : `https://${u}`).hostname;
    } catch {
      return "";
    }
  };
  if (tool === "read_website") {
    const at = args.url ? host(args.url) : "";
    return at
      ? serverText(lang, "doingReadSite", { host: at })
      : serverText(lang, "doingReadWebsite");
  }
  const key =
    tool === "save_file" && args.kind === "logo"
      ? "save_logo"
      : tool === "remove_facts"
        ? "set_facts"
        : tool;
  return LABELS[key] ? serverText(lang, LABELS[key]) : null;
}

/** A tool failure the model can read and fix, instead of a crashed turn: the whole message. */
const attempt = <T>(run: () => Promise<T>) => attemptTool(run, { limit: Number.POSITIVE_INFINITY });

async function spaceState(userId: string, spaceId: string) {
  const p = await ownedSpace(userId, spaceId);
  const files = await spaceFiles(spaceId);
  const categories = await categoryRows(spaceId);
  return {
    knowledge: {
      ...(await knowledgeCounts(spaceId)),
      categories: categories.map((c) => `${c.name} (${c.type}${c.proposed ? ", proposed" : ""})`),
    },
    title: p.brand.name ?? "",
    about: p.brand.about ?? "",
    colors: (p.brand.colors ?? []).map(({ name, value, section }) => {
      const s = p.brand.colorSections?.find((x) => x.id === section);
      return { name, value, ...(s ? { section: s.title } : {}) };
    }),
    // Optional parts are only there when the space has them.
    ...(p.brand.colorSections?.length
      ? {
          colorSections: p.brand.colorSections.map(({ title, kind }) => ({
            title,
            kind: kind ?? "colors",
          })),
        }
      : {}),
    ...(p.brand.gradients?.length
      ? {
          gradients: p.brand.gradients.map((g) => ({
            name: g.name,
            ...(g.description ? { description: g.description } : {}),
            section: p.brand.colorSections?.find((s) => s.id === g.section)?.title,
            css: gradientCss(g),
          })),
        }
      : {}),
    ...(p.brand.patterns?.length
      ? {
          patterns: p.brand.patterns.map((x) => ({
            name: x.name,
            ...(x.description ? { description: x.description } : {}),
            section: p.brand.colorSections?.find((s) => s.id === x.section)?.title,
            tile: Boolean(x.tile),
          })),
        }
      : {}),
    ...(p.brand.logoSections?.length
      ? {
          logoSections: p.brand.logoSections.map(({ title, description, logos }) => ({
            title,
            description,
            logos,
          })),
        }
      : {}),
    ...(p.brand.assetSections?.length
      ? {
          assetSections: p.brand.assetSections.map(({ title, assets }) => ({ title, assets })),
        }
      : {}),
    ...(p.brand.fonts?.length
      ? {
          fonts: p.brand.fonts.map(({ family, role, weights, license, uses }) => ({
            family,
            role,
            weights,
            ...(license ? { license } : {}),
            ...(uses?.length ? { uses } : {}),
          })),
        }
      : {}),
    ...(p.brand.textStyles?.length
      ? {
          textStyles: p.brand.textStyles.map((s) => ({
            name: s.name,
            style: textStyleLine(s, p.brand.fonts ?? []),
          })),
        }
      : {}),
    ...(p.brand.logoRules ? { logoRules: p.brand.logoRules } : {}),
    ...(p.brand.colorRules ? { colorRules: p.brand.colorRules } : {}),
    ...(p.brand.typeRules ? { typeRules: p.brand.typeRules } : {}),
    facts: p.facts.map(({ label, value }) => ({ label, value })),
    files: files.map((f) => ({
      id: f.id,
      kind: f.kind,
      name: f.name,
      description: f.description,
      ...(f.status === "ready" ? {} : { status: f.status }),
    })),
  };
}

/** The space's own tools: what fills it in. */
/** Parts of the brand that wait behind their switches: their tools are left out while off. */
interface BrandSwitches {
  brandSections: boolean;
  brandRules: boolean;
  typography: boolean;
}

function spaceTools(input: AssistantInput, space: SpaceRow, wrote: () => void, on: BrandSwitches) {
  const { signal } = input;
  const userId = input.user.id;
  const spaceId = space.id;
  // Said from inside the tool: an installed AI client runs tools without the stream showing it.
  const doing = (tool: string, args: Record<string, unknown> = {}) => {
    const label = activity(tool, args, input.lang);
    if (label) {
      input.onActivity?.(label);
    }
  };
  // Tools of one step run together; writes to the space's row take turns.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = turn.then(run, run);
    turn = next.catch(() => undefined);
    return next;
  };
  const tools: Record<string, any> = {
    read_website: createTool({
      id: "read_website",
      description: prompt("goose", "tool.read_website"),
      inputSchema: z.object({ url: z.string().describe("The page's address") }),
      execute: ({ url }) => {
        doing("read_website", { url });
        return attempt(() => readWebsite(url, signal));
      },
    }),
    set_profile: createTool({
      id: "set_profile",
      description: prompt("goose", "tool.set_profile"),
      inputSchema: z.object({
        title: z.string().max(120).optional(),
        about: z.string().max(8000).optional(),
      }),
      execute: ({ title, about }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_profile");
            await updateSpace(userId, spaceId, {
              brand: {
                ...(title !== undefined ? { name: title } : {}),
                ...(about !== undefined ? { about } : {}),
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_facts: createTool({
      id: "set_facts",
      description: prompt("goose", "tool.set_facts"),
      inputSchema: z.object({
        facts: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              value: z.string().min(1).max(4000),
              type: z.enum(FACT_TYPES).optional().describe("Only when the value's look misleads"),
            }),
          )
          .min(1),
      }),
      execute: ({ facts }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_facts");
            const p = await ownedSpace(userId, spaceId);
            const next = [...p.facts];
            for (const f of facts) {
              const label = f.label.trim();
              const at = next.findIndex((x) => x.label.toLowerCase() === label.toLowerCase());
              if (at >= 0) {
                next[at] = { ...next[at], value: f.value.trim(), type: f.type ?? next[at].type };
              } else {
                const key = factKey(
                  label,
                  next.map((x) => x.key),
                );
                next.push({
                  key,
                  label,
                  value: f.value.trim(),
                  ...(f.type ? { type: f.type } : {}),
                });
              }
            }
            if (next.length > SPACE_LIMITS.facts) {
              throw new Error(`A space holds at most ${SPACE_LIMITS.facts} facts.`);
            }
            await updateSpace(userId, spaceId, { facts: next });
            wrote();
            return { ok: true, facts: next.length };
          }),
        ),
    }),
    remove_facts: createTool({
      id: "remove_facts",
      description: prompt("goose", "tool.remove_facts"),
      inputSchema: z.object({ labels: z.array(z.string()).min(1) }),
      execute: ({ labels }) =>
        attempt(() =>
          inTurn(async () => {
            doing("remove_facts");
            const p = await ownedSpace(userId, spaceId);
            const gone = new Set(labels.map((l) => l.trim().toLowerCase()));
            const next = p.facts.filter((f) => !gone.has(f.label.toLowerCase()));
            await updateSpace(userId, spaceId, { facts: next });
            wrote();
            return { ok: true, removed: p.facts.length - next.length };
          }),
        ),
    }),
    set_colors: createTool({
      id: "set_colors",
      description: prompt("goose", "tool.set_colors"),
      inputSchema: z.object({
        colors: z
          .array(
            z.object({
              name: z.string().max(120),
              value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
              section: z.string().max(80).optional().describe("A section's title"),
            }),
          )
          .max(SPACE_LIMITS.colors),
        sections: z
          .array(z.object({ title: z.string().min(1).max(80) }))
          .max(SPACE_LIMITS.logoSections)
          .optional(),
      }),
      execute: ({ colors, sections }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_colors");
            if (!on.brandSections && (sections || colors.some((c) => c.section))) {
              throw new Error(
                "Colour sections are not available in this studio: pass the colours without them.",
              );
            }
            const p = await ownedSpace(userId, spaceId);
            const groups = sections
              ? sections.map((s) => ({
                  id: p.brand.colorSections?.find((x) => x.title === s.title)?.id ?? nanoid(10),
                  ...s,
                }))
              : (p.brand.colorSections ?? []);
            const unknown = colors.filter(
              (c) => c.section && !groups.some((s) => s.title === c.section),
            );
            if (unknown.length) {
              throw new Error(
                `No colour section named: ${unknown.map((c) => c.section).join(", ")}`,
              );
            }
            await updateSpace(userId, spaceId, {
              brand: {
                colors: colors.map(({ section, ...c }) => {
                  const id = groups.find((s) => s.title === section)?.id;
                  return { ...c, value: c.value.toLowerCase(), ...(id ? { section: id } : {}) };
                }),
                colorSections: groups,
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_logo_sections: createTool({
      id: "set_logo_sections",
      description: prompt("goose", "tool.set_logo_sections"),
      inputSchema: z.object({
        sections: z
          .array(
            z.object({
              title: z.string().min(1).max(80).describe("The variant: Logomark, Wordmark, …"),
              description: z
                .string()
                .max(400)
                .describe("When to use these logos, in the person's language"),
              logos: z.array(z.string()).describe("Ids of the space's logo files, in order"),
            }),
          )
          .max(SPACE_LIMITS.logoSections),
      }),
      execute: ({ sections }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_logo_sections");
            const logos = (await spaceFiles(spaceId, "logo")).map((f) => f.id);
            const unknown = sections.flatMap((s) => s.logos).filter((id) => !logos.includes(id));
            if (unknown.length) {
              throw new Error(`Not a logo of this space: ${unknown.join(", ")}`);
            }
            await updateSpace(userId, spaceId, {
              brand: {
                logoSections: cleanLogoSections(
                  sections.map((s) => ({ ...s, id: nanoid(10) })),
                  logos,
                ),
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_asset_sections: createTool({
      id: "set_asset_sections",
      description: prompt("goose", "tool.set_asset_sections"),
      inputSchema: z.object({
        sections: z
          .array(
            z.object({
              title: z.string().min(1).max(80),
              assets: z.array(z.string()).describe("Ids of the space's asset files, in order"),
            }),
          )
          .max(SPACE_LIMITS.logoSections),
      }),
      execute: ({ sections }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_asset_sections");
            const assets = (await spaceFiles(spaceId, "asset")).map((f) => f.id);
            const unknown = sections.flatMap((s) => s.assets).filter((id) => !assets.includes(id));
            if (unknown.length) {
              throw new Error(`Not an asset of this space: ${unknown.join(", ")}`);
            }
            await updateSpace(userId, spaceId, {
              brand: {
                assetSections: cleanAssetSections(
                  sections.map((s) => ({ ...s, id: nanoid(10) })),
                  assets,
                ),
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_typography: createTool({
      id: "set_typography",
      description: prompt("goose", "tool.set_typography"),
      inputSchema: z.object({
        fonts: z
          .array(
            z.object({
              family: z.string().min(1).max(80),
              role: z.string().max(200).describe("What it is for, in the person's language"),
              weights: z.array(z.number().int().min(100).max(900)).max(9),
              license: z
                .string()
                .max(200)
                .optional()
                .describe("The licence, only where a source names it: 'SIL Open Font License'"),
              uses: z
                .array(z.enum(FONT_USES))
                .optional()
                .describe("All the licence allows it for, only where a source says so"),
            }),
          )
          .max(SPACE_LIMITS.fonts),
        textStyles: z
          .array(
            z.object({
              name: z.string().min(1).max(60),
              family: z.string().max(80).optional().describe("One of the fonts; none: the first"),
              size: z.number().min(6).max(400),
              weight: z.number().int().min(100).max(900),
              lineHeight: z.number().min(50).max(300).describe("% of the size"),
              tracking: z.number().min(-20).max(50).describe("Letter spacing, % of the size"),
              uppercase: z.boolean().optional(),
            }),
          )
          .max(SPACE_LIMITS.textStyles)
          .optional(),
      }),
      execute: ({ fonts, textStyles }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_typography");
            const p = await ownedSpace(userId, spaceId);
            const faces = fonts.map((f) => ({
              ...f,
              id: p.brand.fonts?.find((x) => x.family === f.family)?.id ?? nanoid(10),
            }));
            await updateSpace(userId, spaceId, {
              brand: {
                fonts: faces,
                ...(textStyles
                  ? {
                      textStyles: textStyles.map(({ family, ...s }) => ({
                        ...s,
                        id: nanoid(10),
                        font: faces.find((f) => f.family === family)?.id,
                      })),
                    }
                  : {}),
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_gradients: createTool({
      id: "set_gradients",
      description: prompt("goose", "tool.set_gradients"),
      inputSchema: z.object({
        section: z.string().min(1).max(80).describe("The gradients section's title"),
        gradients: z
          .array(
            z.object({
              name: z.string().min(1).max(80),
              description: z.string().max(400).optional().describe("When to use it"),
              css: z.string().max(1000),
            }),
          )
          .max(SPACE_LIMITS.gradients),
      }),
      execute: ({ section, gradients }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_gradients");
            const p = await ownedSpace(userId, spaceId);
            const sections = p.brand.colorSections ?? [];
            const found = sections.find((s) => s.title === section && s.kind === "gradients");
            const id = found?.id ?? nanoid(10);
            const parsed = gradients.map((g) => ({ g, read: parseGradient(g.css) }));
            const bad = parsed.filter((x) => !x.read).map((x) => x.g.name);
            if (bad.length) {
              throw new Error(`Not a gradient with hex stops: ${bad.join(", ")}`);
            }
            await updateSpace(userId, spaceId, {
              brand: {
                colorSections: found
                  ? sections
                  : [...sections, { id, title: section, kind: "gradients" }],
                gradients: [
                  ...(p.brand.gradients ?? []).filter((g) => g.section !== id),
                  ...parsed.map(({ g, read }) => ({
                    id: nanoid(10),
                    name: g.name,
                    ...(g.description ? { description: g.description } : {}),
                    section: id,
                    ...(read as NonNullable<typeof read>),
                  })),
                ],
              },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    set_rules: createTool({
      id: "set_rules",
      description: prompt("goose", "tool.set_rules"),
      inputSchema: z.object({
        of: z.enum(["logos", "colors", "type"]),
        rules: z
          .array(
            z.object({
              text: z.string().min(1).max(200),
              mark: z
                .enum(RULE_MARKS)
                .optional()
                .describe("do, dont, important, question, number; none for a plain note"),
            }),
          )
          .max(SPACE_LIMITS.logoRules),
      }),
      execute: ({ of, rules }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_rules");
            await updateSpace(userId, spaceId, {
              brand:
                of === "logos"
                  ? { logoRules: rules }
                  : of === "colors"
                    ? { colorRules: rules }
                    : { typeRules: rules },
            });
            wrote();
            return { ok: true };
          }),
        ),
    }),
    save_file: createTool({
      id: "save_file",
      description: prompt("goose", "tool.save_file"),
      inputSchema: z.object({
        url: z.string(),
        kind: z.enum(SPACE_FILE_KINDS),
        description: z
          .string()
          .max(600)
          .optional()
          .describe("One sentence: what it shows or holds, and what it suits"),
      }),
      execute: ({ url, kind, description }) =>
        attempt(async () => {
          doing("save_file", { kind });
          const row = await addSpaceFileFromUrl(spaceId, { url, kind, description, signal });
          wrote();
          return { ok: true, id: row.id, name: row.name, mime: row.mime, size: row.size };
        }),
    }),
    describe_file: createTool({
      id: "describe_file",
      description: prompt("goose", "tool.describe_file"),
      inputSchema: z.object({ id: z.string(), description: z.string().max(600) }),
      execute: ({ id, description }) =>
        attempt(async () => {
          doing("describe_file");
          await updateSpaceFile(spaceId, id, { description });
          wrote();
          return { ok: true };
        }),
    }),
    look_at_file: createTool({
      id: "look_at_file",
      description: prompt("goose", "tool.look_at_file"),
      inputSchema: z.object({
        id: z.string(),
        from: z.number().int().min(0).optional().describe("Documents: character to start at"),
      }),
      execute: ({ id, from }) =>
        attempt(async () => {
          doing("look_at_file");
          const { row, data } = await spaceFileContent(spaceId, id);
          if (row.kind === "document") {
            const text = await documentText(row);
            if (!text) {
              return { name: row.name, note: `The document is not read yet (${row.status}).` };
            }
            const start = Math.min(from ?? 0, text.length);
            return {
              name: row.name,
              text: text.slice(start, start + 12_000),
              next: start + 12_000 < text.length ? start + 12_000 : null,
            };
          }
          if (!/^image\/(png|jpeg|webp|gif)$/.test(row.mime) || data.byteLength > 5_000_000) {
            return { name: row.name, mime: row.mime, note: "This file cannot be shown to you." };
          }
          return { name: row.name, image: data.toString("base64"), mime: row.mime };
        }),
      toModelOutput: imageOutput("image", (rest) => String(rest.name)),
    }),
  };
  if (!on.brandSections) {
    delete tools.set_logo_sections;
    delete tools.set_gradients;
  }
  if (!on.brandRules) {
    delete tools.set_rules;
  }
  if (!on.typography) {
    delete tools.set_typography;
  }
  return tools;
}

/** A browser tool as the model calls it: sent to the page, its answer awaited. */
function browserTool(input: AssistantInput, spec: BrowserTool) {
  let inputSchema: z.ZodType;
  try {
    inputSchema = z.fromJSONSchema(spec.parameters as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return null;
  }
  return createTool({
    id: spec.name,
    description: spec.description,
    inputSchema,
    // The id is the one `traced` gave the call: the browser answers to it.
    execute: async (args: unknown, ctx?: { toolCallId?: string }) =>
      input.callBrowser({
        toolCallId: ctx?.toolCallId ?? nanoid(10),
        toolCallName: spec.name,
        args,
      }),
  } as never);
}

/** Text of a tool's result for the chat's record, cut short. */
function resultText(out: unknown): string {
  if (typeof out === "string") {
    return out.slice(0, 1200);
  }
  try {
    return (
      JSON.stringify(out, (key, value) => (key === "image" ? "(picture)" : value))?.slice(
        0,
        1200,
      ) ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * Every tool says when it is called and what it gave back (AG-UI's tool call), from inside: an
 * installed AI client runs tools without the stream showing it. A browser tool's call carries the
 * same id to the page.
 */
function traced(
  tools: Record<string, any>,
  input: AssistantInput,
  record: AssistantToolCallRecord[],
) {
  for (const [name, tool] of Object.entries(tools)) {
    const run = tool?.execute;
    if (typeof run !== "function") {
      continue;
    }
    tool.execute = async (args: unknown, ctx: Record<string, unknown> = {}) => {
      const toolCallId = nanoid(10);
      const call = { toolCallId, toolCallName: name, args };
      input.onToolCall?.(call);
      const out = await run(args, { ...ctx, toolCallId });
      const content = resultText(out);
      record.push({ ...call, result: content });
      input.onToolResult?.({ toolCallId, content });
      return out;
    };
  }
}

/** The part of the space page a route stands on. */
function partOf(route: string): string | null {
  const m = route.match(/^\/space\/(info|brand|knowledge|data|results|skills)/);
  return m ? m[1] : route === "/space" ? "info" : null;
}

/** How large each tool is in the prompt: its description and its schema, in characters. */
export function toolSizes(tools: Record<string, any>): AssistantPrompt["tools"] {
  return Object.entries(tools)
    .map(([name, tool]) => {
      let schema = "";
      try {
        schema = JSON.stringify(
          tool?.inputSchema ? z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" }) : {},
        );
      } catch {
        // A provider's own tool (web search) has no schema of ours.
      }
      return { name, chars: String(tool?.description ?? "").length + schema.length };
    })
    .sort((a, b) => b.chars - a.chars);
}

/** One turn of the studio assistant. */
export async function runStudioAssistant(input: AssistantInput): Promise<AssistantResult> {
  // How often the space or a plugin's data changed: a part of the answer changed something when
  // this grew during it.
  let changes = 0;
  // The way the settings chose for the studio's chats: on a client, its tools reach it over MCP.
  const way = await chatTurnWay(managed);
  const resolved = await chatModel(way, input.extra ? "high" : "standard");
  const wrote = () => {
    changes++;
    input.onChanged?.();
  };
  const cards: AssistantCardRecord[] = [];
  const { space } = input;
  const writable = space && input.writable ? space : null;
  const switches = await currentFeatures();
  const brandOn: BrandSwitches = {
    brandSections: switches.brandSections === true,
    brandRules: switches.brandRules === true,
    typography: switches.typography === true,
  };
  const tools: Record<string, any> = {
    ...knowsTools({
      user: input.user,
      space: space ? { id: space.id, name: space.name } : null,
      lang: input.lang,
      chatId: input.chat.id,
      doing: (label) => input.onActivity?.(label),
      card: (card) => {
        cards.push(card);
        input.onCard?.(card);
      },
    }),
    ...(writable ? spaceTools(input, writable, wrote, brandOn) : {}),
  };
  // On everyday effort the chat can offer extra effort for work that asks for more: a card with
  // a button, while it goes on answering.
  if (!input.extra) {
    tools.suggest_extra_effort = createTool({
      id: "suggest_extra_effort",
      description:
        "Offers the person extra effort (a more capable model) with a button under your answer. Call it once, before you start, when the work is demanding: building or changing a wizard with many steps, writing a widget (code), a long or intricate flow, hard analysis. Never for everyday questions or small changes. Say nothing about the button yourself and go on with your answer.",
      inputSchema: z.object({
        reason: z
          .string()
          .min(3)
          .max(160)
          .describe("Why this work needs more, in the person's language, one short sentence."),
      }),
      execute: async ({ reason }) => {
        const card = { plugin: "", tool: "extraEffort", data: { reason } };
        cards.push(card);
        input.onCard?.(card);
        return { shown: true };
      },
    });
  }
  // What the tenant's plugins let the assistant do besides: a source of knowledge, say.
  if (writable) {
    Object.assign(
      tools,
      await assistantToolsOf({
        tenantId: currentTenant(),
        space: { id: writable.id, name: writable.name },
        userId: input.user.id,
        signal: input.signal ?? new AbortController().signal,
        emit: (message) => input.onActivity?.(message),
        changed: wrote,
        card: (card) => {
          cards.push(card);
          input.onCard?.(card);
        },
      }),
    );
  }
  // The space's skills (docs/plans/skills.md): Goose reads them as a step does.
  const skills = space && switches.skills === true ? await activeSkills(space.id) : null;
  const allSkills = space && switches.skills === true ? await skillList(space.id) : [];
  if (skills) {
    Object.assign(
      tools,
      skillToolsOf(skills, (name) =>
        input.onActivity?.(serverText(input.lang, "doingReadSkill", { name })),
      ),
    );
  }
  for (const spec of input.browserTools) {
    if (tools[spec.name]) {
      continue;
    }
    const tool = browserTool(input, spec);
    if (tool) {
      tools[spec.name] = tool;
    }
  }
  const toolCalls: AssistantToolCallRecord[] = [];
  traced(tools, input, toolCalls);
  if (resolved.vendor === "anthropic") {
    tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 5 });
  } else if (resolved.gateway) {
    tools.web_search = gatewayTools.perplexitySearch({ maxResults: 6 });
  }
  const instructions = system();
  const agent = spaceAgent({
    id: "studio-assistant",
    name: "Studio assistant",
    instructions,
    resolved,
    tools,
  });
  const page = input.page;
  const pluginPage =
    page?.plugin && space
      ? await assistantPageOf(currentTenant(), page.plugin, { id: space.id, name: space.name })
      : null;
  const part = page ? partOf(page.route) : null;
  const { history } = input;
  const context = [
    history.earlier.length
      ? prompt("goose", "turn.earlier", {
          chats: history.earlier
            .map(
              (c) => `- ${c.closedAt.slice(0, 10)} "${c.title}": ${c.summary.replace(/\n+/g, " ")}`,
            )
            .join("\n"),
        })
      : "",
    history.running ? `What this chat said before the messages above:\n${history.running}` : "",
    page
      ? `Current page:\n\`\`\`json\n${JSON.stringify(page)}\n\`\`\``
      : prompt("goose", "turn.no_page"),
    pluginPage
      ? [
          [
            pluginPage.description
              ? `The page is the plugin "${pluginPage.name}"'s: ${pluginPage.description}`
              : `The page is the plugin "${pluginPage.name}"'s.`,
            prompt("goose", "turn.plugin_page", {
              prefix: (page?.plugin ?? "").replace(/-/g, "_"),
            }),
          ].join(" "),
          ...pluginPage.blocks,
        ].join("\n\n")
      : "",
    writable
      ? `The space now:\n\`\`\`json\n${JSON.stringify(await spaceState(input.user.id, writable.id))}\n\`\`\``
      : space
        ? prompt("goose", "turn.space_read_only", { name: space.name })
        : "No space is open.",
    part === "knowledge" ? prompt("goose", "turn.knowledge") : "",
    allSkills.length
      ? [
          prompt("goose", "turn.skills"),
          ...allSkills.map((k) => `- ${k.name} (${k.mode}): ${k.description}`),
        ].join("\n")
      : part === "skills"
        ? prompt("goose", "turn.skills_empty")
        : "",
    writable && !(brandOn.brandSections && brandOn.brandRules && brandOn.typography)
      ? prompt("goose", "turn.off", {
          missing: [
            brandOn.brandSections ? "" : "sections of logos and colours, gradients and patterns",
            brandOn.brandRules ? "" : "rules for logos, colours and type",
            brandOn.typography ? "" : "typography (fonts, type scale)",
          ]
            .filter(Boolean)
            .join("; "),
        })
      : "",
    input.message,
  ]
    .filter(Boolean)
    .join("\n\n");
  input.onPrompt?.({
    model: resolved.ref,
    system: instructions,
    context,
    history: history.messages.map((m) => ({ role: m.role, chars: m.content.length })),
    tools: toolSizes(tools),
  });
  let reply = "";
  // Where the part the result holds begins: a message written meanwhile cuts the answer there.
  const from = { reply: 0, cards: 0, toolCalls: 0, changes: 0 };
  const cut = (): AnswerPart => {
    const part = {
      reply: reply.slice(from.reply).trim(),
      changed: changes > from.changes,
      cards: cards.slice(from.cards),
      toolCalls: toolCalls.slice(from.toolCalls),
    };
    Object.assign(from, {
      reply: reply.length,
      cards: cards.length,
      toolCalls: toolCalls.length,
      changes,
    });
    return part;
  };
  const stream = await agent.stream(
    [
      ...history.messages.map((m) =>
        m.role === "user"
          ? { role: "user" as const, content: m.content }
          : { role: "assistant" as const, content: m.content },
      ),
      { role: "user" as const, content: context },
    ],
    {
      maxSteps: MAX_STEPS,
      abortSignal: input.signal,
      modelSettings: { maxOutputTokens: 8000 },
      // What the person wrote meanwhile comes before the next step, after the tools' results.
      prepareStep: async ({ stepNumber, messageList }) => {
        const taken = stepNumber > 0 ? (input.takeSignals?.() ?? []) : [];
        if (!taken.length) {
          return;
        }
        await input.onSignal?.(taken, cut());
        messageList.add({ role: "user", content: signalText(taken) }, "input");
        return { messageList };
      },
    },
  );
  const window = contextWindowOf(resolved.ref);
  // A step lasts from the end of the one before – its tools' work included – to its own end.
  let stepStarted = Date.now();
  for await (const chunk of stream.fullStream as AsyncIterable<any>) {
    const payload = chunk.payload ?? chunk;
    if (chunk.type === "step-finish" && input.onStep) {
      const usage = usageOf(payload.output?.usage);
      input.onStep({
        model: resolved.ref,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        ms: Date.now() - stepStarted,
        costUsd: costOf(resolved, payload.output?.usage),
        tools: (payload.output?.toolCalls ?? []).map(
          (c: any) => c.payload?.toolName ?? c.toolName ?? "",
        ),
        window,
      });
      stepStarted = Date.now();
    } else if (chunk.type === "text-delta") {
      const text: string = payload.text ?? payload.delta ?? "";
      reply += text;
      input.onText?.(text);
    } else if (chunk.type === "tool-call") {
      // The model's own search has no tool of ours that could say so.
      if (payload.toolName === "web_search") {
        input.onActivity?.(serverText(input.lang, LABELS.web_search));
      }
      // Keep what it says before and after a tool call apart.
      if (reply.trim() && !reply.endsWith("\n\n")) {
        input.onText?.("\n\n");
        reply += "\n\n";
      }
    } else if (chunk.type === "error") {
      throw payload.error ?? new Error("assistant stream error");
    }
  }
  const usage = await totalUsage(stream);
  return { ...cut(), costUsd: costOf(resolved, usage) };
}
