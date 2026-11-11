import { env } from "../env.js";

/**
 * What an MCP or API client may do; the Manage-App's consent page lists them, tools register only
 * when granted. `runs:read`: the results of the live runs, as the WordPress plugin lists them.
 */
export const SCOPES = [
  "wizards:read",
  "wizards:write",
  "wizards:publish",
  "runs:test",
  "runs:read",
  // Using a space's elements (docs/plans/modular.md): reading its data, reading its skills and
  // wizards, running them.
  "data:read",
  "elements:read",
  "elements:run",
  // Starting a run of a space that the caller drives on its own machine (`wizards run`): it
  // hands out the run's token. A key or a client has it only where it was granted by name.
  "runs:host",
] as const;
export type Scope = (typeof SCOPES)[number];

/** What a key that names no scopes may do: everything but what must be granted by name. */
export const KEY_SCOPES: Scope[] = SCOPES.filter((scope) => scope !== "runs:host");

/** The scopes a key names, as this runtime knows them; a key that names none has `KEY_SCOPES`. */
export function keyScopes(named: readonly string[] | null | undefined): Scope[] {
  return named ? SCOPES.filter((scope) => named.includes(scope)) : [...KEY_SCOPES];
}

/** The protected resource OAuth tokens are bound to (RFC 8707 / RFC 9728). */
export const MCP_RESOURCE = `${env.appUrl}/api/mcp`;
