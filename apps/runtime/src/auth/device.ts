import { env } from "../env.js";
import { discovery, ManageError, tokenRequest } from "../manage.js";
import { CLIENT, keep, type LinkedAccount, SCOPE } from "./account.js";

/**
 * Signing in from a terminal (RFC 8628): the Manage-App hands out a code, the person types it
 * on any browser at the account's /device page and allows it, and this process asks the token
 * endpoint until they did. For `wizards setup` and `wizards account sign-in`; the studio keeps
 * the browser flow of account.ts. Both end in the same keep(): the refresh token in the vault,
 * the account in the settings, so the runtime picks it up wherever it runs.
 *
 *   POST <account>/api/auth/device/code      client_id, scope, resource → the codes
 *   POST <token endpoint of the discovery>   grant_type device_code, every `interval` seconds,
 *                                            until tokens come, or the code expired or was refused
 */

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCode {
  deviceCode: string;
  /** What the person types. */
  userCode: string;
  verificationUri: string;
  /** The same page with the code filled in, when the Manage-App gives one. */
  verificationUriComplete: string | null;
  expiresAt: number;
  /** Seconds to wait between two asks, as the Manage-App says. */
  interval: number;
}

/** Why a sign-in ended without an account; the message is for the person. */
export class DeviceSignInError extends Error {
  constructor(
    readonly reason: "expired" | "denied" | "refused" | "unreachable" | "skipped",
    message: string,
  ) {
    super(message);
  }
}

interface CodeAnswer {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/** Asks the Manage-App for a code to sign this install in with. */
export async function requestDeviceCode(): Promise<DeviceCode> {
  const base = env.local.accountUrl;
  // The discovery names the endpoint when the Manage-App advertises it.
  const d = (await discovery(base).catch(() => null)) as {
    device_authorization_endpoint?: string;
  } | null;
  const res = await fetch(d?.device_authorization_endpoint ?? `${base}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT.id,
      scope: SCOPE,
      resource: env.local.cloudUrl,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) {
    throw new DeviceSignInError("unreachable", `${base} is not reachable right now.`);
  }
  const data = (await res.json().catch(() => ({}))) as CodeAnswer;
  if (!(res.ok && data.device_code && data.user_code && data.verification_uri)) {
    throw new DeviceSignInError(
      "refused",
      data.error_description ||
        (data.error
          ? `The account refused the sign-in (${data.error}).`
          : `The account did not hand out a code (${res.status}).`),
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
    interval: Math.max(1, data.interval ?? 5),
  };
}

/** A pause that ends early when the signal aborts. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/**
 * Asks the token endpoint until the person allowed the code in the browser, and keeps the
 * tokens as the browser flow does. `authorization_pending` asks again after `interval`;
 * `slow_down` asks five seconds later each time (RFC 8628 §3.5); a network error is tried
 * again a few times. `expired_token` and `access_denied` end it.
 */
export async function waitForDeviceSignIn(
  code: DeviceCode,
  options: {
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Ends the wait without an account: the person chose to sign in later. */
    signal?: AbortSignal;
  } = {},
): Promise<LinkedAccount> {
  const wait = options.wait ?? pause;
  const { signal } = options;
  let interval = code.interval;
  let failures = 0;
  for (;;) {
    await wait(interval * 1000, signal);
    if (signal?.aborted) {
      throw new DeviceSignInError("skipped", "Skipped the sign-in.");
    }
    if (Date.now() >= code.expiresAt) {
      throw new DeviceSignInError("expired", "The code has expired. Start the sign-in again.");
    }
    try {
      const tokens = await tokenRequest(
        { grant_type: GRANT, device_code: code.deviceCode, resource: env.local.cloudUrl },
        CLIENT,
        env.local.accountUrl,
      );
      return await keep(tokens);
    } catch (err) {
      if (!(err instanceof ManageError)) {
        if (++failures >= 5) {
          throw new DeviceSignInError(
            "unreachable",
            `${env.local.accountUrl} stopped answering. Start the sign-in again.`,
          );
        }
        continue;
      }
      failures = 0;
      switch (err.code) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval += 5;
          continue;
        case "expired_token":
          throw new DeviceSignInError("expired", "The code has expired. Start the sign-in again.");
        case "access_denied":
          throw new DeviceSignInError("denied", "The sign-in was refused in the browser.");
        default:
          throw new DeviceSignInError("refused", `The account refused the sign-in (${err.code}).`);
      }
    }
  }
}
