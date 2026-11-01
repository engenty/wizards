import { spawn } from "node:child_process";
import { note } from "@engenty/wizards-shared/run";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { bareMime } from "../routes/delivery.js";
import { ServiceError } from "../services/errors.js";

/**
 * What a file that someone uploads goes through before it is kept: its name, its type read from
 * its bytes, a picture's size, a picture drawn again without its metadata, an SVG written again
 * from an allowlist (docs/plans/upload-checks.md).
 */

/** A picture larger than this is refused before anything decodes it. */
export const MAX_PIXELS = 50_000_000;
export const MAX_SIDE = 16_384;

const MAX_NAME = 120;

export interface CheckedUpload {
  name: string;
  mime: string;
  data: Uint8Array;
}

// --- name ---------------------------------------------------------------------------

/**
 * A file's name as it is kept and shown: no control characters, no bidirectional overrides that
 * make `photo` + U+202E + `gpj.exe` read as `photoexe.jpg`, no folders.
 */
export function cleanName(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim()
    .slice(0, MAX_NAME);
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

// --- type from the bytes --------------------------------------------------------------

const has = (d: Uint8Array, at: number, bytes: readonly number[]) =>
  d.length >= at + bytes.length && bytes.every((b, i) => d[at + i] === b);

const text = (d: Uint8Array, at: number, s: string) =>
  d.length >= at + s.length && [...s].every((ch, i) => d[at + i] === ch.charCodeAt(0));

const u16be = (d: Uint8Array, at: number) => (d[at] << 8) | d[at + 1];
const u16le = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const u24le = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8) | (d[at + 2] << 16);
const u32be = (d: Uint8Array, at: number) =>
  ((d[at] << 24) >>> 0) + ((d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]);
const i32le = (d: Uint8Array, at: number) =>
  d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24);

