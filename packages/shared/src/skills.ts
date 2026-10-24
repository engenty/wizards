/**
 * Skills of a space (docs/plans/skills.md): instructions in the Agent Skills format – a folder
 * with a `SKILL.md` (front matter `name` and `description`, then Markdown) and the text files it
 * points to. A space's wizards follow a skill that is always on in every AI step; one on demand
 * they see by name and description and read when it fits the task. Behind the `skills` switch.
 */

/** When a skill counts: in every AI step, when a step reads it, or not at all. */
export const SKILL_MODES = ["always", "demand", "off"] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

/** Where it came from: written in the studio, uploaded, or added from skills.sh. */
export const SKILL_SOURCES = ["own", "upload", "skills.sh"] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_LIMITS = {
  /** A name, as the Agent Skills format allows it. */
  name: 64,
  description: 1024,
  /** Bytes of the `SKILL.md`, of any other file, of the whole skill, and its files. */
  skillMd: 100_000,
  file: 256_000,
  total: 1_000_000,
  files: 100,
  perSpace: 100,
  /** Skills always on, and the characters of their instructions together: each is in every AI step. */
  always: 5,
  alwaysChars: 20_000,
  /** Skills on demand a step sees by name; more are left out of its list. */
  listed: 50,
} as const;

/** Lower-case letters, digits and single hyphens inside. */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The GitHub owners skills.sh lists as official (skills.sh/official, October 2026). A skill from
 * one of them shows as from an official source; any other is shown as not checked.
 */
export const OFFICIAL_SKILL_OWNERS: readonly string[] = [
  "aave",
  "anthropics",
  "antithesishq",
  "apify",
  "apollographql",
  "astronomer",
  "auth0",
  "automattic",
  "aws",
  "axiomhq",
  "base",
  "better-auth",
  "bitwarden",
  "box",
  "brave",
  "browser-use",
  "browserbase",
  "callstackincubator",
  "clerk",
  "clickhouse",
  "cloudflare",
  "coderabbitai",
  "coinbase",
  "contentful",
  "contentstack",
  "convex-dev",
  "dagster-io",
  "dash0hq",
  "datadog-labs",
  "dbt-labs",
  "deepgram",
  "denoland",
  "elevenlabs",
  "encoredev",
  "exploreomni",
  "expo",
  "facebook",
  "factory-ai",
  "figma",
  "firebase",
  "firecrawl",
  "flutter",
  "getsentry",
  "github",
  "google-gemini",
  "google-labs-code",
  "hashicorp",
  "huggingface",
  "kotlin",
  "langchain-ai",
  "langfuse",
  "launchdarkly",
  "makenotion",
  "mapbox",
  "mastra-ai",
  "mcp-use",
  "medusajs",
  "microsoft",
  "mongodb",
  "n8n-io",
  "neondatabase",
  "nuxt",
  "nvidia",
  "openai",
  "openshift",
  "parallel-web",
  "pinecone-io",
  "planetscale",
  "posthog",
  "prisma",
  "pulumi",
  "pytorch",
  "redis",
  "remotion-dev",
  "resend",
  "rivet-dev",
  "runwayml",
  "sanity-io",
  "semgrep",
  "shopify",
  "signoz",
  "streamlit",
  "stripe",
  "supabase",
  "sveltejs",
  "tavily-ai",
  "temporalio",
  "tinybirdco",
  "tldraw",
  "triggerdotdev",
  "uniformdev",
  "upstash",
  "vapiai",
  "vercel",
  "vercel-labs",
  "webflow",
  "wix",
  "wordpress",
];

/** A skill's address on skills.sh: `owner/repo/skill`. */
export const SKILL_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.:-]{1,100}$/;

export function officialSkill(ref: string | null | undefined): boolean {
  const owner = ref?.split("/")[0]?.toLowerCase();
  return Boolean(owner && OFFICIAL_SKILL_OWNERS.includes(owner));
}

