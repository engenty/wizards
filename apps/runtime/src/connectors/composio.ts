import { featureOn } from "@engenty/wizards-shared/features";
import { note, type RunNote } from "@engenty/wizards-shared/run";
import { accountToken } from "../auth/account.js";
import { env } from "../env.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import { NotedError } from "../model-errors.js";
import { vaultDelete, vaultGet, vaultSet } from "../secrets/vault.js";
import { currentTenant } from "../tenants/tenant.js";

/*
 * Composio's catalog of services (docs/plans/composio.md). Composio keeps the tokens; the runtime
 * keeps only the id of a connected account. Two ways reach it, chosen per call:
 *
 * - `own`: a Composio key of the person's own on a computer of their own (decision 4), kept as
 *   the install's other keys are and never sent to the Manage-App. One Composio user per space
 *   and per person of the install.
 * - `account`: the Manage-App, which holds the product's Composio key and passes Composio's API
 *   through for one tenant's holder at a time (`/v1/connect/composio/*`): the cloud runtime with
 *   its service key, a local install with its linked account's token.
 *
 * Where both are there, the own key wins. A connected account stays with the way it was made:
 * its id is only known to that Composio project.
 */

export type ComposioWay = "own" | "account";

/** A service of Composio's catalog. */
export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  /** Composio signs in with an OAuth app of its own for it (decision 2), or asks nothing. */
  managed: boolean;
}

/** One tool of a toolkit: an action of the connector made from it. */
export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  /** The JSON schema of its arguments. */
  input: Record<string, unknown>;
  /** Composio's hints (`readOnlyHint`, `destructiveHint`, …) and its own words. */
  tags: string[];
}

/** Something the person can mend or retry; the message is for them. */
export class ComposioError extends NotedError {
  constructor(
    said: RunNote,
    /** Composio or the Manage-App said to wait this long, in seconds. */
    readonly retryAfter: number | null = null,
    /** The HTTP status that said no; null where nothing answered. */
    readonly status: number | null = null,
  ) {
    super(said);
  }
}

/** Whether the switch is on for the tenant at hand. */
export async function composioOn(): Promise<boolean> {
  return featureOn(await currentFeatures().catch(() => null), "composio");
}

// --- the own key -----------------------------------------------------------------------------

const KEY = "key.composio";
let ownKey: string | null | undefined;

/** The person's own Composio key on a computer of their own; never on a runtime of a Manage-App. */
export async function composioKey(): Promise<string | null> {
  if (managed) {
    return null;
  }
  if (ownKey === undefined) {
    ownKey = (await vaultGet(KEY)) ?? (env.composioKey || null);
  }
  return ownKey;
}

/** Keeps the own key; an empty one removes it. */
export async function setComposioKey(value: string): Promise<void> {
  if (managed) {
    throw new ComposioError(note("composioOwnKeyLocalOnly"));
  }
  const key = value.trim();
  if (key) {
    await vaultSet(KEY, key);
  } else {
    await vaultDelete(KEY);
  }
  ownKey = undefined;
  offered = null;
}

/** The own key as the settings page shows it: whether there is one, and its last four characters. */
export async function composioKeyHint(): Promise<{ set: boolean; masked: string | null }> {
  const key = await composioKey();
  return { set: Boolean(key), masked: key ? `…${key.slice(-4)}` : null };
}

// --- which way -------------------------------------------------------------------------------

let offered: { at: number; composio: boolean } | null = null;

/** The Manage-App this runtime asks: its own on a runtime of one, the linked account's else. */
const manageBase = () => (managed ? env.manage.url : env.local.accountUrl);

/** Whether the Manage-App passes Composio through (`GET /v1/connect` says `composio: true`). */
async function composioThroughAccount(): Promise<boolean> {
  if (offered && Date.now() - offered.at < (offered.composio ? 600_000 : 60_000)) {
    return offered.composio;
  }
  const composio = await fetch(`${manageBase()}/v1/connect`, { signal: AbortSignal.timeout(5000) })
    .then(async (res) =>
      res.ok ? ((await res.json()) as { composio?: boolean }).composio === true : false,
    )
    .catch(() => false);
  offered = { at: Date.now(), composio };
  return composio;
}

