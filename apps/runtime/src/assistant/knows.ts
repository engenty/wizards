import type { Lang } from "@engenty-wizards/shared/definition";
import type { MarketplaceEntry } from "@engenty-wizards/shared/marketplace";
import type { WizardOutline } from "@engenty-wizards/shared/marketplace-entry";
import { createTool } from "@mastra/core/tools";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { accountOverview, accountToken, linkedAccount } from "../auth/account.js";
import type { SessionUser } from "../auth/index.js";
import { authoringGuide } from "../authoring/guide.js";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import type { AssistantCardRecord } from "../db/schema.js";
import { env } from "../env.js";
import { detectHarnesses } from "../harness/index.js";
import { type MonthlyUsage, managed, publicPlans, tenantInfo, tenantUsage } from "../manage.js";
import { classWays, waysIn } from "../models.js";
import { pluginToolsOf } from "../plugins/registry.js";
import { earlierChats, readChat, searchChats } from "../services/assistant-chats.js";
import { asLang, marketplaceDetail, searchMarketplace } from "../services/marketplace.js";
import { listWizards } from "../services/wizards.js";
import { serverText } from "../texts.js";
import { attempt } from "../tools/shared.js";
import { readDoc, searchDocs } from "./docs.js";

/**
 * What the studio assistant knows beyond the page: the guides of this release, the authoring
 * guide, the gallery, the account (plans, credits, usage), the space's wizards and runs, the
 * models, and the person's earlier chats. It reads; it never buys, upgrades or tops up.
 */

export interface KnowsContext {
  user: SessionUser;
  project: { id: string; name: string; mcpServers: { id: string; name: string }[] } | null;
  lang: Lang;
  /** The chat that is open: `chats_search` leaves it out where asked. */
  chatId: string;
  doing(label: string): void;
  /** A card under the answer: the studio's own have no plugin. */
  card(card: AssistantCardRecord): void;
}

/** Where the account lives: the runtime's Manage-App, or the account a local install links. */
const accountBase = () => (managed ? env.manage.url : env.local.accountUrl);

async function usageOf(tenantId: string): Promise<MonthlyUsage | null> {
  if (managed) {
    return tenantUsage(tenantId, 3);
  }
  const token = await accountToken();
  if (!token) {
    return null;
  }
  const res = await fetch(`${env.local.accountUrl}/v1/me/usage?months=3`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`The account answered ${res.status}.`);
  }
  return (await res.json()) as MonthlyUsage;
}

const NOT_LINKED =
  "This install is not linked to an account. Settings › Account signs one in; then credits, cloud publishing and plans apply. Docs and the gallery work without one.";

