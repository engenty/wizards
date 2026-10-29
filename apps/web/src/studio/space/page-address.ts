import type { PageForm, PageLang, SpacePage } from "@engenty/wizards-shared/spaces";

/** `berger-partner.wizards.page/steuer`: the page's address as people read it. */
export const pageAddress = (host: string, slug: string) => `${host}/${slug}`;

/**
 * Where the page opens: `https://<host>/<slug>`; a `.localhost` host in development is served by
 * the Manage-App on its own port, which its address names.
 */
export function pageUrl(host: string, slug: string, manageUrl: string | null): string {
  if (host.endsWith(".localhost")) {
    const port = manageUrl && URL.canParse(manageUrl) ? new URL(manageUrl).port : "";
    return `http://${host}${port ? `:${port}` : ""}/${slug}`;
  }
  return `https://${host}/${slug}`;
}

/** The one select for the page's language and form: "de-du", "de-sie" or "en". */
export type PageVoice = "de-du" | "de-sie" | "en";

export const voiceOf = (page: Pick<SpacePage, "lang" | "form">): PageVoice =>
  page.lang === "en" ? "en" : page.form === "sie" ? "de-sie" : "de-du";

export function langOfVoice(voice: PageVoice): { lang: PageLang; form?: PageForm } {
  return voice === "en" ? { lang: "en" } : { lang: "de", form: voice === "de-sie" ? "sie" : "du" };
}
