import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { eq, lt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { control, controlDb, withTenant } from "../db/client.js";
import { basePath, env } from "../env.js";
import {
  discovery,
  managed,
  type Role,
  type TokenSet,
  tokenRequest,
  verifyToken,
} from "../manage.js";
import { refreshPro } from "../plugins/pro.js";
import { seal, unseal } from "../secrets/crypto.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";
import { finishLink } from "./account.js";
import { localTicketExpiry } from "./local-ticket.js";

/** Who a studio request acts as: a person, in exactly one tenant. */
export interface Principal {
  id: string;
  tenantId: string;
  role: Role;
  name: string;
  email: string;
  image?: string | null;
}
export type SessionUser = Principal;

const secure = env.appUrl.startsWith("https");

// --- a runtime that runs alone ------------------------------------------------
// One person, one tenant. The studio answers only with a cookie that is set by opening the
// one-time link once: a web page in the same browser cannot reach it.

const LOCAL_COOKIE = "wz_local";
const localCookieValue = createHmac("sha256", env.authSecret).update("local-studio").digest("hex");

let accessKey: string | null = managed
  ? null
  : env.local.accessKey || randomBytes(24).toString("hex");

/** The link that lets the person in; printed at start, opened by the desktop app. */
export function localEntryUrl(): string | null {
  return accessKey ? `${env.appUrl}/api/local/enter?k=${accessKey}` : null;
}

/** Sends everything published here to the cloud of the account that was just linked. */
async function firstSync(): Promise<void> {
  try {
    // Loaded here: the services read the session this module makes.
    const { syncAllToCloud } = await import("../services/cloud.js");
    await withTenant(LOCAL_TENANT, () => syncAllToCloud(localUser().id));
  } catch (err) {
    console.error("[cloud] first sync failed:", err);
  }
}

const localUser = (): Principal => ({
  id: "local",
  tenantId: LOCAL_TENANT,
  role: "owner",
  name: userInfo().username || "Admin",
  email: "",
});

function sameValue(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function setLocalCookie(c: Context) {
  setCookie(c, LOCAL_COOKIE, localCookieValue, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: cookiePath,
    maxAge: 60 * 60 * 24 * 365,
  });
}

// --- signed in at the Manage-App ------------------------------------------------

const SESSION_COOKIE = "wz_session";
/** How much of a wish goes along to the account's sign-in page. */
const WISH_MAX = 600;
const STATE_COOKIE = "wz_oauth";
const SESSION_DAYS = 30;
const SCOPE =
  "openid profile email offline_access wizards:read wizards:write wizards:publish runs:test";

interface LoginState {
  verifier: string;
  nonce: string;
  returnTo: string;
  exp: number;
  /** Set when the desktop app's window started this sign-in in the person's own browser. */
  desktop?: string;
}

// The desktop app shows a server in its window but signs in through the system browser
// (Google refuses embedded views). The finished session travels back as a one-time code in an
// `engenty-wizards://` link; it only counts in the window that asked for it, which holds the
// matching cookie — so a link sent by some web page signs nobody in.
const DESKTOP_COOKIE = "wz_desktop";
interface Handoff {
  sid: string;
  desktop: string;
  exp: number;
}
const usedHandoffs = new Set<string>();
/** Tickets of the local one-time link that were opened, until they run out. */
const usedTickets = new Map<string, number>();

type SessionRow = typeof control.session.$inferSelect;
const sessions = new Map<string, { at: number; row: SessionRow }>();

const client = () => ({ id: env.manage.clientId, secret: env.manage.clientSecret || undefined });
/** Cookies and redirects stay under the path the app is served at. */
const cookiePath = basePath || "/";
/** Where a sign-in and the local link lead: the studio. */
const home = `${basePath}/studio/`;

const callbackUrl = () => `${env.appUrl}/api/auth/callback`;

function safeReturn(path: string | undefined): string {
  return path?.startsWith("/") && !path.startsWith("//") ? path : home;
}

function setSessionCookie(c: Context, id: string) {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: cookiePath,
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

async function claimsOf(tokens: TokenSet) {
  const claims = await verifyToken(tokens.access_token, [env.appUrl]);
  if (!claims) {
    throw new Error("The Manage-App's token did not verify.");
  }
  return claims;
}

/** Renews tenant and role from the Manage-App once the access token they came from has run out. */
async function renew(row: SessionRow): Promise<SessionRow | null> {
  const refresh = row.refreshToken ? unseal<string>(row.refreshToken) : null;
  if (!refresh) {
    return null;
  }
  try {
    const tokens = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: refresh, resource: env.appUrl },
      client(),
    );
    const claims = await claimsOf(tokens);
    const next: SessionRow = {
      ...row,
      tenantId: claims.tenantId,
      role: claims.role,
      name: claims.name || row.name,
      email: claims.email || row.email,
      refreshToken: tokens.refresh_token ? seal(tokens.refresh_token) : row.refreshToken,
      claimsExpireAt: new Date(claims.expiresAt),
    };
    await controlDb.update(control.session).set(next).where(eq(control.session.id, row.id));
    return next;
  } catch {
    return null;
  }
}

