import { anthropic } from "@ai-sdk/anthropic";
import type {
  AssistantPage,
  AssistantPrompt,
  AssistantSignal,
  AssistantStep,
  BrowserTool,
} from "@engenty-wizards/shared/assistant";
import type { Lang } from "@engenty-wizards/shared/definition";
import {
  cleanAssetSections,
  cleanLogoSections,
  FACT_TYPES,
  FONT_USES,
  factKey,
  gradientCss,
  PROJECT_FILE_KINDS,
  PROJECT_LIMITS,
  parseGradient,
  RULE_MARKS,
  textStyleLine,
} from "@engenty-wizards/shared/projects";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { nanoid } from "nanoid";
import { z } from "zod";
import { knowsTools } from "../assistant/knows.js";
import { PRIMER } from "../assistant/primer.js";
import type { SessionUser } from "../auth/index.js";
import type { AssistantCardRecord, AssistantToolCallRecord } from "../db/schema.js";
import { currentFeatures } from "../features.js";
import {
  agentModel,
  attachTools,
  contextWindowOf,
  costOf,
  gatewayTools,
  textModel,
  totalUsage,
  usageOf,
} from "../models.js";
import type { ChatRow, TurnHistory } from "../services/assistant-chats.js";
import { knowledgeCounts } from "../services/knowledge.js";
import {
  addProjectFileFromUrl,
  projectFileContent,
  projectFiles,
  updateProjectFile,
} from "../services/project-files.js";
import { documentText } from "../services/project-index.js";
import { ownedProject, type ProjectRow, updateProject } from "../services/projects.js";
import { categoryRows } from "../services/space-categories.js";
import { currentTenant } from "../tenants/tenant.js";
import { type ServerKey, serverText } from "../texts.js";
import { assistantPageOf, assistantToolsOf } from "../tools/plugin.js";
import { attempt as attemptTool, imageOutput } from "../tools/shared.js";
import { readWebsite } from "./website.js";

export interface AssistantInput {
  user: SessionUser;
  /** The open chat: its earlier messages, running summary and the last chats' summaries. */
  chat: ChatRow;
  history: TurnHistory;
  /** The space the studio shows; null where it has none. */
  project: ProjectRow | null;
  /** The space may be changed: its tools and the plugins' tools are there. */
  writable: boolean;
  message: string;
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
  return `The person wrote this while you were working. What they asked before still stands unless this changes it:\n\n${taken.map((s) => s.message).join("\n\n")}`;
}

const MAX_STEPS = 24;

