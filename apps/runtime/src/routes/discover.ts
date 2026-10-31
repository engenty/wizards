import type { DiscoverAnswer } from "@engenty/wizards-shared/discover";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { discover } from "../services/discover.js";
import { say } from "./lang.js";

/**
 * Fähigkeiten › Entdecken for the studio, under `/api/studio`: one search over skills.sh and
 * integrations.sh (docs/plans/capabilities.md, part B6).
 */

type Vars = { Variables: { user: SessionUser } };

export const discoverRoutes = new Hono<Vars>().get("/spaces/:id/discover", async (c) => {
  const q = z.string().max(200).catch("").parse(c.req.query("q"));
  const found = await discover(c.get("user").id, c.req.param("id"), q);
  const answer: DiscoverAnswer = {
    skills: found.skills,
    connectors: found.connectors,
    errors: {
      ...(found.errors.skills ? { skills: say(c, found.errors.skills) } : {}),
      ...(found.errors.connectors ? { connectors: say(c, found.errors.connectors) } : {}),
    },
  };
  return c.json(answer);
});
