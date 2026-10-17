import type { Lang } from "@engenty-wizards/shared/definition";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { env } from "./env.js";

/**
 * The Manage-App as this runtime sees it (docs/manage-contract.md): it issues the tokens,
 * knows the tenants and their credits. Nothing here runs when `MANAGE_URL` is empty.
 */
export const managed = Boolean(env.manage.url);

export type Role = "owner" | "admin" | "member";

export interface TokenClaims {
  userId: string;
  tenantId: string;
  role: Role;
  name: string;
  email: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
}

const discoveries = new Map<string, { at: number; value: Discovery }>();

/** OIDC discovery of a Manage-App, cached for an hour. */
export async function discovery(base = env.manage.url): Promise<Discovery> {
  const hit = discoveries.get(base);
  if (hit && Date.now() - hit.at < 3600_000) {
    return hit.value;
  }
  const res = await fetch(`${base}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Manage-App discovery failed: ${res.status}`);
  }
  const value = (await res.json()) as Discovery;
  discoveries.set(base, { at: Date.now(), value });
  return value;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function toClaims(payload: JWTPayload): TokenClaims | null {
  const p = payload as JWTPayload & Record<string, unknown>;
  if (typeof p.sub !== "string" || typeof p.tenant !== "string") {
    return null;
  }
  const role = p.role === "owner" || p.role === "admin" ? p.role : "member";
  return {
    userId: p.sub,
    tenantId: p.tenant,
    role,
    name: typeof p.name === "string" ? p.name : "",
    email: typeof p.email === "string" ? p.email : "",
    clientId: typeof p.azp === "string" ? p.azp : String(p.client_id ?? ""),
    scopes: String(p.scope ?? "")
      .split(" ")
      .filter(Boolean),
    expiresAt: (p.exp ?? 0) * 1000,
  };
}

/**
 * Verifies an access token of the Manage-App against its JWKS — no round trip per request.
 * `audiences` are the resources this caller accepts; null skips the audience check.
 */
export async function verifyToken(
  token: string,
  audiences: string[] | null,
  base = env.manage.url,
): Promise<TokenClaims | null> {
  const payload = await verifySigned(token, audiences, base);
  return payload ? toClaims(payload) : null;
}

/** Any token the Manage-App at `base` signed (its JWKS, its issuer); null when it is not one. */
export async function verifySigned(
  token: string,
  audiences: string[] | null,
  base = env.manage.url,
): Promise<JWTPayload | null> {
  try {
    const d = await discovery(base);
    let keys = keySets.get(d.jwks_uri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(d.jwks_uri));
      keySets.set(d.jwks_uri, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: d.issuer,
      ...(audiences ? { audience: audiences } : {}),
    });
    return payload;
  } catch {
    return null;
  }
}

/** Reads a token's claims without verifying it — only for tokens the token endpoint just handed us. */
export function unverifiedClaims(token: string): TokenClaims | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return toClaims(payload);
  } catch {
    return null;
  }
}

// --- service calls -----------------------------------------------------------

export class ManageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.manage.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.manage.serviceKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new ManageError(
      res.status,
      data.code ?? "error",
      data.error ?? `Manage-App ${res.status}`,
    );
  }
  return data as T;
}

export interface TenantInfo {
  id: string;
  name: string;
  status: "active" | "suspended" | "deleted";
  balanceCredits: number;
  /** The plan the tenant is on (Free, Pro, Team, …); an older Manage-App names none. */
  plan?: { id: string; name: string };
  /**
   * `projects`: how many projects the tenant works with, null for as many as it wants.
   * `build: false`: the tenant makes and changes nothing here; its studio shows what its local
   * install synced. `members`: the people its plan allows, null for no limit.
   */
  limits: {
    concurrentRuns: number;
    projects?: number | null;
    build?: boolean;
    members?: number | null;
  };
  /** Ids of the plugins switched on for the tenant, besides the runtime's `PLUGINS_DEFAULT`. */
  modules?: string[];
  /** The plan's feature switches; a feature that is not named is off. `ownKeys`: own API keys here. */
  features?: Record<string, boolean>;
  db: { url: string } | null;
}

export interface TenantMembers {
  members: {
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: Role;
    joinedAt: string;
  }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
  /** The places the plan gives the tenant (null: no limit), and how many are taken or invited. */
  seats: { limit: number | null; taken: number };
}

/** The people of a tenant, as the Manage-App keeps them; they are managed there. */
export function tenantMembers(id: string): Promise<TenantMembers> {
  return call<TenantMembers>("GET", `/v1/tenants/${encodeURIComponent(id)}/members`);
}

