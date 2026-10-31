import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  type BrokerConnection,
  decide,
  kindOf,
  LOG_PAGE,
  type LoggedRow,
  logOfSpace,
  type Who,
  type WhoKind,
} from "../broker/index.js";
import { connectorOfRow, spaceConnectionById } from "../connectors/space-connections.js";
import { requireAdmin } from "../services/access.js";
import { notFound } from "../services/errors.js";
import { ownedSpace } from "../services/spaces.js";

/**
 * The broker heard and tried (docs/plans/broker.md, phase 2), under `/api/studio`, for the
 * space's admins (403 for a member): „Was darf …?“ answers what the broker would decide for a
 * caller, a connection and an action, with the rule that decides, and nothing runs; the log with
 * the filters the Protokoll page will have. No page draws them yet.
 */

type Vars = { Variables: { user: SessionUser } };

const WHO = [
  "guest",
  "person",
  "admin",
  "goose",
  "plugin",
  "step",
] as const satisfies readonly WhoKind[];

const askSchema = z.object({
  who: z.enum(WHO),
  /** A fixed step: whom the run is held for. */
  for: z.enum(["guest", "person", "admin"]).optional(),
  /** A connection of the space, by its id. */
  resource: z.string().min(1).max(80),
  action: z.string().min(1).max(120),
  /** Where the call would be made: in a run (an AI step), in a chat, or outside both (a plugin's job). */
  in: z.enum(["run", "chat", "none"]).default("run"),
});

const logSchema = z.object({
  connection: z.string().min(1).max(200).optional(),
  who: z.enum(WHO).optional(),
  outcome: z.enum(["allow", "ask", "deny"]).optional(),
  critical: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(LOG_PAGE).optional(),
});

/** The caller as the question names them. */
function whoOfAsk(ask: z.infer<typeof askSchema>): Who {
  if (ask.who === "step") {
    return { kind: "step", for: { kind: ask.for ?? "guest" } };
  }
  if (ask.who === "goose") {
    return { kind: "goose", admin: ask.for === "admin" };
  }
  return { kind: ask.who };
}

/** A row as the Protokoll page reads it. */
export function logView(row: LoggedRow) {
  return {
    id: row.id,
    at: row.at.toISOString(),
    durationMs: row.durationMs,
    who: { kind: row.whoKind, id: row.whoId },
    runId: row.runId,
    stepId: row.stepId,
    chatId: row.chatId,
    wizardId: row.wizardId,
    connectionId: row.connectionId,
    actionId: row.actionId,
    kind: row.kind,
    input: JSON.parse(row.inputSummary) as unknown,
    outcome: row.outcome,
    rule: row.rule,
    reason: row.reason,
    result: row.result,
    resultSize: row.resultSize,
    critical: row.critical,
    criticalKind: row.criticalKind,
  };
}

export const brokerRoutes = new Hono<Vars>()
  .get("/spaces/:id/broker/ask", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    await requireAdmin();
    const ask = askSchema.parse(c.req.query());
    const row = await spaceConnectionById(ask.resource).catch(() => null);
    if (!row || row.spaceId !== space.id) {
      throw notFound();
    }
    const connector = await connectorOfRow(row);
    const found = connector.actions.find((a) => a.id === ask.action);
    const kind = found ? kindOf(found.group) : "write";
    const connection: BrokerConnection = { kind: "space_connection", row, connector };
    const who = whoOfAsk(ask);
    const where = {
      spaceId: space.id,
      guest: who.kind === "guest" || (who.kind === "step" && who.for?.kind === "guest"),
      ...(ask.in === "run" ? { runId: "ask", mode: "live" as const } : {}),
      ...(ask.in === "chat" ? { chatId: "ask" } : {}),
    };
    const decision = decide({ who, where, connection, actionId: ask.action, kind });
    return c.json({
      who,
      connection: { id: row.id, name: row.name, connector: connector.id },
      action: { id: ask.action, kind, known: Boolean(found) },
      outcome: decision.outcome,
      rule: decision.rule,
      reason: decision.reason,
      ...(decision.refused ? { refused: decision.refused } : {}),
      ...(decision.admins ? { admins: true } : {}),
    });
  })
  .get("/spaces/:id/broker/log", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    await requireAdmin();
    const query = logSchema.parse(c.req.query());
    const rows = await logOfSpace(space.id, query);
    return c.json({ lines: rows.map(logView) });
  });
