import { note } from "@engenty/wizards-shared/run";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { openToClients, seedClientRules } from "../broker/rwx.js";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { inviteMember, managed } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { currentRole, requireAdmin } from "./access.js";
import { notFound, ServiceError } from "./errors.js";
import { ownedSpace } from "./spaces.js";

/*
 * The clients of a space (docs/plans/org-spaces.md): any space under the organization's root may
 * be shared with clients of the organization, who are in it (`space_member`, role `client`) and
 * see only the spaces they are in. Inviting clients is behind the `clientSpaces` switch and needs
 * `orgSpaces`; who is in a space shared with its members only needs `orgSpaces` alone.
 */

/** Clients are behind their switch, and in the organization's spaces: else they are not there. */
export async function requireClientSpaces(): Promise<void> {
  const features = await currentFeatures();
  if (features.clientSpaces !== true || features.orgSpaces !== true) {
    throw notFound();
  }
}

/** Who is in a space is kept with `orgSpaces`; a client in it needs `clientSpaces` too. */
async function requireSpaceMembers(role?: "member" | "client"): Promise<void> {
  if (role === "client") {
    await requireClientSpaces();
    return;
  }
  if ((await currentFeatures()).orgSpaces !== true) {
    throw notFound();
  }
}

/**
 * A space the organization shares with people: any space under its root (docs/plans/org-spaces.md)
 * — not the root, not someone's Mein Space.
 */
async function sharedSpace(userId: string, spaceId: string) {
  const space = await ownedSpace(userId, spaceId);
  if (currentRole() === "client" || space.kind !== "space" || !space.parentId) {
    throw notFound();
  }
  return space;
}

/**
 * Shares a run of a space with its clients, on purpose, or takes it back
 * (docs/plans/client-portal.md): until then a run the firm makes there stays the firm's.
 */
export async function shareWithClient(
  userId: string,
  runId: string,
  shared: boolean,
): Promise<{ sharedAt: string | null }> {
  await requireClientSpaces();
  if (currentRole() === "client") {
    throw notFound();
  }
  const [run] = await db
    .select({
      id: schema.run.id,
      clientSpaceId: schema.run.clientSpaceId,
      status: schema.run.status,
      wizardSpaceId: schema.wizard.spaceId,
    })
    .from(schema.run)
    .innerJoin(schema.wizard, eq(schema.wizard.id, schema.run.wizardId))
    .where(and(eq(schema.run.id, runId), eq(schema.run.tenantId, currentTenant())))
    .limit(1);
  if (!run) {
    throw notFound();
  }
  // The space the run is in: the one it carries, else its wizard's.
  const space = await sharedSpace(userId, run.clientSpaceId ?? run.wizardSpaceId);
  if (shared && run.status !== "done") {
    throw new ServiceError("refused", note("onlyFinishedResultsShared"));
  }
  const sharedAt = shared ? new Date() : null;
  // Shared, it carries its space, where the clients look for it.
  await db
    .update(schema.run)
    .set({ clientSharedAt: sharedAt, clientSpaceId: space.id })
    .where(eq(schema.run.id, run.id));
  return { sharedAt: sharedAt?.toISOString() ?? null };
}

/** Who is in a space: its clients and the people of the organization chosen for it. */
export async function listSpaceMembers(userId: string, spaceId: string) {
  await requireSpaceMembers();
  const space = await sharedSpace(userId, spaceId);
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

/** Puts a person of the organization into a space, as a client or as one of its people. */
export async function addSpaceMember(
  userId: string,
  spaceId: string,
  member: { userId: string; role: "member" | "client" },
): Promise<void> {
  await requireSpaceMembers(member.role);
  await requireAdmin();
  const space = await sharedSpace(userId, spaceId);
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
  if (member.role === "client") {
    await seedClientRules(space.id);
  }
}

/** Takes a person out of a space. */
export async function removeSpaceMember(
  userId: string,
  spaceId: string,
  memberId: string,
): Promise<void> {
  await requireSpaceMembers();
  await requireAdmin();
  const space = await sharedSpace(userId, spaceId);
  await db
    .delete(schema.spaceMember)
    .where(and(eq(schema.spaceMember.spaceId, space.id), eq(schema.spaceMember.userId, memberId)));
}

/** What of a space its clients reach: the items of each kind opened to them. */
export async function clientOpenOf(userId: string, spaceId: string) {
  await requireClientSpaces();
  const space = await ownedSpace(userId, spaceId);
  if (currentRole() === "client") {
    throw notFound();
  }
  return openToClients(space.id);
}

/**
 * Invites a client into a space by their address: the Manage-App invites them into the
 * organization as a `client` (taking no seat), and the space keeps the address until they sign in
 * for the first time (`claimClientInvites`). Cloud only: a local install has no accounts.
 */
export async function inviteClient(
  userId: string,
  spaceId: string,
  input: { email: string; lang: "de" | "en" },
): Promise<void> {
  await requireClientSpaces();
  await requireAdmin();
  const space = await sharedSpace(userId, spaceId);
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
  await seedClientRules(space.id);
}

/**
 * A person's first sign-in: the spaces that invited their address take them in. Called where the
 * runtime signs a person in.
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
