import { type Context, Hono } from "hono";
import { z } from "zod";
import { clientOf } from "../clients.js";
import type { Principal } from "../mcp/auth.js";
import type { Scope } from "../mcp/scopes.js";
import {
  type ClientWho,
  clientChatMessages,
  clientChatPost,
  clientChats,
  clientFile,
  clientFileInfo,
  clientFiles,
  clientForYou,
  clientMe,
  clientOpenRun,
  clientResults,
  clientSpaces,
  clientStartWizard,
  clientWizards,
} from "../services/client-portal.js";
import { caller, inTenantAs } from "./api.js";
import { notFoundAnswer } from "./lang.js";

/**
 * The client contract on the API (docs/plans/client-portal.md): what a client of the organization
 * reaches of their client spaces, for the client portal (apps/portal) and any app built on it. One
 * list makes both the listing (`GET /client`, inputs as JSON Schema) and the calls
 * (`POST /client/:name`, `POST /client/spaces/:spaceId/:name`). Every call acts as the token's
 * person, whose role must be `client`; the services decide the rest (services/client-portal.ts).
 */

interface ClientCall {
  scope: Scope;
  /** Whether the call is about one client space, named in the path. */
  space: boolean;
  description: string;
  input: z.ZodObject;
  run: (who: ClientWho, spaceId: string, input: any) => Promise<unknown>;
}

const none = z.object({});

export const CLIENT_CALLS = {
  me: {
    scope: "data:read",
    space: false,
    description: "Who you are, and the organization you are a client of.",
    input: none,
    run: (who) => clientMe(who),
  },
  spaces: {
    scope: "data:read",
    space: false,
    description: "Your client spaces, each with the firm's space and its brand.",
    input: none,
    run: (who) => clientSpaces(who),
  },
  for_you: {
    scope: "data:read",
    space: true,
    description:
      "What waits for you in a client space: your runs waiting on a page or an answer, results the firm shared, the wizards you can start.",
    input: none,
    run: (who, spaceId) => clientForYou(who, spaceId),
  },
  wizards: {
    scope: "elements:read",
    space: true,
    description: "The firm's wizards you can start in a client space.",
    input: none,
    run: (who, spaceId) => clientWizards(who, spaceId),
  },
  wizard_start: {
    scope: "elements:run",
    space: true,
    description:
      "Starts one of those wizards in the client space. Gives the run and its ticket for the run's own routes.",
    input: z.object({ wizardId: z.string().min(1).max(64) }),
    run: (who, spaceId, input) => clientStartWizard(who, spaceId, input.wizardId),
  },
  results: {
    scope: "data:read",
    space: true,
    description: "The finished runs of a client space you see: yours, and those the firm shared.",
    input: none,
    run: (who, spaceId) => clientResults(who, spaceId),
  },
  run_open: {
    scope: "data:read",
    space: false,
    description:
      "One run you see, by its id: a ticket its own routes open with (`?rt=`), and its client space.",
    input: z.object({ runId: z.string().min(1).max(64) }),
    run: (who, _spaceId, input) => clientOpenRun(who, input.runId),
  },
  chats: {
    scope: "data:read",
    space: true,
    description: "The chats of a client space you are a member of.",
    input: none,
    run: (who, spaceId) => clientChats(who, spaceId),
  },
  chat_messages: {
    scope: "data:read",
    space: false,
    description: "One of your chats, by its id: who wrote what, and its client space.",
    input: z.object({ chatId: z.string().min(1).max(64) }),
    run: (who, _spaceId, input) => clientChatMessages(who, input.chatId),
  },
  chat_post: {
    scope: "elements:run",
    space: true,
    description:
      "Writes in one of your chats, or starts a new one with the firm. With ask, the space's AI answers you as well.",
    input: z.object({
      chatId: z.string().min(1).max(64).optional(),
      text: z.string().trim().min(1).max(20_000),
      ask: z.boolean().optional(),
    }),
    run: (who, spaceId, input) => clientChatPost(who, spaceId, input),
  },
  files: {
    scope: "data:read",
    space: true,
    description: "The files of a client space. One file's bytes: GET /client/files/:fileId.",
    input: none,
    run: (who, spaceId) => clientFiles(who, spaceId),
  },
  file: {
    scope: "data:read",
    space: false,
    description: "One file you see, by its id: what it is, and its client space.",
    input: z.object({ fileId: z.string().min(1).max(64) }),
    run: (who, _spaceId, input) => clientFileInfo(who, input.fileId),
  },
} satisfies Record<string, ClientCall>;

export type ClientCallName = keyof typeof CLIENT_CALLS;

const CALLS = CLIENT_CALLS as Record<string, ClientCall>;

const callBody = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

/** The token's person as the services know a client, or the answer that turns the call away. */
async function clientWho(
  c: Context,
  scope: Scope,
): Promise<{ who: ClientWho; principal: Principal } | Response> {
  const who = await caller(c, [scope], { clients: true });
  if (who instanceof Response) {
    return who;
  }
  if (who.role !== "client") {
    return c.json({ error: "This is for clients of the organization.", code: "clients_only" }, 403);
  }
  return {
    who: {
      id: who.userId,
      tenantId: who.tenantId,
      role: who.role,
      name: who.name ?? "",
      email: who.email ?? "",
      client: clientOf(c) ?? who.client,
    },
    principal: who,
  };
}

async function callClient(c: Context, name: string, spaceId: string | null) {
  const call = CALLS[name];
  if (!call || call.space !== (spaceId !== null)) {
    return c.json(notFoundAnswer(c), 404);
  }
  const signedIn = await clientWho(c, call.scope);
  if (signedIn instanceof Response) {
    return signedIn;
  }
  const { who, principal } = signedIn;
  const body = callBody.safeParse(await c.req.json().catch(() => ({})));
  const input = body.success ? call.input.safeParse(body.data.input) : null;
  if (!input?.success) {
    return c.json(
      { error: "Invalid input", code: "invalid", issues: input?.error.issues ?? [] },
      400,
    );
  }
  const result = await inTenantAs(principal, () => call.run(who, spaceId ?? "", input.data));
  return c.json({ result });
}

export const clientContractRoutes = new Hono()
  .get("/client", (c) =>
    c.json({
      calls: Object.entries(CALLS).map(([name, call]) => ({
        name,
        path: call.space ? `/api/v1/client/spaces/{spaceId}/${name}` : `/api/v1/client/${name}`,
        scope: call.scope,
        description: call.description,
        input: z.toJSONSchema(call.input, { unrepresentable: "any" }),
      })),
    }),
  )
  .get("/client/files/:fileId", async (c) => {
    const signedIn = await clientWho(c, "data:read");
    if (signedIn instanceof Response) {
      return signedIn;
    }
    const { who, principal } = signedIn;
    const file = await inTenantAs(principal, () => clientFile(who, c.req.param("fileId")));
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": file.mime,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "cache-control": "private, no-store",
      },
    });
  })
  .post("/client/spaces/:spaceId/:name", (c) =>
    callClient(c, c.req.param("name"), c.req.param("spaceId")),
  )
  .post("/client/:name", (c) => callClient(c, c.req.param("name"), null));
