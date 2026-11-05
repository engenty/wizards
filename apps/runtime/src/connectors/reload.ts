import type { ConnectorView } from "@engenty/wizards-shared/connectors";
import { note } from "@engenty/wizards-shared/run";
import { eq } from "drizzle-orm";
import { brokerCall } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import { requireAdmin, requireWritableSpace } from "../services/access.js";
import { ServiceError } from "../services/errors.js";
import { importedView, refreshConnector, resolveConnector } from "./external.js";
import { listSpaceConnections } from "./space-connections.js";

/*
 * „Aktionen neu laden“ in the studio (docs/plans/capabilities-next.md, piece 1): an admin of a
 * space that can be changed here has an imported connector's source read again. An MCP server
 * that lists its tools only to a signed-in account is asked with the sign-in of a connection on
 * that connector: the space's own, or the admin's where each person signs in. The broker reads
 * the sign-in, as for every call, and the reload is a line of the audit.
 */
export async function reloadConnector(
  userId: string,
  spaceId: string,
  id: string,
): Promise<ConnectorView> {
  await requireWritableSpace(spaceId);
  await requireAdmin();
  const current = await importedView(spaceId, id);
  const resolved = current ? await resolveConnector(spaceId, id) : null;
  if (!(current && resolved)) {
    throw new ServiceError("not_found", note("connectorNotExist"));
  }
  const rows = (await listSpaceConnections(spaceId)).filter((row) => row.connectorId === id);
  const own = rows.some((row) => row.signIn === "person")
    ? new Set(
        (
          await db
            .select({ connectionId: schema.spaceConnectionSignIn.connectionId })
            .from(schema.spaceConnectionSignIn)
            .where(eq(schema.spaceConnectionSignIn.userId, userId))
        ).map((s) => s.connectionId),
      )
    : new Set<string>();
  const signedIn = rows.filter((row) => (row.signIn === "space" ? !!row.secret : own.has(row.id)));
  let failed: unknown;
  let refused: string | null = null;
  for (const row of signedIn) {
    try {
      const out = await brokerCall({
        who: { kind: "admin", id: userId },
        where: { spaceId },
        // Listing the tools is none of the connector's actions, so a connection that is for a
        // few of them does not narrow it. Its rule for reading still decides.
        connection: {
          kind: "space_connection",
          row: { ...row, actions: [] },
          connector: resolved.connector,
        },
        action: { id: "list_tools", kind: "read" },
        input: {},
        handler: (account) => refreshConnector(spaceId, id, account.ctx.accessToken),
      });
      if (out.ok) {
        return out.result;
      }
      refused ??= out.reason;
    } catch (err) {
      failed ??= err;
    }
  }
  try {
    return await refreshConnector(spaceId, id, null);
  } catch (err) {
    // A signed-in connection asked and the source failed: that is the answer.
    if (failed) {
      throw failed;
    }
    // The source wants a sign-in, and no connection gave one.
    if (/(^|\D)401(\D|$)|unauthori[sz]ed/i.test(err instanceof Error ? err.message : "")) {
      throw new ServiceError(
        "invalid",
        refused ?? note("connectorNoSignedInConnection", { name: current.name }),
      );
    }
    throw err;
  }
}
