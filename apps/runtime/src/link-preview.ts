import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/client.js";
import { env } from "./env.js";
import { escapeHtml } from "./render/convert.js";
import { sharedRun, shareView } from "./services/shares.js";

function tags(p: { title: string; description: string; url: string; image?: string }): string {
  const t = [
    `<meta property="og:title" content="${escapeHtml(p.title)}">`,
    `<meta property="og:description" content="${escapeHtml(p.description)}">`,
    `<meta property="og:url" content="${escapeHtml(p.url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta name="twitter:card" content="${p.image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtml(p.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(p.description)}">`,
  ];
  if (p.image) {
    t.push(`<meta property="og:image" content="${escapeHtml(p.image)}">`);
    t.push(`<meta name="twitter:image" content="${escapeHtml(p.image)}">`);
  }
  return `<title>${escapeHtml(p.title)}</title>\n${t.join("\n")}`;
}

/**
 * Open Graph tags for shared links, so X, LinkedIn, WhatsApp and Slack show a card: a shared
 * result (`/s/<token>`) with its picture, a public wizard (`/w/<token>`, as a chat
 * `/w/<token>/chat`) with its title.
 */
export async function linkPreview(path: string): Promise<string | null> {
  const share = path.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (share) {
    const run = await sharedRun(share[1]);
    if (!run) {
      return null;
    }
    const view = await shareView(run);
    return tags({
      title: view.title === view.wizard.title ? view.title : `${view.title} · ${view.wizard.title}`,
      description: view.message ?? view.wizard.description,
      url: `${env.publicUrl}/s/${share[1]}`,
      image: `${env.publicUrl}/api/shares/${share[1]}/image`,
    });
  }
  const wizard = path.match(/^\/w\/([A-Za-z0-9_-]+)(\/chat)?\/?$/);
  if (wizard) {
    const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.shareToken, wizard[1]) });
    if (!w || w.publishedVersion === null || !w.shareEnabled) {
      return null;
    }
    const v = await db.query.wizardVersion.findFirst({
      where: and(
        eq(schema.wizardVersion.wizardId, w.id),
        eq(schema.wizardVersion.version, w.publishedVersion),
      ),
    });
    return v
      ? tags({
          title: v.definition.title,
          description: v.definition.description,
          url: `${env.publicUrl}/w/${wizard[1]}${wizard[2] ?? ""}`,
        })
      : null;
  }
  return null;
}
