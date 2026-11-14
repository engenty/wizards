/**
 * Connectors of one service: one sign-in serves kind `mail` and the service's own connector,
 * one account per address (docs/plans/run-connections.md, decided 2026-11-14). No imports: the
 * database's own conversion reads it while a tenant opens (`db/kept-accounts.ts`).
 */
const SAME_SERVICE: readonly (readonly string[])[] = [
  ["mail-gmail", "google-gmail"],
  ["mail-outlook", "microsoft-outlook"],
];

/** The connector ids that share one account with `connectorId`, itself first. */
export function sameService(connectorId: string): string[] {
  const ids = SAME_SERVICE.find((s) => s.includes(connectorId)) ?? [];
  return [connectorId, ...ids.filter((id) => id !== connectorId)];
}
