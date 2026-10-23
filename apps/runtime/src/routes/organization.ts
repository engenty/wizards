import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  cancelInvitation,
  inviteMember,
  ManageError,
  managed,
  removeMember,
  setMemberRole,
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
  });