async function sessionPrincipal(id: string): Promise<Principal | null> {
  const hit = sessions.get(id);
  let row =
    hit && Date.now() - hit.at < 60_000
      ? hit.row
      : await controlDb.query.session.findFirst({ where: eq(control.session.id, id) });
  if (!row || row.expiresAt.getTime() < Date.now()) {
    sessions.delete(id);
    return null;
  }
  if (row.claimsExpireAt.getTime() < Date.now()) {
    const renewed = await renew(row);
    if (!renewed) {
      await controlDb.delete(control.session).where(eq(control.session.id, id));
      sessions.delete(id);
      return null;
    }
    row = renewed;
  }
  sessions.set(id, { at: Date.now(), row });
  return {
    id: row.userId,
    tenantId: row.tenantId,
    role: row.role as Role,
    name: row.name,
    email: row.email,
    image: row.image,
  };
}

/** Sessions that ran out go once an hour, with the retention job. */
export async function purgeSessions() {
  await controlDb.delete(control.session).where(lt(control.session.expiresAt, new Date()));
}

// --- both ------------------------------------------------------------------------

export async function principalOf(c: Context): Promise<Principal | null> {
  if (!managed) {
    const cookie = getCookie(c, LOCAL_COOKIE);
    return cookie && sameValue(cookie, localCookieValue) ? localUser() : null;
  }
  const id = getCookie(c, SESSION_COOKIE);
  return id ? sessionPrincipal(id) : null;
}

