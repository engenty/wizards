import type { PluginWebPage } from "@engenty/wizards/plugin";
import { FONT_WEIGHTS } from "@engenty/wizards-shared/spaces";
import { webContext } from "../render/chromium.js";
import { htmlToContent, htmlToMarkdown } from "../render/convert.js";
import { safeFetch } from "../tools/net-guard.js";

/**
 * A web page as the space assistant needs it: its text, and what it says about the brand —
 * colours from its stylesheets, logo candidates, and the pages that carry address and VAT ID.
 */
export interface WebsiteReading {
  url: string;
  status: number;
  title: string;
  /** The name the site gives itself: `og:site_name`, `application-name`, its structured data. */
  siteName: string;
  description: string;
  text: string;
  brand: {
    themeColor: string | null;
    /** Colours the stylesheet names (`--primary: #…`), most telling first. */
    variables: { name: string; value: string }[];
    /** The colours used most, greys last. */
    frequent: string[];
    logos: { url: string; hint: string }[];
    /** `hero`: the page's big picture (its share image, a hero, a banner): brand material. */
    images: { url: string; alt: string; hero?: boolean }[];
    /** The typefaces it uses, most used first; `headings`: the page sets its headings in it. */
    fonts: { family: string; weights: number[]; headings?: boolean }[];
  };
  /** Pages of the same site that say who the company is, its imprint and contact page first. */
  links: { url: string; text: string }[];
  /** What the page states about the company itself: address, phone, e-mail, VAT ID. */
  contact: CompanyContact;
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

/**
 * Variables that are machinery, not the site's colours: Tailwind's own, and the preset palette
 * WordPress puts on every page.
 */
const MACHINERY = /^--(tw-|wp--preset--)/;

/** A variable's definition, and whether it sits on the root (`:root`, `html`, …) or deeper. */
interface CssVariable {
  value: string;
  root: boolean;
}

/** Every custom property the CSS defines, in order. */
function variablesOf(css: string): Map<string, CssVariable[]> {
  const out = new Map<string, CssVariable[]>();
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const root = rule[1].split(",").some((s) => /^(:root|:host|html|body)$/i.test(s.trim()));
    for (const decl of rule[2].split(";")) {
      const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/);
      if (m?.[2]) {
        out.set(m[1], [...(out.get(m[1]) ?? []), { value: m[2], root }]);
      }
    }
  }
  return out;
}

/** The arguments of a CSS function, split at the commas outside parentheses. */
function argsOf(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(inner.slice(from, i).trim());
      from = i + 1;
    }
  }
  args.push(inner.slice(from).trim());
  return args;
}

/** `name(…)` when the whole value is that one call: its name and what is inside. */
function callOf(value: string): { name: string; inner: string } | null {
  const open = value.match(/^([\w-]+)\(/);
  if (!open || !value.endsWith(")")) {
    return null;
  }
  let depth = 0;
  for (let i = open[0].length - 1; i < value.length; i++) {
    depth += value[i] === "(" ? 1 : value[i] === ")" ? -1 : 0;
    if (depth === 0) {
      return i === value.length - 1
        ? { name: open[1].toLowerCase(), inner: value.slice(open[0].length, -1) }
        : null;
    }
  }
  return null;
}

const rgbOf = (color: string) => [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));

/**
 * Colours as the page draws them: a value that refers to variables (`var(--accent)`, through
 * any number of them) or mixes colours (`color-mix(in oklch, var(--accent) 20%, white)`) is
 * followed to its colour. A variable counts as the page's root sets it, the last definition
 * winning as in the cascade; one only a part of the page sets counts where the root has none.
 */
