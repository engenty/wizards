/**
 * What a team's public page is drawn from: the shape the runtime sends the Manage-App
 * (`PUT /v1/pages/:tenantId`, docs/manage-contract.md) and the Manage-App answers by host.
 */

/** The run page's theme, as the runtime derives it from a space's brand (`runTheme`). */
export interface RunTheme {
  accent: string | null;
  second: string | null;
  background: string | null;
  display: string | null;
  body: string | null;
  dark: boolean;
}

export interface PageWizard {
  slug: string;
  title: string;
  description: string;
  /** One of the engenty kinds (`round`, `drop`, …); an unknown one draws `round`. */
  avatar: string;
  lang: "de" | "en";
  /** What a person takes along at the end: each by its name, kind and files. */
  results: { title: string; kind: string; formats: string[] }[];
  effort: { fields: number; reviews: number; minutes: number; uploads: boolean };
  /** The way through as a short list. */
  steps: { title: string; by: "you" | "ai" }[];
  /** The runtime's run page (`/w/<token>`): where the start button leads. */
  runUrl: string;
  /** A run the owner shared as the example (`/s/<token>`); drawn from the kind where none. */
  exampleUrl?: string;
}

export interface PageSpace {
  /** The space's address under the team's: `<team>.wizards.page/<slug>`. */
  slug: string;
  /** The name on the page; the internal space name never shows. */
  title: string;
  headline?: string;
  intro?: string;
  lang: "de" | "en";
  /** How the page addresses its readers, where the language tells them apart. */
  form?: "du" | "sie";
  brand: { name: string; logoUrl: string | null; theme: RunTheme };
  /** The space's facts as the imprint: the name, then one line each. */
  imprint: { name: string; lines: string[]; website?: string } | null;
  /** In the team's order; the first is shown large. */
  wizards: PageWizard[];
}

export interface PageTeam {
  slug: string;
  name: string;
  lang: string;
  space: PageSpace | null;
}

/**
 * In development the examples' wizards are not all built: a run address `/w/demo-…` stands for
 * one that is not, and the page says so instead of sending the visitor to a dead link. Never in
 * production, where a runtime sends real tokens only.
 */
export const isDemoRun = (url: string) =>
  process.env.NODE_ENV !== "production" && /\/w\/demo-/.test(url);
