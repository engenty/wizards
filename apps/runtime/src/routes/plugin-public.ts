import type { PluginPublicRequest, PluginSharedRequest } from "@engenty/wizards/plugin";
import { type Context, Hono } from "hono";
import { withTenant } from "../db/client.js";
import { SHARED, tenantOfAddress } from "../plugins/public.js";
import { loadedPlugin, pluginIdsOf } from "../plugins/registry.js";
import { tenantStatus } from "../tenants/control.js";
import { notFoundAnswer } from "./lang.js";
import { answerOf } from "./plugins.js";

/**
 * Plugins' public routes (`server.registerPublicRoute`), below `/api/public/plugins/<id>/<ref>`.
 * Nobody is signed in: the ref names the tenant, and the plugin checks a secret of its own.
 * Shared routes (`server.registerSharedRoute`) are below `/api/public/plugins/<id>/shared`, for
 * every tenant; their handler enters a tenant by the ref the call carries.
 */

const notFound = (c: Context) => c.json(notFoundAnswer(c), 404);

/** What a handler threw, as the answer: its status and code, or a 500. */
function failed(c: Context, id: string, what: string, err: unknown): Response {
  const answer = answerOf(err);
  if (answer) {
    return c.json(answer.body, answer.status as 400);
  }
  console.error(`[plugin ${id}] ${what}:`, err);
  return c.json({ error: "The plugin failed.", code: "plugin_failed" }, 500);
}

/** The tenant of a ref, when it is active and has the plugin. */
async function tenantWithPlugin(id: string, ref: string): Promise<string | null> {
  const tenantId = await tenantOfAddress(id, ref);
  if (!tenantId || (await tenantStatus(tenantId)) !== "active") {
    return null;
  }
  return (await pluginIdsOf(tenantId)).has(id) ? tenantId : null;
}

async function shared(c: Context): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const plugin = loadedPlugin(id);
  if (!plugin) {
    return notFound(c);
  }
  const url = new URL(c.req.url);
  const marker = `/plugins/${id}/${SHARED}`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  for (const { route, pattern, params } of plugin.sharedRoutes) {
    const match = route.method === c.req.method ? pattern.exec(path) : null;
    if (!match) {
      continue;
    }
    const request: PluginSharedRequest = {
      request: c.req.raw,
      path: path || "/",
      params: Object.fromEntries(params.map((name, i) => [name, decodeURIComponent(match[i + 1])])),
      query: url.searchParams,
      async inTenant(ref, work) {
        const tenantId = await tenantWithPlugin(id, ref);
        if (!tenantId) {
          throw Object.assign(new Error("No tenant has this address."), {
            status: 404,
            code: "not_found",
          });
        }
        return withTenant(tenantId, async () => await work());
      },
    };
    try {
      const result = await route.handler(request);
      return result instanceof Response ? result : c.json(result ?? null);
    } catch (err) {
      return failed(c, id, `shared ${route.method} ${path}`, err);
    }
  }
  return notFound(c);
}

async function dispatch(c: Context): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const ref = c.req.param("ref") ?? "";
  const tenantId = await tenantWithPlugin(id, ref);
  const plugin = tenantId ? loadedPlugin(id) : undefined;
  if (!tenantId || !plugin) {
    return notFound(c);
  }
  const url = new URL(c.req.url);
  const marker = `/plugins/${id}/${ref}`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  for (const { route, pattern, params } of plugin.publicRoutes) {
    const match = route.method === c.req.method ? pattern.exec(path) : null;
    if (!match) {
      continue;
    }
    const request: PluginPublicRequest = {
      request: c.req.raw,
      path: path || "/",
      params: Object.fromEntries(params.map((name, i) => [name, decodeURIComponent(match[i + 1])])),
      query: url.searchParams,
      tenantId,
      json: async <T>() => {
        const text = await c.req.text();
        return (text ? JSON.parse(text) : {}) as T;
      },
    };
    try {
      const result = await withTenant(tenantId, () => route.handler(request));
      return result instanceof Response ? result : c.json(result ?? null);
    } catch (err) {
      return failed(c, id, `public ${route.method} ${path}`, err);
    }
  }
  return notFound(c);
}

export const publicPluginRoutes = new Hono()
  .all(`/:id/${SHARED}`, shared)
  .all(`/:id/${SHARED}/*`, shared)
  .all("/:id/:ref", dispatch)
  .all("/:id/:ref/*", dispatch);
