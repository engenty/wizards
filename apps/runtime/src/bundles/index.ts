import { createHash } from "node:crypto";
import type {
  BundleImported,
  BundleImportRequest,
  BundleLeftOut,
  BundleOrigin,
  BundlePreviewAnswer,
  BundleRemoval,
  BundleServerChoice,
  BundleServerPreview,
  BundleUpdate,
  BundleUpdateAnswer,
  BundleUpdated,
  BundleView,
} from "@engenty/wizards-shared/bundles";
import type { ConnectorView, ImportRequest } from "@engenty/wizards-shared/connectors";
import type { Lang, WizardDefinition } from "@engenty/wizards-shared/definition";
import { featureOn } from "@engenty/wizards-shared/features";
import { SKILL_LIMITS } from "@engenty/wizards-shared/skills";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  freeNames,
  importConnector,
  namesFromHost,
  previewSource,
} from "../connectors/external.js";
import { db, inTransaction, schema } from "../db/client.js";
import type { StoredRequiredHeader } from "../engenty/connections-external/types.js";
import { currentFeatures } from "../features.js";
import { errorText, noteOf } from "../model-errors.js";
import { requireAdmin, requireWritableSpace } from "../services/access.js";
import { notFound, ServiceError } from "../services/errors.js";
import {
  checkAlways,
  checkContent,
  contentHash,
  insertSkill,
  keepBlobs,
  skillsOn,
} from "../services/skills.js";
import { ownedSpace } from "../services/spaces.js";
import { currentTenant } from "../tenants/tenant.js";
import type { ServerKey } from "../texts.js";
import { fetchRepoZip, parseRepoAddress } from "./fetch.js";
import {
  Archive,
  MAX_ARCHIVE_MB,
  type PluginServer,
  type PluginSkill,
  type ReadPlugin,
  readPlugin,
} from "./read.js";

/**
 * A Connector that brings skills (docs/plans/capabilities-next.md, piece 4). A plugin for Claude
 * Code or Cursor is read from a public repository on GitHub or an uploaded zip (`read.ts`,
 * `fetch.ts`), shown, and taken into a space:
 *
 * - Each of its MCP servers over http becomes a connector through the path of a pasted address
 *   (`connectors/external.ts`): marked „nicht geprüft“, a new connection on it starts for the
 *   admins, and a private address is taken only on a computer of one's own.
 * - Each of its skills becomes a skill of the space with the source `plugin`: read only, its
 *   scripts off, on demand until someone says otherwise.
 * - `space_bundle` records what came together; the skills, the connectors and the connections
 *   set up on them carry its id.
 *
 * „Aktualisieren“ reads the origin again and takes what changed; the connectors, their
 * connections and sign-ins stay as they are. Removing takes all of it at once. Every call here
 * is for an admin of a space that can be changed on this runtime.
 */

type BundleRow = typeof schema.spaceBundle.$inferSelect;

/** Where a plugin is read from: a repository's address, or an uploaded file; and a folder in it. */
export type BundleSource =
  | { address: string; path?: string }
  | { file: { name: string; data: Uint8Array }; path?: string };

const refuse = (server: ServerKey, params?: Record<string, string | number>) =>
  new ServiceError("invalid", { server, params });

/** Part of Fähigkeiten, and an admin's: the space, where the asker may change it. */
async function adminSpace(userId: string, spaceId: string, change = true) {
  if (!featureOn(await currentFeatures(), "capabilities")) {
    throw notFound();
  }
  const space = await ownedSpace(userId, spaceId);
  if (change) {
    await requireWritableSpace(space.id);
  }
  await requireAdmin();
  return space;
}

async function bundleRow(id: string): Promise<BundleRow> {
  const row = await db.query.spaceBundle.findFirst({
    where: and(eq(schema.spaceBundle.id, id), eq(schema.spaceBundle.tenantId, currentTenant())),
  });
  if (!row) {
    throw notFound();
  }
  return row;
}

// --- reading ----------------------------------------------------------------------------------

