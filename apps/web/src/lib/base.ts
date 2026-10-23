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

/** The studio's own pages: the first part of a path after `/studio/` that is no organization's address. */
export const STUDIO_PAGES = new Set([
  "",
  "new",
  "edit",
  "settings",
  "space",
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
  if (!BASE || !path.startsWith("/") || path.startsWith("//")) {
    return path;
  }
  return path === BASE || path.startsWith(`${BASE}/`) ? path : `${BASE}${path}`;
}

/** A file of the app's public folder (`icons/…`, `ai-labels/…`) as the browser must request it. */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
