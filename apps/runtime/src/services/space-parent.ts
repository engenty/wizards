import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";

/**
 * Which space a space reads its setup from, besides its own: a client space its parent
 * (docs/plans/client-spaces.md); with `orgSpaces` every space under the organization's root the
 * root (docs/plans/org-spaces.md). Null where it reads only its own.
 */
export interface SpaceReads {
  /** The space's parent it reads from. */
  parentId: string;
  /**
   * `client`: a client space, which runs only its parent's wizards. `root`: a space under the
   * root, which runs its own and the root's.
   */
  as: "client" | "root";
}

export async function readsOf(spaceId: string): Promise<SpaceReads | null> {
  const space = await db.query.space.findFirst({
    columns: { kind: true, parentId: true },
    where: eq(schema.space.id, spaceId),
  });
  if (!space?.parentId) {
    return null;
  }
  if (space.kind === "client") {
    return { parentId: space.parentId, as: "client" };
  }
  if ((await currentFeatures()).orgSpaces === true) {
    return { parentId: space.parentId, as: "root" };
  }
  return null;
}
