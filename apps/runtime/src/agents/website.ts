import type { PluginWebPage } from "@engenty/wizards/plugin";
import { FONT_WEIGHTS } from "@engenty-wizards/shared/projects";
import { webContext } from "../render/chromium.js";
import { htmlToMarkdown } from "../render/convert.js";
import { safeFetch } from "../tools/net-guard.js";

/**
 * A web page as the project assistant needs it: its text, and what it says about the brand —
 * colours from its stylesheets, logo candidates, and the pages that carry address and VAT ID.
 */
export interface WebsiteReading {
  url: string;
  status: number;
  title: string;
  description: string;
  text: string;
  brand: {
    themeColor: string | null;
    /** Colours the stylesheet names (`--primary: #…`), most telling first. */
    variables: { name: string; value: string }[];
    /** The colours used most, greys last. */
    frequent: string[];
    logos: { url: string; hint: string }[];
    images: { url: string; alt: string }[];
    /** The typefaces it uses, most used first. */
    fonts: { family: string; weights: number[] }[];
  };
  links: { url: string; text: string }[];
}

const UA = { "user-agent": "Mozilla/5.0 (compatible; engenty-wizards/0.1)" };

const attr = (tag: string, name: string) =>
  tag
    .match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    ?.slice(2)
    .find(Boolean) ?? "";

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function hex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(v)) {
    return v;
  }
  if (/^#[0-9a-f]{8}$/.test(v)) {
    return v.slice(0, 7);
  }
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
  if (rgb) {
    return toHex(rgb.slice(1, 4).map(Number));
  }
  const hsl = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (hsl) {
    const [h, sat, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return 255 * (l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return toHex([f(0), f(8), f(4)]);
  }
  const ok = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/);
  if (ok) {
    return toHex(oklchToRgb(Number(ok[1]) / (ok[2] ? 100 : 1), Number(ok[3]), Number(ok[4])));
  }
  return null;
}

const toHex = (rgb: number[]) =>
  `#${rgb
    .map((n) =>
      Math.round(Math.max(0, Math.min(255, n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** OKLCH (as CSS writes it, Tailwind 4 among others) in sRGB, 0–255. */
function oklchToRgb(l: number, c: number, h: number): number[] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return linear.map(
    (x) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055),
  );
}

/** How far a colour is from grey, 0–255. */
function chroma(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** A colour as CSS writes it: hex, rgb(), hsl() or oklch(). */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/;

function coloursOf(css: string) {
  const variables: { name: string; value: string }[] = [];
  for (const m of css.matchAll(new RegExp(`(--[\\w-]+)\\s*:\\s*(${COLOUR.source})`, "g"))) {
    const value = hex(m[2]);
    // Tailwind's own variables are its machinery, not the site's colours.
    if (value && !m[1].startsWith("--tw-") && !variables.some((v) => v.name === m[1])) {
      variables.push({ name: m[1], value });
    }
  }
  const counts = new Map<string, number>();
  for (const m of css.matchAll(new RegExp(COLOUR.source, "g"))) {
    const value = hex(m[0]);
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const telling = /brand|primary|accent|main|theme|secondary|highlight|cta|link/i;
  return {
    variables: variables
      .sort((a, b) => Number(telling.test(b.name)) - Number(telling.test(a.name)))
      .slice(0, 24),
    frequent: [...counts.entries()]
      .sort((a, b) => Number(chroma(b[0]) > 24) - Number(chroma(a[0]) > 24) || b[1] - a[1])
      .slice(0, 12)
      .map(([value]) => value),
  };
}

async function stylesheet(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await safeFetch(url, {
      headers: UA,
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    });
    return res.ok ? (await res.text()).slice(0, 400_000) : "";
  } catch {
    return "";
  }
}

/** The page as a browser shows it, for sites that write their text with scripts. */
async function rendered(url: string): Promise<string | null> {
  try {
    const context = await webContext();
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 }).catch(() => undefined);
      return await page.content();
    } finally {
      await context.close();
    }
  } catch {
    return null;
  }
}

/** A page's HTML, drawn in a browser when it has hardly any text without its scripts. */
async function loadPage(raw: string, signal?: AbortSignal) {
  const res = await safeFetch(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, {
    headers: UA,
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
  });
  const base = res.url;
  let html = (await res.text()).slice(0, 1_500_000);
  // Hardly any text in the page as sent: it is written in the browser.
  if (res.ok && htmlToMarkdown(html).replace(/\s+/g, " ").length < 500) {
    html = ((await rendered(base)) ?? html).slice(0, 1_500_000);
  }
  return { res, base, html };
}

const tagsOf = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);

/** A `<meta>` by its name or property. */
function metaOf(html: string, key: string): string {
  const tag = tagsOf(html, "meta").find((t) =>
    [attr(t, "name"), attr(t, "property")].some((v) => v.toLowerCase() === key),
  );
  return tag ? attr(tag, "content") : "";
}

const titleOf = (html: string) =>
  html
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    .replace(/\s+/g, " ")
    .trim() ?? "";

/** The text of a link, as a reader sees it. */
const linkText = (inner: string) =>
  inner
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/** The `<script type="application/ld+json">` blocks of a page, parsed; a `@graph` is spread out. */
export function jsonLdOf(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const graph = (item as { "@graph"?: unknown } | null)?.["@graph"];
      out.push(...(Array.isArray(graph) ? graph : [item]));
    }
    if (out.length >= 50) {
      break;
    }
  }
  return out.slice(0, 50);
}

/**
 * A page for a plugin (`server.web.read`): its whole text as Markdown, every link and its
 * structured data, as against `readWebsite`, which picks what the assistant needs of a
 * company's site.
 */
export async function readPage(raw: string, signal?: AbortSignal): Promise<PluginWebPage> {
  const { res, base, html } = await loadPage(raw, signal);
  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(attr(`<a ${m[1]}>`, "href"), base)?.replace(/#.*$/, "");
    if (url && !links.some((l) => l.url === url) && links.length < 2000) {
      links.push({ url, text: linkText(m[2]) });
    }
  }
  return {
    url: base,
    status: res.status,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    title: titleOf(html),
    description: metaOf(html, "description") || metaOf(html, "og:description"),
    text: htmlToMarkdown(html).slice(0, 400_000),
    links,
    jsonld: jsonLdOf(html),
  };
}

const saysLogo = (tag: string) =>
  /logo/i.test(
    [
      attr(tag, "src"),
      attr(tag, "alt"),
      attr(tag, "class"),
      attr(tag, "id"),
      attr(tag, "aria-label"),
    ]
      .filter(Boolean)
      .join(" "),
  );

/**
 * The logos a page shows, best first: the logo its structured data names, pictures that say
 * "logo", what its home link in the header shows, and its icons. `inline`: SVGs drawn into the
 * page count too, as `data:` addresses — for a person to pick from, too long for a model to read.
 */
function logosOf(html: string, base: string, inline = false): { url: string; hint: string }[] {
  const logos: { url: string; hint: string }[] = [];
  const add = (href: string, hint: string) => {
    const url = href.startsWith("data:image/svg+xml") ? href : absolute(href, base);
    if (url && !logos.some((l) => l.url === url)) {
      logos.push({ url, hint });
    }
  };
  for (const item of jsonLdOf(html)) {
    const logo = (item as { logo?: unknown } | null)?.logo;
    const href = typeof logo === "string" ? logo : (logo as { url?: unknown } | null)?.url;
    if (typeof href === "string") {
      add(href, "the logo the page names in its structured data");
    }
  }
  for (const tag of tagsOf(html, "img")) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (src && !src.startsWith("data:") && saysLogo(tag)) {
      const alt = attr(tag, "alt");
      add(src, `image on the page${alt ? `, alt "${alt}"` : ""}`);
    }
  }
  // What the link home shows is the logo on most sites, said so or not.
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absolute(attr(`<a ${m[1]}>`, "href"), base);
    if (!href || new URL(href).pathname !== "/" || new URL(href).host !== new URL(base).host) {
      continue;
    }
    const img = tagsOf(m[2], "img")[0];
    const src = img && (attr(img, "src") || attr(img, "data-src"));
    if (src && !src.startsWith("data:")) {
      add(src, "image in the link to the home page");
    }
    const svg = inline ? m[2].match(/<svg\b[\s\S]*?<\/svg>/i)?.[0] : undefined;
    if (svg) {
      add(svgUrl(svg), "drawing in the link to the home page");
    }
  }
  if (inline) {
    for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
      const open = m[0].match(/^<svg\b[^>]*>/i)?.[0] ?? "";
      const title = m[0].match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
      if (saysLogo(open) || /logo/i.test(title)) {
        add(svgUrl(m[0]), "drawing on the page");
      }
    }
  }
  for (const tag of tagsOf(html, "link")) {
    const rel = attr(tag, "rel").toLowerCase();
    if (/apple-touch-icon|mask-icon|(^|\s)icon/.test(rel)) {
      add(attr(tag, "href"), `${rel} ${attr(tag, "sizes")}`.trim());
    }
  }
  return logos;
}

/** An inline SVG as a picture of its own: with its namespace, as a `data:` address. */
function svgUrl(svg: string): string {
  const own = /\bxmlns\s*=/.test(svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "")
    ? svg
    : svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;base64,${Buffer.from(own).toString("base64")}`;
}

