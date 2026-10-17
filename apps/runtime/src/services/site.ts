import type { Lang } from "@engenty-wizards/shared/definition";
import { factKey, PROJECT_LIMITS } from "@engenty-wizards/shared/projects";
import { note } from "@engenty-wizards/shared/run";
import { nanoid } from "nanoid";
import { z } from "zod";
import { runStudioAssistant } from "../agents/studio-assistant.js";
import type { SessionUser } from "../auth/index.js";
import { canSpend } from "../credits/credits.js";
import { errorText } from "../model-errors.js";
import { currentTenant } from "../tenants/tenant.js";
import { serverText } from "../texts.js";
import { projectWritable, requireWritable } from "./access.js";
import { apiSpace, apiSpaceDetails } from "./api.js";
import { openChat, turnHistory } from "./assistant-chats.js";
import { mainLogoId } from "./brand.js";
import { ServiceError } from "./errors.js";
import { addProjectFile } from "./project-files.js";
import { brandColorSchema, ownedProject, updateProject } from "./projects.js";
import { listOrigin, putOriginPage, removeOrigin } from "./space-data.js";

/*
 * A website reads itself into a space: the WordPress plugin sends what the site says about
 * itself (name, tagline, logo, the theme's colours, contact details) and its pages as text. The
 * pages go into Knowledge under the origin `wordpress`, the empty details of the space are filled
 * from what the site states, and the space assistant reads the rest (about, facts from the
 * imprint) as it does when an admin gives it a website. It takes a minute: the call starts a job
 * the client asks after.
 */

export const SITE_ORIGIN = "wordpress";

export const siteSchema = z.object({
  spaceId: z.string().optional(),
  url: z.string().url().max(500),
  name: z.string().max(120).default(""),
  tagline: z.string().max(500).default(""),
  language: z.string().max(20).optional(),
  /** Facts the site states plainly: e-mail, phone, the shop's address. */
  facts: z
    .array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(4000) }))
    .max(40)
    .default([]),
  colors: z.array(brandColorSchema).max(PROJECT_LIMITS.colors).default([]),
  logo: z
    .object({
      name: z.string().max(200),
      mime: z.string().max(100),
      /** Base64. */
      data: z.string().max(4_000_000),
    })
    .nullish(),
  pages: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        title: z.string().max(300),
        url: z.string().max(1000).optional(),
        /** What the page is to the site: `imprint`, `contact`, `privacy`, `about`, `front`, `page`, `product`. */
        role: z.string().max(40).optional(),
        markdown: z.string().max(60_000),
      }),
    )
    .max(60)
    .default([]),
  /** Let the space assistant fill in about and facts; false writes only what the site states. */
  assist: z.boolean().default(true),
});

export type SiteInput = z.infer<typeof siteSchema>;

/** The language the site's people read: German for a German site, else English. */
const siteLang = (input: SiteInput): Lang =>
  input.language?.toLowerCase().startsWith("de") ? "de" : "en";

interface SiteJob {
  id: string;
  tenantId: string;
  userId: string;
  /** The key's person, as the space assistant works for them. */
  user: SessionUser;
  status: "running" | "done" | "failed";
  /** What it is doing now, as the assistant says it. */
  activity: string;
  startedAt: number;
  pages: number;
  reply: string;
  error: string | null;
  space: Awaited<ReturnType<typeof apiSpaceDetails>> | null;
}

const jobs = new Map<string, SiteJob>();
const KEEP_MS = 60 * 60 * 1000;

function forget() {
  const old = Date.now() - KEEP_MS;
  for (const [id, job] of jobs) {
    if (job.startedAt < old) {
      jobs.delete(id);
    }
  }
}

/** What the site states, written where the space has nothing yet; the admin's own stays. */
async function fillFromSite(userId: string, projectId: string, input: SiteInput) {
  const p = await ownedProject(userId, projectId);
  const facts = [...p.facts];
  for (const f of input.facts) {
    const label = f.label.trim();
    if (facts.some((x) => x.label.toLowerCase() === label.toLowerCase())) {
      continue;
    }
    if (facts.length >= PROJECT_LIMITS.facts) {
      break;
    }
    facts.push({
      key: factKey(
        label,
        facts.map((x) => x.key),
      ),
      label,
      value: f.value.trim(),
    });
  }
  const website = facts.some((x) => /^(website|webseite)$/i.test(x.label));
  if (!website && facts.length < PROJECT_LIMITS.facts) {
    facts.push({
      key: factKey(
        "Website",
        facts.map((x) => x.key),
      ),
      label: "Website",
      value: input.url,
    });
  }
  await updateProject(userId, projectId, {
    brand: {
      ...(p.brand.name ? {} : input.name ? { name: input.name } : {}),
      ...(p.brand.about ? {} : input.tagline ? { about: input.tagline } : {}),
      ...(p.brand.colors?.length || !input.colors.length
        ? {}
        : { colors: input.colors.map((c) => ({ ...c, value: c.value.toLowerCase() })) }),
    },
    facts,
  });
  if (input.logo && !(await mainLogoId(projectId))) {
    await addProjectFile(projectId, {
      kind: "logo",
      name: input.logo.name,
      mime: input.logo.mime,
      data: new Uint8Array(Buffer.from(input.logo.data, "base64")),
      description: `Logo von ${input.url}`,
      source: input.url,
    }).catch((err) => console.warn("[site] logo:", (err as Error).message));
  }
}

