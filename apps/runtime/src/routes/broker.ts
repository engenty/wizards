import type { BrokerActionChoice, ProtocolPerson } from "@engenty/wizards-shared/connectors";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  type BrokerConnection,
  cursorOf,
  decide,
  kindOf,
  LOG_PAGE,
  type LoggedRow,
  logLine,
  logOfSpace,
  readCursor,
  type Who,
  type WhoKind,
} from "../broker/index.js";
import { resolveConnector } from "../connectors/external.js";
import {
  connectorOfRow,
  listSpaceConnections,
  spaceConnectionById,
} from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { managed, tenantMembers } from "../manage.js";
import { isAdminRole, requireAdmin } from "../services/access.js";
import { notFound } from "../services/errors.js";
import { userProfile } from "../services/profile.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * The broker heard and tried (docs/plans/broker.md, phase 2), under `/api/studio`, for the
 * space's admins (403 for a member): „Was darf …?“ answers what the broker would decide for a
 * caller, a connection and an action, with the rule that decides, and nothing runs; the log with
 * the filters of Fähigkeiten › Protokoll, a page of it at a time, each line with the names the
 * page shows (the person, the connection, the action, the wizard, the chat); one line with what
 * the run was allowed; the people and connections the page's question picks from.
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
  /** A fixed step: whom the run is held for. Goose: `admin` for an admin's Goose. */
  for: z.enum(["guest", "person", "admin"]).optional(),
  /** A connection of the space, by its id. */
  resource: z.string().min(1).max(80),
  action: z.string().min(1).max(120),
  /** Where the call would be made: in a run (an AI step), in a chat, or outside both (a plugin's job). */
  in: z.enum(["run", "chat", "none"]).default("run"),
});

const flag = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

