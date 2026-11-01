import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { subjectsOfPerson } from "../broker/rwx.js";
import {
  completeFolder,
  createMount,
  deleteMount,
  listMounts,
  mountAccess,
  mountFileContent,
  mountFiles,
  mountFileThumb,
  mountView,
  pickFolder,
  previewFolder,
  rescanMount,
  updateMount,
} from "../mounts/mounts.js";
import { ownedSpace } from "../services/spaces.js";
import { spaceFileResponse } from "./delivery.js";

/**
 * Dateien for the studio (docs/plans/media-and-files.md, section 3), under `/api/studio`: a
 * space's mounts, their files, opening one, mounting a folder of this computer. Every service
 * answers "not found" while the `dateien` switch is off and on a runtime in the cloud.
 */

type Vars = { Variables: { user: SessionUser } };

const whoOf = (c: Context<Vars>) => subjectsOfPerson(c.get("user").id, c.get("user").role);

const access = {
  see: z.enum(["all", "admins"]),
  wizards: z.union([z.enum(["all", "none"]), z.array(z.string().max(60)).max(200)]),
};

export const dateienRoutes = new Hono<Vars>()
  .get("/spaces/:id/mounts", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    return c.json({ mounts: await listMounts(space.id, whoOf(c)) });
  })
  // The system's folder dialog on this computer; `{ path: false }` where there is none.
  .post("/spaces/:id/mounts/pick", async (c) => {
    await ownedSpace(c.get("user").id, c.req.param("id"));
    const { prompt } = z.object({ prompt: z.string().max(200) }).parse(await c.req.json());
    return c.json({ path: await pickFolder(prompt) });
  })
  .get("/spaces/:id/mounts/folders", async (c) => {
    await ownedSpace(c.get("user").id, c.req.param("id"));
    return c.json({ folders: await completeFolder(c.req.query("path") ?? "") });
  })
  // What a folder holds, for the review before it is mounted.
  .post("/spaces/:id/mounts/preview", async (c) => {
    await ownedSpace(c.get("user").id, c.req.param("id"));
    const { path } = z.object({ path: z.string().min(1).max(1000) }).parse(await c.req.json());
    return c.json(await previewFolder(path));
  })
  .post("/spaces/:id/mounts", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    const body = z
      .object({
        path: z.string().min(1).max(1000),
        name: z.string().max(120).optional(),
        folderCategory: z.string().max(60).nullable().optional(),
        ...access,
      })
      .parse(await c.req.json());
    return c.json(await createMount(c.get("user").id, space.id, body));
  })
  .get("/spaces/:id/mounts/:mountId", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    const mount = await mountView(space.id, c.req.param("mountId"), whoOf(c));
    return c.json({ ...mount, ...(await mountAccess(space.id, mount.id)) });
  })
  .patch("/spaces/:id/mounts/:mountId", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    const body = z
      .object({
        name: z.string().max(120).optional(),
        see: access.see.optional(),
        wizards: access.wizards.optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await updateMount(c.get("user").id, space.id, c.req.param("mountId"), whoOf(c), body),
    );
  })
  .post("/spaces/:id/mounts/:mountId/rescan", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    await rescanMount(space.id, c.req.param("mountId"), whoOf(c));
    return c.json({ ok: true });
  })
  .delete("/spaces/:id/mounts/:mountId", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    await deleteMount(space.id, c.req.param("mountId"));
    return c.json({ ok: true });
  })
  .get("/spaces/:id/mounts/:mountId/files", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    return c.json({ files: await mountFiles(space.id, c.req.param("mountId"), whoOf(c)) });
  })
  // A mounted file's bytes, read where it lives.
  .get("/spaces/:id/mount-files/:fileId/content", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    const { file, data } = await mountFileContent(space.id, c.req.param("fileId"), whoOf(c));
    return spaceFileResponse(c, file.mime, data);
  })
  .get("/spaces/:id/mount-files/:fileId/thumb", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    const thumb = await mountFileThumb(space.id, c.req.param("fileId"), whoOf(c));
    return thumb ? spaceFileResponse(c, "image/jpeg", thumb) : c.notFound();
  });
