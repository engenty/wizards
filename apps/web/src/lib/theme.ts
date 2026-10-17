import { useEffect, useSyncExternalStore } from "react";
import { ENGENTY_FILL, ENGENTY_KIND_FILL, type EngentyKind } from "../engenty/colors";

export type Theme = "light" | "dark";

const KEY = "wizards.theme";
const listeners = new Set<() => void>();
const system = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * The pick shared with engenty's other pages (the account pages): a readable cookie on the site's
 * parent domain holding "light", "dark" or "system", like the language's
 * (engenty-wizards-manage, apps/web/src/lib/theme.ts).
 */
const SHARED_COOKIE = "engenty_theme";

function sharedPick(): string | null {
  const raw = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SHARED_COOKIE}=`))
    ?.slice(SHARED_COOKIE.length + 1);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

function sharePick(value: "light" | "dark" | "system") {
  const host = window.location.hostname;
  const labels = host.split(".");
  // app.engenty.ai → engenty.ai, engenty.ai stays itself; localhost and plain addresses keep the host.
  const named = labels.length > 1 && !/^\d+$/.test(labels[labels.length - 1]);
  const parent = named ? (labels.length > 2 ? labels.slice(1).join(".") : host) : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing in Safari and Firefox
  document.cookie = `${SHARED_COOKIE}=${value}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${parent ? `; Domain=${parent}` : ""}${secure}`;
}

/** The visitor's pick: `null` is "follow the OS", chosen on purpose; with no pick at all it is dark. */
function stored(): Theme | null {
  try {
    const value = sharedPick() ?? localStorage.getItem(KEY);
    if (value === "system") {
      return null;
    }
    return value === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Pages shown right now that stand on a vivid ground of their own, whatever the theme. */
let grounded = 0;

/** The visitor's pick (dark until there is one, or the OS setting if asked); a page on its own ground is always dark. */
function current(): Theme {
  if (grounded > 0) {
    return "dark";
  }
  return stored() ?? (system.matches ? "dark" : "light");
}

/**
 * The browser's toolbar — and the status bar of a wizard on the home screen — takes the page's
 * colour: paper in light, the wizard's stage in dark.
 */
export function syncThemeColor() {
  requestAnimationFrame(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const ctx = document.createElement("canvas").getContext("2d");
    if (!meta || !ctx || !document.body) {
      return;
    }
    // The page colour is oklch; a canvas pixel turns it into the hex a meta tag takes.
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    meta.content = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  });
}

function apply() {
  const dark = current() === "dark";
  document.documentElement.classList.toggle("dark", dark);
  syncThemeColor();
  for (const listener of listeners) {
    listener();
  }
}

system.addEventListener("change", apply);
// What this browser shows here goes to the account pages too, also before anyone picks.
if (!sharedPick()) {
  sharePick(stored() ?? "system");
}
apply();

/** The visitor's pick; `null` leaves it to the OS setting. */
export function setTheme(theme: Theme | null) {
  sharePick(theme ?? "system");
  try {
    localStorage.setItem(KEY, theme ?? "system");
  } catch {
    // the pick only lasts this page then
    document.documentElement.classList.toggle("dark", (theme ?? current()) === "dark");
    return;
  }
  apply();
}

/** What the visitor picked, dark until then: `null` follows the OS. */
export function useThemePick(): Theme | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, stored);
}

/** The visitor's pick, dark until there is one — also while a page on its own ground shows dark. */
export function usePreferredTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stored() ?? (system.matches ? "dark" : "light"),
  );
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
  );
}

/**
 * Deep fill in an engenty's own hue: the dark theme's page, and the stage a
 * jelly stands on in light. The gel is see-through, so it only reads against
 * an intense, dark colour like this.
 */
export const stageFill = (kind: EngentyKind) =>
  `oklch(from ${ENGENTY_FILL[ENGENTY_KIND_FILL[kind] ?? "cobalt"]} 0.34 calc(c * 0.6) h)`;

/**
 * A page that stands on one vivid colour, like the landing page: while it is shown, the root
 * takes that colour as its stage and the dark tokens derived from it, in either theme. `null`:
 * the page stands on the theme's own paper for now.
 */
export function useGround(color: string | null) {
  useEffect(() => {
    if (!color) {
      return;
    }
    const root = document.documentElement;
    grounded += 1;
    root.style.setProperty("--stage", color);
    apply();
    return () => {
      grounded -= 1;
      root.style.removeProperty("--stage");
      apply();
    };
  }, [color]);
}

/**
 * Dark pages take the colour of the wizard's engenty, unless its brand names a ground of its own
 * (`--brand-stage`, `useRunTheme`). Set on the root, because every surface token derives from
 * `--stage` there.
 */
export function useStage(kind: string | null | undefined) {
  useEffect(() => {
    if (!kind) {
      return;
    }
    const root = document.documentElement;
    root.style.setProperty("--engenty-stage", stageFill(kind as EngentyKind));
    syncThemeColor();
    return () => {
      root.style.removeProperty("--engenty-stage");
      syncThemeColor();
    };
  }, [kind]);
}
