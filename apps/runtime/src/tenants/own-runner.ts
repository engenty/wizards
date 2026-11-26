import { featureOn } from "@engenty/wizards-shared/features";
import { env } from "../env.js";
import { managed, tenantInfo } from "../manage.js";

// A tenant with a runner of its own (docs/plans/kernel-runners.md, stage B): an admin switches
// it on at the Manage-App, which answers it in `GET /v1/tenants/:id` as `features.ownRunner`.
// Its runs wait for that runner; the shared runners never take them, not even while it is down.

/** What the Manage-App said last, per tenant: it counts while the Manage-App is out of reach. */
const said = new Map<string, boolean>();

/**
 * Whether the tenant has a runner of its own. Read as the rest of the tenant is, through
 * `tenantInfo`'s cache of a minute. Out of reach, the last answer counts; with none, it has none.
 */
export async function hasOwnRunner(tenant: string): Promise<boolean> {
  if (!managed) {
    return false;
  }
  try {
    const marked = featureOn((await tenantInfo(tenant)).features, "ownRunner");
    said.set(tenant, marked);
    return marked;
  } catch {
    return said.get(tenant) ?? false;
  }
}

/**
 * Whether this runner takes the tenant's runs: a tenant's runner only its own tenant's, a shared
 * runner those of every tenant without a runner of its own.
 */
export async function servesTenant(tenant: string): Promise<boolean> {
  if (env.runner.tenant) {
    return env.runner.tenant === tenant;
  }
  return !(await hasOwnRunner(tenant));
}

/** The tenants among these that have a runner of their own. */
export async function withOwnRunner(tenants: Iterable<string>): Promise<Set<string>> {
  const unique = [...new Set(tenants)];
  const marks = await Promise.all(unique.map(hasOwnRunner));
  return new Set(unique.filter((_, i) => marks[i]));
}
