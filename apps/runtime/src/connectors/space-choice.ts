import type { NeedAccountView, WizardNeedView } from "@engenty/wizards-shared/connectors";
import type { Lang, WizardDefinition } from "@engenty/wizards-shared/definition";
import { unavoidableSteps } from "@engenty/wizards-shared/fit";
import { note, saidText } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { missingConnectionsSaid, stepsUsing } from "../engine/requirements.js";
import { requireAdmin } from "../services/access.js";
import { notFound } from "../services/errors.js";
import type { StoreScope } from "../store/index.js";
import { usable } from "./builtin.js";
import { candidates } from "./index.js";
import {
  connectionsFor,
  forget,
  remember,
  runConnectionsOn,
  spaceHolder,
  type Usable,
} from "./person-connections.js";
import { listSpaceConnections } from "./space-connections.js";

/*
 * A wizard's needs on its page in the studio (docs/plans/run-connections.md, step 4): the service
 * each names, the steps that use it, how it resolves for the person looking and, for the space's
 * admins, the space's choice for runs nobody watches. Choosing and clearing that choice is the
 * admins'. The choice reaches a run nobody watches (`r:` holder) through `connectionsFor`; the
 * check before such a run is `unwatchedConnectionsSaid` in engine/requirements.ts.
 */

interface WizardRef {
  id: string;
  spaceId: string;
  draft: WizardDefinition;
}

/** A run nobody watches, as `connectionsFor` reads it: no person, the space's choice. */
const unwatched = (wizardId: string): StoreScope => ({ wizardId, holder: "r:" });

function accountView(u: Usable): NeedAccountView {
  return {
    id: u.row.id,
    owner: u.kind,
    connectorName: u.connector.name,
    label: u.kind === "person" ? u.row.label : (u.row.label ?? u.row.name),
  };
}

/** The needs of a wizard's draft as `viewer` sees them; an admin also sees the space's choice. */
export async function wizardNeeds(
  w: WizardRef,
  viewer: { userId: string; admin: boolean },
  lang: Lang,
): Promise<WizardNeedView[]> {
  const def = w.draft;
  const needs = def.connections ?? [];
  if (!needs.length) {
    return [];
  }
  const unavoidable = unavoidableSteps(def);
  const missing = new Map(
    (await missingConnectionsSaid(def, w.spaceId, viewer.admin)).map((m) => [m.id, m]),
  );
  const forSpace = viewer.admin && (await runConnectionsOn());
  const person: StoreScope = { wizardId: w.id, holder: `u:${viewer.userId}` };
  const views: WizardNeedView[] = [];
  for (const need of needs) {
    const connectors = await candidates(need, w.spaceId);
    const steps = stepsUsing(def, need.id);
    const view: Omit<WizardNeedView, "here"> = {
      id: need.id,
      name: need.title ?? (need.connector ? (connectors[0]?.name ?? need.connector) : null),
      kind: need.kind ?? null,
      steps: steps.map((s) => ({ id: s.id, title: s.title })),
      unavoidable: steps.some((s) => unavoidable.has(s.id)),
    };
    views.push({
      ...view,
      here: await resolvesHere(need, connectors, missing.get(need.id)?.problem, person, w, lang),
      ...(forSpace && !need.spaceConnection ? { space: await spaceChoice(w, need) } : {}),
    });
  }
  return views;
}

async function resolvesHere(
  need: ConnectionDef,
  connectors: Awaited<ReturnType<typeof candidates>>,
  problem: Parameters<typeof saidText>[0] | undefined,
  person: StoreScope,
  w: WizardRef,
  lang: Lang,
): Promise<WizardNeedView["here"]> {
  if (need.spaceConnection) {
    const row = (await listSpaceConnections(w.spaceId)).find((r) => r.id === need.spaceConnection);
    if (row) {
      const connector = connectors.find((c) => c.id === row.connectorId);
      return {
        state: "named",
        account: {
          id: row.id,
          owner: "space",
          connectorName: connector?.name ?? row.connectorId,
          label: row.label ?? row.name,
        },
      };
    }
    return { state: "cannot", problem: saidText(note("notFound"), lang) };
  }
  let can = false;
  for (const c of connectors) {
    can ||= await usable(c);
  }
  if (!can) {
    return {
      state: "cannot",
      problem: saidText(
        problem ?? note("connectorNotInSpace", { connector: need.connector ?? need.id }),
        lang,
      ),
    };
  }
  const found = await connectionsFor(person, w.spaceId, need);
  if (found.chosen && found.by) {
    return { state: found.by === "choice" ? "chosen" : "only", account: accountView(found.chosen) };
  }
  return found.candidates.length
    ? { state: "choose", count: found.candidates.length }
    : { state: "connect" };
}

/** The space's connections that fit a need for a run nobody watches, and the one chosen. */
async function spaceChoice(
  w: WizardRef,
  need: ConnectionDef,
): Promise<NonNullable<WizardNeedView["space"]>> {
  const found = await connectionsFor(unwatched(w.id), w.spaceId, need);
  return {
    chosen: found.by === "choice" && found.chosen ? found.chosen.row.id : null,
    options: found.candidates.filter((u) => u.kind === "space").map(accountView),
  };
}

function needOf(w: WizardRef, needId: string): ConnectionDef {
  const need = (w.draft.connections ?? []).find((c) => c.id === needId && !c.spaceConnection);
  if (!need) {
    throw notFound();
  }
  return need;
}

/** Chooses the connection of the space a wizard's runs nobody watches use for a need. Admins only. */
export async function chooseForSpace(
  w: WizardRef,
  needId: string,
  connectionId: string,
): Promise<void> {
  await requireAdmin();
  if (!(await runConnectionsOn())) {
    throw notFound();
  }
  const need = needOf(w, needId);
  const found = await connectionsFor(unwatched(w.id), w.spaceId, need);
  const target = found.candidates.find((u) => u.kind === "space" && u.row.id === connectionId);
  if (!target) {
    throw notFound();
  }
  await remember(w.id, need.id, spaceHolder(w.spaceId), target);
}

/** Clears the space's choice for a need: runs nobody watches no longer start. Admins only. */
export async function clearForSpace(w: WizardRef, needId: string): Promise<void> {
  await requireAdmin();
  await forget(w.id, spaceHolder(w.spaceId), needOf(w, needId).id);
}
