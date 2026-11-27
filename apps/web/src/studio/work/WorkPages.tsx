import { FileQuestion, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { useFeature } from "../../lib/features";
import { type Key, lang, t } from "../../lib/i18n";
import { MODE_HOME, type Mode, useMode } from "../../lib/mode";
import { useMe } from "../../lib/session";
import { RunnerBody } from "../../runner/RunnerView";
import { TopBar, useCrumbs } from "../AppFrame";
import { AssistantDock } from "../assistant/StudioAssistant";
import { runFacts, runLink } from "./runs";
import { TeamHome } from "./TeamHome";
import { type CriticalItem, useBellOpened, useWaiting } from "./waiting";

/**
 * Work mode's places (behind `workMode`): Chats, which are the chats of the team's Bot Server
 * (wizards.bot) shown here, and the bell with what waits for the person.
 */

export type WorkPlace = "chats" | "waiting";

export const WORK_PLACES: readonly { place: WorkPlace; to: string; label: Key }[] = [
  { place: "chats", to: "/work", label: "work.chats" },
  { place: "waiting", to: "/work/waiting", label: "work.waiting" },
];

/** A page of one mode: in another mode it goes to that mode's start. */
export function InMode({ mode, children }: { mode: Mode; children: ReactNode }) {
  const current = useMode(useMe().data);
  return current === mode ? children : <Navigate to={MODE_HOME[current]} replace />;
}

/** `/work/:place?`: Chats without a place, the bell at `waiting`; any other address leads to the chats. */
export function WorkPage() {
  const { place } = useParams();
  if (place === "waiting") {
    return <WaitingPlace />;
  }
  return place ? <Navigate to="/work" replace /> : <ChatsPage />;
}

/**
 * Chats: the studio's top bar (organization, space, where the page stands), then the Bot Server's
 * page. The page fills the frame, so it draws the bar itself.
 */
function ChatsPage() {
  const me = useMe().data;
  // Goose: folded in the top bar, opened at the bottom of the chats' column.
  const goose = useFeature("goose");
  const column = useRef<HTMLDivElement>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {me ? <TopBar me={me} /> : null}
      <div ref={column} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <TeamHome />
        {goose ? <AssistantDock column={column} /> : null}
      </div>
    </div>
  );
}

const item =
  "flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-[0.9375rem] text-ink hover:bg-ink/5";

/**
 * The bell: the runs that wait for the person, and for an admin the broker's critical lines of
 * the last days (docs/plans/broker.md, "Notifications"), each leading to its run. Opening the
 * bell marks the lines seen.
 */
function WaitingPlace() {
  useCrumbs([{ label: t("work.waiting") }]);
  const waiting = useWaiting().data;
  const opened = useBellOpened();
  const open = opened.mutate;
  useEffect(() => {
    open();
  }, [open]);
  const critical = waiting?.critical ?? [];
  const runs = waiting?.runs?.needs ?? [];
  if (!(critical.length || runs.length)) {
    return <Empty>{t("work.waitingEmpty")}</Empty>;
  }
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-8 py-8">
      {runs.length ? (
        <section className="grid gap-2">
          <h2 className="font-semibold text-[0.75rem] text-ink-3 uppercase tracking-wide">
            {t("work.waiting.runs")}
          </h2>
          <ul className="grid gap-2">
            {runs.map((r) => (
              <li key={r.runId}>
                <NavLink to={runLink(r)} className={item}>
                  <FileQuestion className="size-4 shrink-0 text-ember" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate">
                      {r.wizard} · {r.step}
                    </span>
                    <span className="truncate text-[0.8125rem] text-ink-3">{runFacts(r)}</span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {critical.length ? (
        <section className="grid gap-2">
          <h2 className="font-semibold text-[0.75rem] text-ink-3 uppercase tracking-wide">
            {t("work.waiting.critical")}
          </h2>
          <ul className="grid gap-2">
            {critical.map((c) => (
              <li key={c.id}>
                <CriticalLine line={c} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Where a critical line leads: the run in its wizard; nowhere for a changed rule or a chat's call. */
function criticalLink(line: CriticalItem): string | null {
  if (line.wizardId) {
    return `/edit/${line.wizardId}${line.runId ? `?run=${line.runId}` : ""}`;
  }
  return null;
}

function CriticalLine({ line }: { line: CriticalItem }) {
  const to = criticalLink(line);
  const body = (
    <>
      <ShieldAlert className="size-4 shrink-0 text-ember" />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">
          {t(`work.critical.${line.kind}`)}
          {" · "}
          {line.connectionId} · {line.actionId}
        </span>
        <span className="truncate text-[0.8125rem] text-ink-3">
          {new Date(line.at).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" })}
          {" · "}
          {line.who.kind}
          {line.reason ? ` · ${line.reason}` : ""}
        </span>
      </span>
    </>
  );
  return to ? (
    <NavLink to={to} className={item}>
      {body}
    </NavLink>
  ) : (
    <div className={item}>{body}</div>
  );
}

/**
 * `/work/r/:runId`: a run inside Work, where whoever is asked answers it. It is where a run's mail
 * leads someone who answers for the team, so it opens in any mode.
 */
export function WorkRunPage() {
  const { runId } = useParams();
  useCrumbs([{ label: t("work.waiting") }]);
  return runId ? (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <RunnerBody key={runId} runId={runId} studio stickyProgress />
    </div>
  ) : null;
}

/** A place with nothing in it: one sentence. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="py-24 text-center text-[0.9375rem] text-ink-3">{children}</p>;
}
