import { note } from "@engenty/wizards-shared/run";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { openToClients } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { inviteMember, managed } from "../manage.js";
import { spaceChanged } from "../plugins/events.js";
import { currentTenant } from "../tenants/tenant.js";
import { currentRole, requireAdmin, requireBuild } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedSpace, removeSpace } from "./spaces.js";

/*
 * Client spaces (docs/plans/client-spaces.md): a space's clients, each in a client space under it.
 * The firm makes them in its space; who is in one (`space_member`) decides which client spaces a
 * client of the organization sees. Behind the `clientSpaces` switch.
 */

/** Client spaces are behind their switch: while it is off, they are not there. */
export async function requireClientSpaces(): Promise<void> {
  if ((await currentFeatures()).clientSpaces !== true) {
    throw notFound();
  }
}

/** A space of the firm that may hold client spaces: not a client space itself. */
async function firmSpace(userId: string, spaceId: string) {
  const space = await ownedSpace(userId, spaceId);
  if (space.kind !== "space" || currentRole() === "client") {
    throw notFound();
  }
  return space;
}

/** A client space, as the firm reaches it. */
async function clientSpace(userId: string, spaceId: string) {
  const space = await ownedSpace(userId, spaceId);
  if (space.kind !== "client" || currentRole() === "client") {
    throw notFound();
  }
  return space;
}

/** The client spaces of a space, with how many people are in each, newest first. */
export async function listClientSpaces(userId: string, spaceId: string) {
  await requireClientSpaces();
  const space = await firmSpace(userId, spaceId);
  const rows = await db.query.space.findMany({
    where: and(eq(schema.space.parentId, space.id), eq(schema.space.tenantId, currentTenant())),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
  const counts = rows.length
    ? await db
        .select({ spaceId: schema.spaceMember.spaceId, role: schema.spaceMember.role, n: count() })
        .from(schema.spaceMember)
        .where(
          inArray(
            schema.spaceMember.spaceId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(schema.spaceMember.spaceId, schema.spaceMember.role)
    : [];
  const people = (id: string, role: "member" | "client") =>
    counts.find((c) => c.spaceId === id && c.role === role)?.n ?? 0;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    clients: people(r.id, "client"),
    members: people(r.id, "member"),
  }));
}

/** A new client space under a space of the firm. Its admins make them. */
export async function createClientSpace(
  userId: string,
  spaceId: string,
  name: string,
): Promise<{ id: string }> {
  await requireClientSpaces();
  await requireBuild();
  await requireAdmin();
  const space = await firmSpace(userId, spaceId);
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ServiceError("invalid", "A client space needs a name.");
  }
  const id = nanoid(12);
  await db.insert(schema.space).values({
    id,
    tenantId: currentTenant(),
    name: trimmed,
    brand: {},
    kind: "client",
    parentId: space.id,
  });
  spaceChanged("space.created", id);
  return { id };
}

/** Closes a client space: its data, results and chats go with it. */
export async function deleteClientSpace(userId: string, spaceId: string): Promise<void> {
  await requireClientSpaces();
  await requireAdmin();
  const space = await clientSpace(userId, spaceId);
  await removeSpace(space.id);
}

/** Who is in a client space: the client's people and the firm's assigned members. */
export async function listSpaceMembers(userId: string, spaceId: string) {
  await requireClientSpaces();
  const space = await clientSpace(userId, spaceId);
  const rows = await db.query.spaceMember.findMany({
    where: eq(schema.spaceMember.spaceId, space.id),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });
  return rows.map((m) => ({
    userId: m.userId,
    email: m.email,
    role: m.role,
    addedAt: m.createdAt.toISOString(),
  }));
}

/** Puts a person of the organization into a client space, as a client or as the firm's. */
export async function addSpaceMember(
  userId: string,
  spaceId: string,
  member: { userId: string; role: "member" | "client" },
): Promise<void> {
  await requireClientSpaces();
  await requireAdmin();
  const space = await clientSpace(userId, spaceId);
  await db
    .insert(schema.spaceMember)
    .values({
      id: nanoid(12),
      tenantId: currentTenant(),
      spaceId: space.id,
      userId: member.userId,
      role: member.role,
      addedBy: userId,
    })
    .onConflictDoUpdate({
      target: [schema.spaceMember.spaceId, schema.spaceMember.userId],
      set: { role: member.role },
    });
}

/** Takes a person out of a client space. */
export async function removeSpaceMember(
  userId: string,
  spaceId: string,
  memberId: string,
): Promise<void> {
  await requireClientSpaces();
  await requireAdmin();
  const space = await clientSpace(userId, spaceId);
  await db
    .delete(schema.spaceMember)
    .where(and(eq(schema.spaceMember.spaceId, space.id), eq(schema.spaceMember.userId, memberId)));
}

/** What of a space its clients reach: the items of each kind opened to them. */
export async function clientOpenOf(userId: string, spaceId: string) {
  await requireClientSpaces();
  const space = await firmSpace(userId, spaceId);
  return openToClients(space.id);
}

/**
 * Invites a client into a client space by their address: the Manage-App invites them into the
 * organization as a `client` (taking no seat), and the client space keeps the address until they
 * sign in for the first time (`claimClientInvites`). Cloud only: a local install has no accounts.
 */
export async function inviteClient(
  userId: string,
  spaceId: string,
  input: { email: string; lang: "de" | "en" },
): Promise<void> {
  await requireClientSpaces();
  await requireAdmin();
  const space = await clientSpace(userId, spaceId);
  if (!managed) {
    throw new ServiceError("refused", note("clientsInCloud"));
  }
  const email = input.email.trim().toLowerCase();
  await inviteMember(currentTenant(), { actorId: userId, email, role: "client", lang: input.lang });
  await db.insert(schema.spaceMember).values({
    id: nanoid(12),
    tenantId: currentTenant(),
    spaceId: space.id,
    userId: null,
    email,
    role: "client",
    addedBy: userId,
  });
}

/**
 * A person's first sign-in: the client spaces that invited their address take them in. Called
 * where the runtime signs a person in.
 */
export async function claimClientInvites(userId: string, email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!address) {
    return;
  }
  const pending = await db.query.spaceMember.findMany({
    where: and(
      eq(schema.spaceMember.tenantId, currentTenant()),
      eq(schema.spaceMember.email, address),
      isNull(schema.spaceMember.userId),
    ),
  });
  for (const row of pending) {
    const already = await db.query.spaceMember.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.spaceMember.spaceId, row.spaceId),
        eq(schema.spaceMember.userId, userId),
      ),
    });
    if (already) {
      await db.delete(schema.spaceMember).where(eq(schema.spaceMember.id, row.id));
    } else {
      await db.update(schema.spaceMember).set({ userId }).where(eq(schema.spaceMember.id, row.id));
    }
  }
}
