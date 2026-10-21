import type { Lang } from "@engenty/wizards-shared/definition";
import type { BasicFact, ProjectFact } from "@engenty/wizards-shared/projects";
import { type CompanyContact, readContact, readWebsite } from "../agents/website.js";
import { managed, type Role } from "../manage.js";
import { readSetting, writeSetting } from "../settings.js";
import { type ServerKey, serverText } from "../texts.js";
import { isAdminRole } from "./access.js";
import { addProjectFileFromUrl, projectFiles } from "./project-files.js";
import { listProjects, ownedProject, updateProject } from "./projects.js";

/**
 * The first visit of a team's studio in the cloud: a short wizard asks who the team is, reads
 * its website into the space, takes first documents and explains the space. It shows once, to
 * the people who may change the team, and never to a team that already has wizards; the mark
 * that it is done sits in the control database under the tenant.
 */
const key = (tenantId: string) => `onboarding:${tenantId}`;

export async function needsOnboarding(user: {
  id: string;
  tenantId: string;
  role: Role;
}): Promise<boolean> {
  if (!managed || !isAdminRole(user.role)) {
    return false;
  }
  if (await readSetting(key(user.tenantId))) {
    return false;
  }
  const projects = await listProjects(user.id);
  return projects.every((p) => p.wizardCount === 0);
}

export async function finishOnboarding(tenantId: string): Promise<void> {
  await writeSetting(key(tenantId), { doneAt: new Date().toISOString() });
}

/** A hex colour as `#rrggbb`, or null when the value is no plain colour. */
function hex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const six = v.match(/^#([0-9a-f]{6})\b/);
  if (six) {
    return `#${six[1]}`;
  }
  const three = v.match(/^#([0-9a-f]{3})\b/);
  if (three) {
    return `#${[...three[1]].map((c) => c + c).join("")}`;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const part = (n: string) => Math.min(255, Number(n)).toString(16).padStart(2, "0");
    return `#${part(rgb[1])}${part(rgb[2])}${part(rgb[3])}`;
  }
  return null;
}

/** Greys and near-whites say nothing about a brand. */
function telling(color: string): boolean {
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const light = (r + g + b) / 3;
  return spread > 24 && light > 24 && light < 235;
}

/** A colour's hue, 0–360. */
function hue(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) {
    return 0;
  }
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Two colours of one hue, a shade of the other: one brand colour, not two. */
function shadeOf(a: string, b: string): boolean {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d) < 20;
}

/** A page title is often "Company – Slogan" or "Home | Company": the company's part of it. */
export function companyOf(title: string): string {
  const parts = title
    .split(/\s+[–—|·-]\s+|:\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return title.trim().slice(0, 120);
  }
  const generic = /^(home|start|startseite|willkommen|welcome)$/i;
  const named = parts.filter((p) => !generic.test(p));
  // The shortest telling part is the name; a slogan is longer.
  return (named.sort((a, b) => a.length - b.length)[0] ?? parts[0]).slice(0, 120);
}

