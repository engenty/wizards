import type { AuthInfo } from "@modelcontextprotocol/server";
import { API_KEY_PREFIX, verifyLocalKey } from "../auth/keys.js";
import { LOCAL_CLIENT_HEADER, LOCAL_MCP_HEADER, localTicketExpiry } from "../auth/local-ticket.js";
import { env } from "../env.js";
import { grantActive, managed, type Role, verifyKey, verifyToken } from "../manage.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";
import { MCP_RESOURCE, SCOPES, type Scope } from "./scopes.js";

/** The admin an MCP request acts for, their tenant, and the client acting (shown in the studio thread). */
export interface Principal {
  userId: string;
  tenantId: string;
  /** The person's role in the tenant; a key or a local caller acts as the owner. */
  role: Role;
  client: string;
  scopes: Scope[];
  /** As the account names the person; a local caller has none. */
  name?: string;
  email?: string;
}

export function principalOf(info: AuthInfo): Principal {
  return info.extra as unknown as Principal;
}

function authInfoFor(who: Principal, token: string, clientId: string): AuthInfo {
  return { token, clientId, scopes: who.scopes, extra: { ...who } };
}

function bearer(request: Request): string | null {
  return (
    request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() || null
  );
}

const resourceMetadataUrl = (() => {
  const url = new URL(MCP_RESOURCE);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
})();

/** RFC 6750 / RFC 9728 challenge: tells an MCP client where to start OAuth. */
function challenge(status: 401 | 429, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(status === 401
        ? {
            "www-authenticate": managed
              ? `Bearer error="${error}", error_description="${description}", resource_metadata="${resourceMetadataUrl}", scope="${SCOPES.join(" ")}"`
              : `Bearer error="${error}", error_description="${description}"`,
          }
        : {}),
    },
  });
}

const keyCache = new Map<string, { at: number; who: Principal; keyId: string }>();

/** An API key acts as its owner, in the key's tenant, with every scope. */
async function apiKeyAuth(key: string): Promise<AuthInfo | Response> {
  if (!managed) {
    const found = await verifyLocalKey(key);
    if (!found) {
      return challenge(401, "invalid_token", "This API key is unknown or revoked.");
    }
    const who: Principal = {
      userId: "local",
      tenantId: LOCAL_TENANT,
      role: "owner",
      client: found.name || "MCP",
      scopes: [...SCOPES],
    };
    return authInfoFor(who, key, found.id);
  }
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) {
    return authInfoFor(hit.who, key, hit.keyId);
  }
  const result = await verifyKey(key).catch(() => null);
  if (!result?.valid || !result.userId || !result.tenantId) {
    keyCache.delete(key);
    return challenge(401, "invalid_token", "This API key is unknown or revoked.");
  }
  const who: Principal = {
    userId: result.userId,
    tenantId: result.tenantId,
    role: result.role ?? "member",
    client: result.name || "MCP",
    scopes: [...SCOPES],
    name: result.userName ?? "",
  };
  keyCache.set(key, { at: Date.now(), who, keyId: result.keyId ?? "" });
  return authInfoFor(who, key, result.keyId ?? "");
}

const grantCache = new Map<string, { at: number; active: boolean }>();
/** How long an answer of the Manage-App holds: "Trennen" takes effect within this time. */
const GRANT_TTL = 30_000;

/**
 * A signed token lives its hour whatever happens; whether the person still allows the app —
 * and is still in the team — the Manage-App knows. Asked at most every 30 seconds per grant;
 * when it cannot be asked, the token is refused.
 */
async function grantStands(userId: string, clientId: string, tenantId: string) {
  const key = `${userId}\n${clientId}\n${tenantId}`;
  const hit = grantCache.get(key);
  if (hit && Date.now() - hit.at < GRANT_TTL) {
    return hit.active;
  }
  const active = await grantActive(userId, clientId, tenantId)
    .then((r) => r.active)
    .catch(() => null);
  if (active === null) {
    return false;
  }
  grantCache.set(key, { at: Date.now(), active });
  return active;
}

/** An access token of the Manage-App, issued for this MCP endpoint, acts within its scopes. */
async function tokenAuth(token: string): Promise<AuthInfo | Response> {
  if (!managed) {
    return challenge(401, "invalid_token", "Sign in with an API key from the settings.");
  }
  const claims = await verifyToken(token, [MCP_RESOURCE, env.appUrl]);
  if (!claims) {
    return challenge(401, "invalid_token", "The access token is invalid or expired.");
  }
  if (!(await grantStands(claims.userId, claims.clientId, claims.tenantId))) {
    return challenge(401, "invalid_token", "This connection was ended. Connect again.");
  }
  const granted = new Set(claims.scopes);
  const who: Principal = {
    userId: claims.userId,
    tenantId: claims.tenantId,
    role: claims.role,
    client: claims.clientId || "MCP",
    scopes: SCOPES.filter((s) => granted.has(s)),
    name: claims.name,
    email: claims.email,
  };
  return authInfoFor(who, token, claims.clientId);
}

/**
 * A request from `wizards mcp` on this machine: signed with the data folder's secret,
 * which only a runtime alone has. It acts as the admin, like a key from the settings.
 */
function localAuth(request: Request, ticket: string): AuthInfo | Response {
  if (managed || !localTicketExpiry(env.authSecret, ticket, Date.now(), "local-mcp")) {
    return challenge(401, "invalid_token", "This local signature is invalid or expired.");
  }
  const client =
    request.headers
      .get(LOCAL_CLIENT_HEADER)
      ?.replace(/[^\p{L}\p{N} ._-]/gu, "")
      .trim()
      .slice(0, 60) || "MCP";
  const who: Principal = {
    userId: "local",
    tenantId: LOCAL_TENANT,
    role: "owner",
    client,
    scopes: [...SCOPES],
  };
  return authInfoFor(who, ticket, "local");
}

/** Who an MCP or API request acts for: an API key (`x-api-key` or a `wz_…` bearer) or an OAuth access token. */
export async function authenticate(request: Request): Promise<AuthInfo | Response> {
  const local = request.headers.get(LOCAL_MCP_HEADER)?.trim();
  if (local) {
    return localAuth(request, local);
  }
  const header = request.headers.get("x-api-key")?.trim();
  const token = bearer(request);
  const key = header || (token?.startsWith(API_KEY_PREFIX) ? token : null);
  if (key) {
    return apiKeyAuth(key);
  }
  if (!token) {
    return challenge(401, "invalid_token", "Sign in to use this endpoint.");
  }
  return tokenAuth(token);
}
