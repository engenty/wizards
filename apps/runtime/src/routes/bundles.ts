import { note } from "@engenty/wizards-shared/run";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  applyBundleUpdate,
  type BundleSource,
  bundleRemoval,
  bundleUpdate,
  importBundle,
  listBundles,
  previewBundle,
  removeBundle,
} from "../bundles/index.js";
import { MAX_ARCHIVE_MB } from "../bundles/read.js";
import { actionKindSchema, signInChoiceSchema } from "../connectors/external.js";
import { ServiceError } from "../services/errors.js";
import { requestLang, say } from "./lang.js";

/**
 * A Connector that brings skills, for the studio (docs/plans/capabilities-next.md, piece 4),
 * under `/api/studio`: a plugin for Claude Code or Cursor is read from a public repository on
 * GitHub or an uploaded zip, shown, and taken into a space. Every route is for an admin (403 for
 * a member), and "not found" while `capabilities` is off.
 *
 * A request names its source one of two ways: JSON with `address` (a repository on GitHub, or a
 * folder of it as `…/tree/<branch>/<folder>`), or a form with `file` (a `.zip` or `.plugin`) and
 * the rest of the request as JSON in `options`. `path` names one plugin's folder where the
 * repository or the zip holds several.
 *
 * - `POST /spaces/:id/bundles/preview` reads it: `{ preview, plugins }`. `preview` has the name
 *   and version, each server over http as „Per Adresse“ reads one, the skills, and what is left
 *   out with the reason. `plugins` lists the plugins to choose from where there are several.
 * - `POST /spaces/:id/bundles` takes it: `hash` (the preview's), `servers` (per server's name:
 *   `take`, `id`, `toolPrefix`, `name`, `signIn`, `actionKinds`), `skills` (the folders to take).
 * - `GET /spaces/:id/bundles` lists what came together, with its connectors, connections, skills.
 * - `GET /bundles/:id/update` says what the origin has now; `POST` takes it (`hash`, or a form
 *   with the new `file` for one that came from a file).
 * - `GET /bundles/:id/removal` names what removing takes and the wizards that use its
 *   connections; `DELETE /bundles/:id` removes all of it.
 */

type Vars = { Variables: { user: SessionUser } };

const serverChoice = z.object({
  take: z.boolean().optional(),
  id: z.string().min(2).max(60).optional(),
  toolPrefix: z.string().min(2).max(31).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  signIn: signInChoiceSchema.optional(),
  actionKinds: z.record(z.string().max(200), actionKindSchema).optional(),
  oauthClientId: z.string().max(500).optional(),
  oauthClientSecret: z.string().max(500).optional(),
});

const sourceFields = {
  address: z.string().trim().min(1).max(500).optional(),
  path: z.string().max(300).optional(),
  servers: z.record(z.string().max(100), serverChoice).optional(),
};

const previewSchema = z.object(sourceFields);

const importSchema = z.object({
  ...sourceFields,
  hash: z.string().max(100).optional(),
  skills: z.array(z.string().max(300)).max(200).optional(),
});

const updateSchema = z.object({ hash: z.string().max(100).optional() });

// A zip may weigh what a repository's archive may, and a little for the form around it.
const uploadLimit = bodyLimit({
  maxSize: (MAX_ARCHIVE_MB + 4) * 1_000_000,
  onError: (c) => c.json({ error: say(c, "tooLarge"), code: "too_large" }, 413),
});

/** A request's JSON, and its file where it came as a form. */
async function bodyOf(c: Context<Vars>): Promise<{
  options: unknown;
  file: { name: string; data: Uint8Array } | null;
}> {
  if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
    return { options: await c.req.json().catch(() => ({})), file: null };
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ServiceError("invalid", note("chooseFile"));
  }
  const raw = form.get("options");
  let options: unknown = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      options = JSON.parse(raw);
    } catch {
      throw new ServiceError("invalid", { server: "bundleUploadKind" });
    }
  }
  return { options, file: { name: file.name, data: new Uint8Array(await file.arrayBuffer()) } };
}

function sourceOf(
  input: { address?: string; path?: string },
  file: { name: string; data: Uint8Array } | null,
): BundleSource {
  const path = input.path?.trim() ? { path: input.path.trim() } : {};
  if (file) {
    return { file, ...path };
  }
  if (!input.address) {
    throw new ServiceError("invalid", { server: "bundleNotARepository" });
  }
  return { address: input.address, ...path };
}

export const bundleRoutes = new Hono<Vars>()
  .post("/spaces/:id/bundles/preview", uploadLimit, async (c) => {
    const { options, file } = await bodyOf(c);
    const input = previewSchema.parse(options);
    return c.json(
      await previewBundle(
        c.get("user").id,
        c.req.param("id"),
        sourceOf(input, file),
        requestLang(c),
        input.servers,
      ),
    );
  })
  .get("/spaces/:id/bundles", async (c) =>
    c.json({ bundles: await listBundles(c.get("user").id, c.req.param("id")) }),
  )
  .post("/spaces/:id/bundles", uploadLimit, async (c) => {
    const { options, file } = await bodyOf(c);
    const { address, path, ...input } = importSchema.parse(options);
    return c.json(
      await importBundle(
        c.get("user").id,
        c.req.param("id"),
        sourceOf({ address, path }, file),
        input,
        requestLang(c),
      ),
    );
  })
  .get("/bundles/:id/update", async (c) =>
    c.json(await bundleUpdate(c.get("user").id, c.req.param("id"), requestLang(c))),
  )
  .post("/bundles/:id/update", uploadLimit, async (c) => {
    const { options, file } = await bodyOf(c);
    const { hash } = updateSchema.parse(options);
    return c.json(
      await applyBundleUpdate(
        c.get("user").id,
        c.req.param("id"),
        { ...(hash ? { hash } : {}), ...(file ? { file } : {}) },
        requestLang(c),
      ),
    );
  })
  .get("/bundles/:id/removal", async (c) =>
    c.json(await bundleRemoval(c.get("user").id, c.req.param("id"))),
  )
  .delete("/bundles/:id", async (c) => {
    await removeBundle(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });
