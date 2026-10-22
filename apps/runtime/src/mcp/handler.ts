import {
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { withTenant } from "../db/client.js";
import { env } from "../env.js";
import { nudge } from "../live/hub.js";
import { prompt } from "../prompts.js";
import { asRole } from "../services/access.js";
import { tenantStatus } from "../tenants/control.js";
import { authenticate, principalOf } from "./auth.js";
import { registerFlowApp } from "./flow-app.js";
import { noteRequest } from "./seen.js";
import { registerPrompts, registerTools } from "./tools.js";

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