const SYSTEM = `You are Goose, the assistant of the engenty wizards studio. You stand on every page of the studio except the wizard editor, which has a chat of its own: the space's pages, the settings, the plugins' pages. You help the person who works here understand the app, set it up and find their way.

You talk to the person. Answer in their language, briefly and warmly: a few sentences, a short list where it helps. Never mention JSON, ids, keys or tool names. Call it a space, never a project: the tools say project, the app says space. Name the studio's parts and pages as the studio shows them in the person's language.

${PRIMER}

WHAT YOU KNOW
- How the app works: from the guides of this installed version. Before you explain how something works, docs_search (and docs_read a page); link the page you used (engenty.ai/docs/…). How wizards are written: authoring_guide. Never guess at a menu, a button or a feature.
- Live data only from tools, never from memory: gallery_search / gallery_detail for templates, plans for plans and prices, account for the person, team, plan and credits, usage for what was spent, wizards and runs for the space, models for what thinks and makes here.
- Templates you recommend or talk about: show_templates them, in your order, with your answer. The cards show title, pitch, time, cost and formats: your text says in a line why each fits, never repeats what the card shows.
- You never buy, upgrade, top up or change a plan or a setting that costs money. Explain it, then open the page where the person does it (navigate, or give the billing page's link).
- Earlier chats: their summaries come with every message. chats_search and chat_read find more when the person refers to something said before.

THE PAGE
- Every message comes with the page the person writes from: its address, title, the section in view, an open item, what is selected, a line on what it holds and its fields. Answer about what they see; "this" and "here" mean that page.
- In the browser you may: navigate (open a studio page), highlight (dim the page except one element, or ring it, with a short card), look_at_page (what is visible: headings, buttons, fields with their values), read_section (one area in full), fill_field (put a value into a field, not saved), scroll_to. A page may add tools of its own (filter its list, show a week): use them to show what you talk about. A page you open during an answer brings its tools too: navigate and look_at_page list them, page_tool runs them. Targets are what look_at_page lists.
- Show rather than describe: open the page and highlight the place when the person asks where or how. look_at_page first when you are not sure what is there.
- fill_field never saves: say that the person checks and saves. You never press buttons for the person.

THE SPACE
- Where a space's tools are there, you also fill the space in: what every wizard of the space draws on — who they are (title, about), the brand (logos, colours), assets (images, graphics, videos), documents, and facts (label → value: address, VAT ID, phone, opening hours — anything). The space as it is now comes with every message then; you change it ONLY through tools.
- A website: read_website it first. You get the page's text, colours from its stylesheet, logo candidates and the links to imprint / contact / about. Read those pages too (at most four more) for address, VAT ID, register number, phone, email, bank details, who runs it.
- Facts: one fact per thing, a short label in the person's language ("Adresse", "USt-IdNr.", "Telefon"), the value on one line where it fits. Only what a source or the person states — never guess, never invent. Keep the facts that are there; a fact with a known label is updated.
- About: two to five sentences — what they do, for whom, what sets them apart, the tone they write in. Rewrite it only when you learned something new or the person asks.
- Colours: two to six, the main one first, each with a name that says what it is for ("Primär", "Hintergrund", "Text"). Take them from the stylesheet's variables or its most used colours, never from photos. set_colors replaces the list: pass all colours that should remain. Colours in no section are the standard ones; the first of them is the accent. Colour sections are optional like logo sections: only for a further palette a brand guide or the person names for its own use ("Illustration – drawings and charts"), never for the standard colours. A brand's gradients (set_gradients, as CSS) only where a brand guide or the site's stylesheet has them; patterns and background fills are pictures the person uploads.
- Logos: save the best candidate (an SVG or a large PNG rather than a favicon); a second one only if it truly differs (for dark ground, a signet). A few images that show the business (header, team, products) may be saved as assets — a handful, never everything.
- Logo sections and rules are optional, and most spaces need neither. Logos in no section are the standard ones; the first of them is the main logo. Add a section (set_logo_sections) only for further variants that a brand guide, a brand or press page or the person says are used elsewhere: the title names the variant ("Logomark", "Wordmark"), the description says when to use it ("Small spaces: app icons, favicons"). The standard logos never go into a section; one logo, or a light and a dark one whose descriptions already tell them apart, get no sections. Rules (set_rules, for the logos, the colours or the type) are short rows, one rule each, with a sign: do ("Keep clear space of the mark's height on all sides"), dont ("Place it on photos"), important, question (something to check with the person), number (steps in order), or none for a plain note (minimum size, file formats). Only what such a source or the person states; never invent rules and never write general advice a brand guide did not say.
- Typography: the brand's fonts (set_typography), each with what it is for ("Headings", "Body text") and the weights it uses — from the website's stylesheet (read_website lists its fonts) or a brand guide; system and generic faces are no brand fonts. A font's licence and what it may be used for (web, documents, print, images, video) only where a brand guide, the font's own page or the person says so; the wizards keep to it. A type scale (text styles: name, size, weight, line height, letter spacing) only when a brand guide gives one.
- Asset sections are optional too: tabs of one kind each ("Icons", "Background images"), made with set_asset_sections only when the space holds enough assets of clearly different kinds or the person asks; a handful of pictures stay in the general tab.
- Files the person attached are stored already; the message names them. look_at_file shows you a picture or a document's text. Give a file a description with describe_file when it has none or the person says what it is. Take facts from a document when asked.
- Knowledge is what the wizards' steps look things up in: pages, tables and files, kept apart by typed categories. Documents the person attaches are read into Knowledge by themselves: say so; do not copy their text into facts unless asked. A website, a sitemap or a folder whose entries should go into Knowledge is a source: where a tool proposes sources, use it (the person takes the proposal on its card); where there is none, say that sources need the Sources plugin.
- Talking from another page than Info & brand, change title, about, logos, colours and facts only when the person asks.
- A space that is read-only (synced from a local install, or a team that builds elsewhere) has no tools: say where it is changed.

HOW YOU WORK
- Call independent tools together. Work in few steps.
- Finish with one to three sentences: what you did or found, what is still open, and at most one question.`;

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

