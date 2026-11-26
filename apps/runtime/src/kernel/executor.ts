import { AsyncLocalStorage } from "node:async_hooks";
import { executorCall } from "@engenty/wizards-kernel/executor";
import {
  type GoogleApi,
  googleDescription,
  googleDiscoveryUrl,
} from "@engenty/wizards-kernel/google";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { convertGoogleDiscoveryToOpenApi } from "@executor-js/plugin-openapi/providers/google";
import { createExecutor } from "@executor-js/sdk";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { z } from "zod";
import type {
  ConnectorAction,
  ConnectorActionGroup,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";

/**
 * Executor (`@executor-js/sdk`) below the broker, for a wizard in version 0.3.0
 * (docs/plans/kernel.md, item 15): an operation of a service's API that the connector has no
 * action for becomes an action of that connection, run by executor. The broker decides first, as
 * for every action: the grant, the space's rules, who is asked, once, the log. Then it hands the
 * account to the action, and executor makes the call with that account's token.
 *
 * Executor holds no token. Its one connection per service says only where the token comes from:
 * the provider below, which hands executor the token of the account the broker gave this call, and
 * nothing at any other time. The accounts stay where the runtime keeps them.
 *
 * A connector's own actions come first (item 16): they are task-sized and what a wizard names
 * first. Executor serves only the names that are no action of the connector.
 */

/** The services executor calls for, by the connector that holds their accounts. */
const SERVICES: Record<string, { integration: string; google: GoogleApi }> = {
  "google-gmail": { integration: "gmail", google: "gmail" },
};

/** Where executor reaches a service instead of its own address: the emulator, in tests. */
const reached = new Map<string, string>();

/** The token of the account the broker handed the call that is running. */
const account = new AsyncLocalStorage<string>();

const PROVIDER = "runtime";
const ACCOUNT = "the-call";
const OWNER = "org";
const CONNECTION = "run";

type Made = {
  execute(address: string, args: unknown, options?: unknown): Promise<unknown>;
  tools: {
    list(filter: { integration: string }): Promise<
      readonly {
        address: string;
        name: string;
        description: string;
        inputSchema?: unknown;
        annotations?: { approvalDescription?: string };
      }[]
    >;
  };
  close(): Promise<void>;
};

let made: Promise<Made> | null = null;

/**
 * Executor's requests without the `content-length` its OpenAPI plugin writes: the runtime loads
 * undici's own package (tools/net-guard.ts), which makes itself the dispatcher of every `fetch`
 * and refuses a request that names its length itself. `fetch` counts it anyway.
 */
const fetchCounting: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete("content-length");
  return fetch(input, { ...init, headers });
};
const HTTP = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(Effect.service(HttpClient.HttpClient), (client) =>
    HttpClient.transform(client, (sent) =>
      Effect.provideService(sent, FetchHttpClient.Fetch, fetchCounting),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

async function make(): Promise<Made> {
  const executor = (await createExecutor({
    // Each call answers for itself (executorCall): nobody is there to answer anything else.
    onElicitation: (async () => ({ action: "decline" })) as never,
    providers: [
      {
        key: PROVIDER as never,
        writable: false,
        get: (id) => Effect.sync(() => (id === ACCOUNT ? (account.getStore() ?? null) : null)),
      },
    ],
    plugins: [openApiPlugin({ httpClientLayer: HTTP })] as const,
  })) as unknown as Made & {
    openapi: { addSpec(config: unknown): Promise<unknown> };
    connections: { create(input: unknown): Promise<unknown> };
  };
  for (const [connectorId, service] of Object.entries(SERVICES)) {
    const described = googleDescription(service.google);
    const { specText } = await Effect.runPromise(
      convertGoogleDiscoveryToOpenApi({
        discoveryUrl: googleDiscoveryUrl(service.google),
        documentText: described,
      }),
    );
    await executor.openapi.addSpec({
      spec: { kind: "blob", value: specText },
      slug: service.integration,
      baseUrl: reached.get(connectorId) ?? (JSON.parse(described) as { rootUrl: string }).rootUrl,
      authenticationTemplate: [
        {
          slug: "token",
          type: "apiKey",
          headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
        },
      ],
    });
    await executor.connections.create({
      owner: OWNER,
      name: CONNECTION,
      integration: service.integration,
      template: "token",
      from: { provider: PROVIDER, id: ACCOUNT },
    });
  }
  return executor;
}

const executor = () => {
  made ??= make();
  return made;
};

/** Executor reaches the service of `connectorId` at `url` from now on; null: at its own address. */
export async function reachExecutorAt(connectorId: string, url: string | null): Promise<void> {
  if (url) {
    reached.set(connectorId, url);
  } else {
    reached.delete(connectorId);
  }
  const was = made;
  made = null;
  await (await was?.catch(() => null))?.close();
}

/** What an operation does, by its HTTP method: executor's annotation names it for all but GET. */
function groupOf(annotations: { approvalDescription?: string } | undefined): ConnectorActionGroup {
  const method = annotations?.approvalDescription?.split(" ")[0]?.toUpperCase();
  if (!method || method === "GET" || method === "HEAD") {
    return "read";
  }
  return method === "DELETE" ? "destructive" : "write";
}

/** An operation's input as executor describes it, or any object where zod cannot read that. */
function schemaOf(described: unknown): z.ZodType {
  try {
    return described ? z.fromJSONSchema(described as never) : z.record(z.string(), z.unknown());
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

/**
 * The operations of the connector's service that `connection` names and the connector has no
 * action of its own for, as actions of that connector. None for a connector executor does not
 * call for, or a connection that names no actions.
 */
export async function executorActions(
  connector: ConnectorDefinition,
  connection: Pick<ConnectionDef, "actions">,
): Promise<ConnectorAction[]> {
  const service = SERVICES[connector.id];
  const own = new Set(connector.actions.map((a) => a.id));
  const wanted = (connection.actions ?? []).filter((id) => !own.has(id));
  if (!(service && wanted.length)) {
    return [];
  }
  const tools = await (await executor()).tools.list({ integration: service.integration });
  return tools
    .filter((tool) => wanted.includes(tool.name))
    .map((tool) => ({
      id: tool.name,
      summary: tool.name,
      description: tool.description,
      group: groupOf(tool.annotations),
      inputSchema: schemaOf(tool.inputSchema),
      handler: async (input, ctx) =>
        account.run(ctx.accessToken, async () =>
          executorCall(await executor(), tool.address, input, `${connector.id}.${tool.name}`),
        ),
    }));
}
