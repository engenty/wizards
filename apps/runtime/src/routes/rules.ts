import {
  RWX_FLAGS,
  RWX_LIMITS,
  RWX_RESOURCE_KINDS,
  RWX_SUBJECT_KINDS,
} from "@engenty/wizards-shared/rwx";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { deleteRule, listRules, putRules } from "../broker/rwx.js";

/**
 * The RWX rules of a space for the studio (docs/plans/broker.md, "First: RWX"), under
 * `/api/studio`. Admins only; "not found" while the `broker` switch is off. No page draws them
 * yet: the list is the whole thing, saved as a whole.
 */

type Vars = { Variables: { user: SessionUser } };

const flag = z.enum(RWX_FLAGS).nullable();

const ruleSchema = z.object({
  subjectKind: z.enum(RWX_SUBJECT_KINDS),
  subjectId: z.string().min(1).max(RWX_LIMITS.id).nullable(),
  resourceKind: z.enum(RWX_RESOURCE_KINDS),
  resourceId: z.string().min(1).max(RWX_LIMITS.id),
  r: flag.default(null),
  w: flag.default(null),
  x: flag.default(null),
});

export const ruleRoutes = new Hono<Vars>()
  .get("/spaces/:id/rules", async (c) =>
    c.json({ rules: await listRules(c.get("user").id, c.req.param("id")) }),
  )
  .put("/spaces/:id/rules", async (c) => {
    const { rules } = z
      .object({ rules: z.array(ruleSchema).max(RWX_LIMITS.rules) })
      .parse(await c.req.json());
    return c.json({ rules: await putRules(c.get("user").id, c.req.param("id"), rules) });
  })
  .delete("/spaces/:id/rules/:ruleId", async (c) => {
    await deleteRule(c.get("user").id, c.req.param("id"), c.req.param("ruleId"));
    return c.json({ ok: true });
  });