/** The first paragraph of the page's text that reads like prose, as the about text. */
export function aboutOf(description: string, text: string): string {
  if (description.trim().length >= 40) {
    return description.trim().slice(0, 600);
  }
  const paragraph = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/^[#>*\-\s]+/, "").trim())
    .find((p) => p.length >= 80 && !p.startsWith("[") && !/^!\[/.test(p));
  return (paragraph ?? description.trim()).slice(0, 600);
}

/**
 * Up to three brand colours out of what the site declares and uses: the theme colour first, then
 * the stylesheet's named colours, then the most used ones; greys and near-whites left out, and
 * shades of a colour already taken.
 */
export function brandColors(brand: {
  themeColor: string | null;
  variables: { name: string; value: string }[];
  frequent: string[];
}): { name: string; value: string }[] {
  const candidates = [
    ...(brand.themeColor ? [{ name: "Brand", value: brand.themeColor }] : []),
    ...brand.variables,
    ...brand.frequent.map((value, i) => ({ name: `Colour ${i + 1}`, value })),
  ];
  const colors: { name: string; value: string }[] = [];
  for (const c of candidates) {
    const value = hex(c.value);
    if (value && telling(value) && !colors.some((x) => shadeOf(x.value, value))) {
      colors.push({ name: c.name.replace(/^--/, "").slice(0, 120) || "Colour", value });
    }
    if (colors.length === 3) {
      break;
    }
  }
  return colors;
}

/** The facts a company's site states, by the keys the Info & brand page offers them under. */
const FACTS: [BasicFact, keyof CompanyContact | "website", ServerKey][] = [
  ["adresse", "street", "factAddress"],
  ["plz", "postcode", "factPostcode"],
  ["ort", "city", "factCity"],
  ["uid", "vatId", "factVatId"],
  ["telefon", "phone", "factPhone"],
  ["e_mail", "email", "factEmail"],
  ["website", "website", "factWebsite"],
];

/**
 * The space's facts with what the site states added: a fact the space has a value for stays as
 * it is, an empty one is filled, a missing one is added under its usual key and label.
 */
export function withFacts(
  facts: ProjectFact[],
  found: CompanyContact & { website?: string },
  lang: Lang,
): { facts: ProjectFact[]; added: number } {
  const next = [...facts];
  let added = 0;
  for (const [key, field, label] of FACTS) {
    const value = found[field]?.trim();
    const name = serverText(lang, label);
    const at = next.findIndex(
      (f) => f.key === key || f.label.trim().toLowerCase() === name.toLowerCase(),
    );
    if (!value || (at >= 0 && next[at].value.trim())) {
      continue;
    }
    if (at >= 0) {
      next[at] = { ...next[at], value };
    } else {
      next.push({ key, label: name, value });
    }
    added++;
  }
  return { facts: next, added };
}

export interface WebsiteOutcome {
  name: string;
  about: boolean;
  colors: number;
  logo: boolean;
  facts: number;
  assets: number;
}

/** At most this many pictures of the home page become brand material. */
const ASSETS = 4;

/**
 * Reads a website into the space's Info & brand: the company's name, what it does, up to three
 * of its colours, the facts its imprint and contact page state and, where the space has none
 * yet, its logo and the big pictures of its home page as brand material. What the assistant
 * does on request, done once at the start without a model.
 */
export async function applyWebsite(
  userId: string,
  projectId: string,
  url: string,
  lang: Lang,
): Promise<WebsiteOutcome> {
  const signal = AbortSignal.timeout(30_000);
  const reading = await readWebsite(url, signal, { inline: true });
  const name = companyOf(reading.title || new URL(reading.url).hostname);
  const about = aboutOf(reading.description, reading.text);
  const colors = brandColors(reading.brand);
  const contact = await readContact(reading, signal).catch(() => reading.contact);
  const project = await ownedProject(userId, projectId);
  const facts = withFacts(
    project.facts,
    { ...contact, website: new URL(reading.url).origin },
    lang,
  );
  await updateProject(userId, projectId, {
    brand: {
      name,
      ...(about ? { about } : {}),
      ...(colors.length ? { colors } : {}),
    },
    ...(facts.added ? { facts: facts.facts } : {}),
  });
  const host = new URL(reading.url).hostname;
  const [logo, assets] = await Promise.all([
    (async () => {
      const first = reading.brand.logos[0];
      if (!first || (await projectFiles(projectId, "logo")).length > 0) {
        return false;
      }
      return keep(projectId, first.url, "logo", first.hint);
    })(),
    (async () => {
      if ((await projectFiles(projectId, "asset")).length > 0) {
        return 0;
      }
      const pictures = reading.brand.images.filter((i) => i.hero).slice(0, ASSETS);
      const until = AbortSignal.timeout(30_000);
      let kept = 0;
      // One after the other: the brand material keeps the page's order.
      for (const picture of pictures) {
        const description = picture.alt.startsWith("share image")
          ? `share image of ${host}`
          : picture.alt || `picture on the home page of ${host}`;
        kept += Number(await keep(projectId, picture.url, "asset", description, until));
      }
      return kept;
    })(),
  ]);
  return {
    name,
    about: Boolean(about),
    colors: colors.length,
    logo,
    facts: facts.added,
    assets,
  };
}

/** A picture of the site kept in the space; one that cannot be fetched is no loss. */
async function keep(
  projectId: string,
  url: string,
  kind: "logo" | "asset",
  description: string,
  signal = AbortSignal.timeout(15_000),
): Promise<boolean> {
  try {
    await addProjectFileFromUrl(projectId, { url, kind, description, signal });
    return true;
  } catch {
    // The person adds it under Space → Logos or Brand material.
    return false;
  }
}
