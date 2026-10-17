/**
 * Writes the web's flat engenties (src/engenty/engenty.tsx) as still SVG, first frame of each
 * idle morph, oklch turned into hex: apps/runtime/src/services/engenty-shapes.ts, which the
 * runtime draws a wizard's app icon from (with each kind's ground shadow), and the mobile app's
 * src/engenty/shapes.ts in the apps repo (engenty-wizards-apps) when it is beside this repo, or
 * where WIZARDS_APPS says. Run it after the web's engenties change:
 *
 *   pnpm --filter @engenty-wizards/web exec tsx scripts/engenty-shapes.tsx
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ENGENTY_FILL, ENGENTY_KIND_FILL, ENGENTY_KINDS } from "../src/engenty/colors";
import { ENGENTY_SHADOW, Engenty } from "../src/engenty/engenty";
import { cssToHex } from "./oklch";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = "apps/web/scripts/engenty-shapes.tsx";

/** `var(--x, oklch(…))` → the fallback, then hex. */
const color = (value: string) => cssToHex(value.replace(/^var\(--[\w-]+,\s*(.+)\)$/, "$1"));

function still(svg: string): string {
  return (
    svg
      // The idle morph's first frame becomes the shape's own `d`.
      .replace(
        /<path([^>]*)><animate attributeName="d"[^>]*values="([^";]+)[^"]*"[^>]*><\/animate>/g,
        '<path$1 d="$2">',
      )
      // A path that has a `d` of its own keeps it.
      .replace(/ d="([^"]*)"([^>]*) d="[^"]*"/g, ' d="$1"$2')
      .replace(/<animate[^>]*><\/animate>/g, "")
      // No ground shadow: the app draws engenties straight on the stage.
      .replace(/<ellipse class="e-shadow"[^>]*><\/ellipse>/, "")
      .replace(/ (class|data-[\w-]+|aria-hidden|style|overflow)="[^"]*"/g, "")
      .replace(/(fill|stroke)="([^"]+)"/g, (_, attr, value) => `${attr}="${color(value)}"`)
      .replace(/^<svg[^>]*>/, '<svg viewBox="0 0 120 120">')
  );
}

const shapes = Object.fromEntries(
  ENGENTY_KINDS.map((kind) => [
    kind,
    still(renderToStaticMarkup(createElement(Engenty, { kind, animated: false, size: 120 }))),
  ]),
);
const fills = Object.fromEntries(
  ENGENTY_KINDS.map((kind) => [kind, ENGENTY_FILL[ENGENTY_KIND_FILL[kind]]]),
);

const shapesModule = (
  by: string,
) => `// Written by ${by} from apps/web/src/engenty — do not edit by hand.

export type EngentyKind = ${ENGENTY_KINDS.map((k) => JSON.stringify(k)).join(" | ")};

export const ENGENTY_KINDS: EngentyKind[] = ${JSON.stringify(ENGENTY_KINDS)};

/** Each kind's fill in oklch, as the web writes it: the stage of a wizard takes its hue. */
export const ENGENTY_FILL_OKLCH: Record<EngentyKind, string> = ${JSON.stringify(
  Object.fromEntries(
    Object.entries(fills).map(([k, v]) => [k, v.replace(/^var\(--[\w-]+,\s*(.+)\)$/, "$1")]),
  ),
  null,
  2,
)};

/** Still SVG, 120 × 120. */
export const ENGENTY_SVG: Record<EngentyKind, string> = ${JSON.stringify(shapes, null, 2)};
`;

const shadows = Object.fromEntries(
  ENGENTY_KINDS.map((kind) => [kind, { cy: ENGENTY_SHADOW[kind].cy, rx: ENGENTY_SHADOW[kind].rx }]),
);
writeFileSync(
  join(here, "../../runtime/src/services/engenty-shapes.ts"),
  `${shapesModule(SCRIPT)}
/** The line each kind stands on (\`cy\`) and its shadow's half width, in the same 120 × 120. */
export const ENGENTY_SHADOW: Record<EngentyKind, { cy: number; rx: number }> = ${JSON.stringify(shadows, null, 2)};
`,
);
console.log("wrote apps/runtime/src/services/engenty-shapes.ts");

// The mobile app, in the apps repo beside this one.
const apps = resolve(here, "../../..", process.env.WIZARDS_APPS ?? "../engenty-wizards-apps");
const mobile = join(apps, "mobile/src/engenty/shapes.ts");
if (existsSync(dirname(mobile))) {
  writeFileSync(mobile, shapesModule(`the open repo's ${SCRIPT} (engenty-wizards)`));
  console.log(`wrote ${mobile}`);
} else {
  console.log(`no apps repo at ${apps} (WIZARDS_APPS): the mobile app's shapes.ts not written`);
}
