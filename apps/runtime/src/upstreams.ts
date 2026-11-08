/**
 * Own keys through the gateway (`ownKeysGateway`): an organization's own accounts at the
 * providers live in the Manage-App, and every model call of a cloud runtime goes to the gateway,
 * which runs it on such an account or on the credits (docs/manage-contract.md, "Own accounts").
 * The cloud runtime holds no model keys then. A computer keeps its keys in its vault, as before.
 *
 * Here: whether the switch is on for a tenant, the one-time move of the keys an organization had
 * saved in the cloud studio, and what the runtime remembers of its accounts.
 */
import type { ModelClass } from "@engenty/wizards-shared/definition";
import { type ProviderId, providerInfo } from "@engenty/wizards-shared/providers";
import { feature } from "./features.js";
import {
  addUpstream,
  ManageError,
  managed,
  tenantInfo,
  tenantUpstreams,
  type Upstreams,
} from "./manage.js";
import { seal, unseal } from "./secrets/crypto.js";
import { deleteTenantSetting, readTenantSetting, writeTenantSetting } from "./settings.js";

/** Whether the tenant's calls all go through the gateway. When the Manage-App can't say, they don't. */
export async function gatewayOnly(tenant: string | null): Promise<boolean> {
  if (!managed || !tenant) {
    return false;
  }
  const info = await tenantInfo(tenant).catch(() => null);
  return Boolean(info && feature("ownKeysGateway", info.features));
}

/** The Manage-App's `source` for a key of the studio; Replicate keys are not carried over. */
const SOURCE_OF: Partial<Record<ProviderId, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  fal: "fal",
  elevenlabs: "elevenlabs",
  gateway: "ai-gateway",
};

/** A key that did not move: the provider, and why in the Manage-App's (or the provider's) words. */
export interface KeptKey {
  provider: ProviderId;
  name: string;
  /** `refused`: the Manage-App or the provider refused it; `unsupported`: no account of that kind. */
  reason: "refused" | "unsupported";
  message: string | null;
}

/** The setting the cloud studio kept its keys in (models.ts, `StoredTenantModels`). */
interface StoredModels {
  bindings: Partial<Record<ModelClass, string>>;
  keys: string | null;
}

const NOTICE = "models:moved";

type Translate = (
  bindings: Partial<Record<ModelClass, string>>,
) => Promise<Partial<Record<ModelClass, string>>>;

const moving = new Map<string, Promise<void>>();
/** Tenants whose keys are all moved, in this process; and when a move cut short may try again. */
const moved = new Set<string>();
const retryAt = new Map<string, number>();

/**
 * Moves the keys a tenant saved in the cloud studio to the Manage-App, once: each becomes an
 * account named after its provider and leaves the setting. A key the Manage-App refuses, and a
 * Replicate key, is dropped too; the log says which, and the studio says it once (`takeNotice`).
 * A key the Manage-App could not take for now (it is down) stays for the next try. An account
 * that is already there (same source, same last four) is not added again, so a move cut short
 * goes on where it stopped. `translate` turns the provider bindings into what the gateway serves.
 */
export function moveTenantKeys(
  tenant: string,
  translate: Translate,
  written: () => void = () => undefined,
): Promise<void> {
  if (moved.has(tenant) || (retryAt.get(tenant) ?? 0) > Date.now()) {
    return Promise.resolve();
  }
  const running = moving.get(tenant);
  if (running) {
    return running;
  }
  const work = move(tenant, translate, written)
    .then((done) => {
      if (done) {
        moved.add(tenant);
        retryAt.delete(tenant);
      } else {
        retryAt.set(tenant, Date.now() + 5 * 60_000);
      }
    })
    .catch((err) => {
      console.error(`[own keys] ${tenant}: the move waits:`, (err as Error).message);
      retryAt.set(tenant, Date.now() + 5 * 60_000);
    })
    .finally(() => moving.delete(tenant));
  moving.set(tenant, work);
  return work;
}

/** Forgets that a tenant's keys were moved (a test, or a tenant that was deleted). */
export function forgetMove(tenant: string) {
  moved.delete(tenant);
  retryAt.delete(tenant);
}