function paletteOf(css: string) {
  const variables = variablesOf(css);
  const definitions = (name: string) => {
    const all = variables.get(name) ?? [];
    return [...all.filter((d) => d.root).reverse(), ...all.filter((d) => !d.root).reverse()];
  };
  // The text a variable stands for, its own variables written out: for `hsl(var(--h) 50% 40%)`.
  const text = (value: string, seen: string[]): string =>
    seen.length > 16
      ? value
      : value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name: string, fallback) => {
          const own = seen.includes(name) ? undefined : definitions(name)[0];
          return own ? text(own.value, [...seen, name]) : (fallback?.trim() ?? "");
        });
  const known = new Map<string, string | null>();
  const variable = (name: string, seen: string[]): string | null => {
    if (seen.includes(name)) {
      return null;
    }
    if (!known.has(name)) {
      known.set(
        name,
        definitions(name).reduce<string | null>(
          (found, d) => found ?? colour(d.value, [...seen, name]),
          null,
        ),
      );
    }
    return known.get(name) ?? null;
  };
  const colour = (raw: string, seen: string[]): string | null => {
    const value = raw.replace(/!important$/i, "").trim();
    if (seen.length > 16) {
      return null;
    }
    const call = callOf(value);
    if (call?.name === "var") {
      const [name, fallback] = argsOf(call.inner);
      return variable(name, seen) ?? (fallback ? colour(fallback, seen) : null);
    }
    if (call?.name === "color-mix") {
      return mixed(argsOf(call.inner).slice(1), seen);
    }
    if (value.includes("var(")) {
      return hex(text(value, seen));
    }
    return NAMED[value.toLowerCase()] ?? hex(value);
  };
  // Mixed as sRGB, as the colours a stylesheet compiles for browsers without color-mix() are.
  const mixed = (parts: string[], seen: string[]): string | null => {
    if (parts.length !== 2) {
      return null;
    }
    const [a, b] = parts.map((p) => {
      const m = p.match(/^([\s\S]*?)\s*(\d+(?:\.\d+)?)%$/);
      return { color: (m ? m[1] : p).trim(), share: m ? Number(m[2]) : null };
    });
    const pa = a.share ?? (b.share === null ? 50 : 100 - b.share);
    const pb = b.share ?? 100 - pa;
    if (/^transparent$/i.test(b.color)) {
      return colour(a.color, seen);
    }
    if (/^transparent$/i.test(a.color)) {
      return colour(b.color, seen);
    }
    const [ca, cb] = [colour(a.color, seen), colour(b.color, seen)];
    if (!ca || !cb || pa + pb <= 0) {
      return null;
    }
    const [ra, rb] = [rgbOf(ca), rgbOf(cb)];
    return toHex(ra.map((x, i) => (x * pa + rb[i] * pb) / (pa + pb)));
  };
  return { variables, colour };
}

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };

/** A step of a scale (`-200`, `-dark`): the base colour says more about the brand. */
const SHADE = /[-_](\d{2,3}|light(er)?|dark(er)?|muted|subtle|soft|hover|active)$/i;

function coloursOf(css: string) {
  const { variables: defined, colour } = paletteOf(css);
  const variables: { name: string; value: string }[] = [];
  for (const name of defined.keys()) {
    const value = MACHINERY.test(name) ? null : colour(`var(${name})`, []);
    if (value) {
      variables.push({ name, value });
    }
  }
  const counts = new Map<string, number>();
  const own = css.replace(/--(?:tw-|wp--preset--)[\w-]*\s*:[^;}]*/g, "");
  for (const m of own.matchAll(new RegExp(COLOUR.source, "g"))) {
    const value = hex(m[0]);
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  // A brand's own colours are the ones its stylesheet refers to again and again.
  const uses = new Map<string, number>();
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    uses.set(m[1], (uses.get(m[1]) ?? 0) + 1);
  }
  const rank = (name: string) =>
    (/brand|primary|accent|main|theme/i.test(name)
      ? 4
      : /secondary|highlight|cta|link/i.test(name)
        ? 2
        : 0) - Number(SHADE.test(name));
  return {
    variables: variables
      .sort(
        (a, b) => rank(b.name) - rank(a.name) || (uses.get(b.name) ?? 0) - (uses.get(a.name) ?? 0),
      )
      // Variables that are another one's colour by another name (`--color-accent` → `--accent`).
      .filter((v, i, all) => all.findIndex((x) => x.value === v.value) === i)
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
 * A page for a plugin (`server.web.read`): its whole text and its content as Markdown, every
 * link and its structured data, as against `readWebsite`, which picks what the assistant needs
 * of a company's site.
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
    content: htmlToContent(html).slice(0, 400_000),
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

/** The page's big picture: the one it loads first, or one drawn wide as a hero or banner. */
const hero = (tag: string) =>
  attr(tag, "fetchpriority").toLowerCase() === "high" ||
  Number(attr(tag, "width")) >= 1200 ||
  /\b(hero|banner|slider)\b/i.test(`${attr(tag, "class")} ${attr(tag, "id")}`);

/** A picture drawn as a photo (a hero, a teaser, anything cropped to fill its box): no logo. */
const large = (tag: string) =>
  hero(tag) ||
  Number(attr(tag, "width")) >= 800 ||
  Number(attr(tag, "height")) >= 500 ||
  /\bobject-cover\b/i.test(attr(tag, "class"));

/** A picture that is a logo: it says so and is no photo that merely names one. */
const isLogo = (tag: string) => saysLogo(tag) && !large(tag);

/**
 * The colours a drawing inherits from where it sits: `fill` and `color` that the classes of its
 * link (and its own) give it, followed through the stylesheet's variables.
 */
function inheritedPaint(
  classes: string,
  css: string,
  colour: (value: string, seen: string[]) => string | null,
): { fill?: string; color?: string } {
  const paint: { fill?: string; color?: string } = {};
  for (const cls of classes.split(/\s+/).filter((c) => /^[\w-]+$/.test(c))) {
    const rule = css.match(new RegExp(`(?:^|[}\\s,])\\.${cls}\\s*\\{([^{}]*)\\}`))?.[1] ?? "";
    for (const prop of ["fill", "color"] as const) {
      const value = rule.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1];
      const found = value && !paint[prop] ? colour(value, []) : null;
      if (found) {
        paint[prop] = found;
      }
    }
  }
  return paint;
}

