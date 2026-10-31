import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { type ReactNode, type SVGProps, useEffect } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { useFeature } from "../../lib/features";
import { type Key, lang, t } from "../../lib/i18n";
import { MODE_HOME, type Mode, useMode } from "../../lib/mode";
import { useMe } from "../../lib/session";
import { TopBar, useCrumbs } from "../AppFrame";
import { ChatSidebar } from "./ChatSidebar";
import { ChatView } from "./ChatView";
import { type CriticalItem, useBellOpened, useWaiting } from "./chats";
import { WorkHome } from "./WorkHome";

/**
 * Work mode's places (behind `workMode`), empty in this step: Chats with its sidebar, the
 * engenties, files, data and results of the space, and the bell. The chats, their folders and
 * what waits for the person come with their data (docs: engenty-dev concepts, work mode).
 */

export type WorkPlace = "chats" | "engenties" | "files" | "data" | "results" | "waiting";

export const WORK_PLACES: readonly { place: WorkPlace; to: string; label: Key }[] = [
  { place: "chats", to: "/work", label: "work.chats" },
  { place: "engenties", to: "/work/engenties", label: "work.engenties" },
  { place: "files", to: "/work/files", label: "work.files" },
  { place: "data", to: "/work/data", label: "work.data" },
  { place: "results", to: "/work/results", label: "work.results" },
  { place: "waiting", to: "/work/waiting", label: "work.waiting" },
];

const EMPTY: Record<Exclude<WorkPlace, "chats">, Key> = {
  engenties: "work.engentiesEmpty",
  files: "work.filesEmpty",
  data: "work.dataEmpty",
  results: "work.resultsEmpty",
  waiting: "work.waitingEmpty",
};

/** An engenty as a line glyph, with its one eye, beside the bar's other glyphs. */
export function EngentyGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3.2Q19 7.6 19 14q0 6.5-7 6.9Q5 20.5 5 14q0-6.4 7-10.8z" />
      <circle cx="12" cy="12.6" r="2.2" />
    </svg>
  );
}

/** A page of one mode: in another mode it goes to that mode's start. */
export function InMode({ mode, children }: { mode: Mode; children: ReactNode }) {
  const current = useMode(useMe().data);
  return current === mode ? children : <Navigate to={MODE_HOME[current]} replace />;
}

/** `/work/:place?`: Chats without a place, else one of the others. */
export function WorkPage() {
  const { place, chatId } = useParams();
  const wip = useFeature("workWip");
  if (chatId) {
    return <ChatsPage />;
  }
  // The places past the chats come with `workWip`; without it their addresses lead to the chats.
  const known = wip ? WORK_PLACES.find((p) => p.place === place && p.place !== "chats") : undefined;
  if (place && !known) {
    return <Navigate to="/work" replace />;
  }
  if (known?.place === "waiting") {
    return <WaitingPlace />;
  }
  return known ? <EmptyPlace place={known.place as keyof typeof EMPTY} /> : <ChatsPage />;
}

/**
 * Chats: the studio's top bar (organization, space, where the page stands), then the sidebar
 * and the open chat or Work's start. The page fills the frame, so it draws the bar itself.
 */
function ChatsPage() {
  const { chatId } = useParams();
  const me = useMe().data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {me ? <TopBar me={me} /> : null}
      <div className="flex min-h-0 flex-1">
        <ChatSidebar />
        {chatId ? <ChatView id={chatId} /> : <WorkHome />}
      </div>
    </div>
  );
}

function EmptyPlace({ place }: { place: keyof typeof EMPTY }) {
  const label = WORK_PLACES.find((p) => p.place === place)?.label ?? "work.chats";
  useCrumbs([{ label: t(label) }]);
  return <Empty>{t(EMPTY[place])}</Empty>;
}

const item =
  "flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-[0.9375rem] text-ink hover:bg-ink/5";

/**
 * The bell: the calls held for the person's approval, each leading to its chat, and for an admin
 * the broker's critical lines of the last days (docs/plans/broker.md, "Notifications"), each
 * leading to its run or chat. Opening the bell marks the lines seen.
 */
function WaitingPlace() {
  useCrumbs([{ label: t("work.waiting") }]);
  const waiting = useWaiting().data;
  const opened = useBellOpened();
  const open = opened.mutate;
  useEffect(() => {
    open();
  }, [open]);
  const approvals = waiting?.approvals ?? [];
  const critical = waiting?.critical ?? [];
  if (!(approvals.length || critical.length)) {
    return <Empty>{t("work.waitingEmpty")}</Empty>;
  }
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-8 py-8">
      {approvals.length ? (
        <section className="grid gap-2">
          <h2 className="font-semibold text-[0.75rem] text-ink-3 uppercase tracking-wide">
            {t("work.waiting.calls")}
          </h2>
          <ul className="grid gap-2">
            {approvals.map((a) => (
              <li key={a.id}>
                <NavLink to={`/work/c/${a.chatId}`} className={item}>
                  <ShieldQuestion className="size-4 shrink-0 text-ember" />
                  {t(
                    a.heldFor === "admins"
                      ? "work.approval.waitingAdmins"
                      : "work.approval.waiting",
                    { name: a.toolName },
                  )}
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

/** Where a critical line leads: the chat, or the run in its wizard; nowhere for a changed rule. */
function criticalLink(line: CriticalItem): string | null {
  if (line.chatId) {
    return `/work/c/${line.chatId}`;
  }
  if (line.wizardId) {
    return `/wizards/${line.wizardId}${line.runId ? `?run=${line.runId}` : ""}`;
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

/** Client mode: one placeholder until the client's view is built. */
export function ClientPage() {
  useCrumbs([{ label: t("mode.client") }]);
  return <Empty>{t("client.placeholder")}</Empty>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-24 text-center text-[0.9375rem] text-ink-3">{children}</p>;
}
