import { Hono } from "hono";
import { z } from "zod";
import { LOCAL_MCP_HEADER, localTicketExpiry } from "../auth/local-ticket.js";
import { logs, ReportError, sendReport, status } from "../debug.js";
import { env } from "../env.js";
import { tailQuery } from "../log.js";
import { managed } from "../manage.js";

/**
 * A runtime that runs alone answers its own command line here (`wizards logs`, `wizards
 * report`): each request signed with the data folder's secret, as `wizards mcp` signs its own.
 * Nothing of this is reached from another machine; the account hears from an install only when
 * the person sends a report.
 */
export const localDebugRoutes = new Hono()
  .use(async (c, next) => {
    const ticket = c.req.header(LOCAL_MCP_HEADER) ?? "";
    if (managed || !localTicketExpiry(env.authSecret, ticket, Date.now(), "local-debug")) {
      return c.json({ error: "This ticket isn’t valid.", code: "unauthorized" }, 401);
    }
    await next();
  })
  .get("/status", async (c) => c.json(await status()))
  .get("/logs", (c) => c.json(logs(tailQuery((key) => c.req.query(key)))))
  .post("/report", async (c) => {
    try {
      return c.json(await sendReport());
    } catch (err) {
      if (err instanceof ReportError) {
        return c.json(
          { error: err.message, code: err.code },
          err.code === "no_account" ? 409 : 502,
        );
      }
      throw err;
    }
  });

/** What a page reports about itself: an error it met, with where it stood. */
export const browserReport = z.object({
  level: z.enum(["error", "warn"]).default("error"),
  message: z.string().min(1).max(2000),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  agent: z.string().max(300).optional(),
});
