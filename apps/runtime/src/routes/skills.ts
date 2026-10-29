import { note } from "@engenty/wizards-shared/run";
import { SKILL_LIMITS, SKILL_MODES, SKILL_REF } from "@engenty/wizards-shared/skills";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { ServiceError } from "../services/errors.js";
import {
  copySkill,
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  skillZip,
  updateSkill,
  uploadSkill,
} from "../services/skills.js";
import {
  addRegistrySkill,
  applySkillUpdate,
  previewSkill,
  searchSkills,
  skillUpdate,
} from "../services/skills-registry.js";
import { say } from "./lang.js";

/**
 * The skills of a space for the studio (docs/plans/skills.md), under `/api/studio`. Every
 * service answers "not found" while the `skills` switch is off.
 */

type Vars = { Variables: { user: SessionUser } };

const fileSchema = z.object({
  path: z.string().min(1).max(200),
  text: z.string().max(SKILL_LIMITS.file),
});

const patchSchema = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  body: z.string().max(SKILL_LIMITS.skillMd).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  files: z.array(fileSchema).max(SKILL_LIMITS.files).optional(),
  skillMd: z.string().max(SKILL_LIMITS.skillMd).optional(),
  mode: z.enum(SKILL_MODES).optional(),
  runScripts: z.boolean().optional(),
});

// A skill is 1 MB of text and 20 MB of files for scripts at most; a zip of one, a few more.
const uploadLimit = bodyLimit({
  maxSize: 32 * 1024 * 1024,
  onError: (c) => c.json({ error: say(c, "tooLarge"), code: "too_large" }, 413),
});

export const skillRoutes = new Hono<Vars>()
  .get("/spaces/:id/skills", async (c) =>
    c.json(await listSkills(c.get("user").id, c.req.param("id"))),
  )
  .post("/spaces/:id/skills", async (c) => {
    const body = z
      .object({
        name: z.string().max(200),
        description: z.string().max(4000),
        body: z.string().max(SKILL_LIMITS.skillMd).optional(),
        mode: z.enum(SKILL_MODES).optional(),
      })
      .parse(await c.req.json());
    return c.json(await createSkill(c.get("user").id, c.req.param("id"), body));
  })
  .post("/spaces/:id/skills/upload", uploadLimit, async (c) => {
    const file = (await c.req.formData()).get("file");
    if (!(file instanceof File)) {
      throw new ServiceError("invalid", note("chooseFile"));
    }
    return c.json(
      await uploadSkill(c.get("user").id, c.req.param("id"), {
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      }),
    );
  })
  .get("/spaces/:id/skills/registry", async (c) =>
    c.json(await searchSkills(c.get("user").id, c.req.param("id"), c.req.query("q") ?? "")),
  )
  .get("/spaces/:id/skills/registry/preview", async (c) => {
    const ref = z.string().regex(SKILL_REF).parse(c.req.query("ref"));
    return c.json(await previewSkill(c.get("user").id, c.req.param("id"), ref));
  })
  .post("/spaces/:id/skills/registry", async (c) => {
    const body = z
      .object({ ref: z.string().regex(SKILL_REF), mode: z.enum(SKILL_MODES).optional() })
      .parse(await c.req.json());
    return c.json(await addRegistrySkill(c.get("user").id, c.req.param("id"), body));
  })
  .get("/skills/:id", async (c) => c.json(await getSkill(c.get("user").id, c.req.param("id"))))
  .patch("/skills/:id", async (c) => {
    const body = patchSchema.parse(await c.req.json());
    return c.json({ ok: true, ...(await updateSkill(c.get("user").id, c.req.param("id"), body)) });
  })
  .delete("/skills/:id", async (c) => {
    await deleteSkill(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/skills/:id/copy", async (c) =>
    c.json(await copySkill(c.get("user").id, c.req.param("id"))),
  )
  .get("/skills/:id/zip", async (c) => {
    const zip = await skillZip(c.get("user").id, c.req.param("id"));
    return c.body(zip.data, 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${zip.name}"`,
    });
  })
  .get("/skills/:id/update", async (c) =>
    c.json(await skillUpdate(c.get("user").id, c.req.param("id"))),
  )
  .post("/skills/:id/update", async (c) => {
    const { hash } = z.object({ hash: z.string().max(100) }).parse(await c.req.json());
    return c.json(await applySkillUpdate(c.get("user").id, c.req.param("id"), hash));
  });