/** The way new sign-ins and the catalog take: the own key, else the Manage-App; null where neither. */
export async function composioWay(): Promise<ComposioWay | null> {
  if (await composioKey()) {
    return "own";
  }
  return (await composioThroughAccount()) ? "account" : null;
}

/**
 * Whether the catalog can be read the way new sign-ins take: the own key, the cloud's service
 * key, or a linked account's token. An install without either shows no catalog yet.
 */
export async function composioCatalogWay(): Promise<ComposioWay | null> {
  const way = await composioWay();
  if (way === "account" && !managed && !(await accountToken().catch(() => null))) {
    return null;
  }
  return way;
}

/** Forgets what was asked of the Manage-App (tests, a linked account that changed). */
export function forgetComposioWay() {
  offered = null;
  ownKey = undefined;
}

// --- Composio's own API, with the own key -------------------------------------------------------

const api = () => `${env.composioUrl}/api/v3`;

async function own<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = await composioKey();
  if (!key) {
    throw new ComposioError(note("composioNoKey"));
  }
  const res = await fetch(`${api()}${path}`, {
    method,
    headers: {
      "x-api-key": key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) {
    throw new ComposioError(note("composioNotReached"));
  }
  return answerOf<T>(res);
}

async function answerOf<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string | { message?: string };
    code?: string;
  };
  if (res.ok) {
    return data;
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    throw new ComposioError(
      note("composioBusy"),
      Number.isFinite(after) && after > 0 ? after : 60,
      429,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ComposioError(note("composioKeyRefused"), null, res.status);
  }
  const said = typeof data.error === "object" ? data.error?.message : data.error;
  throw new ComposioError(
    note("composioFailed", { detail: String(said ?? data.code ?? res.status).slice(0, 200) }),
    null,
    res.status,
  );
}

// --- the Manage-App's pass-through -------------------------------------------------------------

