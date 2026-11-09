import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/index.js";
import { db, schema } from "../db/client.js";
import { answeringNarrowed, whoOf } from "../engine/answerers.js";
import { visitorAddress } from "../engine/notices.js";
import type { RunRow } from "../engine/types.js";
import { isAdminRole } from "./access.js";

/**
 * The runs Work lists for a person (behind `durableRuns`, docs/plans/durable-agents.md, "Where a
 * person sees and answers"): those that need them, and under "Waits" those that go on by themselves.
 *
 * A run needs someone when it waits on a step they answer: their own run, or a `who: "team"` step
 * of a wizard that names them. Admins may answer every run, but their list holds only what is asked
 * of them: with nobody named, or "admins", that is the team's steps. Test runs stay in the studio.
 */

const MOST = 100;
/** Waiting for a person looks like sleeping (engine/runner.ts `waitForPerson`). */
const needsPerson = (run: RunRow) =>
  run.status === "waiting_input" ||
  (run.status === "sleeping" && Boolean(run.state.pause) && run.state.pause?.kind !== "retry");

export interface WaitingRun {
  runId: string;
  wizardId: string;
  spaceId: string;
  wizard: string;
  stepId: string;
  step: string;
  /** What it is that waits: a form, a review, an approval, a question of an AI step, a pause. */
  kind: "form" | "review" | "approve" | "question" | "pause";
  status: RunRow["status"];
  /** The wizard's `label` of the run, else the address the run knows its person by. */
  about: string | null;
  /** What the step says to whoever answers it. */
  detail: string | null;
  since: string;
  until: string | null;
}

/** The team's steps a person answers: by the wizards that name them, or with nobody named. */
function teamWizards(
  wizards: { id: string; answerers: string[] | "admins" }[],
  user: Pick<SessionUser, "id" | "role">,
) {
  return wizards
    .filter((w) =>
      Array.isArray(w.answerers) && w.answerers.length
        ? w.answerers.includes(user.id)
        : isAdminRole(user.role),
    )
    .map((w) => w.id);
}

const cursorIsTeams = sql`EXISTS (
  SELECT 1 FROM json_each(${schema.run.definition}, '$.steps') AS s
  WHERE json_extract(s.value, '$.id') = ${schema.run.cursor}
    AND json_extract(s.value, '$.who') = 'team'
)`;

function line(run: RunRow, spaceId: string): WaitingRun | null {
  const step = run.definition.steps.find((s) => s.id === run.cursor);
  if (!step) {
    return null;
  }
  const question = run.state.turn?.question ?? null;
  const pause = run.status === "sleeping" ? run.state.pause : undefined;
  const kind = question
    ? "question"
    : pause
      ? "pause"
      : step.type === "form"
        ? "form"
        : step.type === "review"
          ? step.approve
            ? "approve"
            : "review"
          : "form";
  return {
    runId: run.id,
    wizardId: run.wizardId,
    spaceId,
    wizard: run.definition.title,
    stepId: step.id,
    step: step.title,
    kind,
    status: run.status,
    about: run.label ?? visitorAddress(run),
    detail: question ?? step.description ?? null,
    since: run.updatedAt.toISOString(),
    until: run.wakeAt?.toISOString() ?? null,
  };
}

/** What a person's Work lists, newest first. Nothing without the switch. */
export async function runsFor(
  user: Pick<SessionUser, "id" | "role">,
): Promise<{ needs: WaitingRun[]; waits: WaitingRun[] }> {
  if (!(await answeringNarrowed()) || user.role === "client") {
    return { needs: [], waits: [] };
  }
  const wizards = await db.query.wizard.findMany({
    columns: { id: true, spaceId: true, answerers: true },
  });
  const team = teamWizards(wizards, user);
  const live = eq(schema.run.mode, "live");
  const own = await db.query.run.findMany({
    where: and(
      live,
      eq(schema.run.userId, user.id),
      inArray(schema.run.status, ["waiting_input", "sleeping", "waiting_signal"]),
    ),
    orderBy: [desc(schema.run.updatedAt)],
    limit: MOST,
  });
  // What the team is asked.
  const asked = team.length
    ? await db.query.run.findMany({
        where: and(
          live,
          inArray(schema.run.wizardId, team),
          eq(schema.run.status, "waiting_input"),
          cursorIsTeams,
        ),
        orderBy: [desc(schema.run.updatedAt)],
        limit: MOST,
      })
    : [];
  const spaces = new Map(wizards.map((w) => [w.id, w.spaceId]));
  const needs: WaitingRun[] = [];
  const waits: WaitingRun[] = [];
  const seen = new Set<string>();
  for (const run of [...asked, ...own]) {
    if (seen.has(run.id)) {
      continue;
    }
    seen.add(run.id);
    const shown = line(run, spaces.get(run.wizardId) ?? "");
    if (!shown) {
      continue;
    }
    // Their own run that waits on the team waits on someone else: it goes on without them.
    const theirs =
      needsPerson(run) &&
      (whoOf(run.definition.steps.find((s) => s.id === run.cursor)) !== "team" ||
        asked.some((r) => r.id === run.id));
    (theirs ? needs : waits).push(shown);
  }
  const newest = (a: WaitingRun, b: WaitingRun) => (a.since < b.since ? 1 : -1);
  return { needs: needs.sort(newest), waits: waits.sort(newest) };
}
