import { loadBrandFace } from "@engenty/wizards-runner";
import type { RunTheme } from "@engenty/wizards-shared/run";
import { shippedFontStylesheet, shippedLike } from "@engenty/wizards-shared/theme";

const sheets = new Set<string>();

/** A font the runner ships, once, from the runtime; a family that is not one of ours is left. */
function loadShippedFont(family: string | null, runtime: string) {
  const sheet = family ? shippedFontStylesheet(family) : null;
  if (!sheet || sheets.has(sheet)) {
    return;
  }
  sheets.add(sheet);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${runtime}${sheet}`;
  document.head.append(link);
}

/**
 * Loads the fonts a theme names, as the wizard's own page does: the brand's from their source,
 * the shipped ones from the runtime at `runtime`, and the shipped font of its kind where a brand
 * font fails.
 */
export function loadLookFonts(look: RunTheme, runtime: string) {
  for (const face of look.faces) {
    loadBrandFace(face, face.url.startsWith("/") ? `${runtime}${face.url}` : face.url, () =>
      loadShippedFont(shippedLike(face.family), runtime),
    );
  }
  loadShippedFont(look.display, runtime);
  loadShippedFont(look.body, runtime);
}
