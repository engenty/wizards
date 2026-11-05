import {
  RWX_ASK_KINDS,
  RWX_ASK_WHO,
  RWX_FLAGS,
  RWX_LIMITS,
  RWX_PERMS,
  RWX_RESOURCE_KINDS,
  RWX_SUBJECT_KINDS,
  type RwxAnswer,
} from "@engenty/wizards-shared/rwx";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { describeRules, ruleChoices } from "../broker/rights.js";
import { addRule, askRule, changeRule, deleteRule, listRules, rulesSpace } from "../broker/rwx.js";
import { peopleOf } from "./broker.js";

/**
 * The RWX rules of a space for Fähigkeiten › Rechte (docs/plans/capabilities-next.md, piece 3),
 * under `/api/studio`. Admins only; "not found" while the `broker` switch is off.
 *
 * A rule is added, changed and removed one at a time, and no call touches another rule: the start
 * set, a Wissen folder's audience, a mount's form and „Für Kund:innen sichtbar“ write rules of
 * their own. The list says for each where it is set and what its ids are called. A rule no reader
 * would ask is refused with the reason (`RWX_ASKED`), and so is one on a mount, whose form writes
 * them. „Was darf …?“ for content answers by the readers' own decision.
 */

type Vars = { Variables: { user: SessionUser } };

const flag = z.enum(RWX_FLAGS).nullable();

const ruleSchema = z.object({
  subjectKind: z.enum(RWX_SUBJECT_KINDS),
  subjectId: z.string().min(1).max(RWX_LIMITS.id).nullable().default(null),
  resourceKind: z.enum(RWX_RESOURCE_KINDS),
  resourceId: z.string().min(1).max(RWX_LIMITS.id),
  r: flag.default(null),
  w: flag.default(null),
  x: flag.default(null),
});

/** The flags to set; one left out stays as it is. */
const flagsSchema = z
  .object({ r: flag.optional(), w: flag.optional(), x: flag.optional() })
  .refine((f) => RWX_PERMS.some((p) => f[p] !== undefined), "Name at least one of r, w and x.");

const askSchema = z.object({
  who: z.enum(RWX_ASK_WHO),
  /** A person's id (a person, Goose or an AI for them), a wizard's, a plugin's. */
  id: z.string().min(1).max(RWX_LIMITS.id).optional(),
  /** A wizard's run: the person it is held for; left out, a guest. */
  for: z.string().min(1).max(RWX_LIMITS.id).optional(),
  resource: z.enum(RWX_ASK_KINDS),
  resourceId: z.string().min(1).max(RWX_LIMITS.id).optional(),
  perm: z.enum(RWX_PERMS),
});

export const ruleRoutes = new Hono<Vars>()
  .get("/spaces/:id/rules", async (c) => {
    const user = c.get("user");
    const space = await rulesSpace(user.id, c.req.param("id"));
    const rules = await listRules(user.id, space.id);
    return c.json({ rules: await describeRules(space.id, rules, await peopleOf(user)) });
  })
  // What a rule and the question pick from. Before `:ruleId`, which would take it for a rule.
  .get("/spaces/:id/rules/choices", async (c) => {
    const user = c.get("user");
    const space = await rulesSpace(user.id, c.req.param("id"));
    return c.json(await ruleChoices(space.id, await peopleOf(user)));
  })
  .get("/spaces/:id/rules/ask", async (c) => {
    const user = c.get("user");
    const space = await rulesSpace(user.id, c.req.param("id"));
    const { decision, rule } = await askRule(user.id, space.id, askSchema.parse(c.req.query()));
    const [described] = rule ? await describeRules(space.id, [rule], await peopleOf(user)) : [];
    const answer: RwxAnswer = { ok: decision.ok, rule: described ?? null, reason: decision.reason };
    return c.json(answer);
  })
  .post("/spaces/:id/rules", async (c) => {
    const user = c.get("user");
    const space = await rulesSpace(user.id, c.req.param("id"));
    const rule = await addRule(user.id, space.id, ruleSchema.parse(await c.req.json()));
    const [described] = await describeRules(space.id, [rule], await peopleOf(user));
    return c.json({ rule: described });
  })
  .patch("/spaces/:id/rules/:ruleId", async (c) => {
    const user = c.get("user");
    const space = await rulesSpace(user.id, c.req.param("id"));
    const flags = flagsSchema.parse(await c.req.json());
    const rule = await changeRule(user.id, space.id, c.req.param("ruleId"), flags);
    const [described] = await describeRules(space.id, [rule], await peopleOf(user));
    return c.json({ rule: described });
  })
  .delete("/spaces/:id/rules/:ruleId", async (c) => {
    await deleteRule(c.get("user").id, c.req.param("id"), c.req.param("ruleId"));
    return c.json({ ok: true });
  });
