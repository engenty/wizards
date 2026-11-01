import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { setOpenToClients } from "../broker/rwx.js";
import {
  addSpaceMember,
  clientOpenOf,
  createClientSpace,
  deleteClientSpace,
  inviteClient,
  listClientSpaces,
  listSpaceMembers,
  removeSpaceMember,
  requireClientSpaces,
  shareWithClient,
  updateClientSpace,
} from "../services/client-spaces.js";

/**
 * Client spaces for the studio (docs/plans/client-spaces.md), under `/api/studio`: a space's
 * client spaces, who is in each, and what of the space its clients reach. "Not found" while the
 * `clientSpaces` switch is off.
 */

type Vars = { Variables: { user: SessionUser } };

const OPEN_KINDS = ["document", "table", "page", "wizard"] as const;

export const clientSpaceRoutes = new Hono<Vars>()
  .get("/spaces/:id/clients", async (c) =>
    c.json({ clients: await listClientSpaces(c.get("user").id, c.req.param("id")) }),
  )
  .post("/spaces/:id/clients", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(await createClientSpace(c.get("user").id, c.req.param("id"), name));
  })
  .patch("/spaces/:id/client", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        slug: z.string().trim().min(1).max(48).optional(),
      })
      .parse(await c.req.json());
    return c.json(await updateClientSpace(c.get("user").id, c.req.param("id"), body));
  })
  // A run of a client space shared with its clients on purpose, or taken back.
  .put("/runs/:id/client-share", async (c) => {
    const { shared } = z.object({ shared: z.boolean() }).parse(await c.req.json());
    return c.json(await shareWithClient(c.get("user").id, c.req.param("id"), shared));
  })
  .delete("/spaces/:id/client", async (c) => {
    await deleteClientSpace(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/spaces/:id/members", async (c) =>
    c.json({ members: await listSpaceMembers(c.get("user").id, c.req.param("id")) }),
  )
  .put("/spaces/:id/members/:userId", async (c) => {
    const { role } = z.object({ role: z.enum(["member", "client"]) }).parse(await c.req.json());
    await addSpaceMember(c.get("user").id, c.req.param("id"), {
      userId: c.req.param("userId"),
      role,
    });
    return c.json({ ok: true });
  })
  .post("/spaces/:id/invite", async (c) => {
    const { email, lang } = z
      .object({
        email: z.string().trim().email().max(254),
        lang: z.enum(["de", "en"]).default("de"),
      })
      .parse(await c.req.json());
    await inviteClient(c.get("user").id, c.req.param("id"), { email, lang });
    return c.json({ ok: true });
  })
  .delete("/spaces/:id/members/:userId", async (c) => {
    await removeSpaceMember(c.get("user").id, c.req.param("id"), c.req.param("userId"));
    return c.json({ ok: true });
  })
  .get("/spaces/:id/open-to-clients", async (c) =>
    c.json({ open: await clientOpenOf(c.get("user").id, c.req.param("id")) }),
  )
  .put("/spaces/:id/open-to-clients", async (c) => {
    await requireClientSpaces();
    const body = z
      .object({ kind: z.enum(OPEN_KINDS), id: z.string().min(1).max(64), open: z.boolean() })
      .parse(await c.req.json());
    await setOpenToClients(
      c.get("user").id,
      c.req.param("id"),
      { kind: body.kind, id: body.id },
      body.open,
    );
    return c.json({ ok: true });
  });