/** The brands of an ISO media file (MP4, QuickTime, HEIC, AVIF): its `ftyp` box. */
function ftypBrands(d: Uint8Array): string[] | null {
  if (!text(d, 4, "ftyp")) {
    return null;
  }
  const size = Math.min(u32be(d, 0), d.length, 256);
  const brands: string[] = [];
  for (let at = 8; at + 4 <= size; at += at === 8 ? 8 : 4) {
    brands.push(String.fromCharCode(d[at], d[at + 1], d[at + 2], d[at + 3]));
  }
  return brands;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

function isoType(brands: string[]): string {
  if (brands.includes("avif") || brands.includes("avis")) {
    return "image/avif";
  }
  if (HEIF_BRANDS.has(brands[0])) {
    return "image/heic";
  }
  if (brands[0] === "qt  ") {
    return "video/quicktime";
  }
  if (brands[0] === "M4A " || brands[0] === "M4B ") {
    return "audio/mp4";
  }
  return "video/mp4";
}

/** No NUL in the first 64 KB: what a text, CSV, JSON or mail file holds. */
function looksLikeText(d: Uint8Array): boolean {
  return !d.subarray(0, 65_536).includes(0);
}

/** A drawing: text that starts with markup and has `<svg` near the top. */
function looksLikeSvg(d: Uint8Array): boolean {
  if (!looksLikeText(d)) {
    return false;
  }
  const head = new TextDecoder().decode(d.subarray(0, 4096)).replace(/^﻿/, "");
  return /^\s*</.test(head) && /<svg[\s/>]/i.test(head);
}

function isBmp(d: Uint8Array): boolean {
  return text(d, 0, "BM") && d.length > 26 && [12, 40, 52, 56, 108, 124].includes(i32le(d, 14));
}

/** What a file is, from its first bytes; null when none of the types below. */
export function sniffType(d: Uint8Array): string | null {
  if (has(d, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (has(d, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (text(d, 0, "GIF87a") || text(d, 0, "GIF89a")) {
    return "image/gif";
  }
  if (text(d, 0, "RIFF")) {
    if (text(d, 8, "WEBP")) {
      return "image/webp";
    }
    if (text(d, 8, "WAVE")) {
      return "audio/wav";
    }
    if (text(d, 8, "AVI ")) {
      return "video/x-msvideo";
    }
  }
  const brands = ftypBrands(d);
  if (brands) {
    return isoType(brands);
  }
  if (isBmp(d)) {
    return "image/bmp";
  }
  if (has(d, 0, [0x00, 0x00, 0x01, 0x00]) && d.length > 6 && u16le(d, 4) > 0) {
    return "image/x-icon";
  }
  if (has(d, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return new TextDecoder("latin1").decode(d.subarray(0, 64)).includes("webm")
      ? "video/webm"
      : "video/x-matroska";
  }
  if (text(d, 0, "OggS")) {
    return "audio/ogg";
  }
  if (text(d, 0, "fLaC")) {
    return "audio/flac";
  }
  if (text(d, 0, "ID3") || (d[0] === 0xff && d.length > 1 && (d[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (new TextDecoder("latin1").decode(d.subarray(0, 1024)).includes("%PDF-")) {
    return "application/pdf";
  }
  if (has(d, 0, [0x50, 0x4b, 0x03, 0x04]) || has(d, 0, [0x50, 0x4b, 0x05, 0x06])) {
    return "application/zip";
  }
  if (has(d, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "application/x-ole-storage";
  }
  if (text(d, 0, "{\\rtf")) {
    return "application/rtf";
  }
  if (text(d, 0, "wOFF")) {
    return "font/woff";
  }
  if (text(d, 0, "wOF2")) {
    return "font/woff2";
  }
  if (has(d, 0, [0x00, 0x01, 0x00, 0x00]) || text(d, 0, "true")) {
    return "font/ttf";
  }
  if (text(d, 0, "OTTO")) {
    return "font/otf";
  }
  if (text(d, 0, "ttcf")) {
    return "font/collection";
  }
  if (text(d, 0, "glTF")) {
    return "model/gltf-binary";
  }
  if (looksLikeSvg(d)) {
    return "image/svg+xml";
  }
  return null;
}

/** The kinds of thing a declared type and the bytes must agree on. */
type Kind = "image" | "media" | "pdf" | "office" | "zip" | "rtf" | "font" | "glb" | "text";

const OFFICE =
  /^application\/(msword|vnd\.ms-[a-z.-]+|vnd\.openxmlformats-officedocument\.[a-z.-]+|vnd\.oasis\.opendocument\.[a-z.-]+)$/;
const FONT = /^(font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/;

function declaredKind(mime: string): Kind | null {
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (/^(audio|video)\//.test(mime)) {
    return "media";
  }
  if (mime === "application/pdf") {
    return "pdf";
  }
  if (OFFICE.test(mime)) {
    return "office";
  }
  if (mime === "application/zip" || mime === "application/x-zip-compressed") {
    return "zip";
  }
  if (mime === "application/rtf" || mime === "text/rtf") {
    return "rtf";
  }
  if (FONT.test(mime)) {
    return "font";
  }
  if (mime === "model/gltf-binary") {
    return "glb";
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "message/rfc822" ||
    mime === "model/gltf+json"
  ) {
    return "text";
  }
  return null;
}

function bytesFit(kind: Kind, sniffed: string | null, d: Uint8Array): boolean {
  switch (kind) {
    case "image":
      return sniffed?.startsWith("image/") ?? false;
    case "media":
      return /^(audio|video)\//.test(sniffed ?? "");
    case "pdf":
      return sniffed === "application/pdf";
    case "office":
      return sniffed === "application/zip" || sniffed === "application/x-ole-storage";
    case "zip":
      return sniffed === "application/zip";
    case "rtf":
      return sniffed === "application/rtf";
    case "font":
      return sniffed?.startsWith("font/") ?? false;
    case "glb":
      return sniffed === "model/gltf-binary";
    case "text":
      return looksLikeText(d);
  }
}

// --- pictures -------------------------------------------------------------------------

/** A JPEG's size from its frame header. */
function jpegSize(d: Uint8Array) {
  let at = 2;
  while (at + 9 < d.length) {
    if (d[at] !== 0xff) {
      return null;
    }
    const marker = d[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: u16be(d, at + 5), width: u16be(d, at + 7) };
    }
    at += 2 + u16be(d, at + 2);
  }
  return null;
}

function webpSize(d: Uint8Array) {
  if (text(d, 12, "VP8 ") && d.length >= 30) {
    return { width: u16le(d, 26) & 0x3fff, height: u16le(d, 28) & 0x3fff };
  }
  if (text(d, 12, "VP8L") && d.length >= 25) {
    const [b0, b1, b2, b3] = [d[21], d[22], d[23], d[24]];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (text(d, 12, "VP8X") && d.length >= 30) {
    return { width: 1 + u24le(d, 24), height: 1 + u24le(d, 27) };
  }
  return null;
}

/** HEIC and AVIF name each image's size in an `ispe` box; a grid's whole is the largest. */
function ispeSize(d: Uint8Array) {
  let found: { width: number; height: number } | null = null;
  const end = Math.min(d.length, 2_000_000) - 16;
  for (let at = 0; at < end; at++) {
    if (d[at] === 0x69 && text(d, at, "ispe")) {
      const width = u32be(d, at + 8);
      const height = u32be(d, at + 12);
      if (!found || width * height > found.width * found.height) {
        found = { width, height };
      }
    }
  }
  return found;
}

/** A picture's size in pixels, read from its header without decoding it. */
export function pictureSize(d: Uint8Array, mime: string): { width: number; height: number } | null {
  switch (mime) {
    case "image/png":
      return d.length >= 24 && text(d, 12, "IHDR")
        ? { width: u32be(d, 16), height: u32be(d, 20) }
        : null;
    case "image/gif":
      return d.length >= 10 ? { width: u16le(d, 6), height: u16le(d, 8) } : null;
    case "image/jpeg":
      return jpegSize(d);
    case "image/webp":
      return webpSize(d);
    case "image/avif":
    case "image/heic":
      return ispeSize(d);
    case "image/bmp":
      return i32le(d, 14) === 12
        ? { width: u16le(d, 18), height: u16le(d, 20) }
        : { width: Math.abs(i32le(d, 18)), height: Math.abs(i32le(d, 22)) };
    default:
      return null;
  }
}

/** Whether a picture moves: drawing it again would keep one frame. */
function animated(d: Uint8Array, mime: string): boolean {
  if (mime === "image/gif") {
    return true;
  }
  if (mime === "image/webp") {
    return text(d, 12, "VP8X") && (d[20] & 0x02) !== 0;
  }
  if (mime === "image/avif") {
    return ftypBrands(d)?.includes("avis") ?? false;
  }
  if (mime === "image/png") {
    for (let at = 8; at + 8 <= d.length; ) {
      const type = String.fromCharCode(d[at + 4], d[at + 5], d[at + 6], d[at + 7]);
      if (type === "acTL") {
        return true;
      }
      if (type === "IDAT") {
        return false;
      }
      at += 12 + u32be(d, at);
    }
  }
  return false;
}

/** The formats drawn again, each in itself: PNG lossless, the others at a quality a photo keeps. */
const REDRAWN = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

/**
 * What draws a picture again, in a process of its own: a broken PNG, JPEG or WebP can crash the
 * image library, and that must not take the runtime down. It reads the bytes on stdin, writes the
 * new ones on stdout, and ends with 3 when the picture doesn't decode.
 */
const REDRAW = `
const [url, mime] = process.argv.slice(1);
const { createCanvas, loadImage } = await import(url);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let image;
try { image = await loadImage(Buffer.concat(chunks)); } catch { process.exit(3); }
if (!image.width || !image.height) process.exit(3);
const canvas = createCanvas(image.width, image.height);
canvas.getContext("2d").drawImage(image, 0, 0);
const out =
  mime === "image/jpeg" ? await canvas.encode("jpeg", 92)
  : mime === "image/webp" ? await canvas.encode("webp", 92)
  : mime === "image/avif" ? await canvas.encode("avif", { quality: 80, speed: 8 })
  : await canvas.encode("png");
process.stdout.write(out, () => process.exit(0));
`;

const REDRAW_TIMEOUT_MS = 30_000;

/** Two pictures are drawn at a time (an upload, a thumbnail); each process holds one in memory. */
let drawing = 0;
const waiting: (() => void)[] = [];

export async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (drawing >= 2) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  drawing++;
  try {
    return await work();
  } finally {
    drawing--;
    waiting.shift()?.();
  }
}

/** The bytes the child wrote, or null when it couldn't draw the picture, crashed or took too long. */
function drawInChild(d: Uint8Array, mime: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", REDRAW, import.meta.resolve("@napi-rs/canvas"), mime],
      { env: {}, stdio: ["pipe", "pipe", "ignore"], timeout: REDRAW_TIMEOUT_MS },
    );
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(out) : null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(d));
  });
}

/**
 * A picture decoded and encoded again in its own format: upright as its EXIF orientation said,
 * without EXIF, XMP, comments or anything after its end. Refuses one that doesn't decode.
 */
async function redraw(d: Uint8Array, mime: string): Promise<Uint8Array> {
  const out = await inTurn(() => drawInChild(d, mime));
  if (!out?.byteLength) {
    throw new ServiceError("invalid", note("uploadNotPicture"));
  }
  return new Uint8Array(out);
}

async function checkPicture(d: Uint8Array, mime: string): Promise<Uint8Array> {
  if (mime === "image/svg+xml") {
    return new TextEncoder().encode(cleanSvg(new TextDecoder().decode(d)));
  }
  if (mime === "image/x-icon") {
    return d;
  }
  const size = pictureSize(d, mime);
  if (!size?.width || !size.height) {
    throw new ServiceError("invalid", note("uploadNotPicture"));
  }
  if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) {
    throw new ServiceError(
      "invalid",
      note("uploadPictureTooLarge", { mp: Math.round(MAX_PIXELS / 1_000_000) }),
    );
  }
  return REDRAWN.has(mime) && !animated(d, mime) ? redraw(d, mime) : d;
}

// --- SVG ------------------------------------------------------------------------------

const SVG_ELEMENTS = new Set(
  [
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "textPath",
    "title",
    "desc",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "marker",
    "image",
    "style",
    "filter",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feComposite",
    "feConvolveMatrix",
    "feDiffuseLighting",
    "feDisplacementMap",
    "feDistantLight",
    "feDropShadow",
    "feFlood",
    "feFuncA",
    "feFuncB",
    "feFuncG",
    "feFuncR",
    "feGaussianBlur",
    "feMerge",
    "feMergeNode",
    "feMorphology",
    "feOffset",
    "fePointLight",
    "feSpecularLighting",
    "feSpotLight",
    "feTile",
    "feTurbulence",
  ].map((n) => n.toLowerCase()),
);

/** Elements whose content stays where they go: a link's text, a switch's choices. */
const SVG_UNWRAPPED = new Set(["a", "switch"]);

const NAMESPACES = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);

const DATA_PICTURE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;

/** Text as a browser reads it after XML: character references and the five named entities resolved. */
function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(
      /&(lt|gt|quot|apos|amp);/g,
      (_, n: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[n] ?? "",
    );
}

/**
 * CSS that reaches nothing outside the drawing: only `url(#…)`, no imports, no expressions, and
 * no escapes that could spell any of them.
 */
export function cssStaysInside(css: string): boolean {
  const flat = decodeEntities(css).toLowerCase();
  if (/\\|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/.test(flat)) {
    return false;
  }
  return [...flat.matchAll(/url\s*\(\s*(['"]?)\s*([^)'"]*)/g)].every((m) => m[2].startsWith("#"));
}

const escapeAttr = (v: string) =>
  v
    .replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");

const escapeText = (v: string) =>
  v.replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;");

type XmlNode = Record<string, unknown> & { ":@"?: Record<string, string> };

function nodeName(node: XmlNode): string {
  return Object.keys(node).find((k) => k !== ":@") ?? "";
}

function cleanAttrs(element: string, attrs: Record<string, string> | undefined) {
  const kept: Record<string, string> = {};
  for (const [key, raw] of Object.entries(attrs ?? {})) {
    const name = key.slice(2);
    const lower = name.toLowerCase();
    const value = String(raw);
    if (lower.startsWith("on")) {
      continue;
    }
    if (lower === "xmlns" || lower === "xmlns:xlink") {
      if (NAMESPACES.has(value)) {
        kept[key] = escapeAttr(value);
      }
      continue;
    }
    if (lower.includes(":") && lower !== "xlink:href" && lower !== "xml:space") {
      continue;
    }
    if (lower === "href" || lower === "xlink:href") {
      const target = value.trim();
      if (target.startsWith("#") || (element === "image" && DATA_PICTURE.test(target))) {
        kept[key] = escapeAttr(target);
      }
      continue;
    }
    if (!cssStaysInside(value)) {
      continue;
    }
    kept[key] = escapeAttr(value);
  }
  return kept;
}

function cleanNodes(nodes: XmlNode[], inStyle = false): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of nodes) {
    const name = nodeName(node);
    if (name === "#text" || name === "#cdata") {
      const value = name === "#cdata" ? node[name] : String(node[name] ?? "");
      if (name === "#text") {
        out.push({ "#text": inStyle ? String(value) : escapeText(String(value)) });
      } else {
        out.push({ "#cdata": value });
      }
      continue;
    }
    const lower = name.toLowerCase();
    const children = (node[name] as XmlNode[] | undefined) ?? [];
    if (SVG_UNWRAPPED.has(lower)) {
      out.push(...cleanNodes(children));
      continue;
    }
    if (!SVG_ELEMENTS.has(lower)) {
      continue;
    }
    if (lower === "style") {
      const css = children
        .map((c) => {
          const v = c["#text"] ?? c["#cdata"];
          return Array.isArray(v) ? v.map((x) => (x as XmlNode)["#text"] ?? "").join("") : v;
        })
        .join("");
      if (!cssStaysInside(String(css))) {
        continue;
      }
    }
    const attrs = cleanAttrs(lower, node[":@"]);
    out.push({
      [name]: cleanNodes(children, lower === "style"),
      ...(Object.keys(attrs).length ? { ":@": attrs } : {}),
    });
  }
  return out;
}

/** An SVG written again from the allowlist above. Refuses declarations and a root that isn't `<svg>`. */
export function cleanSvg(source: string): string {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) {
    throw new ServiceError("invalid", note("uploadSvgNotUsable"));
  }
  let tree: XmlNode[];
  try {
    tree = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: false,
      htmlEntities: false,
      trimValues: false,
      cdataPropName: "#cdata",
    }).parse(source) as XmlNode[];
  } catch {
    throw new ServiceError("invalid", note("uploadSvgNotUsable"));
  }
  const roots = tree.filter((n) => {
    const name = nodeName(n);
    return !name.startsWith("?") && !name.startsWith("!") && name !== "#text";
  });
  if (roots.length !== 1 || nodeName(roots[0]) !== "svg") {
    throw new ServiceError("invalid", note("uploadSvgNotUsable"));
  }
  const clean = cleanNodes(roots);
  const xml = new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    processEntities: false,
    suppressEmptyNode: true,
    cdataPropName: "#cdata",
  }).build(clean) as string;
  return xml;
}

// --- the whole check --------------------------------------------------------------------

/**
 * A file as it is kept: its clean name, the type its bytes show (a picture by its bytes, the
 * rest as declared once the bytes agree), and a picture drawn again. Refuses a file whose bytes
 * aren't what its type says, a picture too large to decode, and an SVG that can't be cleaned.
 * A type not checked here is kept as declared: it is served as a download.
 */
export async function checkUpload(input: {
  name: string;
  mime: string;
  data: Uint8Array;
  fallbackName?: string;
}): Promise<CheckedUpload> {
  const name = cleanName(input.name, input.fallbackName ?? "file");
  const declared = bareMime(input.mime) ?? "application/octet-stream";
  const kind = declaredKind(declared);
  if (!kind) {
    return { name, mime: declared, data: input.data };
  }
  const sniffed = sniffType(input.data);
  if (!bytesFit(kind, sniffed, input.data)) {
    throw new ServiceError(
      "invalid",
      kind === "image" ? note("uploadNotPicture") : note("uploadNotItsType"),
    );
  }
  if (kind !== "image" || !sniffed) {
    return { name, mime: declared, data: input.data };
  }
  return { name, mime: sniffed, data: await checkPicture(input.data, sniffed) };
}
