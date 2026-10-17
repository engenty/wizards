import { readFile } from "node:fs/promises";
import type { PluginRequest } from "@engenty/wizards/plugin";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Principal } from "../auth/index.js";
import { managed } from "../manage.js";
import { pluginProblems, reloadPlugin, rescanPlugins } from "../plugins/loader.js";
import { installPro, proState, refreshPro, removePro } from "../plugins/pro.js";
import {
  type LoadedPlugin,
  loadedPlugin,
  onPluginChange,
  pluginAsset,
  pluginIdsOf,
  pluginsOf,
} from "../plugins/registry.js";
import { notFoundAnswer } from "./lang.js";

/**
 * Plugins, as the studio sees them (docs/content/dev/plugins). Below `/api/studio/plugins`, so every
 * request is a signed-in person's, inside that person's tenant:
 *
 *   /                   the tenant's plugins and where their studio halves are
 *   /-/…                the runtime's own part: the built files, reloading
 *   /<id>/…             the routes a plugin registered
 *
 * No plugin is called `-`, so the two never meet.
 */

type Ctx = Context<{ Variables: { user: Principal } }>;

const admin = (user: Principal) => user.role === "owner" || user.role === "admin";

/** Plugins change while the app runs only where it runs alone: a reload would hit every tenant. */
const canReload = (user: Principal) => !managed && admin(user);

function view(plugin: LoadedPlugin) {
  const script = pluginAsset(plugin, "studio");
  const styles = pluginAsset(plugin, "styles");
  const { id, name, version, description } = plugin.source.manifest;
  const address = (file: string, rev: string) =>
    `/api/studio/plugins/-/assets/${id}/${file}?rev=${rev}`;
  return {
    id,
    name,
    version,
    description: description ?? "",
    generation: plugin.generation,
    /** Installed from the linked account's plan (Settings → Plugins → Pro modules). */
    pro: Boolean(plugin.source.pro),
    /** Why the server half did not load; the plugin then adds nothing on the server. */
    error: plugin.error,
    script: script ? address("client.js", script.rev) : null,
    styles: styles ? address("client.css", styles.rev) : null,
    tools: [...plugin.tools.values()].map((tool) => ({
      id: `${id}.${tool.name}`,
      title: tool.title ?? tool.name,
    })),
  };
}

/** A thrown error that says how to answer: `{ status, code }`, as the runtime's own errors do. */
export function answerOf(
  err: unknown,
): { status: number; body: { error: string; code: string } } | null {
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  return typeof e?.status === "number" &&
    e.status >= 400 &&
    e.status < 600 &&
    typeof e.code === "string"
    ? { status: e.status, body: { error: String(e.message ?? e.code), code: e.code } }
    : null;
}

/**
 * Calls the plugin route the request names, as `user`: a signed-in person of the studio, or the
 * person behind an API key or token (`/api/v1/plugins/…`).
 */
export async function dispatchAs(c: Context, user: Principal): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const plugin = (await pluginIdsOf(user.tenantId)).has(id) ? loadedPlugin(id) : undefined;
  if (!plugin) {
    return c.json(notFoundAnswer(c), 404);
  }
  const url = new URL(c.req.url);
  const path = url.pathname.slice(url.pathname.indexOf(`/plugins/${id}`) + `/plugins/${id}`.length);
  for (const { route, pattern, params } of plugin.routes) {
    const match = route.method === c.req.method ? pattern.exec(path) : null;
    if (!match) {
      continue;
    }
    if (route.role === "admin" && !admin(user)) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    const request: PluginRequest = {
      request: c.req.raw,
      path: path || "/",
      params: Object.fromEntries(params.map((name, i) => [name, decodeURIComponent(match[i + 1])])),
      query: url.searchParams,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        role: user.role,
        name: user.name,
        email: user.email,
      },
      json: async <T>() => {
        const text = await c.req.text();
        return (text ? JSON.parse(text) : {}) as T;
      },
    };
    try {
      const result = await route.handler(request);
      return result instanceof Response ? result : c.json(result ?? null);
    } catch (err) {
      const answer = answerOf(err);
      if (answer) {
        return c.json(answer.body, answer.status as 400);
      }
      console.error(`[plugin ${id}] ${route.method} ${path}:`, err);
      return c.json({ error: "The plugin failed.", code: "plugin_failed" }, 500);
    }
  }
  return c.json(notFoundAnswer(c), 404);
}

