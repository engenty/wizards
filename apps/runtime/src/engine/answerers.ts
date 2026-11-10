import type { Step } from "@engenty/wizards-shared/definition";
import type { RunView } from "@engenty/wizards-shared/run";
import { whoOf } from "@engenty/wizards-shared/run-view";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { type Role, tenantMembers } from "../manage.js";
import { isAdminRole } from "../services/access.js";
import { currentTenant } from "../tenants/tenant.js";
import type { RunRow } from "./types.js";

/**
 * Who may answer a run (docs/plans/durable-agents.md, "Who may answer"), behind `durableRuns`: the
 * one rule every door asks, the run's routes, MCP and a plugin's door.
 *
 * | `who`             | Who may answer                                                     |
 * |-------------------|--------------------------------------------------------------------|
 * | `person`, `owner` | The run's person: its member, its visitor, whoever holds its link  |
 * | `team`            | Those named under "Answered by" (`wizard.answerers`)               |
 * | any               | The organization's admins, the one person of a computer, and on a  |
 * |                   | test run any member, so people building a wizard don't get stuck   |
 *
 * `person` and `owner` ask the same people: a run with an owner has that member as its person (a
 * start's run belongs to the start's owner), and a visitor's run has no owner, so it asks its own
 * visitor. A step that asks nobody by role (a running step's question, a result) asks the run's
 * person.
 */

/** Who is at a door. Everything is what the door itself established, never what they say. */
export interface Caller {
  userId?: string | null;
  role?: Role | null;
  visitorId?: string | null;
  /** Holds the run's link: a ticket that answers. */
  link?: boolean;
  /** The one person of a computer with no accounts. */
  local?: boolean;
}

type RunFacts = Pick<RunRow, "mode" | "userId" | "visitorId" | "wizardId">;
type WaitingRun = RunFacts & Pick<RunRow, "cursor" | "definition" | "state">;
export type Answerers = string[] | "admins";

export async function answeringNarrowed(): Promise<boolean> {
  return (await currentFeatures().catch(() => ({ durableRuns: false }))).durableRuns === true;
}

export const stepOfRun = (run: Pick<RunRow, "cursor" | "definition">, stepId = run.cursor) =>
  run.definition.steps.find((s) => s.id === stepId) ?? null;

/** Who a wizard's `who: "team"` steps name, as this install keeps it. */
export async function answerersOf(run: Pick<RunRow, "wizardId">): Promise<Answerers> {
  const wizard = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, run.wizardId),
    columns: { answerers: true },
  });
  return wizard?.answerers ?? [];
}

/** The rule itself: whether the caller may answer a step of this run. */
export function mayAnswerStep(
  run: RunFacts,
  step: Step | null,
  caller: Caller,
  team: Answerers,
): boolean {
  if (caller.local || (caller.role && isAdminRole(caller.role))) {
    return true;
  }
  if (run.mode === "test" && caller.userId && caller.role !== "client") {
    return true;
  }
  if (whoOf(step) === "team") {
    return (
      Boolean(caller.userId) &&
      caller.role !== "client" &&
      Array.isArray(team) &&
      team.includes(caller.userId as string)
    );
  }
  return Boolean(
    caller.link ||
      (caller.userId && caller.userId === run.userId) ||
      (caller.visitorId && caller.visitorId === run.visitorId),
  );
}

/** Whether the caller may act on the run as it stands now: answer it, stop it, try it again. */
export async function mayAct(
  run: Pick<RunRow, "cursor" | "definition"> & RunFacts,
  caller: Caller,
): Promise<boolean> {
  if (!(await answeringNarrowed())) {
    return true;
  }
  const step = stepOfRun(run);
  return mayAnswerStep(run, step, caller, whoOf(step) === "team" ? await answerersOf(run) : []);
}

/**
 * Back undoes the step before and asks it again, so it takes the right to answer both: nobody
 * reopens what another person answered, and nobody takes a step from the one it waits for.
 */
export function mayGoBackFrom(run: WaitingRun, caller: Caller, team: Answerers): boolean {
  const previous = stepOfRun(run, run.state.history.at(-1) ?? null);
  return (
    mayAnswerStep(run, stepOfRun(run), caller, team) && mayAnswerStep(run, previous, caller, team)
  );
}