async function readSource(source: BundleSource, lang: Lang) {
  const say = (err: unknown) => errorText(err, lang);
  if ("file" in source) {
    const { name, data } = source.file;
    if (!/\.(zip|plugin)$/i.test(name)) {
      throw refuse("bundleUploadKind");
    }
    if (data.length > MAX_ARCHIVE_MB * 1_000_000) {
      throw refuse("bundleTooLarge", { mb: MAX_ARCHIVE_MB });
    }
    const read = readPlugin(new Archive(data), {
      path: source.path,
      fallbackName: name.replace(/\.(zip|plugin)$/i, ""),
      say,
    });
    const path = "plugin" in read ? read.plugin.root.replace(/\/$/, "") : (source.path ?? "");
    const origin: BundleOrigin = { kind: "upload", file: name.slice(0, 200), path };
    return { origin, read };
  }
  const address = parseRepoAddress(source.address);
  if (!address) {
    throw refuse("bundleNotARepository");
  }
  const read = readPlugin(new Archive(await fetchRepoZip(address)), {
    path: source.path ?? address.path,
    fallbackName: address.repo.split("/")[1] ?? address.repo,
    say,
  });
  const path = "plugin" in read ? read.plugin.root.replace(/\/$/, "") : address.path;
  const origin: BundleOrigin = { kind: "github", repo: address.repo, ref: address.ref, path };
  return { origin, read };
}

/** Of what a space would take: the servers as the plugin names them and each skill's content. */
function hashOf(plugin: ReadPlugin): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        plugin.format,
        plugin.name,
        plugin.version,
        plugin.servers
          .map((s) => [s.key, s.url, s.transport, s.headers, s.keyHeader])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        plugin.skills
          .map((s) => [s.path, contentHash(s.intake.content)])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]),
    )
    .digest("hex");
}

/** The space's record of a plugin from this origin: the same repository and folder, or the same file's plugin. */
async function sameOrigin(
  spaceId: string,
  origin: BundleOrigin,
  name: string,
): Promise<BundleRow | null> {
  const rows = await db.query.spaceBundle.findMany({
    where: eq(schema.spaceBundle.spaceId, spaceId),
  });
  return (
    rows.find((row) =>
      origin.kind === "github"
        ? row.origin.kind === "github" &&
          row.origin.repo.toLowerCase() === origin.repo.toLowerCase() &&
          row.origin.path === origin.path
        : row.origin.kind === "upload" && row.name === name,
    ) ?? null
  );
}

const fixedHeaders = (server: PluginServer): StoredRequiredHeader[] =>
  server.headers.map((h) => ({ name: h.name, value: h.value, description: null }));

/** `slack` → `Slack`: a connector's name where the admin gives none. */
const nameOf = (key: string) => `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`.slice(0, 120);

const skillPreview = (skill: PluginSkill) => {
  const { content, skipped } = skill.intake;
  return {
    path: skill.path,
    name: content.name,
    description: content.description,
    chars: content.body.length,
    files: content.files.length + content.blobFiles.length,
    scripts: [...content.files, ...content.blobFiles].some((f) =>
      /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|php|go|rs)$/i.test(f.path),
    ),
    skipped: skipped.length,
  };
};

/** What is kept of a list of things left out: never the words of a refusal. */
const kept = (leftOut: BundleLeftOut[]): BundleLeftOut[] =>
  leftOut.map(({ detail: _detail, ...rest }) => rest);

/** Skills are taken where the space has them: with their switch off they are named as left out. */
async function withSkills(plugin: ReadPlugin): Promise<ReadPlugin> {
  if (await skillsOn()) {
    return plugin;
  }
  return {
    ...plugin,
    skills: [],
    leftOut: [
      ...plugin.leftOut,
      ...plugin.skills.map((s): BundleLeftOut => ({ kind: "skill", name: s.path })),
    ],
  };
}

/**
 * Reads a plugin before anything is taken: its name and version, each server over http as „Per
 * Adresse“ reads an address (its sign-in, its actions with what each was read as), its skills,
 * and what is left out. A server that cannot be read is left out with the reason in words: a
 * private address on a managed runtime, a server that does not answer. A repository of several
 * plugins answers with the list to choose from.
 */
