import { ShieldQuestion } from "lucide-react";
import type { ReactNode, SVGProps } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { type Key, t } from "../../lib/i18n";
import { MODE_HOME, type Mode, useMode } from "../../lib/mode";
import { useMe } from "../../lib/session";
import { useCrumbs } from "../AppFrame";
import { ChatSidebar } from "./ChatSidebar";
import { ChatView } from "./ChatView";
import { useWaiting } from "./chats";

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
  if (chatId) {
    return <ChatsPage />;
  }
  const known = WORK_PLACES.find((p) => p.place === place && p.place !== "chats");
  if (place && !known) {
    return <Navigate to="/work" replace />;
  }
  if (known?.place === "waiting") {
    return <WaitingPlace />;
  }
  return known ? <EmptyPlace place={known.place as keyof typeof EMPTY} /> : <ChatsPage />;
}

/** Chats: the sidebar, and the open chat or a line where it will be. */
function ChatsPage() {
  const { chatId } = useParams();
  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar />
      {chatId ? <ChatView id={chatId} /> : <NoChat />}
    </div>
  );
}

function NoChat() {
  useCrumbs([{ label: t("work.chats") }]);
  return (
    <div className="grid min-w-0 flex-1 place-items-center p-6">
      <p className="text-center text-[0.9375rem] text-ink-3">{t("work.chatsEmpty")}</p>
    </div>
  );
}

function EmptyPlace({ place }: { place: keyof typeof EMPTY }) {
  const label = WORK_PLACES.find((p) => p.place === place)?.label ?? "work.chats";
  useCrumbs([{ label: t(label) }]);
  return <Empty>{t(EMPTY[place])}</Empty>;
}

/** The bell: the calls held for the person's approval, each leading to its chat. */
function WaitingPlace() {
  useCrumbs([{ label: t("work.waiting") }]);
  const approvals = useWaiting().data?.approvals ?? [];
  if (!approvals.length) {
    return <Empty>{t("work.waitingEmpty")}</Empty>;
  }
  return (
    <ul className="mx-auto grid w-full max-w-2xl gap-2 py-8">
      {approvals.map((a) => (
        <li key={a.id}>
          <NavLink
            to={`/work/c/${a.chatId}`}
            className="flex items-center gap-2 rounded-xl border border-border px-4 py-3 text-[0.9375rem] text-ink hover:bg-ink/5"
          >
            <ShieldQuestion className="size-4 shrink-0 text-ember" />
            {t("work.approval.waiting", { name: a.toolName })}
          </NavLink>
        </li>
      ))}
    </ul>
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
