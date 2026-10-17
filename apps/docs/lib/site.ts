/** The path the site is served under: `basePath` in next.config.mjs. Links made by hand need it. */
export const BASE_PATH = "/docs";

export const GITHUB_URL = "https://github.com/engenty/wizards";

/** The release notes of a version on GitHub: `0.2.48` → …/releases/tag/v0.2.48. */
export function releaseUrl(version: string): string {
  return `${GITHUB_URL}/releases/tag/v${version}`;
}

/** Where a page's file is on GitHub. `path` is the page's path below docs/content. */
export function githubUrlForPage(path: string): string {
  return `${GITHUB_URL}/blob/main/docs/content/${path}`;
}