export async function previewBundle(
  userId: string,
  spaceId: string,
  source: BundleSource,
  lang: Lang,
  choices: Record<string, Pick<BundleServerChoice, "signIn">> = {},
): Promise<BundlePreviewAnswer> {
  const space = await adminSpace(userId, spaceId);
  const { origin, read } = await readSource(source, lang);
  if ("choices" in read) {
    return { preview: null, plugins: read.choices };
  }
  const plugin = await withSkills(read.plugin);
  const found = await Promise.all(
    plugin.servers.map(async (server): Promise<BundleServerPreview | BundleLeftOut> => {
      try {
        const preview = await previewSource(space.id, {
          sourceKind: "mcp",
          sourceUrl: server.url,
          signIn: choices[server.key]?.signIn,
          headers: fixedHeaders(server),
        });
        return {
          key: server.key,
          url: server.url,
          transport: server.transport,
          headers: server.headers.map((h) => h.name),
          keyHeader: server.keyHeader,
          source: preview,
        };
      } catch (err) {
        return {
          kind: "server",
          name: server.key,
          reason: "refused",
          detail: errorText(err, lang).slice(0, 400),
        };
      }
    }),
  );
  const have = await db.$count(schema.spaceSkill, eq(schema.spaceSkill.spaceId, space.id));
  return {
    plugins: [],
    preview: {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      format: plugin.format,
      origin,
      hash: hashOf(plugin),
      servers: found.filter((s): s is BundleServerPreview => "source" in s),
      skills: plugin.skills.map(skillPreview),
      leftOut: [...found.filter((s): s is BundleLeftOut => "kind" in s), ...plugin.leftOut],
      skillsFree: Math.max(0, SKILL_LIMITS.perSpace - have),
      added: (await sameOrigin(space.id, origin, plugin.name))?.id ?? null,
    },
  };
}

// --- views ------------------------------------------------------------------------------------