async function viaManage<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = managed ? env.manage.serviceKey : await accountToken();
  if (!token) {
    throw new ComposioError(note("connectEngentyAccountFirst"));
  }
  // The service key speaks for every tenant: the one at hand is named. A linked account's token names its own.
  const withTenant =
    managed && body && typeof body === "object" ? { ...body, tenant: currentTenant() } : body;
  const query =
    managed && method === "GET"
      ? `${path.includes("?") ? "&" : "?"}tenant=${encodeURIComponent(currentTenant())}`
      : "";
  const res = await fetch(`${manageBase()}/v1/connect/composio${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(withTenant === undefined ? {} : { "content-type": "application/json" }),
    },
    body: withTenant === undefined ? undefined : JSON.stringify(withTenant),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) {
    throw new ComposioError(note("engentyAccountNotReached"));
  }
  return answerOf<T>(res);
}

// --- the catalog -------------------------------------------------------------------------------

interface RawToolkit {
  slug: string;
  name?: string;
  meta?: { description?: string; logo?: string; categories?: ({ name?: string } | string)[] };
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  /** The Manage-App's shape: already ours. */
  description?: string;
  logo?: string | null;
  categories?: string[];
  managed?: boolean;
}

interface RawTool {
  slug: string;
  name?: string;
  description?: string;
  input_parameters?: Record<string, unknown>;
  input?: Record<string, unknown>;
  tags?: string[];
}

function toolkitOf(raw: RawToolkit): ComposioToolkit {
  const categories =
    raw.categories ??
    (raw.meta?.categories ?? [])
      .map((c) => (typeof c === "string" ? c : (c.name ?? "")))
      .filter(Boolean);
  return {
    slug: raw.slug,
    name: raw.name ?? raw.slug,
    description: (raw.description ?? raw.meta?.description ?? "").slice(0, 400),
    logo: raw.logo ?? raw.meta?.logo ?? null,
    categories,
    managed:
      raw.managed ?? (raw.no_auth === true || (raw.composio_managed_auth_schemes ?? []).length > 0),
  };
}

const toolOf = (raw: RawTool): ComposioTool => ({
  slug: raw.slug,
  name: raw.name ?? raw.slug,
  description: (raw.description ?? "").slice(0, 1000),
  input: raw.input ?? raw.input_parameters ?? { type: "object", properties: {} },
  tags: raw.tags ?? [],
});

/** Toolkits are slugs of letters, digits, `_` and `-`; nothing else reaches a path. */
export const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

const searches = new Map<string, { at: number; hits: ComposioToolkit[] }>();
const toolkits = new Map<string, { at: number; found: ToolkitWithTools | null }>();
const TEN_MINUTES = 600_000;

/** Composio's catalog, searched: the whole of it (decision 5), cached ten minutes. */
export async function searchToolkits(query: string, way: ComposioWay): Promise<ComposioToolkit[]> {
  const q = query.trim().slice(0, 80);
  const cacheKey = `${way}:${way === "account" && managed ? currentTenant() : ""}:${q}`;
  const hit = searches.get(cacheKey);
  if (hit && Date.now() - hit.at < TEN_MINUTES) {
    return hit.hits;
  }
  const params = new URLSearchParams({ limit: "50", ...(q ? { search: q } : {}) });
  const raw =
    way === "own"
      ? (await own<{ items?: RawToolkit[] }>("GET", `/toolkits?${params}`)).items
      : (
          await viaManage<{ toolkits?: RawToolkit[] }>(
            "GET",
            `/toolkits${q ? `?q=${encodeURIComponent(q)}` : ""}`,
          )
        ).toolkits;
  const hits = (raw ?? []).filter((t) => TOOLKIT_SLUG.test(t.slug)).map(toolkitOf);
  searches.set(cacheKey, { at: Date.now(), hits });
  return hits;
}

export interface ToolkitWithTools {
  toolkit: ComposioToolkit;
  tools: ComposioTool[];
}

/** One toolkit with its tools, cached ten minutes; null where Composio has none of that name. */
export async function toolkitTools(
  slug: string,
  way: ComposioWay,
): Promise<ToolkitWithTools | null> {
  if (!TOOLKIT_SLUG.test(slug)) {
    return null;
  }
  const cacheKey = `${way}:${way === "account" && managed ? currentTenant() : ""}:${slug}`;
  const hit = toolkits.get(cacheKey);
  if (hit && Date.now() - hit.at < TEN_MINUTES) {
    return hit.found;
  }
  let found: ToolkitWithTools | null;
  if (way === "own") {
    const toolkit = await own<RawToolkit>("GET", `/toolkits/${slug}`).catch((err) => {
      if (err instanceof ComposioError && err.status === 404) {
        return null;
      }
      throw err;
    });
    const tools = toolkit
      ? ((await own<{ items?: RawTool[] }>("GET", `/tools?toolkit_slug=${slug}&limit=500`)).items ??
        [])
      : [];
    found = toolkit ? { toolkit: toolkitOf(toolkit), tools: tools.map(toolOf) } : null;
  } else {
    const answer = await viaManage<{ toolkit?: RawToolkit | null; tools?: RawTool[] }>(
      "GET",
      `/toolkits?slug=${slug}`,
    );
    found = answer.toolkit
      ? { toolkit: toolkitOf(answer.toolkit), tools: (answer.tools ?? []).map(toolOf) }
      : null;
  }
  toolkits.set(cacheKey, { at: Date.now(), found });
  return found;
}

/** Forgets the cached catalog (tests). */
export function forgetComposioCatalog() {
  searches.clear();
  toolkits.clear();
}

// --- signing in --------------------------------------------------------------------------------

/**
 * The holder a connected account belongs to, as Composio's user id: the space, or one person.
 * Through the Manage-App it puts the tenant in front (`t:<tenant>/s:<space>`).
 */
export type ComposioHolder = `s:${string}` | `u:${string}`;

/** Composio's own OAuth app for a toolkit (decision 2): the auth config, made once where none is. */
async function managedAuthConfig(toolkit: string): Promise<string> {
  const listed = await own<{ items?: { id: string; is_composio_managed?: boolean }[] }>(
    "GET",
    `/auth_configs?toolkit_slug=${toolkit}&is_composio_managed=true`,
  );
  const found = (listed.items ?? []).find((c) => c.is_composio_managed !== false);
  if (found) {
    return found.id;
  }
  const made = await own<{ auth_config?: { id: string } }>("POST", "/auth_configs", {
    toolkit: { slug: toolkit },
    auth_config: { type: "use_composio_managed_auth" },
  });
  if (!made.auth_config?.id) {
    throw new ComposioError(note("composioFailed", { detail: "no auth config" }));
  }
  return made.auth_config.id;
}

/**
 * Composio's sign-in page for a toolkit and holder. With the own key Composio comes back to
 * `returnUrl` with `connected_account_id`; through the Manage-App with a `ticket`. `state` rides
 * along in both.
 */
export async function startComposioSignIn(
  way: ComposioWay,
  input: { toolkit: string; holder: ComposioHolder; returnUrl: string; state: string },
): Promise<string> {
  if (!TOOLKIT_SLUG.test(input.toolkit)) {
    throw new ComposioError(note("composioFailed", { detail: "toolkit" }));
  }
  if (way === "account") {
    return (await viaManage<{ url: string }>("POST", "/start", input)).url;
  }
  const back = new URL(input.returnUrl);
  back.searchParams.set("state", input.state);
  const linked = await own<{ redirect_url?: string }>("POST", "/connected_accounts/link", {
    auth_config_id: await managedAuthConfig(input.toolkit),
    user_id: input.holder,
    callback_url: back.href,
  });
  if (!linked.redirect_url) {
    throw new ComposioError(note("composioFailed", { detail: "no sign-in page" }));
  }
  return linked.redirect_url;
}

/**
 * Composio came back: the connected account's id, checked. Through the Manage-App the ticket is
 * redeemed there. With the own key, the id came in the address, so it must be active, of this
 * toolkit and of this holder: an address someone else made names nobody else's account.
 */
export async function finishComposioSignIn(
  way: ComposioWay,
  input:
    | { state: string; ticket: string }
    | { connectedAccountId: string; holder: ComposioHolder; toolkit: string },
): Promise<string> {
  if ("ticket" in input) {
    if (way !== "account") {
      throw new ComposioError(note("composioFailed", { detail: "ticket" }));
    }
    const { connectedAccountId } = await viaManage<{ connectedAccountId?: string }>(
      "POST",
      "/complete",
      input,
    );
    if (!connectedAccountId) {
      throw new ComposioError(note("composioFailed", { detail: "no account" }));
    }
    return connectedAccountId;
  }
  if (way !== "own") {
    throw new ComposioError(note("composioFailed", { detail: "account" }));
  }
  const account = await own<{
    id?: string;
    user_id?: string;
    status?: string;
    toolkit?: { slug?: string };
  }>("GET", `/connected_accounts/${encodeURIComponent(input.connectedAccountId)}`);
  if (
    account.id !== input.connectedAccountId ||
    account.user_id !== input.holder ||
    (account.toolkit?.slug && account.toolkit.slug !== input.toolkit) ||
    (account.status && account.status.toUpperCase() !== "ACTIVE")
  ) {
    throw new ComposioError(note("composioSignInNotFinished"));
  }
  return input.connectedAccountId;
}

/** Signs a connected account out at Composio; one that is gone there already is no failure. */
export async function composioSignOut(way: ComposioWay, connectedAccountId: string): Promise<void> {
  const id = encodeURIComponent(connectedAccountId);
  try {
    if (way === "own") {
      await own("DELETE", `/connected_accounts/${id}`);
    } else {
      await viaManage("DELETE", `/accounts/${id}`);
    }
  } catch (err) {
    if (err instanceof ComposioError && err.status === 404) {
      return;
    }
    throw err;
  }
}

// --- calls -------------------------------------------------------------------------------------

/** Runs one tool for a connected account; Composio's `data`, or an error the person can read. */
export async function executeComposioTool(
  way: ComposioWay,
  input: {
    connectedAccountId: string;
    holder: ComposioHolder;
    tool: string;
    arguments: Record<string, unknown>;
  },
): Promise<unknown> {
  const answer =
    way === "own"
      ? await own<{ data?: unknown; successful?: boolean; error?: string | null }>(
          "POST",
          `/tools/execute/${encodeURIComponent(input.tool)}`,
          {
            connected_account_id: input.connectedAccountId,
            user_id: input.holder,
            arguments: input.arguments,
          },
        )
      : await viaManage<{ data?: unknown; successful?: boolean; error?: string | null }>(
          "POST",
          "/execute",
          {
            connectedAccountId: input.connectedAccountId,
            tool: input.tool,
            input: input.arguments,
          },
        );
  if (answer.successful === false) {
    throw new ComposioError(
      note("composioFailed", { detail: String(answer.error ?? "").slice(0, 300) }),
    );
  }
  return answer.data ?? null;
}
