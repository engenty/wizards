import type { RunFontFace } from "@engenty/wizards-shared/run";

/** How long a website has to send a brand font before the shipped one is loaded beside it. */
const FACE_WAIT_MS = 3000;

const faces = new Set<string>();

/**
 * Loads a brand font, once, from `url`: our copy of its file, or the space's website (the file,
 * or a stylesheet that holds it). When the website does not answer, does not allow other sites
 * to use the font, or has no font of that name, `fallback` loads the shipped font of its kind:
 * the page's font stack names it right after the brand font.
 */
export function loadBrandFace(face: RunFontFace, url: string, fallback: () => void) {
  const key = `${face.family}\n${face.url}`;
  if (faces.has(key)) {
    return;
  }
  faces.add(key);
  let done = false;
  const wait = setTimeout(() => done || fallback(), FACE_WAIT_MS);
  const loaded = () => {
    done = true;
    clearTimeout(wait);
  };
  const failed = () => {
    loaded();
    fallback();
  };
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