/** The logos on a web page, for a person to pick from (Logos › from a web address). */
export async function scanLogos(
  raw: string,
  signal?: AbortSignal,
): Promise<{ url: string; hint: string }[]> {
  const { base, html } = await loadPage(raw, signal);
  return logosOf(html, base, true)
    .filter((l) => !l.url.startsWith("data:") || l.url.length < 400_000)
    .slice(0, 16);
}

/** The CSS a page brings: its `<style>` blocks, style attributes and first stylesheets. */
async function cssOf(html: string, base: string, signal?: AbortSignal): Promise<string> {
  const sheets = tagsOf(html, "link")
    .filter((t) => /stylesheet/i.test(attr(t, "rel")))
    .map((t) => absolute(attr(t, "href"), base))
    .filter((u): u is string => Boolean(u))
    .slice(0, 4);
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const styled = [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  return [
    ...inline,
    ...styled,
    ...(await Promise.all(sheets.map((s) => stylesheet(s, signal)))),
  ].join("\n");
}

/** Family names that are no brand's own: generic and system faces. */
const GENERIC_FONT =
  /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial|unset|revert|emoji|math|fangsong|segoe ui( emoji| symbol)?|helvetica( neue)?|arial|roboto|noto (sans|color emoji)|apple color emoji|courier( new)?|times( new roman)?|georgia|menlo|monaco|consolas|var\(.*|liberation mono|sfmono-regular|sf mono|sf pro( text| display)?|dejavu sans( mono)?)$/i;

/** "Geist Variable" is Geist: a variable font's file name, not another family. */
const familyName = (raw: string) =>
  raw
    .replace(/^[\s"'(]+|[\s"')]+$/g, "")
    .replace(/\s+variable$/i, "")
    .trim();

/**
 * The typefaces a page uses, most used first, with the weights its `@font-face` rules or its
 * Google / Bunny Fonts links name.
 */
function fontsOf(css: string, html: string): { family: string; weights: number[] }[] {
  const counts = new Map<string, number>();
  const weights = new Map<string, Set<number>>();
  const count = (family: string, n = 1) => counts.set(family, (counts.get(family) ?? 0) + n);
  const weigh = (family: string, list: number[]) => {
    const set = weights.get(family) ?? new Set<number>();
    for (const w of list) {
      set.add(w);
    }
    weights.set(family, set);
  };
  const first = (decl: string) =>
    decl
      .split(",")
      .map(familyName)
      .find((f) => /[a-z]/i.test(f) && !GENERIC_FONT.test(f));
  // --font-weight-…, --font-size-… and the like are no families.
  for (const m of css.matchAll(
    /(?:font-family|--font-(?!weight|size|feature|variation|style|stretch)[\w-]+)\s*:\s*([^;}]+)/gi,
  )) {
    const family = first(m[1]);
    if (family) {
      count(family);
    }
  }
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const family = first(m[1].match(/font-family\s*:\s*([^;]+)/i)?.[1] ?? "");
    const range = (m[1].match(/font-weight\s*:\s*([^;]+)/i)?.[1] ?? "400")
      .split(/\s+/)
      .map(Number)
      .filter((n) => n >= 100 && n <= 900);
    if (family && range.length) {
      const [lo, hi] = [Math.min(...range), Math.max(...range)];
      weigh(
        family,
        FONT_WEIGHTS.filter((w) => w >= lo && w <= hi),
      );
    }
  }
  // fonts.googleapis.com/css2?family=Inter:wght@400;700 and fonts.bunny.net/css?family=inter:400,700
  for (const m of html.matchAll(/fonts\.(?:googleapis\.com|bunny\.net)\/css2?\?([^"'\s>]+)/gi)) {
    for (const part of m[1].replace(/&amp;/g, "&").split("&")) {
      if (!part.startsWith("family=")) {
        continue;
      }
      for (const one of decodeURIComponent(part.slice(7)).split("|")) {
        const [name, spec = ""] = one.split(":");
        const family = familyName(name.replace(/\+/g, " ").replace(/-/g, " ")).replace(
          /\b\w/g,
          (c) => c.toUpperCase(),
        );
        count(family, 3);
        weigh(
          family,
          (spec.match(/\d{3}/g) ?? []).map(Number).filter((w) => w >= 100 && w <= 900),
        );
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([family]) => ({
      family,
      weights: [...(weights.get(family) ?? [])].sort((a, b) => a - b),
    }));
}

/** The typefaces of a web page, for a person to pick from (Typography › from a web address). */
export async function scanFonts(
  raw: string,
  signal?: AbortSignal,
): Promise<{ family: string; weights: number[] }[]> {
  const { base, html } = await loadPage(raw, signal);
  return fontsOf(await cssOf(html, base, signal), html);
}

/**
 * The colours of a web page, for a person to pick from (Colours › from a web address): its
 * theme colour, the colours its stylesheet names, then the ones it uses most. A named one is
 * named after its variable ("--brand-primary" → "brand primary").
 */
export async function scanColors(
  raw: string,
  signal?: AbortSignal,
): Promise<{ name: string; value: string }[]> {
  const { base, html } = await loadPage(raw, signal);
  const { variables, frequent } = coloursOf(await cssOf(html, base, signal));
  const out: { name: string; value: string }[] = [];
  const add = (name: string, value: string | null) => {
    if (value && !out.some((c) => c.value === value)) {
      out.push({ name, value });
    }
  };
  add("theme color", hex(metaOf(html, "theme-color")));
  for (const v of variables) {
    add(v.name.replace(/^--/, "").replace(/[-_]+/g, " "), v.value);
  }
  for (const value of frequent) {
    add("", value);
  }
  return out.slice(0, 24);
}

/**
 * The pictures of a web page, for a person to pick assets from: its share image, then the
 * images it shows, logos left out.
 */
export async function scanImages(
  raw: string,
  signal?: AbortSignal,
): Promise<{ url: string; hint: string }[]> {
  const { base, html } = await loadPage(raw, signal);
  const out: { url: string; hint: string }[] = [];
  const add = (href: string, hint: string) => {
    const url = absolute(href, base);
    if (url && !out.some((i) => i.url === url)) {
      out.push({ url, hint });
    }
  };
  const og = metaOf(html, "og:image");
  if (og) {
    add(og, "share image");
  }
  for (const tag of tagsOf(html, "img")) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (src && !src.startsWith("data:") && !saysLogo(tag)) {
      add(src, attr(tag, "alt"));
    }
  }
  return out.slice(0, 24);
}

export async function readWebsite(raw: string, signal?: AbortSignal): Promise<WebsiteReading> {
  const { res, base, html } = await loadPage(raw, signal);
  const tags = (name: string) => tagsOf(html, name);
  const meta = (key: string) => metaOf(html, key);

  const logos = logosOf(html, base);
  const images: { url: string; alt: string }[] = [];
  for (const tag of tags("img")) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (!src || src.startsWith("data:") || saysLogo(tag)) {
      continue;
    }
    const url = absolute(src, base);
    if (url && images.length < 12 && !images.some((i) => i.url === url)) {
      images.push({ url, alt: attr(tag, "alt") });
    }
  }
  const og = meta("og:image");
  if (og) {
    const url = absolute(og, base);
    if (url) {
      images.unshift({ url, alt: "share image (og:image)" });
    }
  }

  const css = await cssOf(html, base, signal);

  const host = new URL(base).hostname;
  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(attr(`<a ${m[1]}>`, "href"), base);
    const text = linkText(m[2]).slice(0, 60);
    if (
      url &&
      new URL(url).hostname === host &&
      /impressum|imprint|kontakt|contact|about|ueber|über|team|legal|unternehmen|company/i.test(
        `${url} ${text}`,
      ) &&
      !links.some((l) => l.url === url)
    ) {
      links.push({ url, text });
    }
  }

  const text = htmlToMarkdown(html);
  return {
    url: base,
    status: res.status,
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? "",
    description: meta("description") || meta("og:description"),
    text:
      text.length > 9000
        ? `${text.slice(0, 9000)}\n…[${text.length - 9000} more characters]`
        : text,
    brand: {
      themeColor: hex(meta("theme-color")),
      ...coloursOf(css),
      logos: logos.slice(0, 10),
      images,
      fonts: fontsOf(css, html),
    },
    links: links.slice(0, 10),
  };
}