const dispatch = (c: Ctx) => dispatchAs(c, c.get("user"));

const TYPES: Record<string, { kind: "studio" | "styles"; type: string }> = {
  "client.js": { kind: "studio", type: "text/javascript; charset=utf-8" },
  "client.css": { kind: "styles", type: "text/css; charset=utf-8" },
};

export const pluginRoutes = new Hono<{ Variables: { user: Principal } }>()
  .get("/", async (c) => {
    const user = c.get("user");
    return c.json({
      plugins: (await pluginsOf(user.tenantId)).map(view),
      canReload: canReload(user),
      /** What looked like a plugin and is none; for the person who installs them. */
      problems: canReload(user) ? pluginProblems() : [],
    });
  })

  // The built studio half. The address carries the file's revision, so it may be kept for good.
  .get("/-/assets/:id/:file", async (c) => {
    const user = c.get("user");
    const file = c.req.param("file");
    const kind = Object.hasOwn(TYPES, file) ? TYPES[file] : undefined;
    const id = c.req.param("id");
    const plugin = (await pluginIdsOf(user.tenantId)).has(id) ? loadedPlugin(id) : undefined;
    const asset = plugin && kind ? pluginAsset(plugin, kind.kind) : null;
    if (!asset || !kind) {
      return c.json(notFoundAnswer(c), 404);
    }
    return c.body(new Uint8Array(await readFile(asset.file)), 200, {
      "content-type": kind.type,
      "cache-control":
        c.req.query("rev") === asset.rev ? "private, max-age=31536000, immutable" : "no-cache",
    });
  })

  // Says when a plugin loaded again, so an open studio takes the new one without a page load.
  .get("/-/events", (c) => {
    if (managed) {
      return c.json(notFoundAnswer(c), 404);
    }
    return streamSSE(c, async (stream) => {
      let closed = false;
      const stop = onPluginChange((change) => {
        void stream.writeSSE({ event: "change", data: JSON.stringify(change) });
      });
      stream.onAbort(() => {
        closed = true;
        stop();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!closed) {
        await stream.sleep(20_000);
        if (!closed) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
    });
  })

  .post("/-/reload", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    await rescanPlugins();
    return c.json({ plugins: (await pluginsOf(c.get("user").tenantId)).map(view) });
  })

  .post("/-/reload/:id", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    const plugin = await reloadPlugin(c.req.param("id"));
    return plugin ? c.json({ plugin: view(plugin) }) : c.json(notFoundAnswer(c), 404);
  })

  // Pro modules: the closed plugins the linked account's plan includes (plugins/pro.ts).
  .get("/-/pro", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json(notFoundAnswer(c), 404);
    }
    return c.json(await proState());
  })

  .post("/-/pro/refresh", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    await refreshPro();
    return c.json(await proState());
  })

  .post("/-/pro/:id", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    try {
      await installPro(c.req.param("id"));
    } catch (err) {
      const answer = answerOf(err);
      if (answer) {
        return c.json(answer.body, answer.status as 400);
      }
      throw err;
    }
    return c.json(await proState());
  })

  .delete("/-/pro/:id", async (c) => {
    if (!canReload(c.get("user"))) {
      return c.json({ error: "This isn’t allowed here.", code: "forbidden" }, 403);
    }
    try {
      await removePro(c.req.param("id"));
    } catch (err) {
      const answer = answerOf(err);
      if (answer) {
        return c.json(answer.body, answer.status as 400);
      }
      throw err;
    }
    return c.json(await proState());
  })

  .all("/:id", dispatch)
  .all("/:id/*", dispatch);
