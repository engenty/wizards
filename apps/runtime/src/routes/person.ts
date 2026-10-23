import { type Context, Hono } from "hono";
import { z } from "zod";
import { renameSessions, type SessionUser } from "../auth/index.js";
import {
  disconnectPersonApp,
  ManageError,
  managed,
  personConnections,
  renamePerson,
  signOutPersonComputer,
} from "../manage.js";
import { say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

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
 * The person's Konto in the cloud studio, behind the avatar: their name and what holds a sign-in
 * of theirs, kept at the Manage-App for every organization (docs/manage-contract.md).
 */
export const personRoutes = new Hono<Vars>()
  .use(async (c, next) => {
    if (!managed) {
      return c.json({ error: say(c, "onlyAvailableCloud"), code: "not_managed" }, 404);
    }
    await next();
  })
  .put("/name", async (c) => {
    const user = c.get("user");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    try {
      const done = await renamePerson(user.id, name);
      await renameSessions(user.id, done.name);
      return c.json(done);
    } catch (err) {
      if (err instanceof ManageError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400);
      }
      throw err;
    }
  })
  .get("/connections", async (c) => answer(c, personConnections(c.get("user").id)))
  .delete("/connections/:id", async (c) =>
    answer(c, disconnectPersonApp(c.get("user").id, c.req.param("id"))),
  )
  .delete("/computers/:id", async (c) =>
    answer(c, signOutPersonComputer(c.get("user").id, c.req.param("id"))),
  );
