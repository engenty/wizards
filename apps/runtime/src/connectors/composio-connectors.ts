import type { ConnectorView } from "@engenty/wizards-shared/connectors";
import { note } from "@engenty/wizards-shared/run";
import { z } from "zod";
import { classifyMcpTool, groupOf } from "../engenty/connections-external/importer/classify.js";
import type {
  ConnectorAction,
  ConnectorActionGroup,
  ConnectorDefinition,
  ConnectorOAuth2Config,
} from "../engenty/connections-sdk/types.js";
import {
  ComposioError,
  type ComposioHolder,
  type ComposioTool,
  type ComposioToolkit,
  type ComposioWay,
  composioOn,
  composioWay,
  executeComposioTool,
  searchToolkits,
  TOOLKIT_SLUG,
  toolkitTools,
} from "./composio.js";

/*
 * Composio as a source of connectors (docs/plans/composio.md, step 3): a connector per toolkit
 * (`composio-gmail`, …), its actions from the toolkit's tools, each with its kind so a space's
 * rules apply as they do now. Nothing is imported or kept: the connector is made from the catalog
 * when it is named, and the space's connection keeps only the id of the connected account.
 */

export const COMPOSIO_PREFIX = "composio-";

/** The connector id of a toolkit. */
export const composioConnectorId = (toolkit: string) => `${COMPOSIO_PREFIX}${toolkit}`;

/** The toolkit of a connector id; null where the id is not Composio's. */
export function toolkitOfConnector(id: string): string | null {
  if (!id.startsWith(COMPOSIO_PREFIX)) {
    return null;
  }
  const slug = id.slice(COMPOSIO_PREFIX.length);
  return TOOLKIT_SLUG.test(slug) ? slug : null;
}

/**
 * The sign-in of every Composio connector: no OAuth client of ours. Composio's own page signs the
 * person in (`startComposioSignIn`); this config is only what tells it from another connector.
 */
export const COMPOSIO_OAUTH2: ConnectorOAuth2Config = {
  authUrl: "",
  tokenUrl: "",
  baseScopes: [],
};

export function isComposioConnector(connector: ConnectorDefinition): boolean {
  return connector.auth.kind === "oauth2" && connector.auth.oauth2 === COMPOSIO_OAUTH2;
}

/** What a space's connection keeps of a Composio sign-in, sealed: no token, only whose account it is. */
export interface ComposioSecret {
  /** The connected account's id at Composio. */
  composio: string;
  /** The way it was made: its id is known only there. */
  way: ComposioWay;
  holder: ComposioHolder;
  toolkit: string;
}

export function composioSecretOf(accessToken: string): ComposioSecret | null {
  try {
    const parsed = JSON.parse(accessToken) as Partial<ComposioSecret>;
    return typeof parsed.composio === "string" &&
      (parsed.way === "own" || parsed.way === "account") &&
      typeof parsed.holder === "string" &&
      typeof parsed.toolkit === "string"
      ? (parsed as ComposioSecret)
      : null;
  } catch {
    return null;
  }
}

/** A tool's action id: its slug in lower case without the toolkit in front (`GMAIL_SEND_EMAIL` → `send_email`). */
export function actionIdOf(toolkit: string, slug: string): string {
  const lower = slug.toLowerCase();
  const prefix = `${toolkit.replace(/-/g, "_")}_`;
  const id = lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
  return id.replace(/[^a-z0-9_]/g, "_").slice(0, 120) || lower;
}

/** Words that say an action can't be undone, beside Composio's `destructiveHint`. */
const DESTRUCTIVE_WORDS = /(^|_)(delete|remove|destroy|purge|revoke|trash|terminate|cancel)(_|$)/;

/**
 * What a tool does, as the rules see it. Composio's hints (`readOnlyHint`, `destructiveHint`)
 * first; a tool without one is never a read, so it counts as a change until Composio says
 * otherwise. A change whose name says send, mail, message or post is a send; one whose name
 * says delete, remove or trash is destructive.
 */
export function kindOfTool(toolkit: string, tool: ComposioTool): ConnectorActionGroup {
  const hints = new Set(tool.tags.map((t) => t.toLowerCase()));
  const hinted = classifyMcpTool({
    readOnlyHint: hints.has("readonlyhint"),
    destructiveHint: hints.has("destructivehint"),
  });
  if (hinted !== "write") {
    return hinted;
  }
  const id = actionIdOf(toolkit, tool.slug);
  if (DESTRUCTIVE_WORDS.test(id)) {
    return "destructive";
  }
  return groupOf({
    classification: "write",
    id,
    summary: tool.name,
    invoke: { kind: "mcp", tool_name: tool.slug } as never,
  });
}

