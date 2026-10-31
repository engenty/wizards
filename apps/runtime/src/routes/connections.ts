import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { inAudience } from "../broker/index.js";
import { namesOf } from "../connectors/person-sign-ins.js";
import {
  connectionPatchSchema,
  createSpaceConnection,
  newConnectionSchema,
  removeSignIn,
  removeSpaceConnection,
  type SignInAs,
  signInWithCredentials,
  spaceConnectionViews,
  startSpaceConnectionOAuth,
  updateSpaceConnection,
} from "../connectors/space-connections.js";
import { isAdminRole } from "../services/access.js";
import { ownedSpace } from "../services/spaces.js";
import { requestLang } from "./lang.js";

/**
 * The connections of a space for the studio (docs/plans/capabilities.md, "Connections"), under
 * `/api/studio`. Everyone in the organization reads the list, a member the connections within
 * their audience; setting up, changing, removing and signing in as the space is for its admins
 * (403 for a member). A member signs in to a connection in which each person signs in themselves,
 * if it is open to them. Fähigkeiten › Connectors draws them.
 */

type Vars = { Variables: { user: SessionUser } };

/** A sign-in: the keys the person typed, or a request for the provider's sign-in page. */
const signInSchema = z.union([
  z.object({ credentials: z.record(z.string(), z.string().max(500)) }),
  z.object({ oauth: z.literal(true) }),
]);

const asSpace: SignInAs = { as: "space" };

/** The connections this person sees, with the name of who set each up. */
async function views(user: SessionUser, spaceId: string) {
  const admin = isAdminRole(user.role);
  const all = await spaceConnectionViews(spaceId, user.id);
  const shown = admin
    ? all
    : all.filter((v) => inAudience(v.audience, { kind: "person", id: user.id }));
  const names = shown.some((v) => v.setUpBy) ? await namesOf(user) : null;
  return shown.map((v) => ({
    ...v,
    setUpByName: v.setUpBy ? (names?.get(v.setUpBy) ?? null) : null,
  }));
}

const asMe = (user: SessionUser): SignInAs => ({ as: "person", userId: user.id, role: user.role });

export const connectionRoutes = new Hono<Vars>()
  .get("/spaces/:id/connections", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    return c.json({ connections: await views(c.get("user"), space.id) });
  })
  .post("/spaces/:id/connections", async (c) => {
    const user = c.get("user");
    const space = await ownedSpace(user.id, c.req.param("id"));
    const row = await createSpaceConnection(
      user.id,
      space.id,
      newConnectionSchema.parse(await c.req.json()),
    );
    const [view] = (await views(user, space.id)).filter((v) => v.id === row.id);
    return c.json(view);
  })
  .patch("/connections/:id", async (c) => {
    const user = c.get("user");
    const row = await updateSpaceConnection(
      user.id,
      c.req.param("id"),
      connectionPatchSchema.parse(await c.req.json()),
    );
    const [view] = (await views(user, row.spaceId)).filter((v) => v.id === row.id);
    return c.json(view);
  })
  .delete("/connections/:id", async (c) => {
    await removeSpaceConnection(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  // As the space: the admins' sign-in, kept on the connection itself.
  .post("/connections/:id/sign-in", async (c) => signIn(c, asSpace))
  .delete("/connections/:id/sign-in", async (c) => {
    await removeSignIn(c.req.param("id"), asSpace);
    return c.json({ ok: true });
  })
  // Each person themselves: this person's own sign-in.
  .post("/connections/:id/my-sign-in", async (c) => signIn(c, asMe(c.get("user"))))
  .delete("/connections/:id/my-sign-in", async (c) => {
    await removeSignIn(c.req.param("id"), asMe(c.get("user")));
    return c.json({ ok: true });
  });

async function signIn(c: Context<Vars>, as: SignInAs) {
  const body = signInSchema.parse(await c.req.json());
  if ("oauth" in body) {
    const url = await startSpaceConnectionOAuth(c.req.param("id") ?? "", as, requestLang(c));
    return c.json({ url });
  }
  const { label } = await signInWithCredentials(c.req.param("id") ?? "", as, body.credentials);
  return c.json({ ok: true, label });
}
