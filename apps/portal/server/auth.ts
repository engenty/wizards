import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "./env.js";
import { seal, unseal } from "./seal.js";

/**
 * The client's sign-in through the Manage-App (OAuth with PKCE, as the runtime's studio signs in,
 * apps/runtime/src/auth/index.ts). The sign-in comes back to the portal's own origin, one
 * redirect address for every team; from there a one-time hand-over takes the session to the
 * team's host, where only the browser that started the sign-in can use it (its state cookie).
 * The session is the tokens, sealed in an http-only cookie: the portal keeps no database.
 */

const SESSION_COOKIE = "wz_portal";
const STATE_COOKIE = "wz_portal_state";
const SESSION_DAYS = 30;
const SCOPE = "openid profile email offline_access data:read elements:read elements:run";
/** How long a sign-in may take, and a hand-over to the team's host. */
const STATE_MS = 15 * 60_000;
const HANDOVER_MS = 60_000;
/** A token is renewed this long before it runs out. */
const RENEW_MS = 60_000;

export interface Session {
  access: string;
  refresh: string | null;
  /** When the access token runs out, in ms. */
  exp: number;
  userId: string;
  tenantId: string;
  role: string;
  name: string;
  email: string;
}

interface SignInState {
  verifier: string;
  nonce: string;
  /** The team's host the sign-in started on, with its scheme. */
  origin: string;
  returnTo: string;
  exp: number;
}

interface Handover {
  session: Session;
  nonce: string;
  returnTo: string;
  exp: number;
}

/** The origin a request came to, as the proxy in front says. */
export function originOf(c: Context): string {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host");
  return `${proto}://${host}`;
}

const secureFor = (origin: string) => origin.startsWith("https:");
/** Only an address of the portal itself: never another site. */
const safeReturn = (to: string | undefined) =>
  to && /^\/portal(\/[A-Za-z0-9._~%-]*)*\/?$/.test(to) ? to : "/portal";

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

let discovered: { at: number; value: Discovery } | null = null;

async function discovery(): Promise<Discovery> {
  if (discovered && Date.now() - discovered.at < 3600_000) {
    return discovered.value;
  }
  const res = await fetch(`${env.manageUrl}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Manage-App discovery failed: ${res.status}`);
  }
  discovered = { at: Date.now(), value: (await res.json()) as Discovery };
  return discovered.value;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const { token_endpoint } = await discovery();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(
        `${encodeURIComponent(env.clientId)}:${encodeURIComponent(env.clientSecret)}`,
      ).toString("base64")}`,
    },
    body: new URLSearchParams({ ...body, resource: env.runtimeUrl }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`token request failed: ${res.status}`);
  }
  return (await res.json()) as Tokens;
}

/**
 * The session the tokens make. The claims are read, not checked: the runtime checks the token
 * on every call; the portal only shows who is signed in.
 */
function sessionFromTokens(tokens: Tokens, refresh: string | null): Session {
  const payload = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}",
  ) as Record<string, unknown>;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? refresh,
    exp: Number(payload.exp ?? 0) * 1000,
    userId: String(payload.sub ?? ""),
    tenantId: String(payload.tenant ?? ""),
    role: String(payload.role ?? ""),
    name: String(payload.name ?? ""),
    email: String(payload.email ?? ""),
  };
}

function keepSession(c: Context, session: Session) {
  setCookie(c, SESSION_COOKIE, seal(env.secret, session), {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureFor(originOf(c)),
    path: "/portal",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export function signOut(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/portal" });
}

/** The signed-in session, renewed when its token is about to run out; null when there is none. */
export async function currentSession(c: Context): Promise<Session | null> {
  const session = unseal<Session>(env.secret, getCookie(c, SESSION_COOKIE));
  if (!session) {
    return null;
  }
  if (session.exp - RENEW_MS > Date.now()) {
    return session;
  }
  if (!session.refresh) {
    signOut(c);
    return null;
  }
  try {
    const renewed = sessionFromTokens(
      await tokenRequest({ grant_type: "refresh_token", refresh_token: session.refresh }),
      session.refresh,
    );
    keepSession(c, renewed);
    return renewed;
  } catch {
    signOut(c);
    return null;
  }
}

/** Starts the sign-in on the team's host: to the Manage-App, for the host's organization. */
export async function startSignIn(c: Context, organization: string | null): Promise<Response> {
  const verifier = randomBytes(32).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const origin = originOf(c);
  const state: SignInState = {
    verifier,
    nonce,
    origin,
    returnTo: safeReturn(c.req.query("return")),
    exp: Date.now() + STATE_MS,
  };
  setCookie(c, STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureFor(origin),
    path: "/portal/auth",
    maxAge: STATE_MS / 1000,
  });
  const url = new URL((await discovery()).authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.clientId,
    redirect_uri: `${env.portalUrl}/portal/auth/callback`,
    scope: SCOPE,
    resource: env.runtimeUrl,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: seal(env.secret, state),
  }).toString();
  // The team of the host: a person in several organizations gets this one's token.
  if (organization && /^[A-Za-z0-9_-]{1,100}$/.test(organization)) {
    url.searchParams.set("organization", organization);
  }
  return c.redirect(url.toString());
}

/** The sign-in comes back to the portal's origin: tokens for the code, then to the team's host. */
export async function finishSignIn(c: Context): Promise<Response> {
  const state = unseal<SignInState>(env.secret, c.req.query("state"));
  const code = c.req.query("code");
  if (!state || state.exp < Date.now() || !code) {
    return c.redirect(`${state?.origin ?? ""}/portal?signin=failed`);
  }
  try {
    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.portalUrl}/portal/auth/callback`,
      code_verifier: state.verifier,
    });
    const handover: Handover = {
      session: sessionFromTokens(tokens, null),
      nonce: state.nonce,
      returnTo: state.returnTo,
      exp: Date.now() + HANDOVER_MS,
    };
    const next = new URL(`${state.origin}/portal/auth/finish`);
    next.searchParams.set("h", seal(env.secret, handover));
    return c.redirect(next.toString());
  } catch (err) {
    console.error("[portal] sign-in failed:", (err as Error).message);
    return c.redirect(`${state.origin}/portal?signin=failed`);
  }
}

/** On the team's host: the session from the hand-over, for the browser that started it. */
export function takeHandover(c: Context): Response {
  const handover = unseal<Handover>(env.secret, c.req.query("h"));
  const nonce = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/portal/auth" });
  if (!handover || handover.exp < Date.now() || !nonce || nonce !== handover.nonce) {
    return c.redirect("/portal?signin=failed");
  }
  keepSession(c, handover.session);
  return c.redirect(safeReturn(handover.returnTo));
}
