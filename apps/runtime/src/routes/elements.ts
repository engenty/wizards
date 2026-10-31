import { Hono } from "hono";
import { z } from "zod";
import { clientOf } from "../clients.js";
import { callOutside, RUN_COMMAND } from "../elements/outside.js";
import { ELEMENT_SPECS, ELEMENT_TOOL_NAMES } from "../elements/specs.js";
import { caller, inTenantAs } from "./api.js";

/**
 * The space's elements on the API (docs/plans/modular.md, phase 2): the same calls as the MCP
 * tools, made from the catalogue's specs, for a program with a key or token. `GET` lists the
 * calls the token may make with their inputs as JSON Schema; `POST /:name` makes one, as the
 * token's person, in the space of the path (checked against the token, I2).
 */

const calls = () => [
  ...ELEMENT_TOOL_NAMES.map((name) => ({
    name,
    scope: ELEMENT_SPECS[name].scope as string,
    description: ELEMENT_SPECS[name].description(),
    input: ELEMENT_SPECS[name].input,
  })),
  {
    name: "run_command",
    scope: RUN_COMMAND.scope as string,
    description: "Runs a shell command in the sandbox where loaded skills put their scripts.",
    input: RUN_COMMAND.input,
  },
];

const callBody = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

export const elementRoutes = new Hono()
  .get("/spaces/:spaceId/elements", async (c) => {
    const who = await caller(c, [], { clients: true });
    if (who instanceof Response) {
      return who;
    }
    return c.json({
      calls: calls()
        .filter((call) => who.scopes.includes(call.scope as never))
        .map(({ input, ...call }) => ({
          ...call,
          input: z.toJSONSchema(input, { unrepresentable: "any" }),
        })),
    });
  })
  .post("/spaces/:spaceId/elements/:name", async (c) => {
    const who = await caller(c, [], { clients: true });
    if (who instanceof Response) {
      return who;
    }
    const name = c.req.param("name");
    const call = calls().find((k) => k.name === name);
    if (!call) {
      return c.json({ error: `No call ${name}.`, code: "not_found" }, 404);
    }
    if (!who.scopes.includes(call.scope as never)) {
      return c.json(
        { error: "This token isn’t allowed to do that.", code: "insufficient_scope" },
        403,
      );
    }
    const body = callBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: "Invalid input", code: "invalid", issues: body.error.issues }, 400);
    }
    const result = await inTenantAs(who, () =>
      callOutside(
        {
          userId: who.userId,
          role: who.role,
          client: clientOf(c) ?? who.client,
          tenantId: who.tenantId,
          scopes: who.scopes,
        },
        c.req.param("spaceId"),
        name,
        body.data.input,
        c.req.raw.signal,
      ),
    ).catch((err: unknown) => ({
      ok: false as const,
      error: String((err as Error)?.message ?? err).slice(0, 400),
      status: (err as { code?: string })?.code === "not_found" ? 404 : 500,
    }));
    if (result.ok) {
      return c.json({ result: result.result });
    }
    const status = "status" in result ? result.status : 403;
    return c.json(
      { error: result.error, ...("data" in result ? { data: result.data } : {}) },
      status as 403,
    );
  });
