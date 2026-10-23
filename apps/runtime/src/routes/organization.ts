import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  addTenantDomain,
  cancelInvitation,
  changeTenantAddress,
  checkTenantAddress,
  createTenantKey,
  deleteTenantKey,
  inviteMember,
  ManageError,
  managed,
  removeMember,
  removeTenantDomain,
  setMemberRole,
  tenantAddress,
  tenantBilling,
  tenantBillingActivity,
  tenantInvoicePdf,
  tenantKeys,
  verifyTenantDomain,
} from "../manage.js";
import { requestLang, say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

const role = z.enum(["owner", "admin", "member"]);

/** The Manage-App's answer, or its refusal with its status and code. */
async function answer(c: Context, work: Promise<unknown>) {
  try {
    return c.json(await work);
  } catch (err) {
    if (err instanceof ManageError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  }
}

/**
 * The organization's people, changed from the studio's settings: the runtime asks the Manage-App
 * for the person signed in, and the Manage-App checks their role (docs/manage-contract.md). A
 * refusal keeps its status and code; the studio says it in its own words.
 */
export const organizationRoutes = new Hono<Vars>()
  .use(async (c, next) => {
    if (!managed) {
      return c.json({ error: say(c, "onlyAvailableCloud"), code: "not_managed" }, 404);
    }
    await next();
  })
  .post("/invitations", async (c) => {
    const user = c.get("user");
    const body = z
      .object({ email: z.string().trim().email().max(254), role: role.default("member") })
      .parse(await c.req.json());
    const lang = requestLang(c) === "en" ? "en" : "de";
    return answer(c, inviteMember(user.tenantId, { actorId: user.id, ...body, lang }));
  })
  .delete("/invitations/:id", async (c) => {
    const user = c.get("user");
    return answer(c, cancelInvitation(user.tenantId, user.id, c.req.param("id")));
  })
  .patch("/members/:userId", async (c) => {
    const user = c.get("user");
    const body = z.object({ role }).parse(await c.req.json());
    return answer(c, setMemberRole(user.tenantId, user.id, c.req.param("userId"), body.role));
  })
  .delete("/members/:userId", async (c) => {
    const user = c.get("user");
    return answer(c, removeMember(user.tenantId, user.id, c.req.param("userId")));
  })
  .get("/address", async (c) => {
    const user = c.get("user");
    return answer(c, tenantAddress(user.tenantId, user.id));
  })
  .get("/address/check", async (c) =>
    answer(c, checkTenantAddress(c.get("user").tenantId, c.req.query("slug") ?? "")),
  )
  .put("/address", async (c) => {
    const user = c.get("user");
    const { slug } = z.object({ slug: z.string().trim().max(64) }).parse(await c.req.json());
    return answer(c, changeTenantAddress(user.tenantId, user.id, slug));
  })
  .post("/domains", async (c) => {
    const user = c.get("user");
    const { domain } = z.object({ domain: z.string().max(260) }).parse(await c.req.json());
    return answer(c, addTenantDomain(user.tenantId, user.id, domain));
  })
  .post("/domains/:id/verify", async (c) => {
    const user = c.get("user");
    return answer(c, verifyTenantDomain(user.tenantId, user.id, c.req.param("id")));
  })
  .delete("/domains/:id", async (c) => {
    const user = c.get("user");
    return answer(c, removeTenantDomain(user.tenantId, user.id, c.req.param("id")));
  })
  .get("/keys", async (c) => {
    const user = c.get("user");
    return answer(c, tenantKeys(user.tenantId, user.id));
  })
  .post("/keys", async (c) => {
    const user = c.get("user");
    const { name } = z.object({ name: z.string().trim().min(1).max(32) }).parse(await c.req.json());
    return answer(c, createTenantKey(user.tenantId, user.id, name));
  })
  .delete("/keys/:id", async (c) => {
    const user = c.get("user");
    return answer(c, deleteTenantKey(user.tenantId, user.id, c.req.param("id")));
  })
  .get("/billing", async (c) => {
    const user = c.get("user");
    return answer(c, tenantBilling(user.tenantId, user.id));
  })
  .get("/billing/activity", async (c) => {
    const user = c.get("user");
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(c.req.query());
    return answer(c, tenantBillingActivity(user.tenantId, user.id, q));
  })
  // The invoice's PDF lies at Stripe: the studio's link goes there by way of this address.
  .get("/invoices/:id/pdf", async (c) => {
    const user = c.get("user");
    try {
      const { url } = await tenantInvoicePdf(user.tenantId, user.id, c.req.param("id"));
      return c.redirect(url);
    } catch (err) {
      if (err instanceof ManageError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400);
      }
      throw err;
    }
  });
