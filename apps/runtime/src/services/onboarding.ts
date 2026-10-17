import { readWebsite } from "../agents/website.js";
import { managed, type Role } from "../manage.js";
import { readSetting, writeSetting } from "../settings.js";
import { isAdminRole } from "./access.js";
import { addProjectFile, projectFiles } from "./project-files.js";
import { listProjects, updateProject } from "./projects.js";

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
 * the stylesheet's named colours, then the most used ones; greys and near-whites left out.
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
    if (value && telling(value) && !colors.some((x) => x.value === value)) {
      colors.push({ name: c.name.replace(/^--/, "").slice(0, 120) || "Colour", value });
    }
    if (colors.length === 3) {
      break;
    }
  }
  return colors;
}

export interface WebsiteOutcome {
  name: string;
  about: boolean;
  colors: number;
  logo: boolean;
}

/**
 * Reads a website into the space's Info & brand: the company's name, what it does, up to three
 * of its colours and, where the space has none yet, its logo. What the assistant does on
 * request, done once at the start without a model.
 */
export async function applyWebsite(
  userId: string,
  projectId: string,
  url: string,
): Promise<WebsiteOutcome> {
  const reading = await readWebsite(url, AbortSignal.timeout(30_000));
  const name = companyOf(reading.title || new URL(reading.url).hostname);
  const about = aboutOf(reading.description, reading.text);
  const colors = brandColors(reading.brand);
  await updateProject(userId, projectId, {
    brand: {
      name,
      ...(about ? { about } : {}),
      ...(colors.length ? { colors } : {}),
    },
  });
  let logo = false;
  const first = reading.brand.logos[0];
  if (first && (await projectFiles(projectId, "logo")).length === 0) {
    logo = await fetchLogo(projectId, first.url, first.hint);
  }
  return { name, about: Boolean(about), colors: colors.length, logo };
}

const LOGO_BYTES = 5 * 1024 * 1024;

async function fetchLogo(projectId: string, url: string, hint: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const mime = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!res.ok || !mime.startsWith("image/")) {
      return false;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > LOGO_BYTES) {
      return false;
    }
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "logo");
    await addProjectFile(projectId, {
      kind: "logo",
      name,
      mime,
      data,
      description: hint || undefined,
      source: url,
    });
    return true;
  } catch {
    // A logo that cannot be fetched is no loss: the person adds one under Space → Logos.
    return false;
  }
}
