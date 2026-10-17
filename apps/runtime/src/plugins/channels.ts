import type { PluginServerApi } from "@engenty/wizards/plugin";
import {
  bookChannelUsage,
  ManageError,
  managed,
  requestChannelNumber,
  tenantChannels,
  withdrawChannelRequest,
} from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * `server.channels`: the numbers the Manage-App gives the current tenant
 * (docs/manage-contract.md, "Numbers of a tenant"). Without a Manage-App there are none.
 */

/** A refusal of the Manage-App as a plugin passes it on: its status and its code. */
const asked = <T>(work: Promise<T>): Promise<T> =>
  work.catch((err: unknown) => {
    throw err instanceof ManageError
      ? Object.assign(new Error(err.message), { status: err.status, code: err.code })
      : err;
  });

const unmanaged = () =>
  Object.assign(new Error("This runtime has no Manage-App, so it has no numbers."), {
    status: 404,
    code: "not_managed",
  });

export const channelsApi: PluginServerApi["channels"] = {
  async get() {
    if (!managed) {
      return null;
    }
    const c = await asked(tenantChannels(currentTenant()));
    return {
      number: c.number
        ? {
            number: c.number.number,
            country: c.number.country,
            kinds: c.number.kinds,
            providerRef: c.number.providerRef ?? null,
          }
        : null,
      request: c.request
        ? {
            id: c.request.id,
            country: c.request.country,
            wish: c.request.wish,
            createdAt: c.request.createdAt,
          }
        : null,
      shared: c.shared,
      allowed: c.allowed !== false,
    };
  },
  async request(input) {
    if (!managed) {
      throw unmanaged();
    }
    const { request } = await asked(
      requestChannelNumber(currentTenant(), {
        userId: input.userId,
        country: input.country.toUpperCase(),
        wish: input.wish ?? null,
        lang: input.lang,
      }),
    );
    return {
      id: request.id,
      country: request.country,
      wish: request.wish,
      createdAt: request.createdAt,
    };
  },
  async withdraw() {
    if (!managed) {
      throw unmanaged();
    }
    return (await asked(withdrawChannelRequest(currentTenant()))).withdrawn;
  },
  async book(input) {
    if (!managed || input.quantity <= 0) {
      return { credits: 0 };
    }
    return asked(
      bookChannelUsage(currentTenant(), {
        kind: input.kind,
        quantity: input.quantity,
        idempotencyKey: input.key,
        ...(input.runId ? { runId: input.runId } : {}),
      }),
    );
  },
};
