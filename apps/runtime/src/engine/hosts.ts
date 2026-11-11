import {
  HAND_OVER,
  type HandOver,
  handOverSchema,
  PEER_RUNS_PATH,
} from "@engenty/wizards-engine/host-api";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import {
  HOST_OFFERS,
  type HostGap,
  type HostOffers,
  hostFit,
  type ModelWay,
  requiredClasses,
} from "@engenty/wizards-shared/fit";
import { requiresOf } from "@engenty/wizards-shared/requires";
import type { RunHostKind, RunHostRef } from "@engenty/wizards-shared/run";
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

/** What of a new run, besides its wizard, says where it may live. */
export interface Placing {
  /**
   * A guest's run of a published wizard: what objects are for, many runs that mostly wait. Only
   * such a run goes to an object (`EDGE_URL`); a test run never does.
   */
  guest?: boolean;
}

/**
 * The hosts a new run may go to, in order, for the tenant at hand: an object first for a guest's
 * run while the tenant's runs may live in objects (their routes need other hosts on, their
 * services the run's services), then what `RUN_HOSTS` lists.
 */
async function candidatesFor(
  placing: Placing,
  listed: readonly RunHostRef[],
): Promise<readonly RunHostRef[]> {
  const switches = await remoteFeatures().catch(() => null);
  if (!feature("runHosts", switches)) {
    return [];
  }
  const objects =
    placing.guest &&
    env.edgeUrl &&
    feature("edgeRuns", switches) &&
    feature("runServices", switches)
      ? [{ kind: "edge", url: env.edgeUrl } satisfies RunHostRef]
      : [];
  return [...objects, ...listed];
}

/**
 * The host a new run of `def` is placed on: the first of the candidates that can run it, an
 * object first for a guest's run (`Placing`), then `candidates`. Null: this runtime, as for every
 * run while other hosts are off, none is listed or none fits.
 */
export async function hostFor(
  def: WizardDefinition,
  placing: Placing = {},
  candidates: readonly RunHostRef[] = env.runHosts,
): Promise<RunHostRef | null> {
  const hosts = await candidatesFor(placing, candidates);
  if (!hosts.length) {
    return null;
  }
  const requires = def.requires ?? requiresOf(def);
  const ways = await modelWays(requiredClasses(requires));
  return hosts.find((host) => hostFit(requires, offersOf(host), ways).fits) ?? null;
}

/** How a class reaches its model where a host cannot follow, in words for the one who starts. */
const WAY_WORDS: Record<ModelWay, string> = {
  credits: "on credits",
  key: "with your own API key",
  ollama: "with Ollama",
  apple: "on Apple’s model on this computer",
  client: "through an AI client installed with engenty wizards",
};

/**
 * A host the caller brings (`wizards run`) cannot run the wizard: a model it calls is reached in
 * a way only this runtime has, or in no way at all. Nothing was held for the run.
 */
export class HostUnfit extends Error {
  constructor(readonly missing: HostGap[]) {
    super(
      `This wizard can’t run there. ${missing
        .map(({ cls, way }) =>
          way
            ? `Its ${cls} model runs ${WAY_WORDS[way]}, and only engenty wizards reaches it that way.`
            : `Its ${cls} model has nothing to run on.`,
        )
        .join(" ")} Start it in the studio instead.`,
    );
  }
}

/**
 * Throws `HostUnfit` where a host of `kind`, brought by the caller, cannot run `def`: the check
 * `hostFor` makes, with the kind's own ways (the caller's machine is not this one).
 */
export async function requireFit(def: WizardDefinition, kind: RunHostKind): Promise<void> {
  const requires = def.requires ?? requiresOf(def);
  const fit = hostFit(requires, kind, await modelWays(requiredClasses(requires)));
  if (!fit.fits) {
    throw new HostUnfit(fit.missing);
  }
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