async function move(tenant: string, translate: Translate, written: () => void): Promise<boolean> {
  const stored = await readTenantSetting<StoredModels>(tenant, "models");
  const keys = stored?.keys ? (unseal<Partial<Record<ProviderId, string>>>(stored.keys) ?? {}) : {};
  const bindings = stored?.bindings ?? {};
  const translated = await translate(bindings);
  const sameBindings = JSON.stringify(translated) === JSON.stringify(bindings);
  if (!Object.keys(keys).length) {
    if (stored?.keys || !sameBindings) {
      await writeTenantSetting(tenant, "models", {
        bindings: translated,
        keys: null,
      } satisfies StoredModels);
      written();
    }
    return true;
  }
  const present = (await tenantUpstreams(tenant)).accounts;
  const stay: Partial<Record<ProviderId, string>> = {};
  const kept: KeptKey[] = [];
  for (const [provider, raw] of Object.entries(keys) as [ProviderId, string | undefined][]) {
    const key = raw?.trim();
    if (!key) {
      continue;
    }
    const name = providerInfo(provider)?.name ?? provider;
    const source = SOURCE_OF[provider];
    if (!source) {
      kept.push({ provider, name, reason: "unsupported", message: null });
      continue;
    }
    if (present.some((a) => a.source === source && a.keyHint === key.slice(-4))) {
      continue;
    }
    try {
      await addUpstream(tenant, { source, label: name, key });
    } catch (err) {
      if (err instanceof ManageError && err.status >= 400 && err.status < 500) {
        kept.push({ provider, name, reason: "refused", message: err.message });
      } else {
        // The Manage-App is out of reach: the key waits for the next try.
        console.error(`[own keys] ${tenant}: ${provider} not moved yet:`, (err as Error).message);
        stay[provider] = key;
      }
    }
  }
  for (const k of kept) {
    console.warn(
      `[own keys] ${tenant}: the ${k.name} key was not moved (${k.reason}${k.message ? `: ${k.message}` : ""}); it is no longer kept here`,
    );
  }
  if (kept.length) {
    const earlier = (await readTenantSetting<KeptKey[]>(tenant, NOTICE)) ?? [];
    await writeTenantSetting(tenant, NOTICE, [...earlier, ...kept]);
  }
  await writeTenantSetting(tenant, "models", {
    bindings: translated,
    keys: Object.keys(stay).length ? seal(stay) : null,
  } satisfies StoredModels);
  written();
  accounts.delete(tenant);
  return !Object.keys(stay).length;
}

/** The keys the move left out, once: the studio shows them to the admins, then they are gone. */
export async function takeNotice(tenant: string): Promise<KeptKey[]> {
  const kept = await readTenantSetting<KeptKey[]>(tenant, NOTICE);
  if (kept?.length) {
    await deleteTenantSetting(tenant, NOTICE);
  }
  return kept ?? [];
}

// --- the accounts as the runtime last saw them ------------------------------------------------

const accounts = new Map<string, { at: number; value: Upstreams }>();

/** The tenant's accounts and the fallback switch, cached a minute; the studio reads them fresh. */
export async function upstreamsOf(tenant: string, fresh = false): Promise<Upstreams> {
  const hit = accounts.get(tenant);
  if (!fresh && hit && Date.now() - hit.at < 60_000) {
    return hit.value;
  }
  const value = await tenantUpstreams(tenant);
  accounts.set(tenant, { at: Date.now(), value });
  return value;
}

/** Forgets what was read of the tenant's accounts: one was added, changed or removed. */
export function forgetUpstreams(tenant: string) {
  accounts.delete(tenant);
}

/**
 * Whether the tenant had an account ready when the runtime last looked. A provider's "account is
 * empty" through the gateway is then the organization's own account, which its admins can top up.
 * Read without waiting: a failure is classified on the spot (engine/failures.ts).
 */
export function hasOwnAccount(tenant: string | null): boolean {
  if (!tenant) {
    return false;
  }
  const hit = accounts.get(tenant);
  if (!hit || Date.now() - hit.at > 60_000) {
    void gatewayOnly(tenant)
      .then((on) => (on ? upstreamsOf(tenant) : null))
      .catch(() => null);
  }
  return Boolean(hit?.value.accounts.some((a) => a.status === "ready"));
}
