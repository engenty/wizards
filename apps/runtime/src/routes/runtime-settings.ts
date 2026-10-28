import {
  defaultFeatures,
  FEATURE_NAME,
  parseFeatures,
  resolveFeatures,
} from "@engenty/wizards-shared/features";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import { packageVersion } from "../cli/home.js";
import { env } from "../env.js";
import {
  declaredFeatures,
  featuresFile,
  fileFeatures,
  remoteFeatures,
  writeFeature,
} from "../features.js";
import { managed, userInfo } from "../manage.js";
import { localModelSettings } from "../models.js";
import { loadedPlugins } from "../plugins/registry.js";
import { installKind, restartRuntime, restarts } from "../update.js";
import { say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };

/**
 * Whether this person may change what holds for the whole runtime (Settings › Setup, Settings ›
 * Feature switches): on a computer whoever uses it, in the cloud the platform's admins only. Not
 * someone an admin is signed in as.
 */
export async function mayChangeRuntime(user: SessionUser): Promise<boolean> {
  if (!managed) {
    return true;
  }
  return !user.impersonatedBy && (await userInfo(user.id)).admin;
}

/** Where a switch's value comes from, the last layer that names it. */
type FeatureSource = "default" | "env" | "remote" | "file";

/**
 * What holds for the whole runtime: how it runs, what it thinks with, its feature switches. The
 * studio's Settings › Setup and Settings › Feature switches; refused to everyone else.
 */
export const runtimeSettingsRoutes = new Hono<Vars>()
  .use(async (c, next) => {
    if (!(await mayChangeRuntime(c.get("user")))) {
      return c.json({ error: say(c, "onlyPlatformAdmins"), code: "not_platform_admin" }, 403);
    }
    await next();
  })
  .get("/", (c) => {
    const models = managed ? null : localModelSettings();
    return c.json({
      version: packageVersion(),
      kind: managed ? "cloud" : installKind(),
      role: env.role,
      publicUrl: env.publicUrl,
      dataDir: env.dataDir,
      /** A libSQL server, or a file in the data folder; never its address, which may hold a token. */
      database: env.databaseUrl ? "server" : "file",
      files: env.s3.bucket ? "bucket" : "folder",
      featuresFile: featuresFile(),
      /** The command that started it starts it again after a restart. */
      restarts: restarts(),
      /** What a runtime that runs alone thinks with; null in the cloud, where the Manage-App says. */
      models: models
        ? {
            source: models.source,
            keys: Object.entries(models.keys)
              .filter(([, set]) => set)
              .map(([name]) => name),
            ollamaUrl: models.ollamaUrl,
          }
        : null,
      plugins: loadedPlugins().map((p) => p.source.id),
    });
  })
  .get("/features", async (c) => {
    const declared = declaredFeatures();
    const fromEnv = parseFeatures(process.env.FEATURES ?? "");
    const remote = await remoteFeatures();
    const fromFile = fileFeatures();
    const all = resolveFeatures(defaultFeatures(declared), fromEnv, remote, fromFile);
    const names = [
      ...new Set([
        ...Object.keys(declared),
        ...Object.keys(fromEnv),
        ...Object.keys(remote ?? {}),
        ...Object.keys(fromFile),
      ]),
    ];
    const source = (name: string): FeatureSource =>
      name in fromFile
        ? "file"
        : remote && name in remote
          ? "remote"
          : name in fromEnv
            ? "env"
            : "default";
    return c.json({
      file: featuresFile(),
      restarts: restarts(),
      features: names.map((name) => ({
        name,
        on: all[name] === true,
        source: source(name),
        kind: declared[name]?.kind ?? null,
        label: declared[name]?.label ?? null,
        hint: declared[name]?.hint ?? null,
        /** What it would be without this runtime's file. */
        without: resolveFeatures(defaultFeatures(declared), fromEnv, remote)[name] === true,
      })),
    });
  })
  .put("/features/:name", async (c) => {
    const name = c.req.param("name");
    if (!FEATURE_NAME.test(name)) {
      return c.json({ error: say(c, "notFound"), code: "unknown_feature" }, 404);
    }
    const { on } = z.object({ on: z.boolean().nullable() }).parse(await c.req.json());
    // A switch set to what it would be anyway leaves the file: it follows the default again.
    const without = resolveFeatures(
      defaultFeatures(declaredFeatures()),
      parseFeatures(process.env.FEATURES ?? ""),
      await remoteFeatures(),
    );
    writeFeature(name, on === null || on === (without[name] === true) ? null : on);
    return c.json({ ok: true });
  })
  .post("/restart", (c) => c.json({ restarting: restartRuntime() }));