const closePage = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>engenty wizards</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333">
<p>${message}</p>`;

export const authRoutes = new Hono()
  // Local: the one-time link. The key works once per start; a ticket (`wizards open`,
  // the desktop app entering a runtime that already runs) once within its minute.
  .get("/local/enter", (c) => {
    const given = c.req.query("k") ?? "";
    const ticket = c.req.query("t") ?? "";
    const now = Date.now();
    for (const [used, expires] of usedTickets) {
      if (expires <= now) {
        usedTickets.delete(used);
      }
    }
    const expires =
      !managed && ticket && !usedTickets.has(ticket)
        ? localTicketExpiry(env.authSecret, ticket, now)
        : null;
    if (expires) {
      usedTickets.set(ticket, expires);
    } else if (managed || !accessKey || !sameValue(given, accessKey)) {
      return c.text("This link is no longer valid. Run wizards open to get a new one.", 403);
    } else {
      accessKey = null;
    }
    setLocalCookie(c);
    return c.redirect(home);
  })
  // Local development only: the "Dev-Login" button.
  .post("/dev/login", (c) => {
    if (managed || !env.devLogin) {
      return c.notFound();
    }
    setLocalCookie(c);
    return c.json({ ok: true });
  })
  // The desktop app's window asks for a sign-in that will run in the system browser.
  .post("/auth/desktop/start", (c) => {
    if (!managed) {
      return c.notFound();
    }
    const desktop = randomBytes(24).toString("base64url");
    setCookie(c, DESKTOP_COOKIE, desktop, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: `${basePath}/api/auth`,
      maxAge: 900,
    });
    const ticket = seal({ desktop, exp: Date.now() + 15 * 60_000 });
    return c.json({ url: `${env.appUrl}/api/auth/login?desktop=${encodeURIComponent(ticket)}` });
  })
  .get("/auth/handoff", async (c) => {
    const code = c.req.query("code") ?? "";
    const handoff = unseal<Handoff>(code);
    const desktop = getCookie(c, DESKTOP_COOKIE);
    deleteCookie(c, DESKTOP_COOKIE, { path: `${basePath}/api/auth` });
    if (
      !managed ||
      !handoff ||
      handoff.exp < Date.now() ||
      !desktop ||
      !sameValue(desktop, handoff.desktop) ||
      usedHandoffs.has(handoff.sid)
    ) {
      return c.redirect(`${home}?signin=failed`);
    }
    usedHandoffs.add(handoff.sid);
    setSessionCookie(c, handoff.sid);
    return c.redirect(home);
  })
  .get("/auth/login", async (c) => {
    if (!managed) {
      return c.notFound();
    }
    const d = await discovery();
    const verifier = randomBytes(32).toString("base64url");
    const ticket = unseal<{ desktop: string; exp: number }>(c.req.query("desktop") ?? "");
    const state: LoginState = {
      verifier,
      nonce: nanoid(16),
      returnTo: safeReturn(c.req.query("return")),
      exp: Date.now() + 15 * 60_000,
      ...(ticket && ticket.exp > Date.now() ? { desktop: ticket.desktop } : {}),
    };
    setCookie(c, STATE_COOKIE, seal(state), {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: `${basePath}/api/auth`,
      maxAge: 900,
    });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: env.manage.clientId,
      redirect_uri: callbackUrl(),
      scope: SCOPE,
      resource: env.appUrl,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: state.nonce,
    }).toString();
    // What the person wants built (the studio's start page): the account's sign-in page shows it.
    const wish = (c.req.query("wish") ?? "").trim().slice(0, WISH_MAX);
    if (wish) {
      url.searchParams.set("wish", wish);
    }
    return c.redirect(url.toString());
  })
  .get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const rawState = c.req.query("state") ?? "";
    if (!managed) {
      // The linked account of a runtime that runs alone: the system browser lands here.
      if (!code) {
        return c.html(closePage("Sign-in cancelled. You can close this window."), 400);
      }
      try {
        await finishLink(code, rawState);
        // What is published here goes to the account's cloud, from now on and once for all there is.
        void firstSync();
        // The Pro modules the account's plan includes.
        void refreshPro();
        return c.html(closePage("Signed in. You can close this window."));
      } catch (err) {
        console.error("[account]", err);
        return c.html(closePage("The sign-in didn’t work. Try again."), 400);
      }
    }
    const state = unseal<LoginState>(getCookie(c, STATE_COOKIE) ?? "");
    deleteCookie(c, STATE_COOKIE, { path: `${basePath}/api/auth` });
    if (!code || !state || state.exp < Date.now() || state.nonce !== rawState) {
      return c.redirect(`${home}?signin=failed`);
    }
    try {
      const tokens = await tokenRequest(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl(),
          code_verifier: state.verifier,
          resource: env.appUrl,
        },
        client(),
      );
      const claims = await claimsOf(tokens);
      const id = randomBytes(32).toString("base64url");
      await controlDb.insert(control.session).values({
        id,
        userId: claims.userId,
        tenantId: claims.tenantId,
        role: claims.role,
        name: claims.name || claims.email,
        email: claims.email,
        refreshToken: tokens.refresh_token ? seal(tokens.refresh_token) : null,
        claimsExpireAt: new Date(claims.expiresAt),
        expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 3600_000),
      });
      if (state.desktop) {
        // The session belongs to the app's window, not to this browser.
        const code = seal({
          sid: id,
          desktop: state.desktop,
          exp: Date.now() + 2 * 60_000,
        } satisfies Handoff);
        const link = `engenty-wizards://signin?code=${encodeURIComponent(code)}`;
        return c.html(
          `${closePage("Signed in. Go back to engenty wizards now.")}
<script>location.href = ${JSON.stringify(link)};</script>`,
        );
      }
      setSessionCookie(c, id);
      return c.redirect(state.returnTo);
    } catch (err) {
      console.error("[sign-in]", err);
      return c.redirect(`${home}?signin=failed`);
    }
  })
  .post("/auth/sign-out", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) {
      await controlDb.delete(control.session).where(eq(control.session.id, id));
      sessions.delete(id);
    }
    deleteCookie(c, SESSION_COOKIE, { path: cookiePath });
    deleteCookie(c, LOCAL_COOKIE, { path: cookiePath });
    if (!managed) {
      return c.json({ ok: true });
    }
    // The person signs out of the account too (the Manage-App's `/api/sign-out`, a form the page
    // sends there): still signed in there, the sign-in page would sign them in again at once.
    const d = await discovery().catch(() => null);
    return c.json({ ok: true, account: d ? new URL("/api/sign-out", d.issuer).toString() : null });
  });
