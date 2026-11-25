import { eq } from "drizzle-orm";
import type { Who } from "../broker/index.js";
import { listSpaceConnections } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import { connectionToolsOf, usableConnections } from "../tools/connections.js";
import { isAdminRole, roleOf } from "./access.js";

/*
 * A chat's grant (docs/plans/capabilities.md, A7): the space's connections whose audience
 * includes the person the turn is for, as the element `connection_call` reaches them.
 */

/** Who a chat's turn calls as: the person, an admin where their role in the organization says so. */
export async function chatWho(userId: string): Promise<Who> {
  const role = await roleOf(userId);
  return { kind: isAdminRole(role) ? "admin" : "person", id: userId };
}

/**
 * The connections of the space this person reaches in a chat: those open to their role, and of
 * the ones in which each person signs in, only those they signed in to.
 */
export async function chatConnectionTools(spaceId: string, userId: string, who: Who) {
  const rows = await listSpaceConnections(spaceId);
  const own = rows.some((r) => r.signIn === "person")
    ? new Set(
        (
          await db.query.spaceConnectionSignIn.findMany({
            where: eq(schema.spaceConnectionSignIn.userId, userId),
            columns: { connectionId: true },
          })
        ).map((s) => s.connectionId),
      )
    : new Set<string>();
  const reachable = rows.filter((r) => r.signIn === "space" || own.has(r.id));
  return connectionToolsOf(await usableConnections(reachable, who));
}
