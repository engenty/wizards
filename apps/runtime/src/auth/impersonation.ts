import { AsyncLocalStorage } from "node:async_hooks";
import type { Lang } from "@engenty/wizards-shared/definition";

/**
 * A platform admin signed in as someone (the Manage-App's "Sign in as", the token's `act`):
 * the studio's requests run with the admin here, set once per request like the tenant. Runs
 * started then name the admin, and the person's account and organization stay as they are
 * (`refusedWhileImpersonating`, checked on every call to the Manage-App).
 */
interface Impersonating {
  adminId: string;
  lang: Lang;
}

const store = new AsyncLocalStorage<Impersonating>();

/** Runs `fn` as the admin signed in as someone; without an admin, as it is. */
export function asImpersonator<T>(adminId: string | null | undefined, lang: Lang, fn: () => T): T {
  return adminId ? store.run({ adminId, lang }, fn) : fn();
}

/** The admin signed in as the person this request is for; null for the person themselves. */
export function currentImpersonator(): Impersonating | null {
  return store.getStore() ?? null;
}

/**
 * The Manage-App's calls that change the person's account or their organization: people,
 * address, domains, API keys, name, connected apps and computers, the organization's name and
 * profile, the install mail, phone numbers — and the invoices, which carry payment details.
 */
const OFF: [RegExp, RegExp][] = [
  [/^(POST|DELETE)$/, /^\/v1\/tenants\/[^/]+\/invitations(\/|$)/],
  [/^(PATCH|DELETE)$/, /^\/v1\/tenants\/[^/]+\/members\//],
  [/^PUT$/, /^\/v1\/tenants\/[^/]+\/address$/],
  [/^(POST|DELETE)$/, /^\/v1\/tenants\/[^/]+\/domains(\/|$)/],
  [/^(POST|DELETE)$/, /^\/v1\/tenants\/[^/]+\/keys(\/|$)/],
  [/^GET$/, /^\/v1\/tenants\/[^/]+\/invoices\//],
  [/^(PATCH|PUT)$/, /^\/v1\/tenants\/[^/]+(\/profile)?$/],
  [/^(POST|DELETE)$/, /^\/v1\/tenants\/[^/]+\/channels\/requests$/],
  [/^PATCH$/, /^\/v1\/users\/[^/]+$/],
  [/^DELETE$/, /^\/v1\/users\/[^/]+\/(connections|computers)\//],
  [/^POST$/, /^\/v1\/install-mail$/],
];

/** Whether a call to the Manage-App stays off while an admin is signed in as the person. */
export function refusedWhileImpersonating(method: string, path: string): boolean {
  const bare = path.split("?")[0] ?? path;
  return OFF.some(([m, p]) => m.test(method) && p.test(bare));
}