export interface UserInfo {
  /** The person's own feature switches, as an admin set them at the Manage-App. */
  features: Record<string, boolean>;
  /** The person runs the platform (an admin of the Manage-App). */
  admin: boolean;
}

const users = new Map<string, { at: number; value: UserInfo }>();

/** What the Manage-App says of a person beyond their token; cached a minute. */
export async function userInfo(userId: string): Promise<UserInfo> {
  const hit = users.get(userId);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.value;
  }
  const value = await call<Partial<UserInfo>>("GET", `/v1/users/${encodeURIComponent(userId)}`)
    .then((u) => ({ features: u.features ?? {}, admin: u.admin === true }))
    .catch(() => hit?.value ?? { features: {}, admin: false });
  users.set(userId, { at: Date.now(), value });
  return value;
}

const tenants = new Map<string, { at: number; value: TenantInfo }>();

/** Plan, limits and balance of a tenant, cached for a minute. */
export async function tenantInfo(id: string, fresh = false): Promise<TenantInfo> {
  const hit = tenants.get(id);
  if (!fresh && hit && Date.now() - hit.at < 60_000) {
    return hit.value;
  }
  try {
    const value = await call<TenantInfo>("GET", `/v1/tenants/${encodeURIComponent(id)}`);
    tenants.set(id, { at: Date.now(), value });
    return value;
  } catch (err) {
    // The Manage-App is out of reach for a moment: what it said within the hour still counts.
    if (hit && !(err instanceof ManageError) && Date.now() - hit.at < 3600_000) {
      return hit.value;
    }
    throw err;
  }
}

export function forgetTenant(id: string) {
  tenants.delete(id);
}

/** Renames the team at the Manage-App; what it answers is the tenant as it stands now. */
export async function renameTenant(id: string, name: string): Promise<TenantInfo> {
  const value = await call<TenantInfo>("PATCH", `/v1/tenants/${encodeURIComponent(id)}`, {
    name,
  });
  tenants.set(id, { at: Date.now(), value });
  return value;
}

/** What a team tells the studio's first visit about itself; the Manage-App keeps it (its leads). */
export interface TeamProfile {
  kind: "personal" | "club" | "small" | "corp";
  size?: string | null;
  sector?: string | null;
  role?: string | null;
  need?: string | null;
  legalName?: string | null;
  phone?: string | null;
  website?: string | null;
}

export function saveTeamProfile(
  tenantId: string,
  userId: string,
  lang: "de" | "en",
  profile: TeamProfile,
): Promise<{ ok: boolean }> {
  return call("PUT", `/v1/tenants/${encodeURIComponent(tenantId)}/profile`, {
    ...profile,
    userId,
    lang,
  });
}

/** The Manage-App mails the install command and the first steps to one of the team's people. */
export function installMail(email: string, lang: Lang): Promise<{ ok: boolean }> {
  return call("POST", "/v1/install-mail", { email, lang });
}

export interface KeyInfo {
  valid: boolean;
  keyId?: string;
  name?: string;
  userId?: string;
  userName?: string;
  tenantId?: string;
  role?: Role;
}

export function verifyKey(key: string): Promise<KeyInfo> {
  return call<KeyInfo>("POST", "/v1/keys/verify", { key });
}

/** Whether the grant behind an access token still stands: not disconnected, still a member. */
export function grantActive(userId: string, clientId: string, tenantId: string) {
  return call<{ active: boolean }>("POST", "/v1/grants/check", { userId, clientId, tenantId });
}

export function reserve(tenantId: string, runId: string, credits: number) {
  return call<{ id: string }>("POST", "/v1/reservations", { tenantId, runId, credits });
}

export function release(runId: string) {
  return call<{ ok: boolean }>("POST", "/v1/reservations/release", { runId });
}

export function runUsage(tenantId: string, runId: string) {
  return call<{ credits: number; steps: Record<string, number> }>(
    "GET",
    `/v1/runs/${encodeURIComponent(runId)}/usage?tenantId=${encodeURIComponent(tenantId)}`,
  );
}

/** What a tenant spent per calendar month (UTC), newest first, with its costliest runs. */
export interface MonthlyUsage {
  months: { month: string; credits: number; runs: { runId: string; credits: number }[] }[];
}

export function tenantUsage(tenantId: string, months = 3) {
  return call<MonthlyUsage>(
    "GET",
    `/v1/tenants/${encodeURIComponent(tenantId)}/usage?months=${months}`,
  );
}

