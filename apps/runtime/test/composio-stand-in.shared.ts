import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Composio's v3 API and for the Manage-App's pass-through (`/v1/connect/composio/*`),
 * shaped as docs/plans/composio.md proposes. No real key, no real account: the key it takes is
 * `test-composio-key`, the accounts are made up here.
 */

export const STAND_IN_KEY = "test-composio-key";

export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: any;
}

export interface StandIn {
  origin: string;
  seen: Seen[];
  /** Connected accounts as Composio holds them. */
  accounts: Map<string, { user_id: string; toolkit: string; status: string }>;
  /** What each call's answer is, where a test wants another. */
  answer: { execute?: (body: any) => { status: number; body: unknown; headers?: Record<string, string> } };
  /** Whether `GET /v1/connect` says `composio: true`. */
  offers: { composio: boolean };
  close(): Promise<void>;
}

const TOOLKITS = [
  {
    slug: "gmail",
    name: "Gmail",
    meta: { description: "Mail from Google.", logo: "https://logos.test/gmail.svg", categories: [{ name: "mail" }] },
    composio_managed_auth_schemes: ["OAUTH2"],
  },
  {
    slug: "notion",
    name: "Notion",
    meta: { description: "Pages and databases.", logo: null, categories: [] },
    composio_managed_auth_schemes: ["OAUTH2"],
  },
  // Composio has no app of its own for it: an auth config of one's own would be needed.
  { slug: "custom-crm", name: "Custom CRM", meta: { description: "" }, composio_managed_auth_schemes: [] },
];

const TOOLS: Record<string, unknown[]> = {
  gmail: [
    {
      slug: "GMAIL_FETCH_EMAILS",
      name: "Fetch emails",
      description: "Reads mails of the inbox.",
      input_parameters: { type: "object", properties: { query: { type: "string" } } },
      tags: ["readOnlyHint", "important"],
    },
    {
      slug: "GMAIL_SEND_EMAIL",
      name: "Send email",
      description: "Sends a mail.",
      input_parameters: {
        type: "object",
        properties: { recipient_email: { type: "string" }, body: { type: "string" } },
        required: ["recipient_email"],
      },
      tags: [],
    },
    {
      slug: "GMAIL_CREATE_EMAIL_DRAFT",
      name: "Create email draft",
      description: "Keeps a draft.",
      input_parameters: { type: "object", properties: { body: { type: "string" } } },
      tags: [],
    },
    {
      slug: "GMAIL_DELETE_MESSAGE",
      name: "Delete message",
      description: "Deletes a mail for good.",
      input_parameters: { type: "object", properties: { message_id: { type: "string" } } },
      tags: [],
    },
  ],
  notion: [],
};

