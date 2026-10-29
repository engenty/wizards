import { LANGS } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { createUIMessageStreamResponse } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { feature, remoteFeatures } from "../features.js";
import { reverseGeocode } from "../geocode.js";
import { ServiceError } from "../services/errors.js";
import { composerTools } from "../services/work-ai.js";
import {
  addMember,
  attachFile,
  chatFileContent,
  createChat,
  createSection,
  DEV_CHUNK,
  decideApproval,
  deleteChat,
  deleteSection,
  followTurn,
  moveSection,
  readChat,
  removeMember,
  renameSection,
  seeChat,
  sendMessage,
  setChatState,
  sidebar,
  stopTurn,
  updateChat,
  waitingApprovals,
} from "../services/work-chats.js";
import { FILES_PER_MESSAGE } from "../services/work-files.js";
import { spaceFileResponse } from "./delivery.js";
import { say } from "./lang.js";
import { assistantDevFor } from "./studio.js";

type Vars = { Variables: { user: SessionUser } };

/**
 * A turn of the AI as `useChat` reads it. The developer mode's chunks (the prompt, each step's
 * tokens) go only to a person it is offered to.
 */
async function turnResponse(user: SessionUser, stream: ReadableStream) {
  const dev = await assistantDevFor(user);
  const shown = dev
    ? stream
    : stream.pipeThrough(
        new TransformStream<{ type?: string }, { type?: string }>({
          transform(chunk, controller) {
            if (!chunk.type?.startsWith(DEV_CHUNK)) {
              controller.enqueue(chunk);
            }
          },
        }),
      );
  return createUIMessageStreamResponse({ stream: shown as never });
}

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
  // A file for a message, or for a Field of a view's Form (`uploads`, as the runner's fields call
  // it): it lands in the space's files; the message names it by its id.
  .on("POST", ["/chats/:id/files", "/chats/:id/uploads"], async (c) => {
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) {
      throw new ServiceError("invalid", note("chooseFile"));
    }
    const added = await attachFile(c.get("user"), c.req.param("id"), {
      name: file.name,
      mime: file.type.split(";")[0].trim().toLowerCase(),
      data: new Uint8Array(await file.arrayBuffer()),
    });
    return c.json(added);
  })
  // A file of the chat's space, as a view shows it and a Field's upload shows itself.
  .get("/chats/:id/assets/:file", async (c) => {
    const { row, data } = await chatFileContent(
      c.get("user"),
      c.req.param("id"),
      c.req.param("file"),
    );
    return spaceFileResponse(c, row.mime, data);
  })
  // The address of where the person stands, for a Field asking for the place.
  .post("/chats/:id/geocode", async (c) => {
    const { lat, lng, language } = z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        language: z.enum(LANGS).default("en"),
      })
      .parse(await c.req.json());
    await seeChat(c.get("user"), c.req.param("id"));
    return c.json({ label: await reverseGeocode(lat, lng, language) });
  })
  // A person writes; asked, the space's AI answers with a UI message stream (`useChat`).
  .post("/chats/:id/messages", async (c) => {
    const body = z
      .object({
        text: z.string().trim().max(8000).default(""),
        files: z.array(z.string().min(1)).max(FILES_PER_MESSAGE).optional(),
        ask: z.boolean().optional(),
        later: z.boolean().optional(),
        // What the person chose in the composer for the turn (work-ai.ts `TurnChoice`).
        extra: z.boolean().optional(),
        web: z.boolean().optional(),
        pluginsOff: z.array(z.string().min(1).max(80)).max(50).optional(),
        // A view's Form answered: everyone in the chat may send it (work-ai.ts, show_view).
        form: z
          .object({ call: z.string().min(1).max(200), values: z.record(z.string(), z.unknown()) })
          .refine((f) => JSON.stringify(f.values).length <= 20_000)
          .optional(),
      })
      .refine((b) => b.text || b.files?.length)
      .parse(await c.req.json());
    const { extra, web, pluginsOff } = body;
    const sent = await sendMessage(c.get("user"), c.req.param("id"), body.text, {
      ...body,
      choice: { extra, web, pluginsOff },
    });
    return sent.kind === "turn"
      ? turnResponse(c.get("user"), sent.stream)
      : c.json({ sent: sent.kind });
  })
  .post("/chats/:id/approvals/:approval", async (c) => {
    const { approve } = z.object({ approve: z.boolean() }).parse(await c.req.json());
    const sent = await decideApproval(
      c.get("user"),
      c.req.param("id"),
      c.req.param("approval"),
      approve,
    );
    return sent.kind === "turn"
      ? turnResponse(c.get("user"), sent.stream)
      : c.json({ sent: sent.kind });
  })
  // Follow the AI's running turn from its start, as `useChat`'s resume reads it; 204 when none runs.
  .get("/chats/:id/follow", async (c) => {
    const stream = await followTurn(c.get("user"), c.req.param("id"));
    return stream ? turnResponse(c.get("user"), stream) : c.body(null, 204);
  })
  // What the composer offers for the space's AI's turns: web search, the plugins with tools.
  .get("/composer", async (c) => c.json(await composerTools()))
  .get("/approvals", async (c) => c.json({ approvals: await waitingApprovals(c.get("user")) }))
  .post("/chats/:id/stop", async (c) =>
    c.json({ stopped: await stopTurn(c.get("user"), c.req.param("id")) }),
  )
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
