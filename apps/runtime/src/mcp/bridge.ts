import { type Bridge, Bridges } from "@engenty/model-providers/bridge";
import { env } from "../env.js";

/**
 * The tools of one model call, served over MCP to the AI client installed on this machine while
 * it answers that call (@engenty/model-providers/bridge). A bridge lives as long as the call: it
 * opens with it, is reached through a random path on the loopback address, and closes with it.
 * Nothing but this process knows the path; the client works through the tools itself and comes
 * back with the answer.
 */

const bridges = new Bridges({ name: "step" });

/** Opens a call's tools; the client reaches them at the URL until `close`. */
export const openBridge: Bridge = (tools) =>
  bridges.at(`http://127.0.0.1:${env.port}/api/mcp/bridge`)(tools);

/** Answers an MCP request of an open bridge; a closed or unknown one is not found. */
export function bridgeRequest(token: string, request: Request): Promise<Response> {
  return bridges.fetch(request, token);
}