/** A tool's input as zod, for the AI's tool and the broker's checks; any object where the schema can't be read. */
function inputOf(tool: ComposioTool): z.ZodType {
  try {
    const schema = z.fromJSONSchema(tool.input as never);
    return schema instanceof z.ZodObject ? schema : z.object({}).loose();
  } catch {
    return z.object({}).loose();
  }
}

function actionOf(toolkit: string, tool: ComposioTool): ConnectorAction {
  return {
    id: actionIdOf(toolkit, tool.slug),
    summary: (tool.name || tool.slug).slice(0, 160),
    description: (tool.description || tool.name).slice(0, 1024),
    group: kindOfTool(toolkit, tool),
    inputSchema: inputOf(tool),
    handler: async (input, ctx) => {
      const secret = composioSecretOf(ctx.accessToken);
      if (!secret) {
        throw new ComposioError(note("composioSignInNotFinished"));
      }
      return executeComposioTool(secret.way, {
        connectedAccountId: secret.composio,
        holder: secret.holder,
        tool: tool.slug,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
    },
  };
}

/** The connector of a toolkit with its tools. */
export function connectorOfToolkit(
  toolkit: ComposioToolkit,
  tools: ComposioTool[],
): ConnectorDefinition {
  const actions = new Map<string, ConnectorAction>();
  for (const tool of tools) {
    const action = actionOf(toolkit.slug, tool);
    // Two slugs that read the same: the first one stays.
    if (!actions.has(action.id)) {
      actions.set(action.id, action);
    }
  }
  return {
    id: composioConnectorId(toolkit.slug),
    moduleId: "connections-composio",
    name: toolkit.name,
    description: toolkit.description,
    toolPrefix: `composio_${toolkit.slug.replace(/-/g, "_")}`,
    auth: { kind: "oauth2", oauth2: COMPOSIO_OAUTH2 },
    actions: [...actions.values()],
    ...(toolkit.logo ? { icon: toolkit.logo } : {}),
  };
}

/** The connector of `composio-<toolkit>`, made from the catalog; null where the switch is off or Composio can't be reached. */
export async function composioConnector(id: string): Promise<{
  connector: ConnectorDefinition;
  /** Each action's input as Composio describes it, by action id. */
  inputs: Map<string, Record<string, unknown>>;
} | null> {
  const slug = toolkitOfConnector(id);
  if (!slug || !(await composioOn())) {
    return null;
  }
  const way = await composioWay();
  if (!way) {
    return null;
  }
  const found = await toolkitTools(slug, way);
  if (!found) {
    return null;
  }
  const inputs = new Map<string, Record<string, unknown>>();
  for (const tool of found.tools) {
    const actionId = actionIdOf(slug, tool.slug);
    if (!inputs.has(actionId)) {
      inputs.set(actionId, tool.input);
    }
  }
  return { connector: connectorOfToolkit(found.toolkit, found.tools), inputs };
}

/** A toolkit's connector as the studio lists it. */
export function composioView(
  connector: ConnectorDefinition,
  toolkit?: ComposioToolkit,
): ConnectorView {
  return {
    id: connector.id,
    name: connector.name,
    domain: "composio.dev",
    sourceKind: "composio",
    sourceUrl: toolkit ? `https://composio.dev/toolkits/${toolkit.slug}` : "",
    toolPrefix: connector.toolPrefix,
    usable: true,
    missingSetup: null,
    auth: "oauth2",
    needsOAuthClient: false,
    toolsPending: false,
    fromAddress: false,
    bundle: null,
    actions: connector.actions.map((a) => ({
      id: a.id,
      summary: a.summary,
      group: a.group,
    })),
    importedAt: "",
    refreshedAt: null,
  };
}

/** A toolkit of the catalog as Entdecken lists it. */
export interface ComposioCatalogEntry {
  connectorId: string;
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
}

/** Composio's catalog, searched; empty where the switch is off or neither way is there. */
export async function composioCatalog(query: string): Promise<{
  available: boolean;
  toolkits: ComposioCatalogEntry[];
}> {
  if (!(await composioOn())) {
    return { available: false, toolkits: [] };
  }
  const way = await composioWay();
  if (!way) {
    return { available: false, toolkits: [] };
  }
  const hits = await searchToolkits(query, way);
  return {
    available: true,
    // Only what Composio signs in to with its own app (decision 2), or what asks no sign-in.
    toolkits: hits
      .filter((t) => t.managed)
      .map((t) => ({
        connectorId: composioConnectorId(t.slug),
        slug: t.slug,
        name: t.name,
        description: t.description,
        logo: t.logo,
        categories: t.categories,
      })),
  };
}
