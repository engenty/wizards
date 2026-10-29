import { createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { discovery, type TokenSet, tokenRequest, unverifiedClaims } from "../manage.js";
import { seal, unseal } from "../secrets/crypto.js";
import { vaultDelete, vaultGet, vaultSet } from "../secrets/vault.js";
import { deleteSetting, readSetting, writeSetting } from "../settings.js";

/**
 * The account a runtime that runs alone is linked to: sign-in (or sign-up) happens in the system
 * browser at the Manage-App, the code comes back to this server on the loopback interface. The
 * account is optional; it unlocks credits through the gateway and publishing to the cloud.
 */
export const CLIENT = { id: "wizards-desktop" };
const REFRESH = "account.refresh";
export const SCOPE =
  "openid profile email offline_access wizards:read wizards:write wizards:publish";
/** The organization of the linked account as the Manage-App last named it, for lines that must not wait on it. */
const ORGANIZATION = "account.organization";

export interface LinkedAccount {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
}

interface LinkState {
  verifier: string;
  redirect: string;
  exp: number;
}

/** Loopback redirect on the port this server listens on (RFC 8252). */
function redirectUri(): string {
  return `http://127.0.0.1:${env.port}/api/auth/callback`;
}

/**
 * The address that links an account. `signup`: the person has none yet — the account's sign-up
 * page takes the invitation code (`code` fills it in) and goes on to the same sign-in.
 * `organization` (its id or address) names the organization to sign in to: a member gets it
 * without the picker, a switch.
 */
export async function startLink(
  options: { signup?: boolean; code?: string; organization?: string } = {},
): Promise<string> {
  const d = await discovery(env.local.accountUrl);
  const verifier = randomBytes(32).toString("base64url");
  const state: LinkState = { verifier, redirect: redirectUri(), exp: Date.now() + 15 * 60_000 };
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT.id,
    redirect_uri: state.redirect,
    scope: SCOPE,
    resource: env.local.cloudUrl,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: seal(state),
    ...(options.organization ? { organization: options.organization } : {}),
  }).toString();
  if (!options.signup) {
    return url.toString();
  }
  const signUp = new URL("/sign-up", env.local.accountUrl);
  const code = options.code?.trim();
  if (code) {
    signUp.searchParams.set("code", code);
  }
  // The sign-up page goes on only to a path of its own origin.
  signUp.searchParams.set("next", url.pathname + url.search);
  return signUp.toString();
}

let cached: { token: string; expiresAt: number; tenantId: string } | null = null;
/** The organization last written to the settings, so an unchanged one is not written again. */
let rememberedOrganization: string | null = null;

/**
 * Keeps what the token endpoint handed out: the refresh token in the vault, the account in the
 * settings. The browser flow (finishLink) and the device flow (device.ts) end here alike. A
 * token for another organization than before is a switch: the sync of the one before is
 * forgotten first, so nothing of it goes up to the new one (sync/client.ts).
 */
export async function keep(tokens: TokenSet): Promise<LinkedAccount> {
  const claims = unverifiedClaims(tokens.access_token);
  if (!claims) {
    throw new Error("The account's token names no tenant.");
  }
  const before = await linkedAccount();
  const switched = Boolean(before && before.tenantId !== claims.tenantId);
  const oldRefresh = switched ? await vaultGet(REFRESH) : null;
  if (switched) {
    cached = null;
    // Loaded here: the sync reads the account this module keeps.
    const [{ forgetCloud }, sync, { withTenant }, { LOCAL_TENANT }] = await Promise.all([
      import("../services/cloud.js"),
      import("../sync/client.js"),
      import("../db/client.js"),
      import("../tenants/tenant.js"),
    ]);
    // The browser's callback and a terminal come here without the install's tenant.
    await withTenant(LOCAL_TENANT, async () => {
      await sync.noteSyncedSpaces();
      await forgetCloud();
      await sync.keepUnsyncedHere();
    });
    rememberedOrganization = null;
    await deleteSetting(ORGANIZATION);
  }
  if (tokens.refresh_token) {
    await vaultSet(REFRESH, tokens.refresh_token);
  }
  cached = {
    token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
    tenantId: claims.tenantId,
  };
  const account: LinkedAccount = {
    userId: claims.userId,
    tenantId: claims.tenantId,
    name: claims.name,
    email: claims.email,
  };
  await writeSetting("account", account);
  if (oldRefresh && oldRefresh !== tokens.refresh_token) {
    await revoke(oldRefresh);
  }
  return account;
}

