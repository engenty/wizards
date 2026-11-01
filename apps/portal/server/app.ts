import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { type Context, Hono } from "hono";
import { currentSession, finishSignIn, signOut, startSignIn, takeHandover } from "./auth.js";
import { env } from "./env.js";

/**
 * The portal server (docs/plans/client-portal.md): the client's sign-in, and two forwards. The
 * client contract (`/api/v1/client`) gets the session's token; a run's own routes get the run's
 * ticket, which only the contract hands out. It decides nothing itself: the runtime decides every
 * call as the token's person.
 */

/** What a team's portal shows before sign-in, from the Manage-App (its public page by host). */
interface Face {
  team: { id: string; name: string; slug: string; lang: string };
  page: unknown;
  portal: boolean;
}

const faces = new Map<string, { at: number; face: Face | null }>();

async function faceOf(host: string): Promise<Face | null> {
  const hit = faces.get(host);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.face;
  }
  const res = await fetch(`${env.manageUrl}/v1/pages/host/${encodeURIComponent(host)}`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const face = res?.ok ? ((await res.json()) as Face) : null;
  faces.set(host, { at: Date.now(), face });
  return face;
}

const hostOf = (c: Context) =>
  (c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || "")
    .split(":")[0]
    .toLowerCase();

/** Headers a forward passes on: what the body is and the language, never the browser's cookies. */
function forwarded(c: Context, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  for (const name of ["content-type", "accept", "accept-language", "last-event-id"]) {
    const value = c.req.header(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set("x-wizards-client", "portal");
  return headers;
}

/** The runtime's answer as it came, streams included; its cookies stay with it. */
function relay(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(res.body, { status: res.status, headers });
}

async function forward(c: Context, url: string, headers: Headers): Promise<Response> {
  const method = c.req.method;
  const res = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(),
    signal: c.req.raw.signal,
  }).catch(() => null);
  return res ? relay(res) : c.json({ error: "The runtime does not answer.", code: "offline" }, 502);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** A file of the built SPA; every other address under /portal is the SPA's own page. */
async function webFile(c: Context): Promise<Response> {
  const path = normalize(c.req.path.replace(/^\/portal\/?/, "")).replace(/^(\.\.[/\\])+/, "");
  const file = path && path !== "." ? join(env.webDir, path) : "";
  if (file?.startsWith(env.webDir)) {
    const data = await readFile(file).catch(() => null);
    if (data) {
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "cache-control": path.startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
  }
  const index = await readFile(join(env.webDir, "index.html"), "utf8").catch(() => null);
  return index ? c.html(index, 200, { "cache-control": "no-cache" }) : c.notFound();
}

export const app = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  // --- sign-in --------------------------------------------------------------------------------
  .get("/portal/auth/login", async (c) =>
    startSignIn(c, (await faceOf(hostOf(c)))?.team.slug ?? null),
  )
  .get("/portal/auth/callback", (c) => finishSignIn(c))
  .get("/portal/auth/finish", (c) => takeHandover(c))
  .post("/portal/auth/logout", (c) => {
    signOut(c);
    return c.json({ ok: true });
  })
  // --- what the SPA asks ----------------------------------------------------------------------
  // The team of the host and who is signed in: enough to draw the first page.
  .get("/portal/api/session", async (c) => {
    const [face, session] = await Promise.all([faceOf(hostOf(c)), currentSession(c)]);
    return c.json(
      {
        face,
        person: session
          ? {
              name: session.name,
              email: session.email,
              role: session.role,
              tenantId: session.tenantId,
              // The token is for this host's team; else the person is signed in elsewhere.
              here: !face || face.team.id === session.tenantId,
            }
          : null,
      },
      200,
      { "cache-control": "no-store" },
    );
  })
  // The client contract, as the signed-in client.
  .on(["GET", "POST"], "/portal/api/client/*", async (c) => {
    const session = await currentSession(c);
    if (!session) {
      return c.json({ error: "Sign in first.", code: "signed_out" }, 401);
    }
    const rest = c.req.path.slice("/portal/api/client".length);
    return forward(
      c,
      `${env.runtimeApiUrl}/api/v1/client${rest}`,
      forwarded(c, { authorization: `Bearer ${session.access}` }),
    );
  })
  // One run's own routes, with the ticket the contract gave for it.
  .all("/portal/api/run/:runId/:ticket/*", (c) => runRoute(c))
  .all("/portal/api/run/:runId/:ticket", (c) => runRoute(c))
  // The runtime's public files a run shows: fonts, logos.
  .get("/portal/api/public/*", (c) =>
    forward(
      c,
      `${env.runtimeDoorsUrl}${c.req.path.slice("/portal".length)}${new URL(c.req.url).search}`,
      forwarded(c),
    ),
  )
  .get("/portal", (c) => webFile(c))
  .get("/portal/*", (c) => webFile(c))
  .get("/", (c) => c.redirect("/portal"));

function runRoute(c: Context) {
  const { runId, ticket } = c.req.param() as { runId: string; ticket: string };
  const base = `/portal/api/run/${runId}/${ticket}`;
  const rest = c.req.path.slice(base.length);
  const query = new URL(c.req.url).searchParams;
  query.set("rt", ticket);
  return forward(
    c,
    `${env.runtimeDoorsUrl}/api/runs/${encodeURIComponent(runId)}${rest}?${query}`,
    forwarded(c),
  );
}
