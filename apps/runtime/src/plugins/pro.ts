import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { accountToken, linkedAccount } from "../auth/account.js";
import { env } from "../env.js";
import { managed, verifySigned } from "../manage.js";
import { deleteSetting, readSetting, writeSetting } from "../settings.js";
import { MANIFEST_FILE } from "./discovery.js";
import { findNewPlugins, reloadPlugin } from "./loader.js";
import { signedByUs } from "./pro-keys.js";
import {
  currentEntitlement,
  ENTITLEMENT_SETTING,
  type Entitlement,
  type HeldBack,
  heldBackModules,
  INSTALLED_FILE,
  type InstalledModule,
  installedModule,
  proModulesDir,
  runtimeTag,
  setEntitlement,
} from "./pro-state.js";
import { loadedPlugin } from "./registry.js";

/*
 * Pro modules on a runtime that runs alone (docs/pro-modules.md): the closed
 * plugins the linked account's plan includes, fetched from its Manage-App.
 *
 *   GET /v1/modules?runtime=<release>              what is built for this release, the plan's
 *                                                  part of it, and the signed entitlement
 *   GET /v1/modules/:id/package?runtime=<release>  one module's zip
 *
 * A package is taken only when its SHA-256 and the signature over id, version, release and that
 * hash check out against a key this runtime carries (pro-keys.ts): neither the Manage-App nor
 * the way there can hand over code of their own.
 */

/** The audience of an entitlement, as the Manage-App signs it. */
const AUDIENCE = "urn:engenty:wizards:modules";
/** Larger packages are refused before they are read. */
const MAX_PACKAGE = 30 * 1024 * 1024;
/** What a package may hold, besides its manifest. */
const PARTS = ["dist/", "migrations/"];

const base = () => `${env.local.accountUrl}/v1/modules`;

/** Something the person can mend or retry; the message is for them. */
export class ProModuleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
    readonly code = "pro_module",
  ) {
    super(message);
  }
}

export interface ListedModule {
  id: string;
  name: string;
  version: string;
  description: string;
  size: number;
  sha256: string;
  signature: string;
  included: boolean;
}

interface Listing {
  runtime: string;
  plan: { id: string; name: string };
  modules: ListedModule[];
  entitlement: { token: string; expiresAt: string };
}

let listing: Listing | null = null;
let lastError: string | null = null;

// --- the entitlement -------------------------------------------------------------------

/**
 * At start, before the plugins load: what the last check said, while it lasts and belongs to the
 * account that is linked now.
 */
export async function loadEntitlement(): Promise<void> {
  if (managed) {
    return;
  }
  const [stored, account] = await Promise.all([
    readSetting<Entitlement>(ENTITLEMENT_SETTING),
    linkedAccount(),
  ]);
  setEntitlement(stored && account && stored.tenantId === account.tenantId ? stored : null);
}

async function keep(value: Entitlement | null) {
  setEntitlement(value);
  if (value) {
    await writeSetting(ENTITLEMENT_SETTING, value);
  } else {
    await deleteSetting(ENTITLEMENT_SETTING);
  }
}

/** Loads and unloads Pro modules after the entitlement changed. */
async function apply(before: Entitlement | null) {
  const after = currentEntitlement();
  const same =
    before?.modules.join() === after?.modules.join() &&
    (before?.expiresAt ?? 0) > Date.now() === (after?.expiresAt ?? 0) > Date.now();
  if (!same) {
    await findNewPlugins();
  }
}

async function call(path: string, token: string): Promise<Response> {
  const url = new URL(`${base()}${path}`);
  url.searchParams.set("runtime", runtimeTag());
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!res) {
    throw new ProModuleError("Your engenty account is not reachable right now.", 502, "offline");
  }
  return res;
}

/**
 * Asks the account what its plan includes now, keeps the signed answer and fetches what an
 * installed module needs (a new release, a new build). Unreachable: what was confirmed lasts
 * until it ends.
 */
