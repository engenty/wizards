import type {
  OwnConnectionView,
  PersonConnectionView,
  PersonSignIns,
} from "@engenty/wizards-shared/connectors";
import { and, desc, eq } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { inAudience, type Who } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import { managed, tenantMembers } from "../manage.js";
import { isAdminRole } from "../services/access.js";
import { notFound } from "../services/errors.js";
import { userProfile } from "../services/profile.js";
import { listSpaces } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import { resolveConnector } from "./external.js";
import { listSpaceConnections } from "./space-connections.js";

/*
 * A person's own sign-ins (docs/plans/capabilities.md, "A person's own page"): per space of
 * theirs, the connections within their audience. Where each person signs in, whether they did;
 * where the space signs in, which account and who set it up. Other people's sign-ins never show.
 *
 * Every sign-in belongs to a connection of a space: Goose uses the person's sign-ins to those
 * (`agents/goose-connections.ts`), so there are none „only for Goose“ to list yet.
 *
 * Above them the person's own connections (`person_connection` of `u:<id>`,
 * docs/plans/run-connections.md): the accounts they connected in a run, which count in every space
 * of theirs, with the wizards that chose each. Disconnecting one deletes it and every choice that
 * names it. Listed with `runConnections` on or off.
 */

/** Names of the organization's people by id; alone, the one person. */
export async function namesOf(user: SessionUser): Promise<Map<string, string>> {
  if (!managed) {
    return new Map([[user.id, (await userProfile(user)).name]]);
  }
  const people = await tenantMembers(currentTenant()).catch(() => null);
  return new Map((people?.members ?? []).map((m) => [m.userId, m.name]));
}

/** The person's own connections, newest first, with the wizards that chose each. */
async function ownConnections(user: SessionUser, spaceIds: string[]): Promise<OwnConnectionView[]> {
  const rows = await db
    .select({
      id: schema.personConnection.id,
      connectorId: schema.personConnection.connectorId,
      label: schema.personConnection.label,
      createdAt: schema.personConnection.createdAt,
    })
    .from(schema.personConnection)
    .where(eq(schema.personConnection.holder, `u:${user.id}`))
    .orderBy(desc(schema.personConnection.createdAt));
  if (!rows.length) {
    return [];
  }
  const chosen = await db
    .selectDistinct({
      connection: schema.connectionChoice.personConnectionId,
      id: schema.wizard.id,
      title: schema.wizard.title,
    })
    .from(schema.connectionChoice)
    .innerJoin(schema.wizard, eq(schema.wizard.id, schema.connectionChoice.wizardId))
    .where(eq(schema.connectionChoice.holder, `u:${user.id}`));
  const names = new Map<string, string | null>();
  for (const row of rows) {
    if (!names.has(row.connectorId)) {
      let name: string | null = null;
      for (const spaceId of spaceIds) {
        name = (await resolveConnector(spaceId, row.connectorId))?.connector.name ?? null;
        if (name) {
          break;
        }
      }
      names.set(row.connectorId, name);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    connectorId: row.connectorId,
    connectorName: names.get(row.connectorId) ?? null,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    wizards: chosen
      .filter((c) => c.connection === row.id)
      .map((c) => ({ id: c.id, title: c.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

/** Disconnects one of the person's own connections: the account goes, and every choice naming it. */
export async function disconnectOwn(user: SessionUser, id: string): Promise<void> {
  const mine = and(
    eq(schema.personConnection.id, id),
    eq(schema.personConnection.holder, `u:${user.id}`),
  );
  const row = await db.query.personConnection.findFirst({ where: mine, columns: { id: true } });
  if (!row) {
    throw notFound();
  }
  await db
    .delete(schema.connectionChoice)
    .where(eq(schema.connectionChoice.personConnectionId, row.id));
  await db.delete(schema.personConnection).where(mine);
}

export async function personSignIns(user: SessionUser): Promise<PersonSignIns> {
  const who: Who = { kind: isAdminRole(user.role) ? "admin" : "person", id: user.id };
  const own = await db.query.spaceConnectionSignIn.findMany({
    where: eq(schema.spaceConnectionSignIn.userId, user.id),
  });
  let names: Map<string, string> | null = null;
  const spaces: PersonSignIns["spaces"] = [];
  const theirs = await listSpaces(user.id);
  for (const space of theirs) {
    const rows = (await listSpaceConnections(space.id)).filter((row) =>
      inAudience(row.audience, who),
    );
    if (rows.length && rows.some((row) => row.setUpBy) && !names) {
      names = await namesOf(user);
    }
    const connections: PersonConnectionView[] = [];
    for (const row of rows) {
      const connector = (await resolveConnector(space.id, row.connectorId))?.connector ?? null;
      const mine = row.signIn === "person" ? own.find((s) => s.connectionId === row.id) : null;
      connections.push({
        id: row.id,
        name: row.name,
        connectorId: row.connectorId,
        connector: connector
          ? {
              id: connector.id,
              name: connector.name,
              auth: connector.auth.kind,
              ...(connector.auth.kind === "api_key" && row.signIn === "person"
                ? { fields: connector.auth.apiKey.fields }
                : {}),
            }
          : null,
        signIn: row.signIn,
        audience: row.audience,
        mySignIn: mine ? { label: mine.label, signedInAt: mine.signedInAt.toISOString() } : null,
        account:
          row.signIn === "space" && row.secret
            ? {
                label: row.label ?? connector?.name ?? row.name,
                signedInAt: row.setUpAt.toISOString(),
              }
            : null,
        setUpBy: row.setUpBy ? (names?.get(row.setUpBy) ?? null) : null,
        setUpAt: row.setUpAt.toISOString(),
        pausedAt: row.pausedAt?.toISOString() ?? null,
      });
    }
    spaces.push({ id: space.id, name: space.name, connections });
  }
  return {
    own: await ownConnections(
      user,
      theirs.map((s) => s.id),
    ),
    spaces,
  };
}
