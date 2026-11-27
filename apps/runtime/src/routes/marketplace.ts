import { FORMAT_VERSIONS } from "@engenty/wizards-shared/definition";
import { CAPABILITY_IDS } from "@engenty/wizards-shared/fit";
import {
  INDUSTRY_IDS,
  ITEM_FORMAT_IDS,
  MARKETPLACE_PLAN_IDS,
  USE_CASE_IDS,
} from "@engenty/wizards-shared/marketplace";
import { sectorOf } from "@engenty/wizards-shared/sectors";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  asLang,
  featuredFirst,
  marketplaceDetail,
  searchMarketplace,
  searchMarketplaceAsGuest,
  starEntry,
} from "../services/marketplace.js";
import { byFit, organizationContext } from "../services/organization-context.js";
import { notFoundAnswer } from "./lang.js";
import { mayChangeRuntime } from "./runtime-settings.js";

const searchSchema = z.object({
  q: z.string().trim().max(200).default(""),
  lang: z.string().optional(),
  useCase: z.enum(USE_CASE_IDS).optional(),
  industry: z.enum(INDUSTRY_IDS).optional(),
  format: z.enum(ITEM_FORMAT_IDS).optional(),
  capability: z.enum(CAPABILITY_IDS).optional(),
  plan: z.enum(MARKETPLACE_PLAN_IDS).optional(),
  version: z.enum(FORMAT_VERSIONS).optional(),
  starred: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v === "1"),
  limit: z.coerce.number().int().min(1).max(100).default(60),
  offset: z.coerce.number().int().min(0).default(0),
  /** `1`: a platform admin's preview, the templates that are not published too. */
  preview: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v === "1"),
  /** `1`: the templates that fit the organization first, as its first visit learned it. */
  fit: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v === "1"),
});

/** The marketplace for someone signed in: the search on "new", an entry, and the stars. */
export const marketplaceStudio = new Hono<{ Variables: { user: SessionUser } }>()
  .get("/", async (c) => {
    const { lang, fit, preview: asked, ...rest } = searchSchema.parse(c.req.query());
    // Only someone who may change the runtime sees what is not published: a platform admin, or
    // whoever runs it on their own computer.
    const search = { ...rest, preview: asked && (await mayChangeRuntime(c.get("user"))) };
    const context = fit ? await organizationContext(c.get("user").tenantId) : null;
    if (!context) {
      const found = featuredFirst(
        await searchMarketplace({ ...search, lang: asLang(lang) }),
        search,
      );
      return c.json({ ...found, context: null });
    }
    // The whole catalog in the order that fits, then the page of it.
    const all = featuredFirst(
      await searchMarketplace({
        lang: asLang(lang),
        limit: 100,
        offset: 0,
        preview: search.preview,
      }),
      {},
    );
    const sector = sectorOf(context.sector);
    return c.json({
      ...all,
      entries: byFit(all.entries, context).slice(search.offset, search.offset + search.limit),
      context: {
        sector: sector?.id ?? null,
        sectorName: sector ? sector.name[asLang(lang) === "de" ? "de" : "en"] : null,
      },
    });
  })
  .get("/:id", async (c) => {
    const preview = c.req.query("preview") === "1" && (await mayChangeRuntime(c.get("user")));
    const detail = await marketplaceDetail(c.req.param("id"), asLang(c.req.query("lang")), preview);
    return detail ? c.json(detail) : c.json(notFoundAnswer(c), 404);
  })
  .put("/:id/star", async (c) => {
    await starEntry(c.get("user").tenantId, c.req.param("id"), true);
    return c.json({ ok: true });
  })
  .delete("/:id/star", async (c) => {
    await starEntry(c.get("user").tenantId, c.req.param("id"), false);
    return c.json({ ok: true });
  });

/** The gallery for someone not signed in (the studio's start page for guests): only the search. */
export const marketplaceGuest = new Hono().get("/", async (c) => {
  const {
    lang,
    starred: _starred,
    preview: _preview,
    ...search
  } = searchSchema.parse(c.req.query());
  return c.json(await searchMarketplaceAsGuest({ ...search, lang: asLang(lang) }));
});