/** Ends a refresh token at the Manage-App; a Manage-App out of reach lets it run out by itself. */
async function revoke(refresh: string): Promise<void> {
  const d = await discovery(env.local.accountUrl).catch(() => null);
  if (d?.revocation_endpoint) {
    await fetch(d.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, client_id: CLIENT.id }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

export async function finishLink(code: string, rawState: string): Promise<LinkedAccount> {
  const state = unseal<LinkState>(rawState);
  if (!state || state.exp < Date.now()) {
    throw new Error("This sign-in has expired.");
  }
  const tokens = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: state.redirect,
      code_verifier: state.verifier,
      resource: env.local.cloudUrl,
    },
    CLIENT,
    env.local.accountUrl,
  );
  return keep(tokens);
}

export function linkedAccount(): Promise<LinkedAccount | null> {
  return readSetting<LinkedAccount>("account");
}

/** A fresh access token of the linked account, or null when none is linked (or it was revoked). */
export async function accountToken(): Promise<string | null> {
  if (cached && cached.expiresAt - Date.now() > 60_000) {
    // `wizards account switch` in a terminal changes the account under a runtime that runs.
    if ((await linkedAccount())?.tenantId === cached.tenantId) {
      return cached.token;
    }
    cached = null;
  }
  // One refresh at a time: a refresh token is used once, a second caller would be refused.
  refreshing ??= refreshAccount().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

let refreshing: Promise<string | null> | null = null;

async function refreshAccount(): Promise<string | null> {
  const refresh = await vaultGet(REFRESH);
  if (!refresh) {
    return null;
  }
  try {
    const tokens = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: refresh, resource: env.local.cloudUrl },
      CLIENT,
      env.local.accountUrl,
    );
    await keep(tokens);
    return tokens.access_token;
  } catch {
    return null;
  }
}

export async function unlink(): Promise<void> {
  const refresh = await vaultGet(REFRESH);
  if (refresh) {
    await revoke(refresh);
  }
  cached = null;
  await vaultDelete(REFRESH);
  await deleteSetting("account");
  await deleteSetting(ORGANIZATION);
}

export interface KnownOrganization {
  tenantId: string;
  name: string;
  balanceCredits: number;
  /** When the Manage-App last said so. */
  at: string;
}

/** The organization as the Manage-App last named it: `wizards status` and the menu show it without a round trip. */
export function knownOrganization(): Promise<KnownOrganization | null> {
  return readSetting<KnownOrganization>(ORGANIZATION);
}

async function rememberOrganization(tenant: { id: string; name: string; balanceCredits: number }) {
  const same = `${tenant.id}\n${tenant.name}\n${tenant.balanceCredits}`;
  if (same === rememberedOrganization) {
    return;
  }
  rememberedOrganization = same;
  await writeSetting(ORGANIZATION, {
    tenantId: tenant.id,
    name: tenant.name,
    balanceCredits: tenant.balanceCredits,
    at: new Date().toISOString(),
  } satisfies KnownOrganization);
}

/** Balance and tenants of the linked account, straight from the Manage-App. */
export async function accountOverview(): Promise<{
  user: { id: string; name: string; email: string; image?: string | null };
  tenant: {
    id: string;
    name: string;
    role: string;
    /** The plan, and the Pro modules it includes; an older Manage-App sends no modules. */
    plan?: { id: string; name: string };
    modules?: string[];
    balanceCredits: number;
    /** What of the balance ends on a date, the nearest first. */
    expiring?: { kind: string; credits: number; expiresAt: string }[];
    /** The account's feature switches: its plan's, and what an admin set for it or for everyone. */
    features?: Record<string, boolean>;
  };
  /** Every organization of the person, for the switch; an older Manage-App lists none. */
  tenants?: { id: string; name: string; role: string }[];
} | null> {
  const token = await accountToken();
  if (!token) {
    return null;
  }
  const res = await fetch(`${env.local.accountUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) {
    return null;
  }
  const overview = (await res.json()) as Awaited<ReturnType<typeof accountOverview>>;
  if (overview?.tenant) {
    await rememberOrganization(overview.tenant).catch(() => undefined);
    // A plan that changed brings its Pro modules along (plugins/pro.ts).
    const tenant = overview.tenant;
    void import("../plugins/pro.js").then((pro) => pro.followPlan(tenant));
  }
  return overview;
}