/** An inline drawing with the colours it inherits written onto it, where it sets none itself. */
function painted(svg: string, paint: { fill?: string; color?: string }): string {
  const open = svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  const add = [
    paint.fill && !/\sfill\s*=/i.test(open) ? ` fill="${paint.fill}"` : "",
    paint.color && !/\scolor\s*=/i.test(open) ? ` color="${paint.color}"` : "",
  ].join("");
  return add ? svg.replace(/^<svg\b/i, `<svg${add}`) : svg;
}

/**
 * The logos a page shows, best first: the logo its structured data names, what its home link
 * shows (the header's logo, an inline drawing too, in the colours the page gives it), pictures
 * that say "logo" without being big pictures, and its icons. `inline`: SVGs drawn into the page
 * count, as `data:` addresses — for a person to pick from and for the setup to keep, too long
 * for a model to read. `css`: the page's CSS, for the colours an inline drawing inherits.
 */
function logosOf(
  html: string,
  base: string,
  inline = false,
  css = "",
): { url: string; hint: string }[] {
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
  const { colour } = paletteOf(css);
  // What the link home shows is the logo on most sites, said so or not: the first one that
  // shows a picture (the header's), and others only where they say "logo".
  let shown = false;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absolute(attr(`<a ${m[1]}>`, "href"), base);
    if (!href || new URL(href).pathname !== "/" || new URL(href).host !== new URL(base).host) {
      continue;
    }
    if (shown && !saysLogo(`<a ${m[1]}>`)) {
      continue;
    }
    const img = tagsOf(m[2], "img")[0];
    const src = img && (attr(img, "src") || attr(img, "data-src"));
    if (src && !src.startsWith("data:") && !large(img)) {
      add(src, "image in the link to the home page");
    }
    const svg = inline ? m[2].match(/<svg\b[\s\S]*?<\/svg>/i)?.[0] : undefined;
    if (svg) {
      const classes = `${attr(`<a ${m[1]}>`, "class")} ${attr(svg, "class")}`;
      add(
        svgUrl(painted(svg, inheritedPaint(classes, css, colour))),
        "drawing in the link to the home page",
      );
    }
    shown ||= Boolean(img) || Boolean(svg) || /<svg\b/i.test(m[2]);
  }
  for (const tag of tagsOf(html, "img")) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (src && !src.startsWith("data:") && isLogo(tag)) {
      const alt = attr(tag, "alt");
      add(src, `image on the page${alt ? `, alt "${alt}"` : ""}`);
    }
  }
  if (inline) {
    for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
      const open = m[0].match(/^<svg\b[^>]*>/i)?.[0] ?? "";
      const title = m[0].match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
      if (saysLogo(open) || /logo/i.test(title)) {
        add(
          svgUrl(painted(m[0], inheritedPaint(attr(open, "class"), css, colour))),
          "drawing on the page",
        );
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
  return logosOf(html, base, true, await cssOf(html, base, signal))
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

/** Faces that draw icons, not text: "icons", Font Awesome, Dashicons, … */
const ICON_FONT = /icon|awesome|glyph|fontello|icomoon|^(slick|swiper|feather)$/i;

/**
 * No family at all: the object-fit polyfill's `font-family: "object-fit: cover;"`, and other
 * values that carry CSS rather than a name.
 */
const NO_FAMILY = /[:;=(){}]|^\d/;

/** "Geist Variable" is Geist: a variable font's file name, not another family. */
const familyName = (raw: string) =>
  raw
    .replace(/^[\s"'(]+|[\s"')]+$/g, "")
    .replace(/\s+variable$/i, "")
    .trim();

/** The weight a face's name carries: "Geomanist-Medium", "Inter Bold". */
const WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  book: 400,
  regular: 400,
  normal: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  heavy: 900,
  black: 900,
};

const STYLED =
  /^(.+?)([-\s])((?:extra|ultra|semi|demi)?-?(?:thin|hairline|light|book|regular|normal|medium|bold|heavy|black))?\s?(italic|oblique)?$/i;

/** A `font-weight` as numbers: "400", "bold", "100 900". */
const weightsOf = (value: string) =>
  value
    .trim()
    .split(/\s+/)
    .map((w) => (/^normal$/i.test(w) ? 400 : /^bold$/i.test(w) ? 700 : Number(w)))
    .filter((n) => n >= 100 && n <= 900);

/**
 * The typefaces a page uses, most used first, with the weights its `@font-face` rules or its
 * Google / Bunny Fonts links name. A face named for its weight ("Geomanist-Medium") is a weight
 * of its family; icon fonts and values that are no names are left out. `headings`: the page sets
 * its headings in it.
 */
function fontsOf(
  css: string,
  html: string,
): { family: string; weights: number[]; headings?: boolean }[] {
  const counts = new Map<string, number>();
  const faces: { family: string; weights: number[] | null }[] = [];
  const google = new Map<string, number[]>();
  const heading = new Set<string>();
  const count = (family: string, n = 1) => counts.set(family, (counts.get(family) ?? 0) + n);
  const first = (decl: string) =>
    decl
      .split(",")
      .map(familyName)
      .find((f) => /[a-z]/i.test(f) && !GENERIC_FONT.test(f));
  const own = (family: string | undefined) =>
    family && !NO_FAMILY.test(family) && !ICON_FONT.test(family) ? family : undefined;
  // --font-weight-…, --font-size-… and the like are no families.
  const DECL =
    /(?:font-family|--font-(?!weight|size|feature|variation|style|stretch)[\w-]+)\s*:\s*([^;}]+)/gi;
  for (const m of css.matchAll(DECL)) {
    const family = own(first(m[1]));
    if (family) {
      count(family);
    }
  }
  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (/^\s*@font-face/i.test(rule[1])) {
      continue;
    }
    const forHeadings = /(^|[\s,>+~])h[1-3]\b|heading|headline|title|display/i.test(rule[1]);
    for (const m of rule[2].matchAll(DECL)) {
      const family = own(first(m[1]));
      if (family && (forHeadings || /^--font-(heading|headline|display|title)/i.test(m[0]))) {
        heading.add(family);
      }
    }
  }
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const family = own(first(m[1].match(/font-family\s*:\s*([^;]+)/i)?.[1] ?? ""));
    const weight = m[1].match(/font-weight\s*:\s*([^;]+)/i)?.[1];
    if (family) {
      faces.push({ family, weights: weight ? weightsOf(weight) : null });
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
        google.set(family, [
          ...(google.get(family) ?? []),
          ...(spec.match(/\d{3}/g) ?? []).map(Number).filter((w) => w >= 100 && w <= 900),
        ]);
      }
    }
  }
  // A face named for its weight is that weight of its family: always with a hyphen, as font
  // files name them; with a space only where the family is used too ("Archivo Black" is one).
  const named = new Set([...counts.keys(), ...faces.map((f) => f.family)]);
  const fold = (name: string): { family: string; weight?: number } => {
    const m = name.match(STYLED);
    if (!(m && (m[3] || m[4])) || (m[2] !== "-" && !named.has(m[1]))) {
      return { family: name };
    }
    return { family: m[1], weight: m[3] ? WEIGHT_WORDS[m[3].toLowerCase().replace("-", "")] : 400 };
  };
  const total = new Map<string, number>();
  const weights = new Map<string, Set<number>>();
  const weigh = (family: string, list: number[]) =>
    weights.set(family, new Set([...(weights.get(family) ?? []), ...list]));
  for (const [name, n] of counts) {
    const { family } = fold(name);
    total.set(family, (total.get(family) ?? 0) + n);
  }
  for (const face of faces) {
    const { family, weight } = fold(face.family);
    const range = face.weights ?? [weight ?? 400];
    if (range.length) {
      const [lo, hi] = [Math.min(...range), Math.max(...range)];
      weigh(
        family,
        FONT_WEIGHTS.filter((w) => w >= lo && w <= hi),
      );
    }
  }
  for (const [family, list] of google) {
    weigh(family, list);
  }
  const headings = new Set([...heading].map((f) => fold(f).family));
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([family]) => ({
      family,
      weights: [...(weights.get(family) ?? [])].sort((a, b) => a - b),
      ...(headings.has(family) ? { headings: true } : {}),
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
    if (src && !src.startsWith("data:") && !isLogo(tag)) {
      add(src, attr(tag, "alt"));
    }
  }
  return out.slice(0, 24);
}

