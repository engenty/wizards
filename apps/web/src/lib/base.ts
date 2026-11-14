// Named here, not only in the app's tsconfig: plugins type the shared ui (and this file) without it.
/// <reference types="vite/client" />

/**
 * The path the app is served under: `/wizards` on https://example.com/wizards, empty at an origin's root.
 * Vite writes it in at build time (APP_BASE_PATH).
 */
export const BASE = String(import.meta.env.VITE_APP_BASE ?? "").replace(/\/+$/, "");

/**
 * The studio: its pages, and once built the app's own files (scripts, icons, labels). The root of
 * the host belongs to others (a landing page); public wizards stay at `/w/<token>`.
 */
export const STUDIO = `${BASE}/studio`;

/**
 * The studio's own pages: the first part of a path after `/studio/` that is no organization's
 * address. Every first part of a route in `StudioApp` (App.tsx) is here (base.test.ts checks
 * it): one that is missing is read as an organization's address, and the studio then starts
 * below it (`/studio/capabilities/capabilities/…`).
 */
export const STUDIO_PAGES = new Set([
  "",
  "new",
  "wizards",
  "edit",
  "space",
  "skills",
  "capabilities",
  "work",
  "shared",
  "settings",
  "account",
  "setup",
  "start",
  "sign-in",
]);

/**
 * Where the studio's pages start: `/studio/<address>` in an organization of the cloud, `/studio`
 * on a local install. Set once when the studio starts (studio/StudioRoot.tsx).
 */
export let STUDIO_ROOT = STUDIO;

export function setStudioRoot(root: string) {
  STUDIO_ROOT = root;
}

/**
 * The widget an AI app shows runs on the host's origin: its requests go to the runtime at `base`,
 * each with the run's ticket.
 */
let remote: { base: string; ticket: string } | null = null;

export function setRemoteRuntime(runtime: { base: string; ticket: string } | null) {
  remote = runtime ? { base: runtime.base.replace(/\/+$/, ""), ticket: runtime.ticket } : null;
}

/**
 * A run's ticket from a link (a mail, a channel's hand-off: `/w/<token>/<run>?rt=…`). Taken from
 * the address at once, so it does not stay in the address bar or get copied along, and kept for
 * this tab, so a reload still opens the run. Every call about that run carries it.
 */
const linked = (() => {
  if (typeof window === "undefined") {
    return null;
  }
  const url = new URL(window.location.href);
  const runId = /\/w\/[^/]+\/([^/]+)/.exec(url.pathname)?.[1];
  if (!runId) {
    return null;
  }
  const key = `wizards.ticket.${runId}`;
  const given = url.searchParams.get("rt");
  if (given) {
    url.searchParams.delete("rt");
    window.history.replaceState(window.history.state, "", url);
  }
  // A page in a frame on another website may have no storage: the ticket then lasts until a reload.
  let ticket = given;
  try {
    if (given) {
      sessionStorage.setItem(key, given);
    } else {
      ticket = sessionStorage.getItem(key);
    }
  } catch {
    // nothing kept
  }
  return ticket ? { path: `/api/runs/${runId}`, ticket } : null;
})();

/**
 * Where the wizards' pages are (`/api/config`'s `publicUrl`): the doors' origin when they are
 * served apart from the studio. Until the runtime answered, this origin.
 */
let publicBase: string | null = null;

export function setPublicBase(url: string | null | undefined) {
  publicBase = url ? url.replace(/\/+$/, "") : null;
}

/** The address a wizard's page starts with, up to `/w/<token>`. */
export function publicAddress(): string {
  return publicBase ?? `${window.location.origin}${BASE}`;
}

/** A root-relative address (`/api/...`, `/w/...`) as the browser must request it. */
export function withBase(path: string): string {
  if (remote && path.startsWith("/api/")) {
    return `${remote.base}${path}${path.includes("?") ? "&" : "?"}rt=${encodeURIComponent(remote.ticket)}`;
  }
  if (linked && (path === linked.path || path.startsWith(`${linked.path}/`))) {
    const ticketed = `${path}${path.includes("?") ? "&" : "?"}rt=${encodeURIComponent(linked.ticket)}`;
    return BASE ? `${BASE}${ticketed}` : ticketed;
  }
  if (!BASE || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }
  return path === BASE || path.startsWith(`${BASE}/`) ? path : `${BASE}${path}`;
}

/** A file of the app's public folder (`icons/…`, `ai-labels/…`) as the browser must request it. */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
