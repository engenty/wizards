import type { RegistryHit } from "@engenty/wizards-shared/connectors";
import type { DiscoverConnector } from "@engenty/wizards-shared/discover";
import { featureOn } from "@engenty/wizards-shared/features";
import type { SkillHit } from "@engenty/wizards-shared/skills";
import { eq } from "drizzle-orm";
import { searchRegistry } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import type { ServerKey } from "../texts.js";
import { notFound } from "./errors.js";
import { skillsOn } from "./skills.js";
import { searchSkills } from "./skills-registry.js";
import { ownedSpace } from "./spaces.js";

/**
 * Fähigkeiten › Entdecken (docs/plans/capabilities.md, part B6): one search over skills.sh and
 * integrations.sh. Both are asked at once, each with its own time to answer; one that fails or
 * takes too long leaves its list empty and says so, and the other still shows what it found.
 */

/** How long one directory may take before the search goes on without it. */
const WAIT_MS = 10_000;

function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("too late")), WAIT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** `www.Notion.so` and `notion.so` are one service. */
const plainDomain = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

/**
 * The services the space has: the domains of the definitions it imported, and the built-in
 * connectors it has a connection to (a built-in's id is its service's name: `hubspot`, `github`).
 */
async function spaceServices(spaceId: string) {
  const [imported, connections] = await Promise.all([
    db.query.spaceConnector.findMany({
      where: eq(schema.spaceConnector.spaceId, spaceId),
      columns: { record: true },
    }),
    db
      .select({ connectorId: schema.spaceConnection.connectorId })
      .from(schema.spaceConnection)
      .where(eq(schema.spaceConnection.spaceId, spaceId)),
  ]);
  return {
    domains: new Set(imported.map((r) => plainDomain(r.record.domain ?? ""))),
    connected: new Set(connections.map((c) => c.connectorId)),
  };
}

async function markSetUp(spaceId: string, hits: RegistryHit[]): Promise<DiscoverConnector[]> {
  const has = await spaceServices(spaceId);
  return hits.map((hit) => {
    const domain = plainDomain(hit.domain);
    const name = domain.split(".")[0] ?? "";
    return { ...hit, setUp: has.domains.has(domain) || has.connected.has(name) };
  });
}

export interface DiscoverFound {
  skills: SkillHit[];
  connectors: DiscoverConnector[];
  errors: { skills?: ServerKey; connectors?: ServerKey };
}

/** Skills and connectors for a few words, what the space has marked. */
export async function discover(
  userId: string,
  spaceId: string,
  query: string,
): Promise<DiscoverFound> {
  // Part of Fähigkeiten: not there while its switch is off.
  if (!featureOn(await currentFeatures(), "capabilities")) {
    throw notFound();
  }
  const space = await ownedSpace(userId, spaceId);
  const q = query.trim().slice(0, 100);
  if (q.length < 2) {
    return { skills: [], connectors: [], errors: {} };
  }
  const [skills, connectors] = await Promise.allSettled([
    // Skills stay out while their own switch is off.
    skillsOn().then(async (on) =>
      on ? (await within(searchSkills(userId, space.id, q))).hits : [],
    ),
    within(searchRegistry(q)).then((hits) => markSetUp(space.id, hits)),
  ]);
  const errors: DiscoverFound["errors"] = {};
  if (skills.status === "rejected") {
    errors.skills = "skillsRegistryDown";
  }
  if (connectors.status === "rejected") {
    errors.connectors = "connectorsRegistryDown";
  }
  return {
    skills: skills.status === "fulfilled" ? skills.value : [],
    connectors: connectors.status === "fulfilled" ? connectors.value : [],
    errors,
  };
}
