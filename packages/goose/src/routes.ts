import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Goose } from "./goose.js";
import type { Person } from "./tool.js";

const TurnBody = z.object({
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
  message: z.string().min(1),
  page: z
    .object({
      path: z.string().optional(),
      text: z.string().optional(),
      selection: z.string().optional(),
    })
    .optional(),
});

export interface GooseRoutesOptions {
  /** Who asks; by default the `person` the host's auth middleware set. None: 401. */
  person?: (c: Context) => Person | null | undefined;
}

/**
 * `POST /turn` with `{ history, message, page }`: the answer as server-sent events (`text`,
 * `step`, `action`, then `done` or `error`). Mount it where the host wants it, behind its auth.
 */
export function gooseRoutes(goose: Goose, o: GooseRoutesOptions = {}) {
  const app = new Hono<{ Variables: { person?: Person } }>();

  app.post("/turn", async (c) => {
    const person = o.person ? o.person(c) : c.get("person");
    if (!person) {
      return c.json({ error: "unauthorized", message: "Sign in to ask Goose." }, 401);
    }
    if (!goose.chat()) {
      return c.json({ error: "goose_off", message: goose.texts.off }, 503);
    }
    const body = TurnBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid", message: z.prettifyError(body.error) }, 400);
    }
    return streamSSE(c, async (sse) => {
      const abort = new AbortController();
      sse.onAbort(() => abort.abort());
      await goose.turn(body.data, {
        person,
        signal: abort.signal,
        emit: (e) => sse.writeSSE({ event: e.event, data: JSON.stringify(e.data) }),
      });
    });
  });

  return app;
}
