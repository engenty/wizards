/**
 * The Claude Code plugin `wizards` comes from two marketplaces: `engenty`, the GitHub repository
 * engenty/wizards, and one each deployment serves with its own server bundled. The served one is
 * named after the deployment's host, so a person can add both: `wizards@engenty` and
 * `wizards@wizards-example-com`.
 */
export const marketplaceNameOf = (appUrl: string): string =>
  new URL(appUrl).host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
