import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";

/**
 * Which space a space reads its setup from, besides its own: with `orgSpaces` every space under
 * the organization's root reads the root (docs/plans/org-spaces.md) and runs its own wizards and
 * the root's. Null where it reads only its own.
 */
export interface SpaceReads {
  /** The organization's root, which the space reads too. */
  parentId: string;
}

export async function readsOf(spaceId: string): Promise<SpaceReads | null> {
  const space = await db.query.space.findFirst({
    columns: { parentId: true },
    where: eq(schema.space.id, spaceId),
  });
  if (!space?.parentId || (await currentFeatures()).orgSpaces !== true) {
    return null;
  }
  return { parentId: space.parentId };
}

/**
 * The space whose brand files (logos, patterns, brand assets) a space shows: the root's where the
 * space takes the organization's brand and Info (`brandFrom: "root"`), else its own.
 */
export async function brandSpaceId(spaceId: string): Promise<string> {
  const space = await db.query.space.findFirst({
    columns: { brandFrom: true, parentId: true },
    where: eq(schema.space.id, spaceId),
  });
  if (
    space?.brandFrom === "root" &&
    space.parentId &&
    (await currentFeatures()).orgSpaces === true
  ) {
    return space.parentId;
  }
  return spaceId;
}
