/**
 * The portal server's settings (docs/plans/client-portal.md). It needs the Manage-App for the
 * sign-in and a team's public face, the runtime for the client contract and the run routes, and
 * its own client at the Manage-App.
 */

const str = (key: string, fallback = "") => (process.env[key] ?? fallback).trim();
const origin = (value: string) => value.replace(/\/+$/, "");

function required(key: string): string {
  const value = str(key);
  if (!value) {
    throw new Error(`${key} is not set.`);
  }
  return value;
}

const runtimeUrl = origin(required("RUNTIME_URL"));
const secret = required("PORTAL_SECRET");
if (secret.length < 32) {
  throw new Error("PORTAL_SECRET has 32 characters or more.");
}

export const env = {
  port: Number(str("PORTAL_PORT", "8893")),
  host: str("PORTAL_HOST", "0.0.0.0"),
  /** The portal's own origin: the sign-in comes back here, for every team's host. */
  portalUrl: origin(required("PORTAL_URL")),
  manageUrl: origin(required("MANAGE_URL")),
  /** The runtime's public origin: the resource the tokens are for. */
  runtimeUrl,
  /** Where the client contract is served (the `api` role); the runtime's origin by default. */
  runtimeApiUrl: origin(str("RUNTIME_API_URL", runtimeUrl)),
  /** Where the run routes and public files are served (the `doors` role). */
  runtimeDoorsUrl: origin(str("RUNTIME_DOORS_URL", runtimeUrl)),
  clientId: str("PORTAL_CLIENT_ID", "wizards-portal-cloud"),
  clientSecret: required("PORTAL_CLIENT_SECRET"),
  /** Seals the session cookie and the sign-in's state. */
  secret,
  /** The built SPA. */
  webDir: str("PORTAL_WEB_DIR", new URL("../web", import.meta.url).pathname),
};
