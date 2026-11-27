import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env.js";

/** The tenant a request, a run or a background job works for. Set once per entry, never from a request body. */
const current = new AsyncLocalStorage<{ tenantId: string }>();

export class NoTenantError extends Error {
  constructor() {
    super("No tenant in context: tenant tables are reached only inside inTenant().");
  }
}

/**
 * A runner of one tenant (`RUNNER_TENANT`) was asked to work for another. It runs that tenant's
 * own code as ordinary code, so it never opens another tenant's database or files.
 */
export class OtherTenantError extends Error {
  constructor(tenantId: string) {
    super(`This runner serves the tenant "${env.runner.tenant}" alone, not "${tenantId}".`);
  }
}

/** Throws where this process serves one tenant and `tenantId` is another. */
export function ownTenantOnly(tenantId: string) {
  if (env.runner.tenant && tenantId !== env.runner.tenant) {
    throw new OtherTenantError(tenantId);
  }
}

export function inTenant<T>(tenantId: string, fn: () => T): T {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error("bad tenant id");
  }
  ownTenantOnly(tenantId);
  return current.run({ tenantId }, fn);
}

export function currentTenant(): string {
  const store = current.getStore();
  if (!store) {
    throw new NoTenantError();
  }
  return store.tenantId;
}

export function currentTenantOrNull(): string | null {
  return current.getStore()?.tenantId ?? null;
}

/** The one tenant of a runtime that runs alone (desktop app, own machine). */
export const LOCAL_TENANT = "local";