export async function refreshPro(): Promise<void> {
  if (managed) {
    return;
  }
  const before = currentEntitlement();
  const account = await linkedAccount();
  if (!account) {
    listing = null;
    lastError = null;
    await keep(null);
    await apply(before);
    return;
  }
  try {
    const token = await accountToken();
    if (!token) {
      throw new ProModuleError("Your engenty account is not reachable right now.", 502, "offline");
    }
    const res = await call("", token);
    if (res.status === 401) {
      throw new ProModuleError("The engenty account no longer accepts this sign-in.", 403);
    }
    if (!res.ok) {
      throw new ProModuleError(`The account did not answer as expected (${res.status}).`, 502);
    }
    const answer = (await res.json()) as Listing;
    const claims = await verifySigned(
      answer.entitlement?.token ?? "",
      [AUDIENCE],
      env.local.accountUrl,
    );
    if (!claims || claims.sub !== account.tenantId || !Array.isArray(claims.modules)) {
      throw new ProModuleError("The package's confirmation could not be checked.", 502);
    }
    listing = answer;
    lastError = null;
    await keep({
      tenantId: account.tenantId,
      modules: (claims.modules as unknown[]).map(String),
      plan: answer.plan ?? null,
      expiresAt: (claims.exp ?? 0) * 1000,
      checkedAt: Date.now(),
    });
    await apply(before);
    await updateInstalled();
  } catch (err) {
    lastError = (err as Error).message;
    console.error("[pro modules]", lastError);
  }
}

let timer: NodeJS.Timeout | null = null;

/** Checks at start, then once a day while the runtime runs; a check that failed, within the hour. */
export function startProChecks() {
  if (managed || timer) {
    return;
  }
  void refreshPro();
  timer = setInterval(() => {
    const checkedAt = currentEntitlement()?.checkedAt ?? 0;
    if (lastError || Date.now() - checkedAt > 23 * 3600_000) {
      void refreshPro();
    }
  }, 3600_000);
  timer.unref();
}

// --- installing ------------------------------------------------------------------------

async function installedIds(): Promise<string[]> {
  const entries = await readdir(proModulesDir(), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
}

/** Installed modules built for another release or from another build are fetched anew. */
async function updateInstalled() {
  for (const id of await installedIds()) {
    const entry = listing?.modules.find((m) => m.id === id);
    const installed = installedModule(join(proModulesDir(), id));
    if (entry?.included && installed?.sha256 !== entry.sha256) {
      await installPro(id).catch((err) =>
        console.error(`[pro modules] ${id}: update failed:`, (err as Error).message),
      );
    }
  }
}

/** The files of a zip, refusing any that would land outside the module's folder. */
function filesOf(zip: Uint8Array): Record<string, Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new ProModuleError("The package is damaged.", 502);
  }
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) {
      continue;
    }
    const parts = name.split("/");
    const safe = parts.every((p) => p && p !== "." && p !== ".." && !p.includes("\\"));
    const allowed = name === MANIFEST_FILE || PARTS.some((part) => name.startsWith(part));
    if (!(safe && allowed)) {
      throw new ProModuleError(`The package holds a file it may not: ${name}`, 502);
    }
    out[name] = data;
  }
  return out;
}

