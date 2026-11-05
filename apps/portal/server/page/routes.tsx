/** @jsxImportSource hono/jsx */

import { type Context, Hono } from "hono";
import { env } from "../env.js";
import { type Face, hostOf, lookUpFace } from "../face.js";
import { isDemoRun, type PageTeam } from "./data.js";
import { NotBuiltPage, NothingPage, SpacePage } from "./views.js";

/**
 * A team's public pages at `<slug>.wizards.page`, drawn on the server from what the Manage-App
 * answers for the host: the root sends to the team's space, a wizard's address to its run page, a
 * former team address to the current one, anything else shows the "nothing here" page
 * (docs/plans/org-page.md). The client part stays under `/portal`.
 */

/** HTML may be kept a minute. */
const PAGE = { "cache-control": "public, max-age=60" };
const NOT_KEPT = { "cache-control": "no-store" };

const nothing = (c: Context, lang = "de") => c.html(<NothingPage lang={lang} />, 404, PAGE);

/** The team's page as the views take it. */
const teamOf = (face: Face): PageTeam => ({
  slug: face.team.slug,
  name: face.team.name,
  lang: face.team.lang,
  space: face.page,
});

type Env = { Variables: { face: Face | null } };

export const publicPages = new Hono<Env>()
  .use(async (c, next) => {
    const face = await lookUpFace(hostOf(c));
    if (face === "down") {
      return c.html(<NothingPage lang="de" down />, 503, NOT_KEPT);
    }
    if (face?.movedTo) {
      return c.redirect(`${face.movedTo}${c.req.path}`, 301);
    }
    if (face?.paused) {
      return c.html(<NothingPage lang={face.team.lang} paused />, 503, NOT_KEPT);
    }
    c.set("face", face);
    await next();
  })
  .get("/", (c) => {
    const face = c.get("face");
    if (face?.page) {
      return c.redirect(`/${face.page.slug}`, 302);
    }
    // The portal's own origin is no team's: it is where the sign-in comes back.
    return hostOf(c) === new URL(env.portalUrl).hostname
      ? c.redirect("/portal")
      : nothing(c, face?.team.lang);
  })
  .get("/:space", (c) => {
    const face = c.get("face");
    const space = face?.page;
    if (!face || !space || space.slug !== c.req.param("space")) {
      return nothing(c, face?.team.lang);
    }
    return c.html(
      <SpacePage team={teamOf(face)} space={space} siteUrl={space.imprint?.website ?? null} />,
      200,
      PAGE,
    );
  })
  .get("/:space/:wizard", (c) => {
    const face = c.get("face");
    const space = face?.page;
    const wizard = space?.wizards.find((w) => w.slug === c.req.param("wizard"));
    if (!face || !space || space.slug !== c.req.param("space") || !wizard) {
      return nothing(c, face?.team.lang);
    }
    if (isDemoRun(wizard.runUrl)) {
      return c.html(<NotBuiltPage space={space} w={wizard} />, 200, NOT_KEPT);
    }
    return c.redirect(wizard.runUrl, 302);
  })
  .all("*", (c) => nothing(c, c.get("face")?.team.lang));