/** What a site states about the company behind it, as the setup fills the space's facts. */
export interface CompanyContact {
  street?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  email?: string;
  vatId?: string;
  /** The company's name with its legal form, as its imprint gives it. */
  company?: string;
  /** Its number in the company register: "FN 44903 i", "HRB 12345". */
  register?: string;
  /** The court that keeps the register. */
  court?: string;
  /** Who manages it: "Christoph Ludwig". */
  management?: string;
  /** What the company does, as the imprint's "Unternehmensgegenstand" says it. */
  purpose?: string;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  youtube?: string;
  xing?: string;
  x?: string;
  tiktok?: string;
}

/** What makes the facts every space has; with them all, the contact page is not read. */
const CONTACT_KEYS = ["street", "postcode", "city", "phone", "email", "vatId"] as const;

/** The company's profiles on social networks, as their links show them. */
export const SOCIAL_PROFILES = [
  [
    "linkedin",
    /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school|showcase|in)\/[^/?#]+/i,
  ],
  [
    "facebook",
    /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b|login)[^/?#]+/i,
  ],
  ["instagram", /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reels?\/|explore\/)[^/?#]+/i],
  ["youtube", /^https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)[^/?#]+/i],
  ["xing", /^https?:\/\/(?:www\.)?xing\.com\/(?:pages|companies)\/[^/?#]+/i],
  ["x", /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|hashtag|search)[^/?#]+/i],
  ["tiktok", /^https?:\/\/(?:www\.)?tiktok\.com\/@[^/?#]+/i],
] as const satisfies readonly (readonly [keyof CompanyContact, RegExp])[];

const ALL_KEYS = [
  ...CONTACT_KEYS,
  "company",
  "register",
  "court",
  "management",
  "purpose",
  ...SOCIAL_PROFILES.map(([key]) => key),
] as const;

/** Text as a browser reads it: one block or line break per line, character references resolved. */
function linesOf(html: string): string[] {
  return html
    .replace(/<(script|style|svg|noscript|template|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<br\s*\/?>|<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|dd|dt|address|section|article|header|footer|span class="?line)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&shy;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/&(lt|gt|quot|apos);/gi, "")
    .replace(/\u00ad/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** "Hauptstraße 12", "Am Bahnhof 3a/2": a street and its number, the way an address starts. */
const STREET = /^(\p{L}[\p{L}.' -]{1,60}?\s\d{1,4}\s?[a-z]?(?:\s?[/-]\s?\d{1,4}[a-z]?){0,3})$/u;
/** "8020 Graz", "A-8020 Graz", "D-10115 Berlin". */
const TOWN = /^(?:[A-Z]{1,2}-)?(\d{4,5})\s+(\p{Lu}[\p{L}. -]{1,40}?)(?:\s*[,|/–-]\s*.*)?$/u;

/**
 * The first street and town that follow each other: on one line ("…, 8020 Graz") or two. `above`:
 * what comes before the street, where an imprint names the company.
 */
function addressOf(
  lines: string[],
): Pick<CompanyContact, "street" | "postcode" | "city"> & { above?: string } {
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s*[,|·•]\s*/).filter(Boolean);
    for (let j = 0; j < parts.length; j++) {
      const town = parts[j].match(TOWN);
      if (!town) {
        continue;
      }
      const before = j > 0 ? parts[j - 1] : lines[i - 1]?.split(/\s*[,|·•]\s*/).pop();
      const street = before?.match(STREET)?.[1];
      if (street) {
        const above = j > 1 ? parts.slice(0, j - 1).join(", ") : lines[j > 0 ? i - 1 : i - 2];
        return { street, postcode: town[1], city: town[2].trim(), above };
      }
    }
  }
  return {};
}

/** A label, then the value: "Tel. +43 316 …", "E-Mail: office@…". */
function labelled(lines: string[], label: RegExp, value: RegExp): string | undefined {
  for (const line of lines) {
    const m = line.match(
      new RegExp(`(?:^|\\s|\\|)(?:${label.source})\\s*[.:]?\\s*:?\\s*(${value.source})`, "i"),
    );
    if (m) {
      return m[1].trim();
    }
  }
  return undefined;
}

const PHONE = /\+?\(?\d[\d ()/.-]{5,22}\d/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/;

/** The legal forms a company's name ends in: "GmbH", "m.b.H.", "AG", "e.U.", "Ltd." … */
const LEGAL_FORM =
  /(?:GmbH(?:\s?&\s?Co\.?\s?KG)?|Ges\.?\s?m\.?\s?b\.?\s?H\.?|m\.?\s?b\.?\s?H\.?|AG|KG|OG|e\.\s?U\.|GesbR|KEG|eG|e\.\s?V\.|UG(?:\s\(haftungsbeschränkt\))?|SE|Ltd\.?|Limited|Inc\.?|LLC|S\.\s?A\.|S\.\s?r\.\s?l\.|Sàrl|B\.\s?V\.|N\.\s?V\.)/
    .source;
/** "Steirische Wirtschaftsförderungsgesellschaft m.b.H.": a name and its legal form, no more. */
const LEGAL_NAME = new RegExp(`^(\\p{Lu}[\\p{L}\\d&.,'’ -]{1,90}?\\s${LEGAL_FORM})$`, "u");

/** "FN 44903 i" (Austria's company register), "HRB 12345 B" (Germany's). */
const REGISTER = /\bFN\s?\d{1,7}\s?[a-z]\b|\bHR[AB]\s?\d{1,7}(?:\s[A-Z](?=$|[\s,;]))?/;
const COURT_LABEL =
  /(?:^|\s)(?:Firmenbuchgericht|Firmenbuch-Gericht|Handelsregistergericht|Registergericht|Gericht|Register court|Registration court)\s*:\s*(.{4,100})$/i;
const COURT =
  /(?:Landes-?\s(?:als\s)?)?(?:Landes|Handels|Amts)gericht(?:\s(?:für\s)?\p{Lu}[\p{L}.-]*){1,3}/u;
const MANAGEMENT =
  /^(?:Vertretungsberechtigte[rn]?\s)?(?:Geschäftsführ(?:ung|er(?:in)?(?:innen|nen)?)|Managing Directors?)\s*:?\s*(.*)$/i;
const PURPOSE =
  /^(?:Unternehmensgegenstand|Gegenstand des Unternehmens|Geschäftszweck|Firmenzweck|Tätigkeitsbereich|Business purpose|Purpose of the company)\s*:?\s*(.*)$/i;

/** "Christoph Ludwig", "Mag. Anna Berger und DI Max Muster": people's names, nothing else. */
function names(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || v.length > 160 || /[\d@:]/.test(v)) {
    return undefined;
  }
  const people = v.split(/\s*(?:,|;|\sund\s|\sand\s|\s&\s)\s*/).filter(Boolean);
  const word = /^(?:\p{Lu}[\p{L}.'’-]*|\([\p{L}.]+\)|von|van|de|der|den|zu|di|da|le)$/u;
  return people.every((p) => {
    const words = p.split(/\s+/);
    return words.length >= 2 && words.length <= 6 && words.every((w) => word.test(w));
  })
    ? v
    : undefined;
}

/** What follows a label: on its line, or the next line when the label stands alone. */
function after(lines: string[], label: RegExp): { value: string; next?: string } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (m) {
      return { value: m[1].trim(), next: lines[i + 1] };
    }
  }
  return undefined;
}

/** A link to a profile, as the address a person opens: without its query, readable. */
function profileOf(href: string): [keyof CompanyContact, string] | undefined {
  for (const [key, pattern] of SOCIAL_PROFILES) {
    const m = href.trim().match(pattern);
    if (m) {
      let url = m[0].replace(/^http:/i, "https:");
      try {
        url = decodeURI(url);
      } catch {
        // Kept as written.
      }
      return [key, url];
    }
  }
  return undefined;
}

/**
 * What a page states about the company: its structured data (an Organization, a LocalBusiness)
 * first, then what its text says the way an imprint or a contact page says it.
 */
export function contactOf(html: string, base: string): CompanyContact {
  const contact: CompanyContact = {};
  const put = (key: keyof CompanyContact, value: unknown, max = 200) => {
    if (typeof value === "string" && value.trim() && !contact[key]) {
      contact[key] = value.replace(/\s+/g, " ").trim().slice(0, max);
    }
  };
  for (const item of jsonLdOf(html)) {
    const o = item as Record<string, unknown> | null;
    const type = [o?.["@type"]].flat().join(" ");
    if (!o || !/Organization|Corporation|LocalBusiness|Store|Company|Office|Agency/i.test(type)) {
      continue;
    }
    const address = [o.address].flat()[0] as Record<string, unknown> | undefined;
    if (address && typeof address === "object") {
      put("street", address.streetAddress);
      put("postcode", address.postalCode);
      put("city", address.addressLocality);
    }
    put("phone", o.telephone);
    put("email", typeof o.email === "string" ? o.email.replace(/^mailto:/i, "") : undefined);
    put("vatId", o.vatID ?? o.taxID);
    put("company", o.legalName);
    for (const href of [o.sameAs].flat()) {
      const profile = typeof href === "string" ? profileOf(href) : undefined;
      if (profile) {
        put(...profile);
      }
    }
  }
  const lines = linesOf(html.match(/<body\b[\s\S]*/i)?.[0] ?? html);
  const address = addressOf(lines);
  for (const key of ["street", "postcode", "city"] as const) {
    put(key, address[key]);
  }
  put("phone", labelled(lines, /tel(?:efon)?|phone|fon|t/, PHONE));
  const site = new URL(base).hostname.replace(/^www\./, "");
  const mails = [
    labelled(
      lines.map((l) => l.replace(/\s*[[(]at[\])]\s*/gi, "@")),
      /e-?mail|mail/,
      EMAIL,
    ),
    ...[...html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)].map((m) => m[1]),
  ].filter((m): m is string => Boolean(m && EMAIL.test(m)));
  put("email", mails.find((m) => m.toLowerCase().endsWith(`@${site}`)) ?? mails[0]);
  const vat = labelled(
    lines,
    /UID(?:[- ]?Nr\.?|[- ]?Nummer)?|USt\.?[- ]?Id(?:Nr\.?|[- ]?Nummer)?|Umsatzsteuer[- ]?Identifikationsnummer|VAT(?: ID| No\.?| number)?|MWST|TVA/,
    /[A-Z]{2,3}[ -]?[\dA-Z][\dA-Z .-]{6,16}[\dA-Z]/,
  );
  put("vatId", vat?.replace(/[\s.-]/g, "").match(/^[A-Z]{2,3}[\dA-Z]{8,13}$/)?.[0]);
  // Who the company is, as an imprint says it: its name above its address, its register entry,
  // who runs it and what it does.
  put("company", address.above?.match(LEGAL_NAME)?.[1]);
  const registered = lines.find((l) => REGISTER.test(l));
  put("register", registered?.match(REGISTER)?.[0]);
  put("court", after(lines, COURT_LABEL)?.value.replace(/[,;|].*$/, ""));
  put("court", registered?.replace(REGISTER, "").match(COURT)?.[0]);
  const managed = after(lines, MANAGEMENT);
  put("management", names(managed?.value) ?? (managed?.value ? undefined : names(managed?.next)));
  const purpose = after(lines, PURPOSE);
  put(
    "purpose",
    // A link's text ends where the tag did: "… Landesrechnungshofs</a>." reads "… Landesrechnungshofs ."
    (purpose && purpose.value.length >= 3 ? purpose.value : purpose?.next)?.replace(
      /\s+([.,;:!?])(?=\s|$)/g,
      "$1",
    ),
    1200,
  );
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const profile = profileOf(attr(`<a ${m[1]}>`, "href"));
    if (profile) {
      put(...profile);
    }
  }
  return contact;
}

const complete = (c: CompanyContact) => CONTACT_KEYS.every((k) => c[k]);

/**
 * What a company's site states about it, from its home page, its imprint (where the company's
 * name, register entry and management are) and, where that leaves gaps, its contact page: one or
 * two more fetches.
 */
export async function readContact(
  reading: Pick<WebsiteReading, "url" | "links" | "contact">,
  signal?: AbortSignal,
  /** Gets the text of each page read, for a model to read after the patterns. */
  pages?: { url: string; text: string }[],
): Promise<CompanyContact> {
  const contact = { ...reading.contact };
  const imprint = reading.links.find((l) => /impressum|imprint|legal-notice/i.test(l.url));
  const page = reading.links.find((l) => /kontakt|contact/i.test(l.url));
  for (const link of [imprint, page]) {
    if (!link || (link === page && complete(contact))) {
      continue;
    }
    try {
      const { base, html } = await loadPage(link.url, signal);
      pages?.push({ url: base, text: htmlToMarkdown(html) });
      const found = contactOf(html, base);
      for (const key of ALL_KEYS) {
        contact[key] ??= found[key];
      }
    } catch {
      // A page that cannot be read leaves its facts open: the person fills them in.
    }
  }
  return contact;
}

/** The name a site gives itself, where it says so apart from its title. */
function siteNameOf(html: string): string {
  const website = jsonLdOf(html).find((item) =>
    /WebSite/.test([(item as { "@type"?: unknown } | null)?.["@type"]].flat().join(" ")),
  ) as { name?: unknown } | undefined;
  return (
    [
      metaOf(html, "og:site_name"),
      metaOf(html, "application-name"),
      typeof website?.name === "string" ? website.name : "",
    ]
      .map((name) => name.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? ""
  );
}

export async function readWebsite(
  raw: string,
  signal?: AbortSignal,
  options: { inline?: boolean } = {},
): Promise<WebsiteReading> {
  const { res, base, html } = await loadPage(raw, signal);
  const tags = (name: string) => tagsOf(html, name);
  const meta = (key: string) => metaOf(html, key);

  const css = await cssOf(html, base, signal);
  const logos = logosOf(html, base, options.inline, css);
  const images: WebsiteReading["brand"]["images"] = [];
  for (const tag of tags("img")) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (!src || src.startsWith("data:") || isLogo(tag)) {
      continue;
    }
    const url = absolute(src, base);
    if (url && images.length < 12 && !images.some((i) => i.url === url)) {
      images.push({ url, alt: attr(tag, "alt"), ...(hero(tag) ? { hero: true } : {}) });
    }
  }
  const og = meta("og:image");
  if (og) {
    const url = absolute(og, base);
    if (url) {
      images.unshift({ url, alt: "share image (og:image)", hero: true });
    }
  }

  const host = new URL(base).hostname;
  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(attr(`<a ${m[1]}>`, "href"), base)?.replace(/#.*$/, "");
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
  // The imprint and the contact page first: they say who the company is.
  const legal = (l: { url: string }) =>
    Number(/impressum|imprint|legal-notice|kontakt|contact/i.test(new URL(l.url).pathname));
  links.sort((a, b) => legal(b) - legal(a));

  const text = htmlToMarkdown(html);
  return {
    url: base,
    status: res.status,
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? "",
    siteName: siteNameOf(html),
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
    contact: contactOf(html, base),
  };
}