async function projectState(userId: string, projectId: string) {
  const p = await ownedProject(userId, projectId);
  const files = await projectFiles(projectId);
  const categories = await categoryRows(projectId);
  return {
    knowledge: {
      ...(await knowledgeCounts(projectId)),
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

function spaceTools(
  input: AssistantInput,
  project: ProjectRow,
  wrote: () => void,
  on: BrandSwitches,
) {
  const { signal } = input;
  const userId = input.user.id;
  const projectId = project.id;
  // Said from inside the tool: an installed AI client runs tools without the stream showing it.
  const doing = (tool: string, args: Record<string, unknown> = {}) => {
    const label = activity(tool, args, input.lang);
    if (label) {
      input.onActivity?.(label);
    }
  };
  // Tools of one step run together; writes to the project's row take turns.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = turn.then(run, run);
    turn = next.catch(() => undefined);
    return next;
  };
  const tools: Record<string, any> = {
    read_website: createTool({
      id: "read_website",
      description:
        "Read a public web page: its text as Markdown, the colours of its stylesheet (named variables and the most used ones), logo candidates and images with their addresses, and the links to imprint, contact and about pages.",
      inputSchema: z.object({ url: z.string().describe("The page's address") }),
      execute: ({ url }) => {
        doing("read_website", { url });
        return attempt(() => readWebsite(url, signal));
      },
    }),
    set_profile: createTool({
      id: "set_profile",
      description:
        "Set the project's title (the company, brand or undertaking) and/or its about text.",
      inputSchema: z.object({
        title: z.string().max(120).optional(),
        about: z.string().max(8000).optional(),
      }),
      execute: ({ title, about }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_profile");
            await updateProject(userId, projectId, {
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
      description:
        "Add facts to the project, or update the ones whose label is already there. A fact is a label and a value.",
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
            const p = await ownedProject(userId, projectId);
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
            if (next.length > PROJECT_LIMITS.facts) {
              throw new Error(`A project holds at most ${PROJECT_LIMITS.facts} facts.`);
            }
            await updateProject(userId, projectId, { facts: next });
            wrote();
            return { ok: true, facts: next.length };
          }),
        ),
    }),
    remove_facts: createTool({
      id: "remove_facts",
      description: "Remove facts by their labels. Only when the admin asks or a fact is wrong.",
      inputSchema: z.object({ labels: z.array(z.string()).min(1) }),
      execute: ({ labels }) =>
        attempt(() =>
          inTurn(async () => {
            doing("remove_facts");
            const p = await ownedProject(userId, projectId);
            const gone = new Set(labels.map((l) => l.trim().toLowerCase()));
            const next = p.facts.filter((f) => !gone.has(f.label.toLowerCase()));
            await updateProject(userId, projectId, { facts: next });
            wrote();
            return { ok: true, removed: p.facts.length - next.length };
          }),
        ),
    }),
    set_colors: createTool({
      id: "set_colors",
      description:
        "Set the brand's colours — the whole list, the main colour first. Values as #rrggbb. Optional: `sections` for a further palette of its own use (its title), and on a colour the `section` title it belongs to; colours without one are the standard ones. Without `sections` the space keeps its sections.",
      inputSchema: z.object({
        colors: z
          .array(
            z.object({
              name: z.string().max(120),
              value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
              section: z.string().max(80).optional().describe("A section's title"),
            }),
          )
          .max(PROJECT_LIMITS.colors),
        sections: z
          .array(z.object({ title: z.string().min(1).max(80) }))
          .max(PROJECT_LIMITS.logoSections)
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
            const p = await ownedProject(userId, projectId);
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
            await updateProject(userId, projectId, {
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
      description:
        "Optional. Put further logo variants into sections, each with a title and when to use it (Logomark, Wordmark, Monochrome). Logos in no section are the standard ones and come first — never put those into a section. Use it only when a brand guide, a brand page or the person says a variant is used elsewhere — one logo or two plain variants need none. Replaces all sections: pass every section that should remain, an empty list removes them.",
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
          .max(PROJECT_LIMITS.logoSections),
      }),
      execute: ({ sections }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_logo_sections");
            const logos = (await projectFiles(projectId, "logo")).map((f) => f.id);
            const unknown = sections.flatMap((s) => s.logos).filter((id) => !logos.includes(id));
            if (unknown.length) {
              throw new Error(`Not a logo of this space: ${unknown.join(", ")}`);
            }
            await updateProject(userId, projectId, {
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
      description:
        "Optional. Sort the space's assets into sections, each shown as a tab named by its title (Icons, Background images, Team photos). Assets in no section stay in the general tab. Use it only when there are enough assets of clearly different kinds, or the person asks. Replaces all sections: pass every section that should remain, an empty list removes them.",
      inputSchema: z.object({
        sections: z
          .array(
            z.object({
              title: z.string().min(1).max(80),
              assets: z.array(z.string()).describe("Ids of the space's asset files, in order"),
            }),
          )
          .max(PROJECT_LIMITS.logoSections),
      }),
      execute: ({ sections }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_asset_sections");
            const assets = (await projectFiles(projectId, "asset")).map((f) => f.id);
            const unknown = sections.flatMap((s) => s.assets).filter((id) => !assets.includes(id));
            if (unknown.length) {
              throw new Error(`Not an asset of this space: ${unknown.join(", ")}`);
            }
            await updateProject(userId, projectId, {
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
      description:
        "Set the brand's fonts — the whole list, the main one first — each with what it is for, its weights and, where a source says so, its licence and what it may be used for. Optional: `textStyles`, the type scale a brand guide gives (name, font family, size px, weight, line height %, letter spacing %); without it the space keeps its text styles.",
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
          .max(PROJECT_LIMITS.fonts),
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
          .max(PROJECT_LIMITS.textStyles)
          .optional(),
      }),
      execute: ({ fonts, textStyles }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_typography");
            const p = await ownedProject(userId, projectId);
            const faces = fonts.map((f) => ({
              ...f,
              id: p.brand.fonts?.find((x) => x.family === f.family)?.id ?? nanoid(10),
            }));
            await updateProject(userId, projectId, {
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
      description:
        "Optional. Set the brand's gradients, as a brand guide or the site's stylesheet gives them: each with a name, when to use it where the source says so, and its CSS (linear-, radial- or conic-gradient with hex stops). They go into a gradients section, made when there is none with that title. Replaces the gradients of that section.",
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
          .max(PROJECT_LIMITS.gradients),
      }),
      execute: ({ section, gradients }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_gradients");
            const p = await ownedProject(userId, projectId);
            const sections = p.brand.colorSections ?? [];
            const found = sections.find((s) => s.title === section && s.kind === "gradients");
            const id = found?.id ?? nanoid(10);
            const parsed = gradients.map((g) => ({ g, read: parseGradient(g.css) }));
            const bad = parsed.filter((x) => !x.read).map((x) => x.g.name);
            if (bad.length) {
              throw new Error(`Not a gradient with hex stops: ${bad.join(", ")}`);
            }
            await updateProject(userId, projectId, {
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
      description:
        "Optional. Set how the logos, the colours or the type may be used: one short rule per row, with its sign (do, dont, important, question, number; none for a plain note). Only rules a brand guide, the website or the person states — never invented ones, never general advice. Replaces that list; an empty list removes it.",
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
          .max(PROJECT_LIMITS.logoRules),
      }),
      execute: ({ of, rules }) =>
        attempt(() =>
          inTurn(async () => {
            doing("set_rules");
            await updateProject(userId, projectId, {
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
      description:
        "Fetch a file from a public address into the project: a logo, an asset (image, graphic, video) or a document (PDF, Word, Excel, CSV, text). Documents are read and indexed afterwards.",
      inputSchema: z.object({
        url: z.string(),
        kind: z.enum(PROJECT_FILE_KINDS),
        description: z
          .string()
          .max(600)
          .optional()
          .describe("One sentence: what it shows or holds, and what it suits"),
      }),
      execute: ({ url, kind, description }) =>
        attempt(async () => {
          doing("save_file", { kind });
          const row = await addProjectFileFromUrl(projectId, { url, kind, description, signal });
          wrote();
          return { ok: true, id: row.id, name: row.name, mime: row.mime, size: row.size };
        }),
    }),
    describe_file: createTool({
      id: "describe_file",
      description: "Set the description of one of the project's files.",
      inputSchema: z.object({ id: z.string(), description: z.string().max(600) }),
      execute: ({ id, description }) =>
        attempt(async () => {
          doing("describe_file");
          await updateProjectFile(projectId, id, { description });
          wrote();
          return { ok: true };
        }),
    }),
    look_at_file: createTool({
      id: "look_at_file",
      description:
        "Look at one of the project's files: a picture is shown to you, a document comes as text.",
      inputSchema: z.object({
        id: z.string(),
        from: z.number().int().min(0).optional().describe("Documents: character to start at"),
      }),
      execute: ({ id, from }) =>
        attempt(async () => {
          doing("look_at_file");
          const { row, data } = await projectFileContent(projectId, id);
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
  const m = route.match(/^\/space\/(info|knowledge|data|results)/);
  return m ? m[1] : route === "/space" ? "info" : null;
}

/** How large each tool is in the prompt: its description and its schema, in characters. */
function toolSizes(tools: Record<string, any>): AssistantPrompt["tools"] {
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
  const resolved = await textModel("high");
  const wrote = () => {
    changes++;
    input.onChanged?.();
  };
  const cards: AssistantCardRecord[] = [];
  const { project } = input;
  const space = project && input.writable ? project : null;
  const switches = await currentFeatures();
  const brandOn: BrandSwitches = {
    brandSections: switches.brandSections === true,
    brandRules: switches.brandRules === true,
    typography: switches.typography === true,
  };
  const tools: Record<string, any> = {
    ...knowsTools({
      user: input.user,
      project: project
        ? { id: project.id, name: project.name, mcpServers: project.mcpServers }
        : null,
      lang: input.lang,
      chatId: input.chat.id,
      doing: (label) => input.onActivity?.(label),
      card: (card) => {
        cards.push(card);
        input.onCard?.(card);
      },
    }),
    ...(space ? spaceTools(input, space, wrote, brandOn) : {}),
  };
  // What the tenant's plugins let the assistant do besides: a source of knowledge, say.
  if (space) {
    Object.assign(
      tools,
      await assistantToolsOf({
        tenantId: currentTenant(),
        space: { id: space.id, name: space.name },
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
  attachTools(resolved, tools);
  const agent = new Agent({
    id: "studio-assistant",
    name: "Studio assistant",
    instructions: {
      role: "system",
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    model: agentModel(resolved),
    tools,
  });
  const page = input.page;
  const pluginPage =
    page?.plugin && project
      ? await assistantPageOf(currentTenant(), page.plugin, { id: project.id, name: project.name })
      : null;
  const part = page ? partOf(page.route) : null;
  const { history } = input;
  const context = [
    history.earlier.length
      ? `Earlier chats with this person, newest first (chats_search finds more):\n${history.earlier
          .map(
            (c) => `- ${c.closedAt.slice(0, 10)} "${c.title}": ${c.summary.replace(/\n+/g, " ")}`,
          )
          .join("\n")}`
      : "",
    history.running ? `What this chat said before the messages above:\n${history.running}` : "",
    page
      ? `Current page:\n\`\`\`json\n${JSON.stringify(page)}\n\`\`\``
      : "The person writes from a page that tells nothing about itself.",
    pluginPage
      ? [
          `The page is the plugin "${pluginPage.name}"'s${pluginPage.description ? `: ${pluginPage.description}` : "."} They most likely mean what that page holds: use its tools first (their names begin with "${page?.plugin?.replace(/-/g, "_")}_"). Space settings stay possible when they ask for them.`,
          ...pluginPage.blocks,
        ].join("\n\n")
      : "",
    space
      ? `The space now:\n\`\`\`json\n${JSON.stringify(await projectState(input.user.id, space.id))}\n\`\`\``
      : project
        ? `The space "${project.name}" is read-only here: nothing of it can be changed in this studio.`
        : "No space is open.",
    part === "knowledge"
      ? "The person talks to you from Knowledge: they want the wizards to know something."
      : "",
    space && !(brandOn.brandSections && brandOn.brandRules && brandOn.typography)
      ? `Not in this studio (no tools for it; never offer it): ${[
          brandOn.brandSections ? "" : "sections of logos and colours, gradients and patterns",
          brandOn.brandRules ? "" : "rules for logos, colours and type",
          brandOn.typography ? "" : "typography (fonts, type scale)",
        ]
          .filter(Boolean)
          .join("; ")}.`
      : "",
    input.message,
  ]
    .filter(Boolean)
    .join("\n\n");
  input.onPrompt?.({
    model: resolved.ref,
    system: SYSTEM,
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