export function knowsTools(ctx: KnowsContext): Record<string, any> {
  const { user } = ctx;
  // The entries this turn's searches found, so show_templates needs no second request.
  const found = new Map<string, MarketplaceEntry>();
  return {
    docs_search: createTool({
      id: "docs_search",
      description:
        "Search the engenty wizards user guide and plugin guide of this installed version. Gives the best sections with an excerpt and their engenty.ai/docs link. Use it before you explain how something works.",
      inputSchema: z.object({ query: z.string().min(2).max(200) }),
      execute: async ({ query }) => {
        ctx.doing(serverText(ctx.lang, "doingReadGuide"));
        return { hits: searchDocs(query) };
      },
    }),
    docs_read: createTool({
      id: "docs_read",
      description:
        "Read one page of the guides by its id from docs_search (user/steps, dev/plugins/tools), from a character on.",
      inputSchema: z.object({
        page: z.string().min(1).max(200),
        from: z.number().int().min(0).optional(),
      }),
      execute: async ({ page, from }) => {
        ctx.doing(serverText(ctx.lang, "doingReadGuide"));
        return readDoc(page, from ?? 0);
      },
    }),
    authoring_guide: createTool({
      id: "authoring_guide",
      description:
        "The authoring guide the wizard editor and AI apps build with: how a wizard is written (steps, fields, flows, tools, outputs, model classes). Long: read it in parts with `from`.",
      inputSchema: z.object({ from: z.number().int().min(0).optional() }),
      execute: ({ from }) =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingAuthoringGuide"));
          const guide = authoringGuide(
            ctx.project?.mcpServers ?? [],
            ctx.project ? await listConnectors(ctx.project.id) : [],
            await pluginToolsOf(user.tenantId),
          );
          const start = Math.min(from ?? 0, guide.length);
          return {
            text: guide.slice(start, start + 14_000),
            next: start + 14_000 < guide.length ? start + 14_000 : null,
          };
        }),
    }),
    gallery_search: createTool({
      id: "gallery_search",
      description:
        "Search the gallery of wizard templates (engenty.ai/wizards and the plugins' starters): title, pitch, what it needs that this install has no model for, and its price per run in credits.",
      inputSchema: z.object({ query: z.string().max(200).optional() }),
      execute: ({ query }) =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingGallery"));
          const hits = await searchMarketplace({
            q: query ?? "",
            lang: asLang(ctx.lang),
            limit: 8,
          });
          for (const e of hits.entries) {
            found.set(e.id, e);
          }
          return {
            total: hits.total,
            offline: hits.offline,
            entries: hits.entries.map((e) => ({
              id: e.id,
              title: e.title,
              pitch: e.pitch,
              formats: e.formats,
              steps: e.steps,
              credits: e.credits,
              missing: e.missing,
              needsPlugins: e.needs ?? [],
              plugin: e.plugin?.name,
            })),
          };
        }),
    }),
    gallery_detail: createTool({
      id: "gallery_detail",
      description: "One template of the gallery: what it does, its steps, what it makes and needs.",
      inputSchema: z.object({ id: z.string().min(1).max(120) }),
      execute: ({ id }) =>
        attempt(async () => {
          const detail = await marketplaceDetail(id, asLang(ctx.lang));
          if (!detail) {
            return { error: "No such template." };
          }
          const { terms: _terms, hash: _hash, ...rest } = detail;
          return rest;
        }),
    }),
    show_templates: createTool({
      id: "show_templates",
      description:
        "Show templates of the gallery as cards under your answer, in the order given. A card shows the title, the pitch, the time, the cost and what it makes; the person opens it to see the steps and make a wizard of it.",
      inputSchema: z.object({ ids: z.array(z.string().min(1).max(120)).min(1).max(6) }),
      execute: ({ ids }) =>
        attempt(async () => {
          const entries: Omit<MarketplaceEntry, "terms" | "hash">[] = [];
          for (const id of new Set(ids)) {
            const entry = found.get(id) ?? (await marketplaceDetail(id, asLang(ctx.lang)));
            if (!entry) {
              continue;
            }
            // The card needs the entry, not the outline the dialog loads by itself.
            const {
              terms: _terms,
              hash: _hash,
              description: _description,
              outline: _outline,
              results: _results,
              files: _files,
              ...shown
            } = entry as MarketplaceEntry & Partial<WizardOutline>;
            entries.push(shown);
          }
          if (!entries.length) {
            return { error: "None of these templates is in the gallery." };
          }
          ctx.card({ plugin: "", tool: "templates", data: { entries } });
          return { shown: entries.map((e) => e.title) };
        }),
    }),
    plans: createTool({
      id: "plans",
      description:
        "The plans teams can be on (Free, Pro, Team): price a month, monthly credits, limits, and the credit packages to buy on top. Live from the account service.",
      inputSchema: z.object({}),
      execute: () =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingPlans"));
          const plans = await publicPlans(accountBase());
          return { ...plans, billingPage: `${accountBase()}/billing` };
        }),
    }),
    account: createTool({
      id: "account",
      description:
        "The person, their team, their role, the team's plan, the credit balance and credits that end on a date.",
      inputSchema: z.object({}),
      execute: () =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingAccount"));
          if (managed) {
            const info = await tenantInfo(user.tenantId, true);
            return {
              person: { name: user.name, email: user.email, role: user.role },
              team: { name: info.name, plan: info.plan?.name ?? null, status: info.status },
              balanceCredits: Math.floor(info.balanceCredits),
              limits: info.limits,
              billingPage: `${env.manage.url}/billing`,
            };
          }
          if (!(await linkedAccount())) {
            return { linked: false, note: NOT_LINKED };
          }
          const overview = await accountOverview();
          if (!overview) {
            return {
              linked: true,
              signedIn: false,
              note: "The sign-in ran out: Settings › Account signs in again.",
            };
          }
          return {
            linked: true,
            person: overview.user,
            team: { name: overview.tenant.name, role: overview.tenant.role },
            plan: (overview.tenant as { plan?: { name: string } }).plan?.name ?? null,
            balanceCredits: Math.floor(overview.tenant.balanceCredits),
            expiring: overview.tenant.expiring ?? [],
            billingPage: `${env.local.accountUrl}/billing`,
          };
        }),
    }),
    usage: createTool({
      id: "usage",
      description:
        "Credits the team used per month (the last three), and the runs and wizards that cost the most.",
      inputSchema: z.object({}),
      execute: () =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingUsage"));
          if (!(managed || (await linkedAccount()))) {
            return { linked: false, note: NOT_LINKED };
          }
          const usage = await usageOf(user.tenantId);
          if (!usage) {
            return { note: "The sign-in ran out: Settings › Account signs in again." };
          }
          const runIds = [...new Set(usage.months.flatMap((m) => m.runs.map((r) => r.runId)))];
          const runs = runIds.length
            ? await db
                .select({ id: schema.run.id, wizard: schema.wizard.title, mode: schema.run.mode })
                .from(schema.run)
                .innerJoin(schema.wizard, eq(schema.wizard.id, schema.run.wizardId))
                .where(inArray(schema.run.id, runIds))
            : [];
          const byRun = new Map(runs.map((r) => [r.id, r]));
          return {
            months: usage.months.map((m) => {
              const perWizard = new Map<string, number>();
              for (const r of m.runs) {
                const title = byRun.get(r.runId)?.wizard ?? "(a run of another install)";
                perWizard.set(title, (perWizard.get(title) ?? 0) + r.credits);
              }
              return {
                month: m.month,
                credits: m.credits,
                wizards: [...perWizard.entries()]
                  .map(([wizard, credits]) => ({
                    wizard,
                    credits: Math.round(credits * 100) / 100,
                  }))
                  .sort((a, b) => b.credits - a.credits)
                  .slice(0, 10),
              };
            }),
          };
        }),
    }),
    wizards: createTool({
      id: "wizards",
      description:
        "The space's wizards: title, description, published or draft, whether its link is on, steps, last change.",
      inputSchema: z.object({}),
      execute: () =>
        attempt(async () => {
          if (!ctx.project) {
            return { note: "No space is open." };
          }
          return {
            wizards: (await listWizards(user.id, ctx.project.id)).map((w) => ({
              id: w.id,
              title: w.title,
              description: w.description,
              published: w.published,
              linkOn: w.shareEnabled,
              steps: w.stepCount,
              updatedAt: w.updatedAt,
              editor: `/edit/${w.id}`,
            })),
          };
        }),
    }),
    runs: createTool({
      id: "runs",
      description:
        "The space's latest runs, newest first: wizard, test or live, status, the error of a failed one.",
      inputSchema: z.object({
        status: z.enum(["failed", "done", "running", "waiting_input", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(40).optional(),
      }),
      execute: ({ status, limit }) =>
        attempt(async () => {
          if (!ctx.project) {
            return { note: "No space is open." };
          }
          const rows = await db
            .select({
              id: schema.run.id,
              wizard: schema.wizard.title,
              wizardId: schema.wizard.id,
              mode: schema.run.mode,
              status: schema.run.status,
              error: schema.run.error,
              runner: schema.run.runner,
              createdAt: schema.run.createdAt,
            })
            .from(schema.run)
            .innerJoin(schema.wizard, eq(schema.wizard.id, schema.run.wizardId))
            .where(
              and(
                eq(schema.wizard.projectId, ctx.project.id),
                status ? eq(schema.run.status, status) : undefined,
              ),
            )
            .orderBy(desc(schema.run.createdAt))
            .limit(limit ?? 15);
          return {
            runs: rows.map((r) => ({
              ...r,
              error: r.error?.slice(0, 400) ?? null,
              createdAt: r.createdAt.toISOString(),
            })),
          };
        }),
    }),
    models: createTool({
      id: "models",
      description:
        "What thinks and makes for this install, per model class: an installed AI client, an own key, a local model, credits, or nothing (with the problem). Also which AI clients are installed and signed in.",
      inputSchema: z.object({}),
      execute: () =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingModels"));
          return {
            classes: waysIn(await classWays(), "en"),
            clients: managed
              ? []
              : (await detectHarnesses()).map((h) => ({
                  id: h.id,
                  installed: Boolean(h.version),
                  signedIn: h.auth !== "none",
                })),
            page: "/settings/models",
          };
        }),
    }),
    chats_search: createTool({
      id: "chats_search",
      description:
        "Search the person's earlier chats with you (their messages and summaries) for words: what was asked, changed or decided before.",
      inputSchema: z.object({ query: z.string().min(3).max(200) }),
      execute: ({ query }) =>
        attempt(async () => {
          ctx.doing(serverText(ctx.lang, "doingEarlierChats"));
          const hits = (await searchChats(user, query)).filter((h) => h.chatId !== ctx.chatId);
          return {
            hits,
            recent: hits.length
              ? undefined
              : (await earlierChats(user, 10)).map((c) => ({
                  id: c.id,
                  title: c.title,
                  closedAt: c.closedAt,
                })),
          };
        }),
    }),
    chat_read: createTool({
      id: "chat_read",
      description: "Read one earlier chat by its id (from chats_search): its summary and messages.",
      inputSchema: z.object({ id: z.string().min(1).max(40) }),
      execute: ({ id }) =>
        attempt(async () => {
          const chat = await readChat(user, id);
          return {
            title: chat.title,
            summary: chat.summary,
            startedAt: chat.startedAt,
            closedAt: chat.closedAt,
            messages: chat.messages.slice(-40).map((m) => ({
              role: m.role,
              text: m.content.slice(0, 2000),
              at: m.createdAt,
            })),
          };
        }),
    }),
  };
}
