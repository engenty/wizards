import type { Context } from "hono";
import { ownerUrl } from "../tenants/control.js";

/**
 * Hands a request on to the runner holding the run — what only the process with the run's
 * browser can answer. The runner serves the same routes and checks the same cookie; the caller's
 * headers go along. Null: nobody holds the run, or the runner named no address (RUNNER_URL).
 */
export async function fromOwner(c: Context, runId: string): Promise<Response | null> {
  const base = await ownerUrl(runId);
  if (!base) {
    return null;
  }
  const here = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer();
  try {
    const res = await fetch(`${base}${here.pathname}${here.search}`, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    console.error(`[run ${runId}] the runner did not answer:`, err);
    return null;
  }
}