const logSchema = z.object({
  connection: z.string().min(1).max(200).optional(),
  who: z.enum(WHO).optional(),
  outcome: z.enum(["allow", "ask", "deny"]).optional(),
  /** What came of the call: `ok`, a refusal (`needs_approval`: held for the admins), an error's class. */
  result: z.string().min(1).max(80).optional(),
  /** Refused by a rule or by the person asked. */
  refused: flag,
  critical: flag,
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  q: z.string().max(200).optional(),
  /** The `next` of the page before. */
  cursor: z.string().max(80).optional(),
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

/** The organization's people by id, with their role; alone, the one person. */
async function peopleOf(user: SessionUser): Promise<ProtocolPerson[]> {
  if (!managed) {
    return [{ id: user.id, name: (await userProfile(user)).name, role: "owner" }];
  }
  const people = await tenantMembers(currentTenant()).catch(() => null);
  return (people?.members ?? []).map((m) => ({ id: m.userId, name: m.name, role: m.role }));
}

/** A connector, looked up once per request. */
function connectorCache(spaceId: string) {
  const found = new Map<string, Promise<ConnectorDefinition | null>>();
  return (id: string) => {
    let connector = found.get(id);
    if (!connector) {
      connector = resolveConnector(spaceId, id)
        .then((r) => r?.connector ?? null)
        .catch(() => null);
      found.set(id, connector);
    }
    return connector;
  };
}

/**
 * The lines with the names the page shows: who by name (a fixed step: whom its run is held for),
 * the connection and the action by theirs, the wizard of a run, the title of a chat.
 */
async function describeLines(rows: LoggedRow[], spaceId: string, people: ProtocolPerson[]) {
  const named = new Map(people.map((p) => [p.id, p]));
  const connections = new Map((await listSpaceConnections(spaceId)).map((c) => [c.id, c]));
  const connector = connectorCache(spaceId);
  const ids = (pick: (row: LoggedRow) => string | null) => [
    ...new Set(rows.map(pick).filter((id): id is string => !!id)),
  ];
  const runIds = ids((r) => r.runId);
  const wizardIds = ids((r) => r.wizardId);
  const chatIds = ids((r) => r.chatId);
  const [runs, wizards, chats] = await Promise.all([
    runIds.length
      ? db
          .select({
            id: schema.run.id,
            mode: schema.run.mode,
            userId: schema.run.userId,
          })
          .from(schema.run)
          .where(inArray(schema.run.id, runIds))
      : [],
    wizardIds.length
      ? db
          .select({ id: schema.wizard.id, title: schema.wizard.title, draft: schema.wizard.draft })
          .from(schema.wizard)
          .where(inArray(schema.wizard.id, wizardIds))
      : [],
    chatIds.length
      ? db
          .select({ id: schema.chat.id, title: schema.chat.title })
          .from(schema.chat)
          .where(inArray(schema.chat.id, chatIds))
      : [],
  ]);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const wizardOf = new Map(wizards.map((w) => [w.id, w]));
  const chatOf = new Map(chats.map((c) => [c.id, c]));
  const person = (id: string | null) => (id ? (named.get(id)?.name ?? null) : null);

  return Promise.all(
    rows.map(async (row) => {
      const view = logView(row);
      const run = row.runId ? runOf.get(row.runId) : undefined;
      const wizard = row.wizardId ? wizardOf.get(row.wizardId) : undefined;
      const space = connections.get(row.connectionId);
      const def = wizard?.draft.connections?.find((c) => c.id === row.connectionId);
      const holder = space
        ? await connector(space.connectorId)
        : def?.connector
          ? await connector(def.connector)
          : null;
      const action = holder?.actions.find((a) => a.id === row.actionId);
      // A fixed step: the run is held for a person who signed in, else for a guest.
      const heldFor =
        row.whoKind === "step" && run
          ? run.userId
            ? {
                kind: isAdminRole(named.get(run.userId)?.role ?? "member") ? "admin" : "person",
                id: run.userId,
                name: person(run.userId),
              }
            : { kind: "guest", id: null, name: null }
          : null;
      return {
        ...view,
        who: {
          ...view.who,
          name: ["person", "admin", "goose"].includes(row.whoKind) ? person(row.whoId) : null,
          ...(heldFor ? { for: heldFor } : {}),
        },
        connectionName: space?.name ?? def?.title ?? null,
        connectorName: holder?.name ?? null,
        actionName: action?.summary ?? null,
        wizardName: wizard?.title ?? null,
        runMode: run?.mode ?? null,
        chatTitle: row.chatId ? (chatOf.get(row.chatId)?.title ?? null) : null,
      };
    }),
  );
}

/** The ids whose names hold the search text: people, the space's connections, its wizards. */
async function matchesOf(q: string, spaceId: string, people: ProtocolPerson[]) {
  const text = q.trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  const has = (name: string | null | undefined) => !!name && name.toLowerCase().includes(text);
  const wizards = await db
    .select({ id: schema.wizard.id, title: schema.wizard.title })
    .from(schema.wizard)
    .where(eq(schema.wizard.spaceId, spaceId));
  return {
    who: people.filter((p) => has(p.name)).map((p) => p.id),
    connections: (await listSpaceConnections(spaceId)).filter((c) => has(c.name)).map((c) => c.id),
    wizards: wizards.filter((w) => has(w.title)).map((w) => w.id),
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
  // What „Was darf …?“ picks from: the organization's people, the space's connections and their actions.
  .get("/spaces/:id/broker/choices", async (c) => {
    const space = await ownedSpace(c.get("user").id, c.req.param("id"));
    await requireAdmin();
    const connector = connectorCache(space.id);
    const connections = await Promise.all(
      (await listSpaceConnections(space.id)).map(async (row) => {
        const found = await connector(row.connectorId);
        const actions: BrokerActionChoice[] = (found?.actions ?? []).map((a) => ({
          id: a.id,
          name: a.summary || a.id,
          kind: kindOf(a.group),
        }));
        return {
          id: row.id,
          name: row.name,
          connector: found ? { id: found.id, name: found.name } : null,
          audience: row.audience,
          signIn: row.signIn,
          actions,
        };
      }),
    );
    return c.json({ people: await peopleOf(c.get("user")), connections });
  })
  .get("/spaces/:id/broker/log", async (c) => {
    const user = c.get("user");
    const space = await ownedSpace(user.id, c.req.param("id"));
    await requireAdmin();
    const { cursor, q, ...query } = logSchema.parse(c.req.query());
    const before = cursor ? readCursor(cursor) : null;
    const limit = query.limit ?? LOG_PAGE;
    const people = await peopleOf(user);
    const rows = await logOfSpace(space.id, {
      ...query,
      limit,
      ...(before ? { before } : {}),
      ...(q?.trim() ? { q, matches: await matchesOf(q, space.id, people) } : {}),
    });
    const last = rows.at(-1);
    return c.json({
      lines: await describeLines(rows, space.id, people),
      // A full page may have more behind it.
      next: last && rows.length === limit ? cursorOf(last) : null,
    });
  })
  // One line, with what its run was allowed through that connection or to that host.
  .get("/spaces/:id/broker/log/:line", async (c) => {
    const user = c.get("user");
    const space = await ownedSpace(user.id, c.req.param("id"));
    await requireAdmin();
    const row = await logLine(space.id, c.req.param("line"));
    if (!row) {
      throw notFound();
    }
    const [line] = await describeLines([row], space.id, await peopleOf(user));
    const run = row.runId
      ? await db.query.run.findFirst({
          where: (t, { eq }) => eq(t.id, row.runId as string),
          columns: { id: true, wizardId: true, mode: true, status: true, grant: true },
        })
      : undefined;
    const host = row.connectionId.startsWith("host:") ? row.connectionId.slice(5) : null;
    return c.json({
      line,
      run: run
        ? {
            id: run.id,
            wizardId: run.wizardId,
            mode: run.mode,
            status: run.status,
            // Null: a run from before grants were kept, or one the grant does not bind (a space's connection).
            grant: run.grant
              ? {
                  actions: host ? null : (run.grant.connections[row.connectionId] ?? []),
                  hosts: run.grant.hosts,
                }
              : null,
          }
        : null,
    });
  });
