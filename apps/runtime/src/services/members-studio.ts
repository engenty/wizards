import { featureOn } from "@engenty/wizards-shared/features";
import { note } from "@engenty/wizards-shared/run";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { currentRole, isAdminRole, requireAdmin } from "./access.js";
import { ServiceError } from "./errors.js";

/**
 * Members in the Studio, one rule per space (docs/plans/capabilities.md, "Who sees the place"):
 * „Mitglieder dürfen ins Studio“. Behind the `capabilities` switch; while it is off, a member
 * reaches every space's studio API as before and edits what is there.
 *
 * With the switch on, a member of an organization reaches a space's studio API only where its
 * admins opened the Studio to members. There they build and test wizards and add and change
 * skills, knowledge and data. They publish nothing and share nothing outside the space, and they
 * set up no connection and change no rule: those stay with the admins (their own guards). Work
 * keeps what it reads in every space: the space's wizards to start, its files, its connectors and
 * connections.
 */

const CLOSED = () => new ServiceError("forbidden", note("studioClosedToMembers"));
const PUBLISH = () => new ServiceError("forbidden", note("onlyAdminsPublish"));

/** Whether the rule counts here: an organization's member, with `capabilities` on. */
async function ruledMember(): Promise<boolean> {
  return (
    managed && !isAdminRole(currentRole()) && featureOn(await currentFeatures(), "capabilities")
  );
}

/** Whether the person at hand builds in this space's Studio: always, but for a member by the rule. */
export async function studioOpen(space: { membersStudio: boolean }): Promise<boolean> {
  return space.membersStudio || !(await ruledMember());
}

/**
 * Making a wizard in a space: the admins', and with the switch on also the members' where the
 * Studio is open to them.
 */
export async function requireMaker(space: () => Promise<string>): Promise<void> {
  if (!(await ruledMember())) {
    return requireAdmin();
  }
  if (!(await openToMembers(await space()))) {
    throw CLOSED();
  }
}

async function openToMembers(spaceId: string): Promise<boolean> {
  const space = await db.query.space.findFirst({
    where: and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())),
    columns: { membersStudio: true },
  });
  // A space that is not there is the route's "not found", not ours.
  return space?.membersStudio ?? true;
}

/** What Work reads in any space of the organization, whatever the rule says. */
const WORK_READS =
  /^\/spaces\/[^/]+\/(wizards|files(\/[^/]+\/(content|text))?|connectors|connections)$/;

/** Publishing and sharing outside the space: the admins' alone. */
const PUBLISHING: [string, RegExp][] = [
  ["POST", /^\/wizards\/[^/]+\/(publish|rotate-link|cloud)$/],
  // Its settings: the link on or off, its limits, its channels, its translation, its space.
  ["PATCH", /^\/wizards\/[^/]+$/],
  ["PUT", /^\/wizards\/[^/]+\/translations\/[^/]+$/],
  ["DELETE", /^\/wizards\/[^/]+\/translations\/[^/]+$/],
];

/** The space a studio request is about, from its address: an id, or an item of the space. */
async function spaceOf(path: string): Promise<string | null> {
  const [, kind, id, sub] = path.split("/");
  if (!id) {
    return null;
  }
  const one = async <T extends { spaceId: string }>(found: Promise<T | undefined>) =>
    (await found)?.spaceId ?? null;
  const tenant = currentTenant();
  switch (kind) {
    case "spaces":
      return id;
    case "wizards":
      return one(
        db.query.wizard.findFirst({
          where: and(eq(schema.wizard.id, id), eq(schema.wizard.tenantId, tenant)),
          columns: { spaceId: true },
        }),
      );
    case "tables":
      return one(
        db.query.spaceTable.findFirst({
          where: eq(schema.spaceTable.id, id),
          columns: { spaceId: true },
        }),
      );
    case "pages":
      return one(
        db.query.spacePage.findFirst({
          where: eq(schema.spacePage.id, id),
          columns: { spaceId: true },
        }),
      );
    case "categories":
      return one(
        db.query.spaceCategory.findFirst({
          where: eq(schema.spaceCategory.id, id),
          columns: { spaceId: true },
        }),
      );
    case "values": {
      const value = await db.query.spaceCategoryValue.findFirst({
        where: eq(schema.spaceCategoryValue.id, id),
        columns: { categoryId: true },
      });
      return value ? spaceOf(`/categories/${value.categoryId}`) : null;
    }
    case "skills":
      return one(
        db.query.spaceSkill.findFirst({
          where: eq(schema.spaceSkill.id, id),
          columns: { spaceId: true },
        }),
      );
    case "connections":
      // A person's own sign-in is theirs, in their menu.
      return sub === "my-sign-in"
        ? null
        : one(
            db.query.spaceConnection.findFirst({
              where: eq(schema.spaceConnection.id, id),
              columns: { spaceId: true },
            }),
          );
    default:
      return null;
  }
}

/**
 * The studio API for a member, after the guard in app.ts set who they are: refuses a space whose
 * Studio is closed to members, and publishing anywhere. Admins and owners pass untouched.
 */
export async function membersStudioGate(c: Context, next: Next): Promise<void> {
  if (!(await ruledMember())) {
    return next();
  }
  const method = c.req.method;
  const path = c.req.path.slice(c.req.path.indexOf("/api/studio") + "/api/studio".length);
  if (PUBLISHING.some(([m, re]) => m === method && re.test(path))) {
    throw PUBLISH();
  }
  if (method === "GET" && WORK_READS.test(path)) {
    return next();
  }
  const spaceId = await spaceOf(path);
  if (spaceId && !(await openToMembers(spaceId))) {
    throw CLOSED();
  }
  return next();
}
