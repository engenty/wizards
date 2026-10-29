import {
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { withTenant } from "../db/client.js";
import { env } from "../env.js";
import { feature } from "../features.js";
import { nudge } from "../live/hub.js";
import { tenantInfo } from "../manage.js";
import { prompt } from "../prompts.js";
import { asRole } from "../services/access.js";
import { tenantStatus } from "../tenants/control.js";
import { serverText } from "../texts.js";
import { authenticate, type Principal, principalOf } from "./auth.js";
import { registerFlowApp } from "./flow-app.js";
import { appKind, clientNameOf, noteChecked, noteRequest } from "./seen.js";
import { registerPrompts, registerTools } from "./tools.js";

/**
 * An app the organization's model policy keeps out of its spaces (`modelPolicy.apps`): its tool
 * calls are answered with a tool error the app shows, before any tool reads the space. Calls of
 * other kinds (listing the tools) go on. Behind `modelTiers`.
 */
async function appRefusal(who: Principal, client: string, body: unknown): Promise<Response | null> {
  const calls = (Array.isArray(body) ? body : [body]).filter(
    (m): m is { id?: unknown; method?: string } =>
      Boolean(m) && typeof m === "object" && (m as { method?: string }).method === "tools/call",
  );
  if (!calls.length) {
    return null;
  }
  const info = await tenantInfo(who.tenantId).catch(() => null);
  const policy = info && feature("modelTiers", info.features) ? info.modelPolicy : undefined;
  if (!info || !policy) {
    return null;
  }
  const kind = appKind(client);
  const allowed = kind === "local" ? policy.apps.local : policy.apps.subscriptions;
  noteChecked(who.tenantId, client, who.name ?? who.email ?? null, allowed);
  if (allowed) {
    return null;
  }
  const text =
    kind === "local"
      ? serverText("en", "appLocalRefused", { organization: info.name, app: client })
      : serverText("en", "appSubscriptionRefused", {
          organization: info.name,
          app: client,
          tier: info.tier?.name ?? serverText("en", "appYourTier"),
        });
  const answers = calls.map((call) => ({
    jsonrpc: "2.0",
    id: call.id ?? null,
    result: { content: [{ type: "text", text }], isError: true },
  }));
  return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A wizard definition is a few KB; this leaves room and refuses anything far beyond it. */
const MAX_BODY_BYTES = 300_000;

/**
 * Streamable HTTP MCP endpoint, stateless: every request authenticates — with an access token of
 * the Manage-App or an API key — and gets a fresh server whose tools act as that admin, in the
 * tenant the token or key names.
 */
export function mcpHandler(): (request: Request) => Promise<Response> {
  const allowedHosts = [new URL(env.appUrl).hostname, "localhost", "127.0.0.1"];
  const handler = createMcpHandler(
    (ctx) => {
      const server = new McpServer(
        { name: "engenty-wizards", version: "0.1.0" },
        {
          instructions: prompt("mcp", "instructions"),
          capabilities: { tools: {}, prompts: {}, resources: {} },
        },
      );
      const who = principalOf(ctx.authInfo!);
      registerTools(server, who);
      registerPrompts(server);
      registerFlowApp(server);
      return server;
    },
    { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES },
  );

  return async (request) => {
    const rejected = originValidationResponse(request, allowedHosts);
    if (rejected) {
      return rejected;
    }
    const authInfo = await authenticate(request);
    if (authInfo instanceof Response) {
      return authInfo;
    }
    const who = principalOf(authInfo);
    if ((await tenantStatus(who.tenantId)) === "suspended") {
      return new Response(
        JSON.stringify({ error: "This account is suspended.", code: "tenant_suspended" }),
        { status: 403 },
      );
    }
    if (request.method === "POST") {
      const body = await request
        .clone()
        .json()
        .catch(() => null);
      noteRequest(who.tenantId, authInfo.clientId, who.client, body);
      const refused = await appRefusal(who, clientNameOf(authInfo.clientId, who.client), body);
      if (refused) {
        return refused;
      }
    }
    const answer = await withTenant(who.tenantId, () =>
      asRole(who.role, () => handler.fetch(request, { authInfo })),
    );
    if (request.method === "POST") {
      nudge(who.tenantId);
    }
    return answer;
  };
}