/** The site's pages as Knowledge: the same page again rewrites, a page gone from the site goes. */
async function writePages(projectId: string, input: SiteInput): Promise<number> {
  const keys = new Set<string>();
  for (const page of input.pages) {
    if (!page.markdown.trim()) {
      continue;
    }
    keys.add(page.key);
    await putOriginPage(SITE_ORIGIN, {
      space: projectId,
      key: page.key,
      label: page.url ?? null,
      title: page.title || page.url || "Seite",
      markdown: page.url ? `Quelle: ${page.url}\n\n${page.markdown}` : page.markdown,
    });
  }
  for (const item of await listOrigin(SITE_ORIGIN, projectId)) {
    if (item.kind === "page" && !keys.has(item.key)) {
      await removeOrigin(SITE_ORIGIN, projectId, item.key);
    }
  }
  return keys.size;
}

/** What the assistant gets: the site's own statements, and the pages that carry the details. */
function assistMessage(input: SiteInput): string {
  const telling = ["imprint", "contact", "about", "front"];
  const pages = [...input.pages]
    .sort((a, b) => {
      const rank = (r?: string) => (telling.includes(r ?? "") ? telling.indexOf(r ?? "") : 9);
      return rank(a.role) - rank(b.role);
    })
    .slice(0, 6)
    .map(
      (p) =>
        `## ${p.title}${p.url ? ` (${p.url})` : ""}${p.role ? ` [${p.role}]` : ""}\n\n${p.markdown.slice(0, 6000)}`,
    );
  return [
    `This is the WordPress website ${input.url}. Fill the space from what it says about itself: a title, a description (about), facts (address, phone, email, VAT ID, company register, opening hours, who runs it) and the colours, if there are none yet. Its pages are already in Knowledge; do not copy them. Write in the website's own language.`,
    "The details below come straight from WordPress. Read the website with read_website only when something important is missing. Invent nothing.",
    `Name: ${input.name || "—"}\nTagline: ${input.tagline || "—"}\nLanguage: ${input.language ?? "—"}`,
    input.facts.length
      ? `What the website states:\n${input.facts.map((f) => `- ${f.label}: ${f.value}`).join("\n")}`
      : "",
    input.colors.length
      ? `The theme's colours: ${input.colors.map((c) => `${c.name} ${c.value}`).join(", ")}`
      : "",
    pages.length ? `Pages:\n\n${pages.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 7900);
}

async function work(job: SiteJob, projectId: string, input: SiteInput) {
  try {
    const lang = siteLang(input);
    job.activity = serverText(lang, "siteTakingOver");
    await fillFromSite(job.userId, projectId, input);
    job.activity = serverText(lang, "siteWritingPages");
    job.pages = await writePages(projectId, input);
    if (input.assist && (await canSpend())) {
      job.activity = serverText(lang, "siteReading");
      const project = await ownedProject(job.userId, projectId);
      // The person's open assistant chat gives the context; the turn is not stored in it.
      const chat = await openChat(job.user);
      const result = await runStudioAssistant({
        user: job.user,
        chat,
        history: await turnHistory(job.user, chat),
        project,
        writable: await projectWritable(project),
        message: assistMessage(input),
        page: null,
        browserTools: [],
        lang: siteLang(input),
        onActivity: (label) => {
          job.activity = label;
        },
        // No studio page is open: the browser's tools are not offered.
        callBrowser: async () => ({ error: "No page is open." }),
      }).catch((err) => {
        // What the site states is written; the assistant's part is a bonus.
        console.warn("[site] assistant:", (err as Error).message);
        return null;
      });
      job.reply = result?.reply ?? "";
    }
    job.space = await apiSpaceDetails(job.userId, projectId);
    job.status = "done";
    job.activity = "";
  } catch (err) {
    job.status = "failed";
    job.error =
      err instanceof ServiceError
        ? errorText(err, siteLang(input))
        : serverText(siteLang(input), "siteFailed");
    console.error("[site]", err);
  }
}

/**
 * Starts reading a website into the caller's space; answers at once with the job. Called inside
 * the caller's tenant and role, which the job keeps.
 */
export async function startSiteJob(
  who: {
    userId: string;
    tenantId: string;
    role: SessionUser["role"];
    name?: string;
    email?: string;
  },
  input: SiteInput,
) {
  forget();
  const { userId } = who;
  const space = await apiSpace(userId, input.spaceId);
  const running = [...jobs.values()].find(
    (j) => j.tenantId === currentTenant() && j.status === "running",
  );
  if (running) {
    return siteJobView(running);
  }
  // Refused here and not in the job: a space from a local install, or a plan that builds nothing.
  await requireWritable(space);
  const job: SiteJob = {
    id: nanoid(12),
    tenantId: currentTenant(),
    userId,
    user: {
      id: userId,
      tenantId: who.tenantId,
      role: who.role,
      name: who.name ?? "",
      email: who.email ?? "",
    },
    status: "running",
    activity: "Beginnt …",
    startedAt: Date.now(),
    pages: 0,
    reply: "",
    error: null,
    space: null,
  };
  jobs.set(job.id, job);
  void work(job, space.id, input);
  return siteJobView(job);
}

function siteJobView(job: SiteJob) {
  return {
    id: job.id,
    status: job.status,
    activity: job.activity,
    pages: job.pages,
    reply: job.reply,
    error: job.error,
    space: job.space,
  };
}

export function siteJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job || job.tenantId !== currentTenant()) {
    throw new ServiceError("not_found", note("jobNotExistAlready"));
  }
  return siteJobView(job);
}