async function viewOf(row: BundleRow): Promise<BundleView> {
  const [connectors, connections, skills] = await Promise.all([
    db.query.spaceConnector.findMany({
      where: and(
        eq(schema.spaceConnector.spaceId, row.spaceId),
        eq(schema.spaceConnector.bundleId, row.id),
      ),
      orderBy: [asc(schema.spaceConnector.createdAt)],
    }),
    db.query.spaceConnection.findMany({
      where: and(
        eq(schema.spaceConnection.spaceId, row.spaceId),
        eq(schema.spaceConnection.bundleId, row.id),
      ),
      orderBy: [asc(schema.spaceConnection.setUpAt)],
    }),
    db.query.spaceSkill.findMany({
      where: and(
        eq(schema.spaceSkill.spaceId, row.spaceId),
        eq(schema.spaceSkill.bundleId, row.id),
      ),
      orderBy: [asc(schema.spaceSkill.name)],
    }),
  ]);
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    version: row.version,
    description: row.description,
    format: row.format,
    origin: row.origin,
    hash: row.hash,
    leftOut: row.leftOut,
    connectors: connectors
      .map((c) => ({ id: c.id, name: c.record.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    connections: connections.map((c) => ({ id: c.id, name: c.name, connectorId: c.connectorId })),
    skills: skills.map((k) => ({
      id: k.id,
      name: k.name,
      description: k.description,
      mode: k.mode,
    })),
    addedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What came together in a space, each with its connectors, connections and skills. */
export async function listBundles(userId: string, spaceId: string): Promise<BundleView[]> {
  const space = await adminSpace(userId, spaceId, false);
  const rows = await db.query.spaceBundle.findMany({
    where: eq(schema.spaceBundle.spaceId, space.id),
    orderBy: [asc(schema.spaceBundle.createdAt)],
  });
  return Promise.all(rows.map(viewOf));
}

// --- taking -----------------------------------------------------------------------------------

/**
 * One server of a plugin as a connector of the space. Its sign-in is the admin's choice, else
 * what the server describes itself; where it asks for one and describes none, the header its
 * plugin names for a key.
 */
async function importServer(
  userId: string,
  spaceId: string,
  bundleId: string,
  server: PluginServer,
  choice: BundleServerChoice | undefined,
): Promise<{ connector: ConnectorView; warnings: string[] }> {
  const suggested = await freeNames(spaceId, namesFromHost(new URL(server.url).host));
  const request: ImportRequest = {
    sourceKind: "mcp",
    sourceUrl: server.url,
    id: choice?.id ?? suggested.id,
    toolPrefix: choice?.toolPrefix ?? suggested.toolPrefix,
    name: choice?.name ?? nameOf(server.key),
    ...(choice?.signIn ? { signIn: choice.signIn } : {}),
    ...(choice?.actionKinds ? { actionKinds: choice.actionKinds } : {}),
    ...(choice?.oauthClientId ? { oauthClientId: choice.oauthClientId } : {}),
    ...(choice?.oauthClientSecret ? { oauthClientSecret: choice.oauthClientSecret } : {}),
  };
  const from = { bundleId, headers: fixedHeaders(server) };
  try {
    return await importConnector(userId, spaceId, request, from);
  } catch (err) {
    if (!choice?.signIn && server.keyHeader && noteOf(err)?.code === "connectorSignInUnknown") {
      const signIn = { kind: "header" as const, ...server.keyHeader };
      return importConnector(userId, spaceId, { ...request, signIn }, from);
    }
    throw err;
  }
}

async function addSkill(spaceId: string, bundleId: string, skill: PluginSkill) {
  await keepBlobs(skill.intake.blobs);
  return insertSkill(spaceId, skill.intake.content, {
    source: "plugin",
    origin: skill.path,
    originHash: contentHash(skill.intake.content),
    rename: true,
    bundleId,
  });
}

/** Takes back what an import made so far: nothing of a plugin stays where a part of it failed. */
async function dropBundle(spaceId: string, id: string) {
  await inTransaction(async () => {
    const connectors = await db
      .select({ id: schema.spaceConnector.id })
      .from(schema.spaceConnector)
      .where(
        and(eq(schema.spaceConnector.spaceId, spaceId), eq(schema.spaceConnector.bundleId, id)),
      );
    const ids = connectors.map((c) => c.id);
    await db
      .delete(schema.spaceConnection)
      .where(
        and(
          eq(schema.spaceConnection.spaceId, spaceId),
          ids.length
            ? or(
                eq(schema.spaceConnection.bundleId, id),
                inArray(schema.spaceConnection.connectorId, ids),
              )
            : eq(schema.spaceConnection.bundleId, id),
        ),
      );
    await db
      .delete(schema.spaceConnector)
      .where(
        and(eq(schema.spaceConnector.spaceId, spaceId), eq(schema.spaceConnector.bundleId, id)),
      );
    await db
      .delete(schema.spaceSkill)
      .where(and(eq(schema.spaceSkill.spaceId, spaceId), eq(schema.spaceSkill.bundleId, id)));
    await db.delete(schema.spaceBundle).where(eq(schema.spaceBundle.id, id));
  });
}

/**
 * Takes a plugin into the space as it was shown: its servers over http as connectors, its skills
 * as skills, and the record of what came together. A plugin with skills and no server over http
 * brings its skills alone, one with a server and no skills its connector alone; one with neither
 * is refused. A server that fails stops the import and nothing stays: the admin leaves it out
 * (`take: false`) and tries again.
 */
export async function importBundle(
  userId: string,
  spaceId: string,
  source: BundleSource,
  input: BundleImportRequest,
  lang: Lang,
): Promise<BundleImported> {
  const space = await adminSpace(userId, spaceId);
  const { origin, read } = await readSource(source, lang);
  if ("choices" in read) {
    throw refuse("bundleChoose");
  }
  const plugin = await withSkills(read.plugin);
  const hash = hashOf(plugin);
  // Taken only as it was shown: a change since the person looked is shown first.
  if (input.hash && input.hash !== hash) {
    throw new ServiceError("revision_conflict", { server: "bundleChanged" });
  }
  if (await sameOrigin(space.id, origin, plugin.name)) {
    throw refuse("bundleAlreadyThere", { name: plugin.name });
  }
  const unknown = Object.keys(input.servers ?? {}).find(
    (key) => !plugin.servers.some((s) => s.key === key),
  );
  if (unknown !== undefined) {
    throw refuse("bundleServerUnknown", { key: unknown });
  }
  const servers = plugin.servers.filter((s) => input.servers?.[s.key]?.take !== false);
  const skills = input.skills
    ? plugin.skills.filter((s) => input.skills?.includes(s.path))
    : plugin.skills;
  if (!(servers.length || skills.length)) {
    throw refuse("bundleNothingToTake");
  }
  const have = await db.$count(schema.spaceSkill, eq(schema.spaceSkill.spaceId, space.id));
  if (have + skills.length > SKILL_LIMITS.perSpace) {
    throw refuse("skillsTooMany");
  }
  const id = nanoid(14);
  const taken = new Set(servers.map((s) => s.key));
  await db.insert(schema.spaceBundle).values({
    id,
    tenantId: currentTenant(),
    spaceId: space.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    format: plugin.format,
    origin,
    hash,
    // A server the admin left out is one the space did not take.
    leftOut: kept([
      ...plugin.servers
        .filter((s) => !taken.has(s.key))
        .map((s): BundleLeftOut => ({ kind: "server", name: s.key })),
      ...plugin.leftOut,
    ]),
    addedBy: userId,
  });
  const connectors: ConnectorView[] = [];
  const warnings: string[] = [];
  try {
    for (const server of servers) {
      try {
        const made = await importServer(userId, space.id, id, server, input.servers?.[server.key]);
        connectors.push(made.connector);
        warnings.push(...made.warnings.map((w) => `${server.key}: ${w}`));
      } catch (err) {
        throw new ServiceError("invalid", {
          server: "bundleServerFailed",
          params: { key: server.key, detail: errorText(err, lang).slice(0, 400) },
        });
      }
    }
    for (const skill of skills) {
      await addSkill(space.id, id, skill);
    }
  } catch (err) {
    await dropBundle(space.id, id);
    throw err;
  }
  return { bundle: await viewOf(await bundleRow(id)), connectors, warnings };
}

// --- updating ---------------------------------------------------------------------------------

/** The plugin at a bundle's origin now, read the way it was first. */
async function readAgain(
  row: BundleRow,
  file: { name: string; data: Uint8Array } | null,
  lang: Lang,
): Promise<ReadPlugin> {
  const { origin } = row;
  let source: BundleSource;
  if (file) {
    source = { file, path: origin.path };
  } else if (origin.kind === "github") {
    const tree = origin.ref ? `/tree/${encodeURIComponent(origin.ref)}` : "";
    source = { address: `https://github.com/${origin.repo}${tree}`, path: origin.path };
  } else {
    throw refuse("bundleUploadAgain");
  }
  const { read } = await readSource(source, lang);
  if ("choices" in read) {
    throw refuse("bundleNoPlugin");
  }
  return withSkills(read.plugin);
}

/** What the origin has now, set against what the space took. */
async function changesOf(row: BundleRow, plugin: ReadPlugin) {
  const [skills, connectors] = await Promise.all([
    db.query.spaceSkill.findMany({
      where: and(
        eq(schema.spaceSkill.spaceId, row.spaceId),
        eq(schema.spaceSkill.bundleId, row.id),
      ),
    }),
    db.query.spaceConnector.findMany({
      where: and(
        eq(schema.spaceConnector.spaceId, row.spaceId),
        eq(schema.spaceConnector.bundleId, row.id),
      ),
    }),
  ]);
  const byPath = new Map(skills.map((k) => [k.origin ?? "", k]));
  const paths = new Set(plugin.skills.map((s) => s.path));
  const urls = new Set(plugin.servers.map((s) => s.url));
  const have = new Set(connectors.map((c) => c.record.source_url));
  // A server the admin left out when the plugin was taken stays out; the record names it.
  const leftOutBefore = new Set(
    row.leftOut.filter((l) => l.kind === "server" && !l.reason).map((l) => l.name),
  );
  return {
    added: plugin.skills.filter((s) => !byPath.has(s.path)),
    changed: plugin.skills.flatMap((s) => {
      const skill = byPath.get(s.path);
      return skill && skill.originHash !== contentHash(s.intake.content)
        ? [{ skill, next: s }]
        : [];
    }),
    removed: skills.filter((k) => !paths.has(k.origin ?? "")),
    newServers: plugin.servers.filter((s) => !(have.has(s.url) || leftOutBefore.has(s.key))),
    goneConnectors: connectors.filter((c) => !urls.has(c.record.source_url)),
    leftOutBefore,
  };
}

/**
 * Whether the origin changed since the plugin was taken, and what: skills new, changed or gone,
 * servers new or no longer named. A plugin from a file has no origin to ask (`upload`).
 */
export async function bundleUpdate(
  userId: string,
  id: string,
  lang: Lang,
): Promise<BundleUpdateAnswer> {
  const row = await bundleRow(id);
  await adminSpace(userId, row.spaceId, false);
  if (row.origin.kind === "upload") {
    return { update: null, upload: true };
  }
  const plugin = await readAgain(row, null, lang);
  const hash = hashOf(plugin);
  if (hash === row.hash) {
    return { update: null, upload: false };
  }
  return { update: await updateOf(row, plugin, hash), upload: false };
}

async function updateOf(row: BundleRow, plugin: ReadPlugin, hash: string): Promise<BundleUpdate> {
  const changes = await changesOf(row, plugin);
  return {
    version: plugin.version,
    hash,
    skills: {
      added: changes.added.map((s) => s.intake.content.name),
      changed: changes.changed.map((c) => c.skill.name),
      removed: changes.removed.map((k) => k.name),
    },
    servers: {
      added: changes.newServers.map((s) => ({ key: s.key, url: s.url })),
      removed: changes.goneConnectors.map((c) => ({ connectorId: c.id, name: c.record.name })),
    },
    leftOut: kept(plugin.leftOut),
  };
}

/**
 * Takes the origin's state of now. A skill that changed is replaced and keeps its name, when it
 * counts and whether its scripts run; a new one comes on demand; one the origin dropped goes. A
 * connector, its connections and their sign-ins stay as they are. A new server becomes a new
 * connector, „nicht geprüft“ like the first; one that cannot be imported as it stands is named
 * and the rest is taken. A connector whose server the origin no longer names leaves the bundle
 * and stays a connector of its own: nothing a wizard uses goes away, and no sign-in is sent to
 * an address that changed. A plugin from a file is updated with the new file.
 */
export async function applyBundleUpdate(
  userId: string,
  id: string,
  input: { hash?: string; file?: { name: string; data: Uint8Array } },
  lang: Lang,
): Promise<BundleUpdated> {
  const row = await bundleRow(id);
  const space = await adminSpace(userId, row.spaceId);
  const plugin = await readAgain(row, input.file ?? null, lang);
  const hash = hashOf(plugin);
  // Taken only as it was shown: a change since the person looked is shown first.
  if (input.hash && input.hash !== hash) {
    throw new ServiceError("revision_conflict", { server: "bundleChanged" });
  }
  const changes = await changesOf(row, plugin);
  const others = await db.$count(schema.spaceSkill, eq(schema.spaceSkill.spaceId, space.id));
  if (others - changes.removed.length + changes.added.length > SKILL_LIMITS.perSpace) {
    throw refuse("skillsTooMany");
  }
  // What the space would refuse is said before anything is written.
  const replaced = [];
  for (const { skill, next } of changes.changed) {
    const content = checkContent({ ...next.intake.content, name: skill.name });
    await checkAlways(skill.spaceId, skill.id, skill.mode, content.body);
    replaced.push({ skill, next, content });
  }
  for (const { skill, next, content } of replaced) {
    await keepBlobs(next.intake.blobs);
    await db
      .update(schema.spaceSkill)
      .set({
        description: content.description,
        body: content.body,
        meta: content.meta,
        files: content.files,
        blobFiles: content.blobFiles,
        originHash: contentHash(next.intake.content),
        updatedAt: new Date(),
      })
      .where(eq(schema.spaceSkill.id, skill.id));
  }
  if (changes.removed.length) {
    await db.delete(schema.spaceSkill).where(
      inArray(
        schema.spaceSkill.id,
        changes.removed.map((k) => k.id),
      ),
    );
  }
  for (const skill of changes.added) {
    await addSkill(space.id, row.id, skill);
  }
  for (const connector of changes.goneConnectors) {
    await db
      .update(schema.spaceConnector)
      .set({ bundleId: null })
      .where(
        and(
          eq(schema.spaceConnector.spaceId, space.id),
          eq(schema.spaceConnector.id, connector.id),
        ),
      );
    await db
      .update(schema.spaceConnection)
      .set({ bundleId: null })
      .where(
        and(
          eq(schema.spaceConnection.spaceId, space.id),
          eq(schema.spaceConnection.connectorId, connector.id),
        ),
      );
  }
  const notTaken: BundleUpdated["notTaken"] = [];
  for (const server of changes.newServers) {
    try {
      await importServer(userId, space.id, row.id, server, undefined);
    } catch (err) {
      notTaken.push({ key: server.key, detail: errorText(err, lang).slice(0, 400) });
    }
  }
  const out = new Set([...changes.leftOutBefore, ...notTaken.map((n) => n.key)]);
  await db
    .update(schema.spaceBundle)
    .set({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      format: plugin.format,
      hash,
      leftOut: kept([
        ...plugin.servers
          .filter((s) => out.has(s.key))
          .map((s): BundleLeftOut => ({ kind: "server", name: s.key })),
        ...plugin.leftOut,
      ]),
      ...(input.file && row.origin.kind === "upload"
        ? { origin: { ...row.origin, file: input.file.name.slice(0, 200) } }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.spaceBundle.id, row.id));
  return { bundle: await viewOf(await bundleRow(row.id)), notTaken };
}

// --- removing ---------------------------------------------------------------------------------

/** The names by which a definition's connections reach the space's connections `ids`. */
function usedIn(definition: WizardDefinition, ids: Map<string, string>): string[] {
  return (definition.connections ?? []).flatMap((c) => {
    const name = c.spaceConnection ? ids.get(c.spaceConnection) : undefined;
    return name === undefined ? [] : [name];
  });
}

/**
 * What removing takes with it, asked before it is removed: the connectors, their connections,
 * the skills, and the wizards whose draft or published version uses one of the connections.
 */
export async function bundleRemoval(userId: string, id: string): Promise<BundleRemoval> {
  const row = await bundleRow(id);
  await adminSpace(userId, row.spaceId, false);
  const view = await viewOf(row);
  const connectorIds = view.connectors.map((c) => c.id);
  const connections = connectorIds.length
    ? await db.query.spaceConnection.findMany({
        where: and(
          eq(schema.spaceConnection.spaceId, row.spaceId),
          or(
            eq(schema.spaceConnection.bundleId, row.id),
            inArray(schema.spaceConnection.connectorId, connectorIds),
          ),
        ),
        orderBy: [asc(schema.spaceConnection.setUpAt)],
      })
    : [];
  const names = new Map(connections.map((c) => [c.id, c.name]));
  const wizards: BundleRemoval["wizards"] = [];
  if (names.size) {
    const rows = await db.query.wizard.findMany({
      where: eq(schema.wizard.spaceId, row.spaceId),
      columns: { id: true, title: true, draft: true, publishedVersion: true },
      orderBy: [asc(schema.wizard.title)],
    });
    for (const wizard of rows) {
      const published =
        wizard.publishedVersion === null
          ? null
          : await db.query.wizardVersion.findFirst({
              where: and(
                eq(schema.wizardVersion.wizardId, wizard.id),
                eq(schema.wizardVersion.version, wizard.publishedVersion),
              ),
              columns: { definition: true },
            });
      const used = new Set([
        ...usedIn(wizard.draft, names),
        ...(published ? usedIn(published.definition, names) : []),
      ]);
      if (used.size) {
        wizards.push({ id: wizard.id, title: wizard.title, connections: [...used].sort() });
      }
    }
  }
  return {
    connectors: view.connectors,
    connections: connections.map((c) => ({ id: c.id, name: c.name })),
    skills: view.skills.map((k) => ({ id: k.id, name: k.name })),
    wizards,
  };
}

/** Removes what came together, all at once: the connectors, their connections and the skills. */
export async function removeBundle(userId: string, id: string): Promise<void> {
  const row = await bundleRow(id);
  await adminSpace(userId, row.spaceId);
  await dropBundle(row.spaceId, row.id);
}
