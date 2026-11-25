import { Hono } from "hono";
import type { SessionUser } from "../auth/index.js";
import { feature, remoteFeatures } from "../features.js";
import { ManageError, managed, teamHome, teamHomePass } from "../manage.js";
import { isAdminRole } from "../services/access.js";
import { bellOpened, criticalsFor } from "../services/broker-bell.js";
import { runsFor } from "../services/work-runs.js";
import { say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

/**
 * Work (behind `workMode`): its chats are the chats of the team's Bot Server (wizards.bot), whose
 * own page the studio shows. The runtime says where that server is and fetches the pass that
 * pairs the person's browser with it; the bell lists what waits for the person in the studio.
 */
export const workRoutes = new Hono<Vars>()
  .use(async (c, next) => {
    if (!feature("workMode", await remoteFeatures().catch(() => null))) {
      return c.json({ error: say(c, "notFound"), code: "not_found" }, 404);
    }
    await next();
  })
  // Where the team's Bot Server is. `may`: the person runs it, so they chat there; a member's
  // and a client's chats on it are not built. A runtime without a Manage-App has none.
  .get("/home", async (c) => {
    const user = c.get("user");
    if (!managed) {
      return c.json({ state: "unmanaged" });
    }
    return c.json({ ...(await teamHome(user.tenantId, user.id)), may: isAdminRole(user.role) });
  })
  // The address the studio shows: the server's page, with the pass that pairs this browser as
  // the person. A person's own server takes no pass and asks for its code itself.
  .post("/home/pass", async (c) => {
    const user = c.get("user");
    if (!(managed && isAdminRole(user.role))) {
      return c.json({ error: say(c, "notFound"), code: "not_found" }, 404);
    }
    try {
      return c.json(await teamHomePass(user.tenantId, user.id), 200, {
        "cache-control": "no-store",
      });
    } catch (err) {
      if (err instanceof ManageError && (err.status === 404 || err.status === 409)) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
  })
  // The bell: the runs that wait for the person, and for an admin the broker's critical lines.
  .get("/approvals", async (c) => {
    const user = c.get("user");
    return c.json({ runs: await runsFor(user), ...(await criticalsFor(user)) });
  })
  .post("/approvals/seen", async (c) => {
    await bellOpened(c.get("user"));
    return c.json({ ok: true });
  });
