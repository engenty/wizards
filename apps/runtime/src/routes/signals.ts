import { createHmac, timingSafeEqual } from "node:crypto";
import { signalNameOpen, signalNameSchema } from "@engenty/wizards-shared/definition";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db, schema, withTenant } from "../db/client.js";
import { SIGNAL_DATA_BYTES, sendSignal, signalKey, wizardScope } from "../engine/signals.js";
import { env } from "../env.js";
import { allowed } from "../limits.js";
import { unseal } from "../secrets/crypto.js";
import { dataTooLarge, signalMisfit, signalsOn } from "../services/signals.js";
import { tenantOfLink, tenantStatus } from "../tenants/control.js";
import { notFoundAnswer } from "./lang.js";
import { clientIp } from "./runs.js";

const HOUR = 3600_000;

/** An address is guessed from one place, or hammered with bad signatures: this many per token's limit. */
const IP_FACTOR = 5;

const bodySchema = z.object({
  name: signalNameSchema,
  key: z.string().min(1).max(500),
  data: z.record(z.string(), z.unknown()).optional(),
  delivery: z.string().min(1).max(200).optional(),
});

/** `x-wizards-signature: sha256=<hex>`: the HMAC of the raw body with the address's secret. */
function signedRight(secret: string, body: string, given: string | undefined) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const said = Buffer.from(given ?? "");
  return expected.length === said.length && timingSafeEqual(expected, said);
}

const misfit = (c: Context, error: string, more: Record<string, unknown> = {}) =>
  c.json({ error, code: "signal_misfit", ...more }, 422);

/**
 * Something from another service, for the runs that wait for it: `POST /api/public/signals/<token>`
 * with `{ name, key, data?, delivery? }`. The token belongs to one wizard and matches only its
 * runs. The signal is written, the runs go in line, and the sender has its answer before any step
 * runs. Nobody is signed in: the token names the wizard, and a secret if it has one proves it.
 */
export const signalRoutes = new Hono().post("/:token", async (c) => {
  const notFound = () => c.json(notFoundAnswer(c), 404);
  const tooMany = () =>
    c.json({ error: "Too many signals. Try later.", code: "too_many_tries" }, 429);
  const perHour = env.limits.signalsPerHour;
  if (!allowed(`signal-ip:${clientIp(c) ?? "?"}`, perHour * IP_FACTOR, HOUR)) {
    return tooMany();
  }
  const token = c.req.param("token");
  const tenantId = await tenantOfLink(token, "signal");
  if (!tenantId || (await tenantStatus(tenantId)) === "suspended") {
    return notFound();
  }
  return withTenant(tenantId, async () => {
    if (!(await signalsOn())) {
      return notFound();
    }
    const w = await db.query.wizard.findFirst({
      where: and(eq(schema.wizard.signalToken, token), eq(schema.wizard.tenantId, tenantId)),
    });
    if (!w) {
      return notFound();
    }
    const raw = await c.req.text();
    // Checked before the limit counts: a stranger with the address cannot use up the sender's.
    if (w.signalSecret) {
      const secret = unseal<string>(w.signalSecret);
      if (!(secret && signedRight(secret, raw, c.req.header("x-wizards-signature")))) {
        return c.json({ error: "The signature is not right.", code: "bad_signature" }, 401);
      }
    }
    if (!allowed(`signal:${token}`, perHour, HOUR)) {
      return tooMany();
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return misfit(c, "The body is not JSON.");
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return misfit(c, `${issue?.path.join(".") || "body"}: ${issue?.message}`);
    }
    const { name, key, data } = parsed.data;
    if (!(signalNameOpen(name) && signalKey(key))) {
      return misfit(c, `"${name}" with this key cannot be sent from outside.`);
    }
    if (dataTooLarge(data)) {
      return c.json(
        { error: `Data holds at most ${SIGNAL_DATA_BYTES} bytes.`, code: "too_large" },
        413,
      );
    }
    const off = await signalMisfit(w, name, data);
    if (off) {
      return misfit(c, "No wait of this wizard takes this.", off);
    }
    const sent = await sendSignal({
      spaceId: w.spaceId,
      scope: wizardScope(w.id),
      name,
      key,
      data,
      source: "route",
      delivery: parsed.data.delivery ?? c.req.header("idempotency-key"),
    });
    return c.json({ id: sent.id, runs: sent.runs });
  });
});
