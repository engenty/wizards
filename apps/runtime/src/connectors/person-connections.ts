import { featureOn } from "@engenty/wizards-shared/features";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { and, eq, getTableColumns, inArray, notExists } from "drizzle-orm";
import { nanoid } from "nanoid";
import { inAudience, type Who, whoOf } from "../broker/index.js";
import { db, schema } from "../db/client.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { currentFeatures } from "../features.js";
import { seal } from "../secrets/crypto.js";
import { roleOf } from "../services/access.js";
import type { StoreScope } from "../store/index.js";
import { candidates } from "./index.js";
import { sameService } from "./same-service.js";
import { listSpaceConnections, type SpaceConnectionRow } from "./space-connections.js";

/*
 * The connections a run may use (docs/plans/run-connections.md): the wizard names the service,
 * the run finds the account. A person's own connection (`person_connection`) counts in every
 * space they are in; a connection of the space stays in its space, and a run that carries a space
 * sees that space's alone. Which one a wizard uses is remembered per need and holder
 * (`connection_choice`).
 *
 * Behind `runConnections`: a person's account reaches a wizard that did not connect it, and the
 * space's connections are offered for a need. Without it a wizard reaches the accounts connected
 * in its own runs alone, as before.
 */

/** A person's connection without its secret: only the broker unseals that. */
export type PersonConnectionRow = Omit<typeof schema.personConnection.$inferSelect, "secret">;

const { secret: _secret, ...PUBLIC } = getTableColumns(schema.personConnection);

/** A connection a run may use for a need, with the need's connector it is used as. */
export type Usable =
  | { kind: "person"; row: PersonConnectionRow; connector: ConnectorDefinition }
  | { kind: "space"; row: SpaceConnectionRow; connector: ConnectorDefinition };

export interface Found {
  /** Every connection the run may use for the need. */
  candidates: Usable[];
  /** The one to use: the remembered choice while it is a candidate, else the only candidate. */
  chosen: Usable | null;
  /** How `chosen` was found; `only` is not remembered yet. */
  by: "choice" | "only" | null;
}

const NONE: Found = { candidates: [], chosen: null, by: null };

/** Whether the switch for the new reach is on for the tenant at hand. */
export async function runConnectionsOn(): Promise<boolean> {
  return featureOn(await currentFeatures().catch(() => null), "runConnections");
}

/** For whom the space remembers a choice: the runs nobody watches. */
export const spaceHolder = (spaceId: string) => `s:${spaceId}`;

/** The space a run is in: the one it carries, else the wizard's. */
const homeOf = (scope: StoreScope, spaceId: string) => scope.clientSpaceId ?? spaceId;

async function whoOfHolder(holder: string): Promise<Who> {
  return holder.startsWith("u:") ? whoOf(holder, await roleOf(holder.slice(2))) : whoOf(holder);
}

/** A connection of the space someone may use: in their audience and signed in. */
async function spaceUsable(row: SpaceConnectionRow, who: Who): Promise<boolean> {
  if (!inAudience(row.audience, who)) {
    return false;
  }
  if (row.signIn === "space") {
    return row.secret !== null;
  }
  if (!who.id || who.kind === "guest") {
    return false;
  }
  const own = await db.query.spaceConnectionSignIn.findFirst({
    where: and(
      eq(schema.spaceConnectionSignIn.connectionId, row.id),
      eq(schema.spaceConnectionSignIn.userId, who.id),
    ),
    columns: { userId: true },
  });
  return own !== undefined;
}

/**
 * The connections a run may use for one of its wizard's needs, and the one to use: the
 * remembered choice while it is still a candidate, else the only candidate, else none.
 */
export async function connectionsFor(
  scope: StoreScope,
  spaceId: string,
  need: ConnectionDef,
): Promise<Found> {
  const connectors = await candidates(need, spaceId);
  if (!connectors.length) {
    return NONE;
  }
  // The need's own connectors first; a sibling of the same service reads as the need's.
  const asNeed = new Map<string, ConnectorDefinition>(connectors.map((c) => [c.id, c]));
  for (const c of connectors) {
    for (const id of sameService(c.id)) {
      if (!asNeed.has(id)) {
        asNeed.set(id, c);
      }
    }
  }
  const home = homeOf(scope, spaceId);
  const holders = [
    scope.holder,
    // A run nobody watches uses what an admin chose for the space.
    ...(scope.holder.startsWith("r:") ? [spaceHolder(home)] : []),
  ];
  const choices = await db.query.connectionChoice.findMany({
    where: and(
      eq(schema.connectionChoice.wizardId, scope.wizardId),
      eq(schema.connectionChoice.need, need.id),
      inArray(schema.connectionChoice.holder, holders),
    ),
  });
  const choice =
    choices.find((c) => c.holder === scope.holder) ??
    choices.find((c) => c.holder !== scope.holder);
  const reach = await runConnectionsOn();

  const found: Usable[] = [];
  const own = await db
    .select(PUBLIC)
    .from(schema.personConnection)
    .where(
      and(
        eq(schema.personConnection.holder, scope.holder),
        inArray(schema.personConnection.connectorId, [...asNeed.keys()]),
      ),
    );
  for (const row of own) {
    const connector = asNeed.get(row.connectorId);
    if (connector && (reach || row.id === choice?.personConnectionId)) {
      found.push({ kind: "person", row, connector });
    }
  }
  if (reach) {
    const who = await whoOfHolder(scope.holder);
    for (const row of await listSpaceConnections(home)) {
      const connector = asNeed.get(row.connectorId);
      if (connector && (await spaceUsable(row, who))) {
        found.push({ kind: "space", row, connector });
      }
    }
  }
  const remembered = choice
    ? found.find((u) =>
        u.kind === "person"
          ? u.row.id === choice.personConnectionId
          : u.row.id === choice.spaceConnectionId,
      )
    : undefined;
  if (remembered) {
    return { candidates: found, chosen: remembered, by: "choice" };
  }
  return found.length === 1
    ? { candidates: found, chosen: found[0], by: "only" }
    : { candidates: found, chosen: null, by: null };
}

