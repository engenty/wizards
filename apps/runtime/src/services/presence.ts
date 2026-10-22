import type { PresenceEntry, PresenceKind } from "@engenty/wizards-shared/live";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/**
 * Who is in a wizard, page or table (docs/plans/live-changes.md, 8). A signal for people and AI:
 * it never stops anyone from editing. Rows go through the live feed (`presence`), so every open
 * studio, in every process, sees them.
 */

/** Unseen this long, an entry is gone. */
export const PRESENCE_GONE_MS = 45_000;
/** An agent (MCP, API) counts as present this long after it read or wrote. */
export const AGENT_PRESENT_MS = 60_000;

export interface Presence {
  kind: PresenceKind;
  item: string;
  who: string;
  tab?: string;
  whoKind: PresenceEntry["whoKind"];
  name: string;
  client?: string | null;
  place?: string | null;
  placeLabel?: string | null;
  state: PresenceEntry["state"];
}

/** Here, now. Again within 20 s keeps it; a new state or place goes out to every studio. */
export async function markPresent(p: Presence, at = new Date()) {
  const row = {
    kind: p.kind,
    item: p.item,
    who: p.who,
    tab: p.tab ?? "",
    whoKind: p.whoKind,
    name: p.name,
    client: p.client ?? null,
    place: p.place ?? null,
    placeLabel: p.placeLabel ?? null,
    state: p.state,
    seenAt: at,
  };
  await db
    .insert(schema.livePresence)
    .values(row)
    .onConflictDoUpdate({
      target: [
        schema.livePresence.kind,
        schema.livePresence.item,
        schema.livePresence.who,
        schema.livePresence.tab,
      ],
      set: {
        name: row.name,
        client: row.client,
        place: row.place,
        placeLabel: row.placeLabel,
        state: row.state,
        seenAt: row.seenAt,
      },
    });
}

/** Gone from the item: the editor closed, the turn ended. */
export async function leave(kind: PresenceKind, item: string, who: string, tab = "") {
  await db
    .delete(schema.livePresence)
    .where(
      and(
        eq(schema.livePresence.kind, kind),
        eq(schema.livePresence.item, item),
        eq(schema.livePresence.who, who),
        eq(schema.livePresence.tab, tab),
      ),
    );
}

/** Who is in the item now, the longest there first. */
export async function presentIn(
  kind: string,
  item: string,
  now = Date.now(),
): Promise<PresenceEntry[]> {
  const rows = await db
    .select()
    .from(schema.livePresence)
    .where(
      and(
        eq(schema.livePresence.kind, kind),
        eq(schema.livePresence.item, item),
        gt(schema.livePresence.seenAt, sql`${now} - ${keptFor}`),
      ),
    )
    .orderBy(schema.livePresence.seenAt);
  return rows.map((r) => ({
    who: r.who,
    tab: r.tab,
    whoKind: r.whoKind as PresenceEntry["whoKind"],
    name: r.name,
    client: r.client,
    place: r.place,
    placeLabel: r.placeLabel,
    state: r.state as PresenceEntry["state"],
    seenAt: r.seenAt.toISOString(),
  }));
}

/** Deletes who is gone; each delete tells the open studios. */
export async function expirePresence(now = Date.now()) {
  await db
    .delete(schema.livePresence)
    .where(lt(schema.livePresence.seenAt, sql`${now} - ${keptFor}`));
}

/** How long an entry stays without being seen again: an agent's a minute, else 45 seconds. */
const keptFor = sql`CASE WHEN ${schema.livePresence.whoKind} = 'agent' THEN ${AGENT_PRESENT_MS} ELSE ${PRESENCE_GONE_MS} END`;

/** An agent's mark: present, and gone a minute later unless it comes back (no heartbeats). */
export async function markAgent(
  kind: PresenceKind,
  item: string,
  agent: { id: string; name: string; client: string | null },
  state: PresenceEntry["state"],
) {
  await markPresent({
    kind,
    item,
    who: agent.id,
    whoKind: "agent",
    name: agent.name,
    client: agent.client,
    state,
  });
}

/** For tests and the hourly purge. */
export const presenceCount = async () =>
  (await db.select({ n: sql<number>`count(*)` }).from(schema.livePresence))[0]?.n ?? 0;

/**
 * The studio assistant in a wizard while `work` runs, for the person it works for: a heartbeat
 * keeps a long turn present, the end takes it away.
 */
export async function asAssistantIn<T>(
  wizardId: string,
  person: { id: string; name: string },
  work: () => Promise<T>,
): Promise<T> {
  const who = `assistant:${person.id}`;
  const mark = () =>
    markPresent({
      kind: "wizard",
      item: wizardId,
      who,
      whoKind: "assistant",
      name: "Studio assistant",
      client: person.name,
      state: "editing",
    }).catch((err) => console.error("[presence]", err));
  await mark();
  const beat = setInterval(() => void mark(), 20_000);
  beat.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(beat);
    await leave("wizard", wizardId, who).catch(() => undefined);
  }
}
