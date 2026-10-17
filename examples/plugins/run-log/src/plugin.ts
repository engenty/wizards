import { definePlugin, type PluginRunEvent } from "@engenty/wizards/plugin";
import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { entry } from "./schema";

/**
 * The server half of the example: its own table, a listener on runs that end, two routes for
 * its page and its section of the space page, and a tool agent steps can list as
 * `run-log.recent`.
 */
export default definePlugin((wizards) => {
  const { server } = wizards;
  const db = () => server.getTenantDb();

  server.registerMigrations("migrations");

  const keep = async ({ run, wizard }: PluginRunEvent) => {
    await db().insert(entry).values({
      runId: run.id,
      wizardId: wizard.id,
      projectId: wizard.projectId,
      title: wizard.title,
      mode: run.mode,
      status: run.status,
      endedAt: new Date(),
    });
  };
  server.on("run.done", keep);
  server.on("run.failed", keep);
  server.on("run.cancelled", keep);

  /** The last lines, of all spaces or of one. */
  const recent = (limit: number, space?: string) =>
    db()
      .select()
      .from(entry)
      .where(space ? eq(entry.projectId, space) : undefined)
      .orderBy(desc(entry.endedAt), desc(entry.id))
      .limit(limit);

  // `?space=<id>`: only the runs of that space's wizards, for its section of the space page.
  server.registerHttpRoute({
    method: "GET",
    path: "/",
    handler: async ({ query }) => {
      const space = query.get("space") ?? undefined;
      const [{ total }] = await db()
        .select({ total: count() })
        .from(entry)
        .where(space ? eq(entry.projectId, space) : undefined);
      return { total, entries: await recent(space ? 5 : 100, space) };
    },
  });

  server.registerHttpRoute({
    method: "DELETE",
    path: "/",
    role: "admin",
    handler: async () => {
      await db().delete(entry);
      return { ok: true };
    },
  });

  server.registerTool({
    name: "recent",
    title: "Run log",
    description:
      "How the last runs of this app's wizards ended: the wizard's title, test or live, done, failed or cancelled, and when.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    execute: async ({ limit }, ctx) => {
      await ctx.emit("Run log");
      const rows = await recent(limit ?? 10);
      return {
        runs: rows.map((row) => ({
          wizard: row.title,
          mode: row.mode,
          status: row.status,
          endedAt: row.endedAt.toISOString(),
        })),
      };
    },
  });
});
