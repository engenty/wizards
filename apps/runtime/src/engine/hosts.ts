import {
  HAND_OVER,
  type HandOver,
  handOverSchema,
  PEER_RUNS_PATH,
} from "@engenty/wizards-engine/host-api";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  HOST_OFFERS,
  type HostOffers,
  hostFit,
  type ModelWay,
  requiredClasses,
} from "@engenty/wizards-shared/fit";
import { requiresOf } from "@engenty/wizards-shared/requires";
import type { RunHostRef } from "@engenty/wizards-shared/run";
import { env } from "../env.js";
import { feature, remoteFeatures } from "../features.js";
import { modelWays } from "../models.js";

/*
 * Where a new run lives (docs/plans/runs-on-their-own.md, "Where a run can live"): this runtime,
 * or a host it lists (`RUN_HOSTS`) that can run the wizard. `requires` decides before the start;
 * nothing moves a run in the middle.
 */

/**
 * The ways of this machine: the installed client and Apple on the device answer only here, so
 * a class that runs on one keeps the run here, whatever another runtime process could do.
 */
const OF_THIS_MACHINE: ReadonlySet<ModelWay> = new Set(["client", "apple"]);

/** What a listed host offers a run of this runtime: its kind's ways, without this machine's. */
function offersOf(host: RunHostRef): HostOffers {
  return { ways: HOST_OFFERS[host.kind].ways.filter((way) => !OF_THIS_MACHINE.has(way)) };
}

/**
 * The host a new run of `def` is placed on: the first of `candidates` that can run it. Null:
 * this runtime, as for every run while other hosts are off, none is listed or none fits.
 */
export async function hostFor(
  def: WizardDefinition,
  candidates: readonly RunHostRef[] = env.runHosts,
): Promise<RunHostRef | null> {
  if (!candidates.length || !feature("runHosts", await remoteFeatures().catch(() => null))) {
    return null;
  }
  const requires = def.requires ?? requiresOf(def);
  const ways = await modelWays(requiredClasses(requires));
  return candidates.find((host) => hostFit(requires, offersOf(host), ways).fits) ?? null;
}

/** How long a host has to take a run before it stays here. */
const HAND_OVER_MS = 10_000;

/**
 * Hands a new run to its host: the definition, the workspace by reference, the token and the
 * state after the start (`HandOver`). Throws when the host does not take it.
 */
export async function handOver(host: RunHostRef, payload: HandOver): Promise<void> {
  const body = handOverSchema.parse(payload);
  const res = await fetch(
    `${host.url}${PEER_RUNS_PATH}/${encodeURIComponent(body.runId)}/${HAND_OVER}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HAND_OVER_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`The ${host.kind} host at ${host.url} did not take the run: ${res.status}.`);
  }
}
