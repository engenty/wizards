import type { Context } from "hono";
import { env } from "./env.js";
import type { PageSpace } from "./page/data.js";

/** A team's host as the Manage-App answers it (`GET /v1/pages/host/<host>`). */
export interface Face {
  team: { id: string; name: string; slug: string; lang: string };
  page: PageSpace | null;
  portal: boolean;
  /** An admin held the team's page. */
  paused?: boolean;
  /** A former address: the origin of the current one. */
  movedTo?: string;
}

/**
 * Kept briefly: a hold takes a page offline at once, and the browser may keep the HTML a minute
 * on top of this.
 */
const KEEP_MS = 10_000;
const faces = new Map<string, { at: number; face: Face | null }>();

/**
 * The team of a host: null where no team has it, "down" where the Manage-App doesn't say. A
 * failure is not kept and never reads as "no team".
 */
export async function lookUpFace(host: string): Promise<Face | null | "down"> {
  const hit = faces.get(host);
  if (hit && Date.now() - hit.at < KEEP_MS) {
    return hit.face;
  }
  const res = await fetch(`${env.manageUrl}/v1/pages/host/${encodeURIComponent(host)}`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res || (!res.ok && res.status !== 404)) {
    return "down";
  }
  const face = res.ok ? ((await res.json()) as Face) : null;
  faces.set(host, { at: Date.now(), face });
  return face;
}

/** The portal's part of the host: there, a Manage-App that doesn't answer is a team unknown. */
export async function faceOf(host: string): Promise<Face | null> {
  const face = await lookUpFace(host);
  return face === "down" ? null : face;
}

/** The team's host a request came to; in development the portal's own may stand for one. */
export function hostOf(c: Context): string {
  const host = (
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    ""
  )
    .split(":")[0]
    .toLowerCase();
  return env.devTeamHost && host === new URL(env.portalUrl).hostname ? env.devTeamHost : host;
}