/** Fetches one module of the plan, checks it and puts it in place; then it loads. */
export async function installPro(id: string): Promise<void> {
  if (managed) {
    throw new ProModuleError("Not available here.", 404, "not_found");
  }
  const token = await accountToken();
  if (!token) {
    throw new ProModuleError("Sign in to your engenty account first (Settings → Account).", 409);
  }
  if (!listing) {
    await refreshPro();
  }
  const entry = listing?.modules.find((m) => m.id === id);
  if (!entry) {
    throw new ProModuleError(
      `There is no build of this module for ${runtimeTag()}.`,
      404,
      "not_found",
    );
  }
  if (!entry.included) {
    throw new ProModuleError("This module is not part of your plan.", 403, "plan");
  }
  const res = await call(`/${encodeURIComponent(id)}/package`, token);
  if (!res.ok) {
    throw new ProModuleError(`The module could not be fetched (${res.status}).`, 502);
  }
  if (Number(res.headers.get("content-length") ?? 0) > MAX_PACKAGE) {
    throw new ProModuleError("The package is too large.", 502);
  }
  const zip = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const genuine =
    sha256 === entry.sha256 &&
    signedByUs({
      id,
      version: entry.version,
      runtime: runtimeTag(),
      sha256,
      signature: entry.signature,
    });
  if (zip.length > MAX_PACKAGE || !genuine) {
    throw new ProModuleError("The package is not signed by engenty and was discarded.", 502);
  }
  const files = filesOf(zip);
  const manifest = JSON.parse(new TextDecoder().decode(files[MANIFEST_FILE] ?? new Uint8Array()));
  if (manifest?.id !== id) {
    throw new ProModuleError("The package does not belong to this module.", 502);
  }

  const dir = proModulesDir();
  const target = join(dir, id);
  const fresh = join(dir, `.new-${id}-${randomBytes(4).toString("hex")}`);
  const old = join(dir, `.old-${id}-${randomBytes(4).toString("hex")}`);
  await mkdir(fresh, { recursive: true });
  try {
    for (const [path, data] of Object.entries(files)) {
      await mkdir(dirname(join(fresh, path)), { recursive: true });
      await writeFile(join(fresh, path), data);
    }
    const installed: InstalledModule = {
      id,
      version: entry.version,
      runtime: runtimeTag(),
      sha256,
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(fresh, INSTALLED_FILE), `${JSON.stringify(installed, null, 2)}\n`);
    if (existsSync(target)) {
      await rename(target, old);
    }
    await rename(fresh, target);
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
  await reloadPlugin(id);
}

/** Removes an installed module; its tables and what is in them stay. */
export async function removePro(id: string): Promise<void> {
  if (managed || !(await installedIds()).includes(id)) {
    throw new ProModuleError("This module is not installed.", 404, "not_found");
  }
  await rm(join(proModulesDir(), id), { recursive: true, force: true });
  await findNewPlugins();
}

// --- what the studio shows -------------------------------------------------------------

export interface ProModuleView {
  id: string;
  name: string;
  version: string;
  description: string;
  size: number | null;
  included: boolean;
  installed: { version: string; runtime: string } | null;
  loaded: boolean;
  /** Why an installed module does not load (pro-state.ts). */
  heldBack: HeldBack | null;
  update: boolean;
}

export async function proState() {
  const entitlement = currentEntitlement();
  const account = await linkedAccount();
  const ids = new Set([...(listing?.modules.map((m) => m.id) ?? []), ...(await installedIds())]);
  const modules: ProModuleView[] = [...ids].sort().map((id) => {
    const entry = listing?.modules.find((m) => m.id === id);
    const installed = installedModule(join(proModulesDir(), id));
    const plugin = loadedPlugin(id);
    return {
      id,
      name: entry?.name ?? plugin?.source.manifest.name ?? id,
      version: entry?.version ?? installed?.version ?? "",
      description: entry?.description ?? plugin?.source.manifest.description ?? "",
      size: entry?.size ?? null,
      included: entitlement?.modules.includes(id) ?? false,
      installed: installed ? { version: installed.version, runtime: installed.runtime } : null,
      loaded: Boolean(plugin?.source.pro),
      heldBack: heldBackModules().get(id) ?? null,
      update: Boolean(entry?.included && installed && installed.sha256 !== entry.sha256),
    };
  });
  return {
    linked: Boolean(account),
    /** Where the plans are: `<accountUrl>/billing`. */
    accountUrl: env.local.accountUrl,
    runtime: runtimeTag(),
    plan: entitlement?.plan ?? listing?.plan ?? null,
    expiresAt: entitlement ? new Date(entitlement.expiresAt).toISOString() : null,
    checkedAt: entitlement ? new Date(entitlement.checkedAt).toISOString() : null,
    error: lastError,
    modules,
  };
}
