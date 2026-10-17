import { note } from "@engenty-wizards/shared/run";
import { accountToken } from "../auth/account.js";
import type { OAuth2Tokens } from "../engenty/connections-sdk/oauth2.js";
import { env } from "../env.js";
import { NotedError } from "../model-errors.js";

/*
 * Google accounts on a local install without an OAuth client of its own: the Manage-App of the
 * linked account runs the consent at Google with its client and hands the tokens over, and
 * refreshes them later (docs/manage-contract.md, "Google accounts through the Manage-App").
 */

const base = () => `${env.local.accountUrl}/v1/connect`;

/** Something the person can mend or retry; the message is for them. */
export class AccountConnectError extends NotedError {}

let offered: { at: number; google: boolean } | null = null;

/** Whether the Manage-App connects Google accounts; asked at most every ten minutes. */
export async function googleThroughAccount(): Promise<boolean> {
  if (offered && Date.now() - offered.at < (offered.google ? 600_000 : 60_000)) {
    return offered.google;
  }
  const google = await fetch(base(), { signal: AbortSignal.timeout(5000) })
    .then(async (res) =>
      res.ok ? ((await res.json()) as { google?: boolean }).google === true : false,
    )
    .catch(() => false);
  offered = { at: Date.now(), google };
  return google;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const token = await accountToken();
  if (!token) {
    throw new AccountConnectError(note("connectEngentyAccountFirst"));
  }
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) {
    throw new AccountConnectError(note("engentyAccountNotReached"));
  }
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; error?: string };
  if (!res.ok) {
    throw new AccountConnectError(
      data.code === "invalid_grant"
        ? note("googleNoLongerAccepts")
        : data.code === "not_configured"
          ? note("googleNotConnectedThrough")
          : note("viaAccountFailed", { code: data.code ?? res.status }),
    );
  }
  return data;
}

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

const tokensOf = (t: GoogleTokens): OAuth2Tokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? null,
  expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
  grantedScopes: (t.scope ?? "").split(/\s+/).filter(Boolean),
});

/** Google's consent page for these scopes; Google comes back to `returnUrl` with a ticket. */
export async function startThroughAccount(
  scopes: string[],
  state: string,
  returnUrl: string,
): Promise<string> {
  return (await call<{ url: string }>("/google/start", { scopes, state, returnUrl })).url;
}

export async function redeemTicket(ticket: string): Promise<OAuth2Tokens> {
  return tokensOf(await call<GoogleTokens>("/google/redeem", { ticket }));
}

export async function refreshThroughAccount(refreshToken: string): Promise<OAuth2Tokens> {
  return tokensOf(await call<GoogleTokens>("/google/refresh", { refreshToken }));
}
