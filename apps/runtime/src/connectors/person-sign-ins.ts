import type { PersonConnectionView, PersonSignIns } from "@engenty/wizards-shared/connectors";
import { eq } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { inAudience, type Who } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import { managed, tenantMembers } from "../manage.js";
import { isAdminRole } from "../services/access.js";
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
 */

/** Names of the organization's people by id; alone, the one person. */
export async function namesOf(user: SessionUser): Promise<Map<string, string>> {
  if (!managed) {
    return new Map([[user.id, (await userProfile(user)).name]]);
  }
  const people = await tenantMembers(currentTenant()).catch(() => null);
  return new Map((people?.members ?? []).map((m) => [m.userId, m.name]));
}

export async function personSignIns(user: SessionUser): Promise<PersonSignIns> {
  const who: Who = { kind: isAdminRole(user.role) ? "admin" : "person", id: user.id };
  const own = await db.query.spaceConnectionSignIn.findMany({
    where: eq(schema.spaceConnectionSignIn.userId, user.id),
  });
  let names: Map<string, string> | null = null;
  const spaces: PersonSignIns["spaces"] = [];
  for (const space of await listSpaces(user.id)) {
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
      });
    }
    spaces.push({ id: space.id, name: space.name, connections });
  }
  return { spaces };
}