function json(res: import("node:http").ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startComposioStandIn(): Promise<StandIn> {
  const seen: Seen[] = [];
  const accounts: StandIn["accounts"] = new Map();
  const answer: StandIn["answer"] = {};
  const offers = { composio: true };
  const authConfigs = new Map<string, string>();
  let next = 1;
  let origin = "";
  const tickets = new Map<string, { connectedAccountId: string }>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    const body = raw ? JSON.parse(raw) : null;
    seen.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { authorization: req.headers.authorization, "x-api-key": req.headers["x-api-key"] as string | undefined },
      body,
    });
    const p = url.pathname;

    // --- the linked account's sign-in (auth/account.ts asks for it) ---------------------------
    if (p === "/.well-known/openid-configuration") {
      return json(res, { issuer: origin, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` });
    }

    // --- the Manage-App's pass-through ------------------------------------------------------
    if (p === "/v1/connect") {
      return json(res, { google: false, composio: offers.composio });
    }
    if (p.startsWith("/v1/connect/composio/")) {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        return json(res, { error: "no token", code: "unauthorized" }, 401);
      }
      const rest = p.slice("/v1/connect/composio".length);
      if (rest === "/toolkits") {
        const slug = url.searchParams.get("slug");
        if (slug) {
          const toolkit = TOOLKITS.find((t) => t.slug === slug);
          return json(res, {
            toolkit: toolkit
              ? { slug: toolkit.slug, name: toolkit.name, description: toolkit.meta.description, logo: null, categories: [], managed: true }
              : null,
            tools: (TOOLS[slug] ?? []).map((t: any) => ({ ...t, input: t.input_parameters })),
          });
        }
        return json(res, {
          toolkits: TOOLKITS.map((t) => ({
            slug: t.slug,
            name: t.name,
            description: t.meta.description,
            logo: null,
            categories: [],
            managed: t.composio_managed_auth_schemes.length > 0,
          })),
        });
      }
      if (rest === "/start") {
        const id = `ca_manage_${next++}`;
        accounts.set(id, { user_id: body.holder, toolkit: body.toolkit, status: "ACTIVE" });
        const ticket = `ticket-${id}`;
        tickets.set(ticket, { connectedAccountId: id });
        const back = new URL(body.returnUrl);
        back.searchParams.set("state", body.state);
        back.searchParams.set("ticket", ticket);
        return json(res, { url: `https://connect.composio.test/sign-in?next=${encodeURIComponent(back.href)}` });
      }
      if (rest === "/complete") {
        const found = tickets.get(body.ticket);
        return found ? json(res, found) : json(res, { error: "unknown ticket", code: "invalid_ticket" }, 400);
      }
      if (rest === "/execute") {
        if (answer.execute) {
          const a = answer.execute(body);
          return json(res, a.body, a.status, a.headers);
        }
        return accounts.has(body.connectedAccountId)
          ? json(res, { successful: true, data: { ran: body.tool, input: body.input } })
          : json(res, { error: "not this tenant's account", code: "forbidden" }, 403);
      }
      const gone = /^\/accounts\/(.+)$/.exec(rest);
      if (gone && req.method === "DELETE") {
        return accounts.delete(decodeURIComponent(gone[1] ?? "")) ? json(res, { ok: true }) : json(res, { error: "gone" }, 404);
      }
      return json(res, { error: "not found" }, 404);
    }

    // --- Composio's own API -------------------------------------------------------------------
    if (!p.startsWith("/api/v3/")) {
      return json(res, { error: "not found" }, 404);
    }
    if (req.headers["x-api-key"] !== STAND_IN_KEY) {
      return json(res, { error: { message: "invalid api key" } }, 401);
    }
    const v3 = p.slice("/api/v3".length);
    if (v3 === "/toolkits") {
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return json(res, { items: TOOLKITS.filter((t) => !q || t.name.toLowerCase().includes(q)) });
    }
    const toolkit = /^\/toolkits\/([^/]+)$/.exec(v3);
    if (toolkit) {
      const found = TOOLKITS.find((t) => t.slug === toolkit[1]);
      return found ? json(res, found) : json(res, { error: { message: "toolkit not found" } }, 404);
    }
    if (v3 === "/tools") {
      return json(res, { items: TOOLS[url.searchParams.get("toolkit_slug") ?? ""] ?? [] });
    }
    if (v3 === "/auth_configs" && req.method === "GET") {
      const id = authConfigs.get(url.searchParams.get("toolkit_slug") ?? "");
      return json(res, { items: id ? [{ id, is_composio_managed: true }] : [] });
    }
    if (v3 === "/auth_configs" && req.method === "POST") {
      const id = `ac_${next++}`;
      authConfigs.set(body.toolkit.slug, id);
      return json(res, { auth_config: { id }, toolkit: { slug: body.toolkit.slug } });
    }
    if (v3 === "/connected_accounts/link") {
      const id = `ca_own_${next++}`;
      const slug = [...authConfigs].find(([, v]) => v === body.auth_config_id)?.[0] ?? "";
      accounts.set(id, { user_id: body.user_id, toolkit: slug, status: "ACTIVE" });
      const back = new URL(body.callback_url);
      back.searchParams.set("status", "success");
      back.searchParams.set("connected_account_id", id);
      return json(res, {
        redirect_url: `https://connect.composio.test/link?next=${encodeURIComponent(back.href)}`,
        connected_account_id: id,
      });
    }
    const account = /^\/connected_accounts\/([^/]+)$/.exec(v3);
    if (account) {
      const id = decodeURIComponent(account[1] ?? "");
      const found = accounts.get(id);
      if (req.method === "DELETE") {
        return found && accounts.delete(id) ? json(res, { success: true }) : json(res, { error: { message: "gone" } }, 404);
      }
      return found
        ? json(res, { id, user_id: found.user_id, status: found.status, toolkit: { slug: found.toolkit } })
        : json(res, { error: { message: "not found" } }, 404);
    }
    const execute = /^\/tools\/execute\/([^/]+)$/.exec(v3);
    if (execute) {
      if (answer.execute) {
        const a = answer.execute(body);
        return json(res, a.body, a.status, a.headers);
      }
      const found = accounts.get(body.connected_account_id);
      if (!found || found.user_id !== body.user_id) {
        return json(res, { successful: false, error: "Connected account not found", data: null });
      }
      return json(res, { successful: true, error: null, data: { ran: execute[1], input: body.arguments } });
    }
    return json(res, { error: "not found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    accounts,
    answer,
    offers,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
