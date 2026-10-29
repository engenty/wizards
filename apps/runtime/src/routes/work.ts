import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { feature, remoteFeatures } from "../features.js";
import {
  addMember,
  createChat,
  createSection,
  deleteChat,
  deleteSection,
  moveSection,
  postMessage,
  readChat,
  removeMember,
  renameSection,
  setChatState,
  sidebar,
  updateChat,
} from "../services/work-chats.js";
import { say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

const name = z.string().trim().min(1).max(120);
const member = z.object({ kind: z.enum(["person", "engenty"]), id: z.string().min(1).max(80) });

/** Work's chats and their sections (docs: engenty-dev concepts, work mode), behind `workMode`. */
export const workRoutes = new Hono<Vars>()
  .use(async (c, next) => {
    if (!feature("workMode", await remoteFeatures().catch(() => null))) {
      return c.json({ error: say(c, "notFound"), code: "not_found" }, 404);
    }
    await next();
  })
  .get("/chats", async (c) => {
    const { space, q } = z
      .object({ space: z.string().min(1), q: z.string().max(200).optional() })
      .parse(c.req.query());
    return c.json(await sidebar(c.get("user"), space, q));
  })
  .post("/chats", async (c) => {
    const body = z
      .object({
        spaceId: z.string().min(1).optional(),
        title: z.string().max(120).optional(),
        sectionId: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
        private: z.boolean().optional(),
      })
      .refine((b) => b.spaceId || b.parentId)
      .parse(await c.req.json());
    return c.json(await createChat(c.get("user"), body));
  })
  .get("/chats/:id", async (c) => c.json(await readChat(c.get("user"), c.req.param("id"))))
  .patch("/chats/:id", async (c) => {
    const patch = z
      .object({
        title: z.string().max(120).optional(),
        sectionId: z.string().nullable().optional(),
        private: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(await updateChat(c.get("user"), c.req.param("id"), patch));
  })
  .delete("/chats/:id", async (c) => {
    await deleteChat(c.get("user"), c.req.param("id"));
    return c.json({ ok: true });
  })
  .put("/chats/:id/state", async (c) => {
    const patch = z
      .object({
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        read: z.boolean().optional(),
      })
      .parse(await c.req.json());
    await setChatState(c.get("user"), c.req.param("id"), patch);
    return c.json({ ok: true });
  })
  .post("/chats/:id/messages", async (c) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(8000) })
      .parse(await c.req.json());
    return c.json(await postMessage(c.get("user"), c.req.param("id"), text));
  })
  .post("/chats/:id/members", async (c) => {
    const { kind, id } = member.parse(await c.req.json());
    await addMember(c.get("user"), c.req.param("id"), kind, id);
    return c.json({ ok: true });
  })
  .delete("/chats/:id/members/:kind/:member", async (c) => {
    const { kind, id } = member.parse({ kind: c.req.param("kind"), id: c.req.param("member") });
    await removeMember(c.get("user"), c.req.param("id"), kind, id);
    return c.json({ ok: true });
  })
  .post("/sections", async (c) => {
    const body = z.object({ spaceId: z.string().min(1), name }).parse(await c.req.json());
    return c.json(await createSection(c.get("user"), body.spaceId, body.name));
  })
  .patch("/sections/:id", async (c) => {
    const body = z.object({ name }).parse(await c.req.json());
    return c.json(await renameSection(c.get("user"), c.req.param("id"), body.name));
  })
  .post("/sections/:id/move", async (c) => {
    const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(await c.req.json());
    await moveSection(c.get("user"), c.req.param("id"), direction);
    return c.json({ ok: true });
  })
  .delete("/sections/:id", async (c) => {
    await deleteSection(c.get("user"), c.req.param("id"));
    return c.json({ ok: true });
  });
