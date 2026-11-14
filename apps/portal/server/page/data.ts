export type { PageSpace, PageTeam, PageWizard, RunTheme } from "@engenty/wizards-shared/page-data";

/**
 * In development the examples' wizards are not all built: a run address `/w/demo-…` stands for
 * one that is not, and the page says so instead of sending the visitor to a dead link. Never in
 * production, where a runtime sends real tokens only.
 */
export const isDemoRun = (url: string) =>
  process.env.NODE_ENV !== "production" && /\/w\/demo-/.test(url);
