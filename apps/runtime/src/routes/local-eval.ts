import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { LOCAL_MCP_HEADER, localTicketExpiry } from "../auth/local-ticket.js";
import { withTenant } from "../db/client.js";
import { env } from "../env.js";
import { managed } from "../manage.js";
import { ServiceError } from "../services/errors.js";
import { datasetSchema, evalDataset, wizardNamed } from "../services/evals.js";
import { LOCAL_TENANT } from "../tenants/tenant.js";

/**
 * `wizards eval <wizard> --dataset <file>` on a runtime that runs alone (services/evals.ts),
 * signed with the data folder's secret as `wizards logs` signs its requests. The answer is a
 * line of JSON for each entry once it is judged, a line now and then while one works, and the
 * summary last, so a long dataset keeps the connection open.
 */
const KEEP_ALIVE_MS = 20_000;

export const localEvalRoutes = new Hono()
  .use(async (c, next) => {
    const ticket = c.req.header(LOCAL_MCP_HEADER) ?? "";
    if (managed || !localTicketExpiry(env.authSecret, ticket, Date.now(), "local-eval")) {
      return c.json({ error: "This ticket isn’t valid.", code: "unauthorized" }, 401);
    }
    await next();
  })
  .post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wizard?: unknown; dataset?: unknown };
    const dataset = datasetSchema.safeParse(body.dataset);
    if (typeof body.wizard !== "string" || !dataset.success) {
      return c.json(
        {
          error: dataset.success
            ? "Name the wizard."
            : `The dataset doesn’t fit: ${dataset.error.issues[0]?.path.join(".") || "file"}: ${dataset.error.issues[0]?.message}`,
          code: "invalid",
        },
        400,
      );
    }
    const named = body.wizard;
    const wizard = await withTenant(LOCAL_TENANT, () => wizardNamed("local", named)).catch(
      () => null,
    );
    if (!wizard) {
      return c.json({ error: `There is no wizard “${named}” here.`, code: "not_found" }, 404);
    }
    const signal = c.req.raw.signal;
    return streamText(c, async (stream) => {
      const write = (line: unknown) => stream.write(`${JSON.stringify(line)}\n`);
      const alive = setInterval(() => void write({ working: true }), KEEP_ALIVE_MS);
      try {
        const done = await withTenant(LOCAL_TENANT, () =>
          evalDataset("local", wizard.id, dataset.data, signal, async (entry) => {
            await write({ entry });
          }),
        );
        await write({ summary: done.summary });
      } catch (err) {
        await write(
          err instanceof ServiceError
            ? err.toJSON()
            : { error: err instanceof Error ? err.message : String(err) },
        );
      } finally {
        clearInterval(alive);
      }
    });
  });