/**
 * A visitor may take their own run back while the team has it: it is their request, and the team
 * shouldn't work on what they dropped. True only then, for what they couldn't do by `mayAct`.
 */
export async function mayWithdraw(
  run: Pick<RunRow, "cursor" | "definition" | "visitorId" | "status">,
  caller: Caller,
): Promise<boolean> {
  return (
    Boolean(caller.visitorId && caller.visitorId === run.visitorId) &&
    run.status === "waiting_input" &&
    whoOf(stepOfRun(run)) === "team" &&
    (await answeringNarrowed())
  );
}

/** A door with no person's identity to check: a plugin's, which speaks for the run's visitor. */
export const doorCaller = (run: Pick<RunRow, "visitorId">): Caller => ({
  visitorId: run.visitorId,
});

/**
 * The people a `who: "team"` step asks: those named, or with nobody named its admins, as the
 * Manage-App has them now. Someone who left is no longer asked. No answer from the Manage-App leaves
 * those named as they are; the admins can't be named then, and read their list in Work.
 */
export async function teamToAsk(team: Answerers): Promise<string[]> {
  const members = await tenantMembers(currentTenant())
    .then((m) => m.members)
    .catch((err) => {
      console.warn("[answerers] members not read:", (err as Error).message);
      return null;
    });
  if (Array.isArray(team) && team.length) {
    return members
      ? team.filter((id) => members.some((m) => m.userId === id && m.role !== "client"))
      : team;
  }
  return (members ?? []).filter((m) => isAdminRole(m.role)).map((m) => m.userId);
}

/** Outside the organization: a visitor, a link's holder, a client in their portal. */
const guestOf = (caller: Caller) => !(caller.local || (caller.userId && caller.role !== "client"));

/**
 * The run as this viewer may see it. Someone in the organization reads along; a visitor or a link's
 * holder doesn't see a step that isn't theirs, nor what the organization answered in such a step.
 */
export async function viewFor(view: RunView, run: RunRow, caller: Caller): Promise<RunView> {
  if (!(await answeringNarrowed())) {
    return view;
  }
  const team = await answerersOf(run);
  const step = stepOfRun(run);
  const may = mayAnswerStep(run, step, caller, team);
  const waits = run.status === "waiting_input";
  const guest = guestOf(caller);
  const narrowed: RunView = {
    ...view,
    answeredBy: waits && !may ? whoOf(step) : null,
    canWithdraw: await mayWithdraw(run, caller),
    canBack: view.canBack && mayGoBackFrom(run, caller, team),
    ask: may ? view.ask : null,
    talk: may && view.talk,
    // What was typed, and what the browser may do alone, is for whoever may answer.
    unsent: may ? view.unsent : undefined,
    ahead: may ? view.ahead : undefined,
    pagesSent: may ? view.pagesSent : undefined,
  };
  if (!guest) {
    return narrowed;
  }
  const inside = run.definition.steps.filter((s) => whoOf(s) === "team");
  const hiddenFields = new Set(
    inside.flatMap((s) => (s.type === "form" ? s.fields.map((f) => f.id) : [])),
  );
  const seen: RunView = {
    ...narrowed,
    values: Object.fromEntries(Object.entries(view.values).filter(([id]) => !hiddenFields.has(id))),
    answered: view.answered.filter((s) => !inside.some((i) => i.id === s.id)),
  };
  return seen.answeredBy
    ? {
        ...seen,
        step: null,
        shown: [],
        outputs: {},
        lists: [],
        connections: [],
        closed: {},
        prefill: {},
        question: null,
      }
    : seen;
}

/**
 * What a guest may not open while the run waits for someone else: the outputs that step shows.
 */
export async function hiddenWhileAsked(run: RunRow, caller: Caller): Promise<string[]> {
  if (!guestOf(caller) || !(await answeringNarrowed())) {
    return [];
  }
  const step = stepOfRun(run);
  return run.status === "waiting_input" &&
    step?.type === "review" &&
    !mayAnswerStep(run, step, caller, await answerersOf(run))
    ? step.show
    : [];
}
