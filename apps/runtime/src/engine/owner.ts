import { RUN_SERVICES_PATH } from "@engenty/wizards-shared/run-services";
import type { Context } from "hono";
import { tokenOf } from "../broker/token.js";
import { env } from "../env.js";
import { ownerUrl } from "../tenants/control.js";
import { runServicesOn } from "../tools/acted.js";
import { releaseResources } from "./resources.js";
import { runStore } from "./run-store.js";

/**
 * How often a request was handed on. Twice at most: the web to the runner holding the run, the
 * runner to the broker that has its browser. A process that has nothing and gets it a third time
 * answers it itself: no request goes round in a ring.
 */
const HANDED = "x-wizards-handed";
const HANDS = 2;

/**
 * Where this process's runs have their services, in the current tenant: the broker
 * (`RUN_SERVICES_URL`) while the run services are switched on, else null, this process.
 */
export async function servicesUrl(): Promise<string | null> {
  return env.runServicesUrl && (await runServicesOn()) ? env.runServicesUrl : null;
}

/**
 * Hands a request on to the process that has the run's browser and sandbox: the broker that serves
 * the run's services when this process asks one (`servicesUrl`), else the runner holding the run.
 * Either serves the same routes and checks the same cookie; the caller's headers go along. Null:
 * nobody has the run, the runner named no address (RUNNER_URL), or the request was handed on
 * as often as it may be.
 */
export async function fromOwner(c: Context, runId: string): Promise<Response | null> {
  const hands = Number(c.req.header(HANDED) ?? 0) || 0;
  if (hands >= HANDS) {
    return null;
  }
  const base = (await servicesUrl()) ?? (await ownerUrl(runId));
  if (!base) {
    return null;
  }
  const here = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set(HANDED, String(hands + 1));
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer();
  try {
    const res = await fetch(`${base}${here.pathname}${here.search}`, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    console.error(`[run ${runId}] the process that has it did not answer:`, err);
    return null;
  }
}

/**
 * Lets go of what the run held while its drive worked: its browser and sandbox, here or, when
 * the broker serves the run's services, there (`POST …/run/release` with the run's token, which a
 * run that ended may still send). A run whose token can't be signed (from before tokens) held
 * nothing there.
 */
export async function releaseRunResources(runId: string): Promise<void> {
  await releaseResources(runId);
  const base = await servicesUrl();
  const run = base ? await runStore.get(runId) : undefined;
  const token = run ? await tokenOf(run) : null;
  if (!(base && token)) {
    return;
  }
  const res = await fetch(`${base}${RUN_SERVICES_PATH}/run/release`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`The run's services answered the release with ${res.status}.`);
  }
}
