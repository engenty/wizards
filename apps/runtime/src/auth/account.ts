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
/** The team of the linked account as the Manage-App last named it, for lines that must not wait on it. */
const TEAM = "account.team";

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
 */
export async function startLink(
  options: { signup?: boolean; code?: string } = {},
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

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Keeps what the token endpoint handed out: the refresh token in the vault, the account in the
 * settings. The browser flow (finishLink) and the device flow (device.ts) end here alike.
 */
export async function keep(tokens: TokenSet): Promise<LinkedAccount> {
  const claims = unverifiedClaims(tokens.access_token);
  if (!claims) {
    throw new Error("The account's token names no tenant.");
  }
  if (tokens.refresh_token) {
    await vaultSet(REFRESH, tokens.refresh_token);
  }
  cached = {
    token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 600) * 1000,
  };
  const account: LinkedAccount = {
    userId: claims.userId,
    tenantId: claims.tenantId,
    name: claims.name,
    email: claims.email,
  };
  await writeSetting("account", account);
  return account;
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
    return cached.token;
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
  cached = null;
  await vaultDelete(REFRESH);
  await deleteSetting("account");
  await deleteSetting(TEAM);
}

export interface KnownTeam {
  tenantId: string;
  name: string;
  balanceCredits: number;
  /** When the Manage-App last said so. */
  at: string;
}

/** The team as the Manage-App last named it: `wizards status` and the menu show it without a round trip. */
export function knownTeam(): Promise<KnownTeam | null> {
  return readSetting<KnownTeam>(TEAM);
}

let rememberedTeam: string | null = null;

async function rememberTeam(tenant: { id: string; name: string; balanceCredits: number }) {
  const same = `${tenant.id}\n${tenant.name}\n${tenant.balanceCredits}`;
  if (same === rememberedTeam) {
    return;
  }
  rememberedTeam = same;
  await writeSetting(TEAM, {
    tenantId: tenant.id,
    name: tenant.name,
    balanceCredits: tenant.balanceCredits,
    at: new Date().toISOString(),
  } satisfies KnownTeam);
}

/** Balance and tenants of the linked account, straight from the Manage-App. */
export async function accountOverview(): Promise<{
  user: { id: string; name: string; email: string; image?: string | null };
  tenant: {
    id: string;
    name: string;
    role: string;
    balanceCredits: number;
    /** What of the balance ends on a date, the nearest first. */
    expiring?: { kind: string; credits: number; expiresAt: string }[];
    /** The account's feature switches: its plan's, and what an admin set for it or for everyone. */
    features?: Record<string, boolean>;
  };
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
    await rememberTeam(overview.tenant).catch(() => undefined);
  }
  return overview;
}