/** A file of a skill beside its `SKILL.md`: a path inside the skill's folder and its text. */
export interface SkillFile {
  path: string;
  text: string;
}

/** A skill as the list shows it. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  mode: SkillMode;
  source: SkillSource;
  /** skills.sh: `owner/repo/skill`. */
  origin: string | null;
  official: boolean;
  /** Its files beside the `SKILL.md`. */
  files: number;
  /** Characters of its instructions: what a step reads, or carries when it is always on. */
  chars: number;
  updatedAt: string;
}

export interface SkillsList {
  skills: SkillSummary[];
  readOnly: boolean;
}

/** A skill opened: its instructions, the rest of its front matter and its files. */
export interface SkillDetail extends SkillSummary {
  projectId: string;
  body: string;
  /** Front matter beside `name` and `description`, kept as it came (`license`, `metadata` …). */
  meta: Record<string, unknown>;
  fileList: SkillFile[];
  /** The hash of what skills.sh had when it was added: an update is offered when it differs. */
  originHash: string | null;
  readOnly: boolean;
}

/** A skill on skills.sh, as a search finds it. */
export interface SkillHit {
  ref: string;
  name: string;
  /** `owner/repo` on GitHub. */
  source: string;
  installs: number;
  official: boolean;
  /** The space has a skill from this address already. */
  added: boolean;
}

/** A skill of skills.sh read whole, before it is added. */
export interface SkillPreview {
  ref: string;
  name: string;
  description: string;
  body: string;
  meta: Record<string, unknown>;
  fileList: SkillFile[];
  /** Files left out: not text, or too large. */
  skipped: { path: string; reason: "binary" | "size" | "path" | "count" }[];
  official: boolean;
  bytes: number;
  hash: string;
}

/** Whether a path may be a file of a skill: relative, inside its folder, no hidden or odd parts. */
export function skillPathOk(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && /^[\w.@+ -]+$/.test(part));
}

/** Text files only: instructions, references, data, and scripts kept as text. */
const TEXT_EXT =
  /\.(md|markdown|mdx|txt|text|csv|tsv|json|jsonl|yaml|yml|toml|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|rb|go|rs|java|kt|swift|php|sql|r|ini|cfg|conf|env\.example|svg|tex|rst|adoc)$/i;
const TEXT_NAMES =
  /^(LICENSE|LICENCE|NOTICE|README|CHANGELOG|COPYING|Makefile|Dockerfile)(\.\w+)?$/i;

export function skillTextPath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return TEXT_EXT.test(name) || TEXT_NAMES.test(name);
}

const scriptPath = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|php|go|rs)$/i;

/** A script: kept as text, never run. */
export function skillScript(path: string): boolean {
  return scriptPath.test(path);
}

// --- SKILL.md --------------------------------------------------------------------------------

export interface ParsedSkillMd {
  name: string;
  description: string;
  body: string;
  /** The other keys of the front matter. */
  meta: Record<string, unknown>;
}

/** Why a `SKILL.md` was not taken: no front matter, or no name or description in it. */
export type SkillMdProblem = "frontmatter" | "name" | "description";

