import type { Context } from "hono";
import { env } from "./env.js";
import { allowed } from "./limits.js";
import { managed } from "./manage.js";

/**
 * The clients of the public run API: who starts runs here (docs/content/dev/api.md,
 * docs/plans/api-clients.md). A client names itself in the `x-wizards-client` header: `web` (the
 * runner in a browser), `app` (the mobile app), `cli`, or the id of a client registered at the
 * Manage-App. The id is no secret: it carries the terms, the limits and the revocation of a
 * client, not its proof. The run keeps it.
 *
 * A managed runtime fetches the list of clients from its Manage-App at the start and once an
 * hour, and keeps the last list when a fetch fails. Without a list every client may start runs:
 * the Manage-App being down must not close the wizards. A runtime that runs alone fetches
 * nothing and refuses nothing — its API is the person's own.
 */

export const CLIENT_HEADER = "x-wizards-client";

/** The clients this repository ships: the runner, the mobile app, the command line. */
export const OWN_CLIENTS = ["web", "app", "cli"] as const;

export interface Client {
  id: string;
  name: string;
  /** Runs an hour across all visitors; null = no cap. */
  runsPerHour: number | null;
  revoked: boolean;
}

export interface ClientList {
  clients: Client[];
  /** What an id not in the list gets: runs with a cap, or nothing. */
  unknown: { allow: boolean; runsPerHour: number | null };
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The client a request names, or null when it names none or a malformed one. */
export function clientOf(c: Pick<Context, "req">): string | null {
  const id = c.req.header(CLIENT_HEADER)?.trim().toLowerCase() ?? "";
  return ID.test(id) ? id : null;
}

let list: ClientList | null = null;

/** The list in force; tests set it, a managed runtime fetches it. */
export function setClientList(next: ClientList | null) {
  list = next;
}

export interface Refusal {
  status: 403 | 429;
  code: "client_refused" | "client_limit";
  /** What the visitor reads, a line of the run notes. */
  note: "clientRefused" | "clientLimit";
}

const HOUR = 3600_000;

/**
 * Why `client` may not start a run now, or null when it may. Counts the try against the
 * client's hourly cap, so call it once per start.
 */
export function clientRefused(client: string | null): Refusal | null {
  if (!list) {
    return null;
  }
  const known = list.clients.find((c) => c.id === client);
  const cap = known ? known.runsPerHour : list.unknown.runsPerHour;
  if (known ? known.revoked : !list.unknown.allow) {
    return {
      status: 403,
      code: "client_refused",
      note: "clientRefused",
    };
  }
  if (cap !== null && !allowed(`client:${client ?? "unknown"}`, cap, HOUR)) {
    return {
      status: 429,
      code: "client_limit",
      note: "clientLimit",
    };
  }
  return null;
}

/** The list as the Manage-App sends it, checked; throws on a shape this runtime does not know. */
export function parseClientList(body: unknown): ClientList {
  const raw = body as { clients?: unknown; unknown?: unknown };
  if (!Array.isArray(raw?.clients)) {
    throw new Error("no clients");
  }
  const clients = raw.clients.map((c: Record<string, unknown>) => {
    if (typeof c?.id !== "string" || !ID.test(c.id)) {
      throw new Error("bad client id");
    }
    return {
      id: c.id,
      name: typeof c.name === "string" ? c.name : c.id,
      runsPerHour: typeof c.runsPerHour === "number" && c.runsPerHour >= 0 ? c.runsPerHour : null,
      revoked: c.revoked === true,
    };
  });
  const unknown = (raw.unknown ?? {}) as Record<string, unknown>;
  return {
    clients,
    unknown: {
      allow: unknown.allow !== false,
      runsPerHour:
        typeof unknown.runsPerHour === "number" && unknown.runsPerHour >= 0
          ? unknown.runsPerHour
          : null,
    },
  };
}

/**
 * Fetches the Manage-App's list. A Manage-App without the call (404) means no list: everything
 * may start runs. Any other failure keeps the list from before.
 */
export async function loadClientList(): Promise<void> {
  if (!managed) {
    return;
  }
  try {
    const res = await fetch(`${env.manage.url}/v1/clients`, {
      headers: { authorization: `Bearer ${env.manage.serviceKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      list = null;
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    list = parseClientList(await res.json());
  } catch (err) {
    console.warn(`[clients] the Manage-App's client list was not read: ${(err as Error).message}`);
  }
}

/** A managed runtime: the list now, and again every hour. */
export function startClientChecks() {
  if (!managed) {
    return;
  }
  void loadClientList();
  setInterval(() => void loadClientList(), HOUR).unref();
}