/** A plan teams can be on, as the Manage-App's public `GET /v1/plans` lists it. */
export interface PublicPlan {
  id: string;
  name: string;
  description: string;
  /** A month, in cents of `currency`, before tax; 0 for free. */
  priceCents: number;
  monthlyCredits: number;
  topUp: boolean;
  limits: { members: number | null; projects: number | null };
}

export interface PublicPlans {
  currency: string;
  plans: PublicPlan[];
  /** Credits bought on top, where the plan allows it. */
  packages: { id: string; name: string; credits: number; priceCents: number }[];
}

/** The plans of a Manage-App: public, no key needed. */
export async function publicPlans(base: string): Promise<PublicPlans> {
  const res = await fetch(`${base}/v1/plans`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new ManageError(res.status, "error", `Manage-App ${res.status}`);
  }
  return (await res.json()) as PublicPlans;
}

/** The tenant's numbers at the Manage-App, as `GET /v1/tenants/:id/channels` answers. */
export interface TenantChannels {
  /** The tenant's own number for texts and calls; null while it has none. */
  number: {
    number: string;
    country: string;
    kinds: ("sms" | "call" | "whatsapp")[];
    /** The provider's id of the number (Twilio's `PN…`); null when none was entered. */
    providerRef: string | null;
    since: string | null;
  } | null;
  /** The tenant's open request for a number, and who asked; null for none. */
  request: {
    id: string;
    country: string;
    wish: string | null;
    email: string;
    createdAt: string;
  } | null;
  /** The numbers every tenant shares (WhatsApp, a keyword per wizard). */
  shared: { number: string; country: string; kinds: ("sms" | "call" | "whatsapp")[] }[];
  /** The tenant's plan has a number of its own; false on a plan without one (Free). */
  allowed?: boolean;
}

const channels = new Map<string, { at: number; value: TenantChannels }>();

/** The tenant's numbers, cached for a minute. */
export async function tenantChannels(id: string): Promise<TenantChannels> {
  const hit = channels.get(id);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.value;
  }
  const value = await call<TenantChannels>("GET", `/v1/tenants/${encodeURIComponent(id)}/channels`);
  channels.set(id, { at: Date.now(), value });
  return value;
}

/**
 * Forgets what the Manage-App said of the tenant's numbers: the next `tenantChannels` asks.
 * The runtime tests of the Manage-App's channel plugins (sms, calls, whatsapp) call it.
 */
export function forgetChannels(id: string) {
  channels.delete(id);
}

/** A person of the tenant asks for its number; what the Manage-App answers with is the request. */
export async function requestChannelNumber(
  id: string,
  input: { userId: string; country: string; wish?: string | null; lang: Lang },
) {
  channels.delete(id);
  return call<{ request: NonNullable<TenantChannels["request"]> }>(
    "POST",
    `/v1/tenants/${encodeURIComponent(id)}/channels/requests`,
    input,
  );
}

/** The tenant takes its open request back. */
export async function withdrawChannelRequest(id: string) {
  channels.delete(id);
  return call<{ withdrawn: boolean }>(
    "DELETE",
    `/v1/tenants/${encodeURIComponent(id)}/channels/requests`,
  );
}

/** What a tenant's channel used, priced by the Manage-App: texts by segment, calls by minute. */
export function bookChannelUsage(
  id: string,
  input: {
    kind: "sms" | "call" | "whatsapp";
    quantity: number;
    runId?: string;
    idempotencyKey: string;
  },
) {
  return call<{ credits: number }>(
    "POST",
    `/v1/tenants/${encodeURIComponent(id)}/channels/usage`,
    input,
  );
}

/** A push to the mobile app on one device; the Manage-App holds the APNs and FCM keys. */
export function pushToDevice(input: {
  tenantId: string;
  device: { token: string; platform: "ios" | "android" };
  title: string;
  body: string;
  data: Record<string, string>;
}) {
  return call<{ ok: boolean }>("POST", "/v1/push", input);
}

// --- token endpoint ----------------------------------------------------------

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Code or refresh token → tokens. A confidential client sends its secret, a public one only its id. */
export async function tokenRequest(
  params: Record<string, string>,
  client: { id: string; secret?: string },
  base = env.manage.url,
): Promise<TokenSet> {
  const d = await discovery(base);
  const body = new URLSearchParams({ ...params, client_id: client.id });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString("base64")}`;
  }
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenSet & { error?: string };
  if (!res.ok || !data.access_token) {
    throw new ManageError(res.status, data.error ?? "token_error", "Token request failed");
  }
  return data;
}
