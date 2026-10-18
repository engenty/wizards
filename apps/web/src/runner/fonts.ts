import type { WizardFont } from "@engenty/wizards-shared/style";

// The typefaces a wizard can choose (WIZARD_FONTS), shipped with the runner: each loads only when
// a wizard uses it, from this site, in the weights the pages use (text 400–700).
const LOADERS: Record<WizardFont, () => Promise<unknown>[]> = {
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
  Promise.all(LOADERS[family as WizardFont]()).catch(() => loaded.delete(family));
}