export class SkillMdError extends Error {
  constructor(readonly problem: SkillMdProblem) {
    super(`SKILL.md: ${problem}`);
  }
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** A block scalar's lines (`|`, `>`, with `-` or `+`), indentation taken off. */
function blockScalar(style: string, lines: string[]): string {
  const indent = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  const plain = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
  let text: string;
  if (style.startsWith("|")) {
    text = plain.join("\n");
  } else {
    // Folded: lines of a paragraph join with a space, an empty line stays a break.
    text = plain
      .join("\n")
      .replace(/([^\n])\n(?!\n)/g, "$1 ")
      .replace(/\n\n/g, "\n");
  }
  return style.includes("-") ? text.replace(/\s+$/, "") : `${text.replace(/\n*$/, "")}\n`;
}

/**
 * The front matter of a `SKILL.md`, in the part of YAML skills use: `key: value` with quoted or
 * plain values, plain values going on over indented lines, block scalars (`|`, `>`), one level
 * of mapping (`metadata:`) and lists of plain items. What it does not read it leaves out.
 */
export function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const more = (from: number) => {
    const taken: string[] = [];
    let j = from;
    while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
      taken.push(lines[j]);
      j++;
    }
    while (taken.length && taken[taken.length - 1].trim() === "") {
      taken.pop();
      j--;
    }
    return { taken, next: j };
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w.-]*)\s*:(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();
    const { taken, next } = more(i + 1);
    i = next;
    if (/^[|>][+-]?\d*$/.test(rest)) {
      out[key] = blockScalar(rest, taken);
    } else if (rest === "" && taken.length) {
      const items = taken.filter((l) => l.trim());
      if (items.every((l) => /^\s*-\s/.test(l))) {
        out[key] = items.map((l) => unquote(l.replace(/^\s*-\s/, "")));
      } else {
        const map: Record<string, string> = {};
        for (const l of items) {
          const kv = /^\s*([^:#]+?)\s*:\s*(.*)$/.exec(l);
          if (kv) {
            map[kv[1]] = unquote(kv[2]);
          }
        }
        out[key] = map;
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s))
        .filter(Boolean);
    } else if (/^["']/.test(rest) && !/^(["']).*\1\s*$/.test(rest)) {
      // A quoted value over several lines.
      out[key] = unquote([rest, ...taken.map((l) => l.trim())].join(" "));
    } else {
      const value = [rest, ...taken.map((l) => l.trim()).filter(Boolean)].join(" ");
      out[key] = unquote(value);
    }
  }
  return out;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A `SKILL.md` read: its name, description, the rest of its front matter and its instructions. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const m = FRONTMATTER.exec(text);
  if (!m) {
    throw new SkillMdError("frontmatter");
  }
  const front = parseFrontmatter(m[1]);
  const name = typeof front.name === "string" ? front.name.trim() : "";
  const description =
    typeof front.description === "string" ? front.description.replace(/\s+/g, " ").trim() : "";
  if (!name) {
    throw new SkillMdError("name");
  }
  if (!description) {
    throw new SkillMdError("description");
  }
  const { name: _n, description: _d, ...meta } = front;
  return { name, description, body: text.slice(m[0].length).replace(/^\s*\n/, ""), meta };
}

function yamlValue(value: unknown, indent = ""): string {
  if (Array.isArray(value)) {
    return `\n${value.map((v) => `${indent}  - ${yamlScalar(String(v))}`).join("\n")}`;
  }
  if (value && typeof value === "object") {
    return `\n${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${indent}  ${k}: ${yamlScalar(String(v))}`)
      .join("\n")}`;
  }
  return ` ${yamlScalar(String(value ?? ""))}`;
}

/** A plain scalar where YAML reads it back the same, else a double-quoted one. */
function yamlScalar(value: string): string {
  return /^[^\s"'#&*!|>%@`{}[\],?:-][^\n#]*$/.test(value) &&
    !/:\s|\s$/.test(value) &&
    !/^(true|false|null|yes|no|~|[\d.+-]+)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

/** A skill as its `SKILL.md`: front matter with name, description and the rest, then its instructions. */
export function skillMd(skill: {
  name: string;
  description: string;
  body: string;
  meta?: Record<string, unknown>;
}): string {
  const keys = Object.entries(skill.meta ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${yamlValue(v)}`);
  return [
    "---",
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    ...keys,
    "---",
    "",
    skill.body.replace(/^\n+/, ""),
  ].join("\n");
}

/** A name the format allows, made from any title: `Tonalität & Stil` → `tonalitaet-stil`. */
export function skillNameOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.name)
    .replace(/-+$/, "");
}

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;
