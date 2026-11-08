/**
 * Settings › Models › API keys in the cloud, behind `ownKeysGateway`: the organization's own
 * accounts at the providers live in the Manage-App (docs/manage-contract.md, "Own accounts"), and
 * these routes pass the studio's requests on. Owners and admins add, change and remove accounts;
 * members see the list. A computer keeps its keys in its vault, on the routes in studio.ts.
 */
import type { Context } from "hono";
import { z } from "zod";
import type { SessionUser } from "../auth/index.js";
import {
  addUpstream,
  changeUpstream,
  checkUpstream,
  ManageError,
  removeUpstream,
  setUpstreamFallback,
  type UpstreamInput,
} from "../manage.js";
import { moveOwnKeys, ownKeysThroughGateway } from "../models.js";
import { forgetUpstreams, takeNotice, upstreamsOf } from "../upstreams.js";
import { say } from "./lang.js";

type Vars = { Variables: { user: SessionUser } };
type C = Context<Vars>;

/** The kinds of account the Manage-App keeps. */
export const UPSTREAM_SOURCES = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "bedrock",
  "azure",
  "compat",
  "ai-gateway",
  "fal",
  "elevenlabs",
] as const;

/**
 * What the studio sends besides the key. A box ticked is the admin's word, so it is kept with who
 * ticked it and when; the company of another provider is the name in its address.
 */
const settingsInput = z
  .object({
    region: z.string().trim().min(1).max(40).optional(),
    baseUrl: z.url().max(300).optional(),
    deployments: z
      .array(
        z.object({
          deployment: z.string().trim().min(1).max(120),
          model: z.string().trim().max(120).optional(),
          zone: z.string().trim().max(40).optional(),
        }),
      )
      .max(40)
      .optional(),
    noAbuseLog: z.boolean().optional(),
    euServers: z.boolean().optional(),
    noRetention: z.boolean().optional(),
  })
  .optional();

const addInput = z.object({
  source: z.enum(UPSTREAM_SOURCES),
  label: z.string().trim().min(1).max(80),
  key: z.string().trim().min(1).max(4000),
  settings: settingsInput,
});

const changeInput = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  key: z.string().trim().min(1).max(4000).optional(),
  settings: settingsInput,
});

/** "openai.inference.de-txl.ionos.com" → "ionos": the name a list shows for another provider. */
export function companyOf(baseUrl: string): string {
  const parts = new URL(baseUrl).hostname.split(".").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : (parts[0] ?? "");
}

function settingsFor(
  source: string | null,
  input: z.infer<typeof settingsInput>,
  user: SessionUser,
): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  const said = (on: boolean) => (on ? { by: user.id, at: new Date().toISOString() } : null);
  const { noAbuseLog, noRetention, ...rest } = input;
  return {
    ...rest,
    ...(noAbuseLog !== undefined ? { noAbuseLog: said(noAbuseLog) } : {}),
    ...(noRetention !== undefined ? { noRetention: said(noRetention) } : {}),
    // Another provider always names its company: the Manage-App asks for it with the address.
    ...((source === "compat" || rest.euServers !== undefined) && rest.baseUrl
      ? { company: companyOf(rest.baseUrl) }
      : {}),
  };
}

/** Owners and admins change the accounts; members read them. */
const mayChange = (user: SessionUser) => user.role === "owner" || user.role === "admin";

/** Null where the routes count: a cloud runtime with the switch on for the organization. */
async function closed(c: C): Promise<Response | null> {
  return (await ownKeysThroughGateway()) ? null : c.notFound();
}

function refused(c: C): Response {
  return c.json({ error: say(c, "onlyOrganizationAdminsChange"), code: "forbidden" }, 403);
}

/** The Manage-App's answer, or its refusal with its status, its words and its code. */
async function passOn(c: C, work: () => Promise<unknown>, status: 200 | 201 = 200) {
  try {
    const value = await work();
    forgetUpstreams(c.get("user").tenantId);
    return value === undefined ||
      value === null ||
      (typeof value === "object" && !Object.keys(value).length)
      ? c.body(null, 204)
      : c.json(value, status);
  } catch (err) {
    if (err instanceof ManageError && err.status < 500) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error("[own keys]", (err as Error).message);
    return c.json({ error: say(c, "ownKeysUnavailable"), code: "manage_unavailable" }, 503);
  }
}

/** The accounts and the fallback switch; the admins also hear once which saved keys didn't move. */
export async function listKeys(c: C) {
  const gate = await closed(c);
  if (gate) {
    return gate;
  }
  const user = c.get("user");
  await moveOwnKeys();
  try {
    const upstreams = await upstreamsOf(user.tenantId, true);
    return c.json({
      ...upstreams,
      kept: mayChange(user) ? await takeNotice(user.tenantId) : [],
    });
  } catch (err) {
    if (err instanceof ManageError && err.status < 500) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error("[own keys]", (err as Error).message);
    return c.json({ error: say(c, "ownKeysUnavailable"), code: "manage_unavailable" }, 503);
  }
}

export async function addKey(c: C) {
  const gate = await closed(c);
  if (gate) {
    return gate;
  }
  const user = c.get("user");
  if (!mayChange(user)) {
    return refused(c);
  }
  const input = addInput.parse(await c.req.json());
  const settings = settingsFor(input.source, input.settings, user);
  return passOn(
    c,
    () =>
      addUpstream(user.tenantId, {
        source: input.source,
        label: input.label,
        key: input.key,
        ...(settings ? { settings } : {}),
      }),
    201,
  );
}

export async function changeKey(c: C) {
  const gate = await closed(c);
  if (gate) {
    return gate;
  }
  const user = c.get("user");
  if (!mayChange(user)) {
    return refused(c);
  }
  const input = changeInput.parse(await c.req.json());
  const id = c.req.param("id") ?? "";
  // A new address for another provider names its company too: which kind of account it is.
  const source = input.settings?.baseUrl
    ? ((await upstreamsOf(user.tenantId).catch(() => null))?.accounts.find((a) => a.id === id)
        ?.source ?? null)
    : null;
  const settings = settingsFor(source, input.settings, user);
  const change: UpstreamInput = {
    ...(input.label ? { label: input.label } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(settings ? { settings } : {}),
  };
  return passOn(c, () => changeUpstream(user.tenantId, id, change));
}

export async function checkKeyOf(c: C, id: string) {
  const user = c.get("user");
  if (!mayChange(user)) {
    return refused(c);
  }
  return passOn(c, () => checkUpstream(user.tenantId, id));
}

export async function removeKey(c: C) {
  const gate = await closed(c);
  if (gate) {
    return gate;
  }
  const user = c.get("user");
  if (!mayChange(user)) {
    return refused(c);
  }
  return passOn(c, async () => {
    await removeUpstream(user.tenantId, c.req.param("id") ?? "");
    return null;
  });
}

/** "Guthaben springt ein": the credits take a call over that the provider refuses. */
export async function setFallback(c: C) {
  const gate = await closed(c);
  if (gate) {
    return gate;
  }
  const user = c.get("user");
  if (!mayChange(user)) {
    return refused(c);
  }
  const { fallback } = z.object({ fallback: z.boolean() }).parse(await c.req.json());
  return passOn(c, () => setUpstreamFallback(user.tenantId, fallback));
}
