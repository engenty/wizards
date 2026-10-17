import { posix } from "node:path";
import type { RunTheme } from "@engenty-wizards/shared/run";
import { isTextMime, type WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { getBlob } from "../files/blobs.js";
import { guardHtml } from "../render/guard.js";
import { WIDGET_RUNTIME } from "./runtime.js";

export interface WidgetBrand {
  name: string;
  accent: string | null;
  logo: string | null;
  /** The project's colours by name; the first is the accent. */
  colors?: { name: string; value: string }[];
  /** The project's facts: key → value. */
  facts?: Record<string, string>;
  /** How the run page looks: accent, second colour, ground, typefaces (`runTheme`). */
  theme?: RunTheme;
}

interface Loaded {
  file: WorkspaceFile;
  data: Buffer;
}

const MAX_BUNDLE_BYTES = 30_000_000;

function isExternal(ref: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

/** A reference in a file at `fromDir`, as a workspace path. */
function resolvePath(ref: string, fromDir: string): string {
  const clean = ref.split(/[?#]/)[0];
  return clean.startsWith("/")
    ? posix.normalize(clean.slice(1))
    : posix.normalize(posix.join(fromDir, clean));
}

function dataUri(l: Loaded): string {
  return `data:${l.file.mime};base64,${l.data.toString("base64")}`;
}

/**
 * The widget as ONE self-contained HTML file: its scripts, styles and images inlined, every other
 * workspace file in the payload `wizard.file()` reads, and the run's data. This file is the result:
 * it is what the preview shows, what is shared, downloaded, and rendered to PNG/PDF/MP4.
 */
export async function bundleWidget(input: {
  entry: string;
  files: WorkspaceFile[];
  data: unknown;
  brand: WidgetBrand;
  /** An origin the page may load images, video and audio from (films). */
  media?: string;
  /** What the widget shows of the run is media a model made ("generated") or changed ("edited"). */
  ai?: "generated" | "edited";
}): Promise<string> {
  const loaded = new Map<string, Loaded>();
  for (const file of input.files) {
    loaded.set(file.path, { file, data: await getBlob(file.hash) });
  }
  const entry = loaded.get(input.entry);
  if (!entry) {
    throw new Error(`The widget file ${input.entry} is missing from the workspace.`);
  }
  const inlined = new Set<string>([input.entry]);
  const lookup = (ref: string, fromDir: string): Loaded | null => {
    if (isExternal(ref)) {
      return null;
    }
    return loaded.get(resolvePath(ref, fromDir)) ?? loaded.get(resolvePath(ref, "")) ?? null;
  };
  const inlineCssUrls = (css: string, fromDir: string) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q: string, ref: string) => {
      const l = lookup(ref, fromDir);
      return l ? `url("${dataUri(l)}")` : m;
    });

  const entryDir = posix.dirname(input.entry) === "." ? "" : posix.dirname(input.entry);
  let html = entry.data.toString("utf8");

  html = html.replace(
    /<script\b([^>]*?)\bsrc\s*=\s*(['"])([^'"]+)\2([^>]*)>\s*<\/script>/gi,
    (m, before: string, _q: string, ref: string, after: string) => {
      const l = lookup(ref, entryDir);
      if (!l) {
        return m;
      }
      inlined.add(l.file.path);
      const code = l.data.toString("utf8").replace(/<\/script/gi, "<\\/script");
      return `<script${before}${after}>${code}</script>`;
    },
  );
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*(['"]?)stylesheet\1/i.test(tag)) {
      return tag;
    }
    const ref = tag.match(/\bhref\s*=\s*(['"])([^'"]+)\1/i)?.[2];
    const l = ref ? lookup(ref, entryDir) : null;
    if (!l) {
      return tag;
    }
    inlined.add(l.file.path);
    const dir = posix.dirname(l.file.path) === "." ? "" : posix.dirname(l.file.path);
    return `<style>${inlineCssUrls(l.data.toString("utf8"), dir)}</style>`;
  });
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, css: string, close: string) =>
      `${open}${inlineCssUrls(css, entryDir)}${close}`,
  );
  html = html.replace(
    /(<(?:img|source|video|audio|image|use)\b[^>]*?\b(?:src|href|poster|xlink:href)\s*=\s*)(['"])([^'"]+)\2/gi,
    (m, head: string, q: string, ref: string) => {
      const l = lookup(ref, entryDir);
      return l ? `${head}${q}${dataUri(l)}${q}` : m;
    },
  );

  const payloadFiles: Record<string, { mime: string; text?: string; b64?: string }> = {};
  for (const [path, l] of loaded) {
    if (inlined.has(path)) {
      continue;
    }
    payloadFiles[path] = isTextMime(l.file.mime)
      ? { mime: l.file.mime, text: l.data.toString("utf8") }
      : { mime: l.file.mime, b64: l.data.toString("base64") };
  }
  const payload = JSON.stringify({
    data: input.data ?? {},
    brand: input.brand,
    ai: input.ai ?? null,
    files: payloadFiles,
    base: entryDir ? `${entryDir}/` : "",
  }).replace(/</g, "\\u003c");
  const boot = `<script type="application/json" id="wizard-payload">${payload}</script><script>${WIDGET_RUNTIME}</script>`;

  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => `${m}${boot}`)
    : `<!doctype html><html><head>${boot}</head><body>${html}</body></html>`;
  const out = guardHtml(html, input.media);
  if (Buffer.byteLength(out) > MAX_BUNDLE_BYTES) {
    throw new Error("The widget with its files is larger than 30 MB.");
  }
  return out;
}
