import { ADDRESS_NAMES, addressKind, addressUrl } from "@engenty/wizards-shared/addresses";
import type { Lang } from "@engenty/wizards-shared/definition";
import {
  type BasicFact,
  factKey,
  PROJECT_LIMITS,
  type ProjectFact,
} from "@engenty/wizards-shared/projects";
import { nanoid } from "nanoid";
import { type CompanyPage, readCompany } from "../agents/company.js";
import { type CompanyContact, readContact, readWebsite } from "../agents/website.js";
import { managed, type Role } from "../manage.js";
import { readSetting, writeSetting } from "../settings.js";
import { type ServerKey, serverText } from "../texts.js";
import { isAdminRole } from "./access.js";
import { addProjectFileFromUrl, projectFiles } from "./project-files.js";
import { listProjects, ownedProject, updateProject } from "./projects.js";

/**
 * The first visit of a studio in the cloud. What the organization is (its kind, name, website,
 * first documents) is asked once per organization, of the first admin who opens it while it has no
 * wizards; what concerns the person (the greeting, what a space is) once per person; everyone
 * else gets one page that says where they are. The marks sit in the control database: the
 * organization's under the tenant, the person's under the user, and a visit under both.
 */
export type OnboardingMode =
  /** A person new to the studio, in an organization nobody has set up: everything. */
  | "full"
  /** Someone the studio knows, in an organization nobody has set up: its questions only. */
  | "organization"
  /** An organization set up already, or a member: one page that says where they are. */
  | "welcome";

const organizationKey = (tenantId: string) => `onboarding:${tenantId}`;
const personKey = (userId: string) => `onboarding:person:${userId}`;
const visitKey = (tenantId: string, userId: string) => `onboarding:visit:${tenantId}:${userId}`;

/** The organization was set up: its first visit was done, or it has wizards. */
async function setUp(user: { id: string; tenantId: string }): Promise<boolean> {
  if (await readSetting(organizationKey(user.tenantId))) {
    return true;
  }
  const projects = await listProjects(user.id);
  return projects.some((p) => p.wizardCount > 0);
}

/**
 * The person went through the studio's first visit before: their own mark, or, from before
 * the marks were per person, an organization of theirs they manage that has its mark.
 */
async function known(userId: string, organizations: { id: string; role: Role }[]) {
  if (await readSetting(personKey(userId))) {
    return true;
  }
  for (const o of organizations) {
    if (isAdminRole(o.role) && (await readSetting(organizationKey(o.id)))) {
      return true;
    }
  }
  return false;
}

export async function onboardingFor(
  user: { id: string; tenantId: string; role: Role },
  organizations: { id: string; role: Role }[] = [],
): Promise<OnboardingMode | null> {
  if (!managed || (await readSetting(visitKey(user.tenantId, user.id)))) {
    return null;
  }
  if (isAdminRole(user.role) && !(await setUp(user))) {
    return (await known(user.id, organizations)) ? "organization" : "full";
  }
  return "welcome";
}

/** The first visit is done: the organization's questions where they were asked, the person, the visit. */
export async function finishOnboarding(
  user: { id: string; tenantId: string },
  mode: OnboardingMode,
): Promise<void> {
  const doneAt = new Date().toISOString();
  if (mode !== "welcome") {
    await writeSetting(organizationKey(user.tenantId), { doneAt, by: user.id });
  }
  await writeSetting(personKey(user.id), { doneAt });
  await writeSetting(visitKey(user.tenantId, user.id), { doneAt });
}

