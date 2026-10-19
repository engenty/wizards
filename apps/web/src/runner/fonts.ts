import type { RunFontFace } from "@engenty/wizards-shared/run";
import type { ShippedFont } from "@engenty/wizards-shared/theme";
import { withBase } from "../lib/base";

// The fonts a theme can name (SHIPPED_FONTS), shipped with the runner: each loads only when
// a wizard uses it, from this site, in the weights the pages use (text 400–700).
const LOADERS: Record<ShippedFont, () => Promise<unknown>[]> = {
  Inter: () => [
    import("@fontsource/inter/400.css"),
    import("@fontsource/inter/500.css"),
    import("@fontsource/inter/600.css"),
    import("@fontsource/inter/700.css"),
  ],
  Figtree: () => [
    import("@fontsource/figtree/400.css"),
    import("@fontsource/figtree/500.css"),
    import("@fontsource/figtree/600.css"),
    import("@fontsource/figtree/700.css"),
  ],
  "DM Sans": () => [
    import("@fontsource/dm-sans/400.css"),
    import("@fontsource/dm-sans/500.css"),
    import("@fontsource/dm-sans/600.css"),
    import("@fontsource/dm-sans/700.css"),
  ],
  Nunito: () => [
    import("@fontsource/nunito/400.css"),
    import("@fontsource/nunito/500.css"),
    import("@fontsource/nunito/600.css"),
    import("@fontsource/nunito/700.css"),
  ],
  Fredoka: () => [
    import("@fontsource/fredoka/400.css"),
    import("@fontsource/fredoka/500.css"),
    import("@fontsource/fredoka/600.css"),
    import("@fontsource/fredoka/700.css"),
  ],
  "Bricolage Grotesque": () => [
    import("@fontsource/bricolage-grotesque/400.css"),
    import("@fontsource/bricolage-grotesque/500.css"),
    import("@fontsource/bricolage-grotesque/600.css"),
    import("@fontsource/bricolage-grotesque/700.css"),
  ],
  Fraunces: () => [
    import("@fontsource/fraunces/400.css"),
    import("@fontsource/fraunces/500.css"),
    import("@fontsource/fraunces/600.css"),
    import("@fontsource/fraunces/700.css"),
  ],
  "Playfair Display": () => [
    import("@fontsource/playfair-display/400.css"),
    import("@fontsource/playfair-display/500.css"),
    import("@fontsource/playfair-display/600.css"),
    import("@fontsource/playfair-display/700.css"),
  ],
  Lora: () => [
    import("@fontsource/lora/400.css"),
    import("@fontsource/lora/500.css"),
    import("@fontsource/lora/600.css"),
    import("@fontsource/lora/700.css"),
  ],
  "Young Serif": () => [import("@fontsource/young-serif/400.css")],
  Caveat: () => [
    import("@fontsource/caveat/400.css"),
    import("@fontsource/caveat/500.css"),
    import("@fontsource/caveat/600.css"),
    import("@fontsource/caveat/700.css"),
  ],
  Creepster: () => [import("@fontsource/creepster/400.css")],
  Nosifer: () => [import("@fontsource/nosifer/400.css")],
};

const loaded = new Set<string>();

/** Loads a typeface a wizard names, once; a family that is not one of ours is left as it is. */
export function loadWizardFont(family: string | null | undefined) {
  if (!family || loaded.has(family) || !(family in LOADERS)) {
    return;
  }
  loaded.add(family);
  Promise.all(LOADERS[family as ShippedFont]()).catch(() => loaded.delete(family));
}

const SERIFS =
  /serif|fraunces|playfair|lora|garamond|antiqua|baskerville|caslon|bodoni|didot|times|georgia|merriweather|tiempos/i;

/** A family looks like a serif by its name: what takes its place is a serif too. */
export const serifFamily = (family: string) => SERIFS.test(family) && !/sans/i.test(family);

/** The shipped font that shows where a brand font does not load: one of its kind. */
export const shippedLike = (family: string): ShippedFont =>
  serifFamily(family) ? "Lora" : "Inter";

/** How long a website has to send a brand font before the shipped one is loaded beside it. */
const FACE_WAIT_MS = 3000;

const faces = new Set<string>();

/**
 * Loads a brand font, once, from where its space keeps it: our copy of its file, or the space's
 * website (the file, or a stylesheet that holds it). When the website does not answer, does not
 * allow other sites to use the font, or has no font of that name, the shipped font of its kind
 * shows: the page's font stack names it right after the brand font.
 */
export function loadBrandFace(face: RunFontFace) {
  const key = `${face.family}\n${face.url}`;
  if (faces.has(key)) {
    return;
  }
  faces.add(key);
  let done = false;
  const fallback = () => loadWizardFont(shippedLike(face.family));
  const wait = setTimeout(() => done || fallback(), FACE_WAIT_MS);
  const loaded = () => {
    done = true;
    clearTimeout(wait);
  };
  const failed = () => {
    loaded();
    fallback();
  };
  const url = face.url.startsWith("/") ? withBase(face.url) : face.url;
  if (face.stylesheet) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.onerror = failed;
    link.onload = () => {
      document.fonts
        .load(`1em "${face.family.replace(/"/g, "")}"`)
        .then((found) => (found.length ? loaded() : failed()), failed);
    };
    document.head.append(link);
    return;
  }
  const font = new FontFace(face.family, `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`, {
    display: "swap",
    weight: "100 900",
  });
  font.load().then((f) => {
    document.fonts.add(f);
    loaded();
  }, failed);
}
