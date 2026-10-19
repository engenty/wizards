import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SHIPPED_FONTS, shippedFontSlug } from "@engenty/wizards-shared/theme";

/**
 * The fonts the runner ships (SHIPPED_FONTS), served for pages that are not the runtime's own: a
 * host's OpenUI chat loads a theme's font from here. Each comes from its Fontsource package as
 * the run page bundles it: a stylesheet with the weights the pages use, every subset by its
 * unicode-range, and the files it names next to it.
 */

const require = createRequire(import.meta.url);
const SLUGS = SHIPPED_FONTS.map(shippedFontSlug);
/** The weights the pages use (text 400–700); a font that has fewer comes in those it has. */
const WEIGHTS = [400, 500, 600, 700];
const FILE = /^[a-z0-9-]+-\d{3}-normal\.woff2?$/;

const packageDir = (slug: string) => dirname(require.resolve(`@fontsource/${slug}/package.json`));

/** The stylesheet of a shipped font by its slug; null for one that is not ours. */
export async function shippedFontCss(slug: string): Promise<string | null> {
  if (!SLUGS.includes(slug)) {
    return null;
  }
  const dir = packageDir(slug);
  const sheets = await Promise.all(
    WEIGHTS.map((w) => readFile(join(dir, `${w}.css`), "utf8").catch(() => "")),
  );
  return sheets.join("\n");
}

/** One file a shipped font's stylesheet names; null for anything else. */
export async function shippedFontFile(file: string): Promise<Buffer | null> {
  // The longest slug first: one slug can start another's name.
  const slug = FILE.test(file)
    ? [...SLUGS].sort((a, b) => b.length - a.length).find((s) => file.startsWith(`${s}-`))
    : undefined;
  return slug ? await readFile(join(packageDir(slug), "files", file)).catch(() => null) : null;
}