/** A starting name the Manage-App gives a new team: its first admin names it. */
export function startingName(name: string | null | undefined): boolean {
  return !name || /^(neues team|new team)$/i.test(name.trim()) || /^team \S+$/i.test(name.trim());
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

/** A paragraph of Markdown as words: links and emphasis as their text, pictures left out. */
const plain = (p: string) =>
  p
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Sentences about the company, not a teaser, a menu or a cookie notice. */
const prose = (p: string) =>
  /[.!?…]$|[.!?]\s/.test(p) &&
  p.split(" ").length >= 8 &&
  !/cookie|datenschutz|privacy|einwilligung|consent|zustimmung/i.test(p);

/** At most `max` characters, cut after a sentence where it is longer. */
function cut(text: string, max = 600): string {
  if (text.length <= max) {
    return text;
  }
  const part = text.slice(0, max);
  const end = Math.max(part.lastIndexOf(". "), part.lastIndexOf("! "), part.lastIndexOf("? "));
  return end > max / 2 ? part.slice(0, end + 1) : part;
}

/**
 * The about text: a description that says something, else a paragraph of the home page, else
 * what the imprint gives as the company's purpose (its "Unternehmensgegenstand"); a slogan only
 * where nothing longer is there.
 */
export function aboutOf(description: string, text: string, purpose = ""): string {
  // A heading, a list or a paragraph that is mostly links (a menu, a footer) is no account.
  const linked = (p: string) =>
    [...p.matchAll(/\[([^\]]*)\]\([^)]*\)/g)].reduce((n, m) => n + m[1].length, 0) >
    plain(p).length / 2;
  const paragraphs = text
    .split(/\n{2,}/)
    .filter((p) => !(/^\s*(#|!?\[|[-*+] |\d+\. )/.test(p) || linked(p)))
    .map((p) => plain(p.replace(/^>\s*/, "")))
    .filter(prose);
  const [desc, does] = [description.trim(), purpose.trim()];
  return cut(
    [
      desc.length >= 120 ? desc : "",
      paragraphs.find((p) => p.length >= 120),
      does.length >= 120 ? does : "",
      desc.length >= 40 ? desc : "",
      paragraphs.find((p) => p.length >= 80),
      desc,
      does,
    ].find(Boolean) ?? "",
  );
}

/**
 * The brand's fonts out of what the site uses: the families it serves itself (its `@font-face`
 * rules, its Google Fonts link), at most two, the second only where one of them is clearly the
 * headings' font.
 */
export function brandFonts(
  fonts: { family: string; weights: number[]; headings?: boolean }[],
  lang: Lang,
): { family: string; role: string; weights: number[] }[] {
  const served = fonts.filter((f) => f.weights.length).slice(0, 2);
  const [a, b] = served;
  if (!a) {
    return [];
  }
  if (!b || Boolean(a.headings) === Boolean(b.headings)) {
    return [{ family: a.family, role: serverText(lang, "fontRoleAll"), weights: a.weights }];
  }
  return served.map((f) => ({
    family: f.family,
    role: serverText(lang, f.headings ? "fontRoleHeadings" : "fontRoleText"),
    weights: f.weights,
  }));
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

type Found = CompanyContact & { website?: string };

/** The facts a company's site states, by the keys the Info page offers them under. */
const FACTS: [BasicFact, keyof Found, ServerKey][] = [
  ["adresse", "street", "factAddress"],
  ["plz", "postcode", "factPostcode"],
  ["ort", "city", "factCity"],
  ["uid", "vatId", "factVatId"],
  ["telefon", "phone", "factPhone"],
  ["e_mail", "email", "factEmail"],
  ["website", "website", "factWebsite"],
];

/** The profiles on social networks, under their networks' names. */
const PROFILES: [keyof Found, string][] = [
  ["linkedin", "LinkedIn"],
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
  ["youtube", "YouTube"],
  ["xing", "XING"],
  ["x", "X"],
  ["tiktok", "TikTok"],
];

/**
 * The facts beyond the basics an imprint states, labelled as the company's country names them:
 * Austria's Firmenbuch ("FN 44903 i"), Germany's Handelsregister ("HRB 12345").
 */
function moreFacts(found: Found, lang: Lang): [keyof Found, string][] {
  const trade = /^HR[AB]/.test(found.register ?? "");
  return [
    ["company", serverText(lang, "factCompany")],
    ["register", serverText(lang, trade ? "factTradeRegister" : "factRegister")],
    ["court", serverText(lang, trade ? "factTradeRegisterCourt" : "factRegisterCourt")],
    ["management", serverText(lang, "factManagement")],
    ...PROFILES,
  ];
}

/** A value as it compares: "FN 44903 i" is "FN 44903i". */
const sameValue = (a: string, b: string) =>
  a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();

/**
 * The space's facts with what the site states added: a fact the space has a value for stays as
 * it is, an empty one is filled, a missing one is added, the basics under their usual keys, the
 * others under a key made from their label. `more`: facts a model read, by label; one whose
 * value the space already has is left out.
 */
export function withFacts(
  facts: ProjectFact[],
  found: Found,
  lang: Lang,
  more: { label: string; value: string }[] = [],
): { facts: ProjectFact[]; added: number } {
  const next = [...facts];
  let added = 0;
  const basicKey = (label: string) =>
    FACTS.find(([, , l]) => factKey(serverText(lang, l)) === factKey(label))?.[0] ?? null;
  const rows: [string | null, string | undefined, string][] = [
    ...FACTS.map(([key, field, label]): [string, string | undefined, string] => [
      key,
      found[field],
      serverText(lang, label),
    ]),
    ...moreFacts(found, lang).map(([field, label]): [null, string | undefined, string] => [
      null,
      found[field],
      label,
    ]),
    ...more
      .filter((m, i) => !more.slice(0, i).some((x) => sameValue(x.value, m.value)))
      .map((m): [string | null, string | undefined, string] => [
        basicKey(m.label),
        m.value,
        m.label,
      ]),
  ];
  for (const [i, [basic, raw, name]] of rows.entries()) {
    const value = raw?.trim();
    const key = basic ?? factKey(name);
    const at = next.findIndex(
      (f) => f.key === key || f.label.trim().toLowerCase() === name.toLowerCase(),
    );
    if (
      !value ||
      // Beyond the basics, a value the space has under another label is not added twice.
      (i >= FACTS.length && next.some((f) => sameValue(f.value, value))) ||
      (at >= 0 && next[at].value.trim()) ||
      (at < 0 && next.length >= PROJECT_LIMITS.facts)
    ) {
      continue;
    }
    if (at >= 0) {
      next[at] = { ...next[at], value };
    } else {
      next.push({
        key:
          basic ??
          factKey(
            name,
            next.map((f) => f.key),
          ),
        label: name,
        value,
      });
    }
    added++;
  }
  return { facts: next, added };
}

export interface WebsiteOutcome {
  name: string;
  about: boolean;
  colors: number;
  fonts: number;
  logo: boolean;
  facts: number;
  assets: number;
}

/** At most this many pictures of the home page become brand material. */
const ASSETS = 4;

/**
 * Reads a website into the space's Info and Brand: the company's name, what it does, up to three
 * of its colours, the facts its imprint and contact page state (its full name with its legal
 * form among them, where the site goes by a shorter one) and, where the space has none yet, its
 * fonts, its logo and the big pictures of its home page as brand material. What the assistant
 * does on request, done once at the start: patterns read the pages, one model call checks and
 * completes name, about, facts and fonts; without a model or credits the patterns' reading
 * stands.
 */
export async function applyWebsite(
  userId: string,
  projectId: string,
  url: string,
  lang: Lang,
): Promise<WebsiteOutcome> {
  const signal = AbortSignal.timeout(30_000);
  const reading = await readWebsite(url, signal, { inline: true });
  const colors = brandColors(reading.brand);
  const pages: CompanyPage[] = [{ url: reading.url, text: reading.text }];
  const contact = await readContact(reading, signal, pages).catch(() => reading.contact);
  const website = new URL(reading.url).origin;
  // What the patterns read; a model checks and completes it where one may be used.
  const found = {
    name: companyOf(reading.siteName || reading.title || new URL(reading.url).hostname),
    about: aboutOf(reading.description, reading.text, contact.purpose),
    fonts: brandFonts(reading.brand.fonts, lang),
  };
  const read = await readCompany({
    lang,
    pages,
    found: {
      name: found.name,
      company: contact.company,
      about: found.about,
      facts: withFacts([], { ...contact, website }, lang).facts.map(({ label, value }) => ({
        label,
        value,
      })),
      fonts: reading.brand.fonts,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const name = read?.name ?? found.name;
  const about = read?.about ?? found.about;
  const company = read?.company ?? contact.company;
  const project = await ownedProject(userId, projectId);
  const fonts = project.brand.fonts?.length ? [] : read?.fonts.length ? read.fonts : found.fonts;
  const facts = withFacts(
    project.facts,
    {
      ...contact,
      // The full name only where it says more than the name the space goes by.
      company: company?.toLowerCase() === name.toLowerCase() ? undefined : company,
      website,
    },
    lang,
    read?.facts,
  );
  await updateProject(userId, projectId, {
    brand: {
      name,
      ...(about ? { about } : {}),
      ...(colors.length ? { colors } : {}),
      ...(fonts.length ? { fonts: fonts.map((f) => ({ ...f, id: nanoid(10) })) } : {}),
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
    fonts: fonts.length,
    logo,
    facts: facts.added,
    assets,
  };
}

/**
 * Reads the addresses the person ticked or added into the space: the first website as
 * `applyWebsite` does, every other address (profiles, a blog, a second site) as a fact under its
 * name. Null where none of them is a website.
 */
export async function applyAddresses(
  userId: string,
  projectId: string,
  raw: string[],
  lang: Lang,
): Promise<WebsiteOutcome | null> {
  const urls = [...new Set(raw.flatMap((r) => addressUrl(r) ?? []))].slice(0, 10);
  const site = urls.find((u) => addressKind(u) === "website");
  const outcome = site ? await applyWebsite(userId, projectId, site, lang) : null;
  const rest = urls.filter((u) => u !== site);
  if (rest.length) {
    const project = await ownedProject(userId, projectId);
    const named = rest.map((url) => {
      const kind = addressKind(url);
      const count = rest.filter((u) => addressKind(u) === kind).indexOf(url);
      return {
        label: count ? `${ADDRESS_NAMES[kind]} ${count + 1}` : ADDRESS_NAMES[kind],
        value: url,
      };
    });
    const facts = withFacts(project.facts, {}, lang, named);
    if (facts.added) {
      await updateProject(userId, projectId, { facts: facts.facts });
    }
    if (outcome) {
      outcome.facts += facts.added;
    }
  }
  return outcome;
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
