import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { principalOf } from "../auth/index.js";
import { db, schema, withTenant } from "../db/client.js";
import { allowed, hashIp } from "../limits.js";
import { managed, postBugReport } from "../manage.js";
import { tenantOfRun } from "../tenants/control.js";
import { clientIp } from "./runs.js";

/**
 * "Report a problem" (docs/plans/wizards-admin.md in the Manage repository): what a person chose
 * to send from the run page or the studio – their words, a screenshot with their marks, the
 * error, the log lines – goes on to the Manage-App's bug reports. The dialog masked what was
 * typed into the wizard before it left the browser. A runtime that runs alone has nobody to
 * send it to: the report goes into its own log.
 */

const SCREENSHOT = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const line = (max: number) => z.string().trim().max(max);

export const bugReportBody = z.object({
  where: z.enum(["run", "studio", "page"]),
  url: z.string().url().max(2000),
  runId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable()
    .optional(),
  comment: line(4000).nullable().optional(),
  error: z
    .object({ message: line(2000), stack: line(8000).optional() })
    .nullable()
    .optional(),
  logs: z.array(line(2000)).max(200).default([]),
  screenshot: z.string().max(4_000_000).regex(SCREENSHOT).nullable().optional(),
  contact: z.string().trim().email().max(200).nullable().optional(),
});

export const reportRoutes = new Hono().post(
  "/bug-reports",
  bodyLimit({ maxSize: 4_500_000 }),
  async (c) => {
    const ip = hashIp(clientIp(c));
    if (!allowed(`bug:${ip ?? "?"}`, 10, 60 * 60 * 1000)) {
      return c.json({ ok: false }, 429);
    }
    const parsed = bugReportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ ok: false, issues: parsed.error.issues.map((i) => i.path.join(".")) }, 400);
    }
    const body = parsed.data;
    // The team and the wizard, as far as the run or the signed-in person tells them.
    const who = await principalOf(c).catch(() => null);
    let tenantId = who?.tenantId ?? null;
    let wizardId: string | null = null;
    if (body.runId) {
      const runTenant = await tenantOfRun(body.runId);
      if (runTenant && (!tenantId || tenantId === runTenant)) {
        tenantId = runTenant;
        const run = await withTenant(runTenant, () =>
          db.query.run.findFirst({
            where: eq(schema.run.id, body.runId!),
            columns: { wizardId: true },
          }),
        );
        wizardId = run?.wizardId ?? null;
      }
    }
    const report = {
      ...body,
      tenantId,
      wizardId,
      userAgent: c.req.header("user-agent")?.slice(0, 400) ?? null,
    };
    if (!managed) {
      console.error(
        `[bug report ${tenantId ?? "visitor"}] at ${body.url}: ${body.comment ?? ""} ${body.error?.message ?? ""}`,
      );
      return c.json({ ok: true, sent: false });
    }
    try {
      const { id } = await postBugReport(report);
      return c.json({ ok: true, sent: true, id });
    } catch (err) {
      console.error("[bug report] not sent:", (err as Error).message);
      return c.json({ ok: false }, 502);
    }
  },
);