// --- writing ---------------------------------------------------------------------

/**
 * Keeps an account a person (or a visitor) signed in to: one row per address and service, so a
 * second sign-in to the same address replaces the tokens of the first.
 */
export async function saveConnection(
  holder: string,
  connectorId: string,
  label: string,
  data: unknown,
): Promise<PersonConnectionRow> {
  const secret = seal(data);
  const existing = await db.query.personConnection.findFirst({
    where: and(
      eq(schema.personConnection.holder, holder),
      inArray(schema.personConnection.connectorId, sameService(connectorId)),
      eq(schema.personConnection.label, label),
    ),
    columns: { id: true },
  });
  if (existing) {
    const [row] = await db
      .update(schema.personConnection)
      .set({ connectorId, secret, updatedAt: new Date() })
      .where(eq(schema.personConnection.id, existing.id))
      .returning(PUBLIC);
    return row;
  }
  const [row] = await db
    .insert(schema.personConnection)
    .values({ id: nanoid(14), holder, connectorId, label, secret })
    .returning(PUBLIC);
  return row;
}

/** Remembers which connection a wizard uses for a need, for one holder. */
export async function remember(
  wizardId: string,
  need: string,
  holder: string,
  to: Pick<Usable, "kind"> & { row: { id: string } },
): Promise<void> {
  const target =
    to.kind === "person"
      ? { personConnectionId: to.row.id, spaceConnectionId: null }
      : { personConnectionId: null, spaceConnectionId: to.row.id };
  await db
    .insert(schema.connectionChoice)
    .values({ wizardId, need, holder, ...target })
    .onConflictDoUpdate({
      target: [
        schema.connectionChoice.wizardId,
        schema.connectionChoice.need,
        schema.connectionChoice.holder,
      ],
      set: { ...target, chosenAt: new Date() },
    });
}

/**
 * Forgets choices of a wizard for one holder: one need's, or all of them. A person's connection
 * no choice points at any more goes with it; one another wizard uses stays.
 */
export async function forget(wizardId: string, holder: string, need?: string): Promise<void> {
  const gone = await db
    .delete(schema.connectionChoice)
    .where(
      and(
        eq(schema.connectionChoice.wizardId, wizardId),
        eq(schema.connectionChoice.holder, holder),
        need === undefined ? undefined : eq(schema.connectionChoice.need, need),
      ),
    )
    .returning({ id: schema.connectionChoice.personConnectionId });
  await dropUnchosen(gone.flatMap((g) => (g.id ? [g.id] : [])));
}

/** Deletes those of the person's connections that no wizard chose. */
async function dropUnchosen(ids: string[]): Promise<void> {
  if (!ids.length) {
    return;
  }
  await db
    .delete(schema.personConnection)
    .where(
      and(
        inArray(schema.personConnection.id, ids),
        notExists(
          db
            .select({ id: schema.connectionChoice.wizardId })
            .from(schema.connectionChoice)
            .where(eq(schema.connectionChoice.personConnectionId, schema.personConnection.id)),
        ),
      ),
    );
}

/**
 * What a wizard remembers for a holder, as „Was dieser Wizard sich merkt“ lists it: one entry
 * per chosen connection, under the slot the wizard's account had in its store before.
 */
export async function chosenAccounts(
  wizardId: string,
  holder: string,
): Promise<{ slot: string; provider: string; label: string; createdAt: string }[]> {
  const rows = await db
    .select({
      need: schema.connectionChoice.need,
      person: {
        connectorId: schema.personConnection.connectorId,
        label: schema.personConnection.label,
        createdAt: schema.personConnection.createdAt,
      },
      space: {
        connectorId: schema.spaceConnection.connectorId,
        label: schema.spaceConnection.label,
        name: schema.spaceConnection.name,
        setUpAt: schema.spaceConnection.setUpAt,
      },
    })
    .from(schema.connectionChoice)
    .leftJoin(
      schema.personConnection,
      eq(schema.personConnection.id, schema.connectionChoice.personConnectionId),
    )
    .leftJoin(
      schema.spaceConnection,
      eq(schema.spaceConnection.id, schema.connectionChoice.spaceConnectionId),
    )
    .where(
      and(
        eq(schema.connectionChoice.wizardId, wizardId),
        eq(schema.connectionChoice.holder, holder),
      ),
    );
  return rows.flatMap((r) => {
    if (r.person) {
      return [
        {
          slot: `connection:${r.need}`,
          provider: r.person.connectorId,
          label: r.person.label,
          createdAt: r.person.createdAt.toISOString(),
        },
      ];
    }
    if (r.space) {
      return [
        {
          slot: `connection:${r.need}`,
          provider: r.space.connectorId,
          label: r.space.label ?? r.space.name,
          createdAt: r.space.setUpAt.toISOString(),
        },
      ];
    }
    return [];
  });
}
