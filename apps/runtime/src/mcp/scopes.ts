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
] as const;
export type Scope = (typeof SCOPES)[number];

/** The protected resource OAuth tokens are bound to (RFC 8707 / RFC 9728). */
export const MCP_RESOURCE = `${env.appUrl}/api/mcp`;
