import { MessageSquare, ShieldQuestion } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { Mascot } from "../../brand";
import { lang, t } from "../../lib/i18n";
import { type Me, useCurrentSpace, useMe, type WizardSummary } from "../../lib/session";
import { Button, cn } from "../../ui";
import { Composer, type ComposerHandle } from "../../ui/composer";
import { useCrumbs } from "../AppFrame";
import { useAssistantPage } from "../assistant/page";
import { openExternal } from "../LocalRuntime";
import {
  type Approval,
  type SidebarChat,
  uploadFiles,
  useCreateChat,
  useDecide,
  useSidebar,
  useWaiting,
} from "./chats";
import { usePublishedWizards, useTurnChoices, wizardChatLink } from "./choices";
import { SpaceFilesDialog } from "./SpaceFilesDialog";

/**
 * Work's start, where no chat is open (docs: engenty-dev concepts, "Work Beyond Chat", Today):
 * what needs the person first (calls held for their approval, chats with something new), what
 * the space's AI answers right now, a few of the space's wizards, the chats of late, and a field
 * that starts a new chat by asking the space's AI, with files if the person adds some.
 */

const RECENT = 6;
/** The space's published wizards the start shows, the ones changed last first. */
const WIZARDS = 4;

export function WorkHome() {
  useCrumbs([{ label: t("work.chats") }]);
  // A chat starts here: Goose stays small beside it.
  useAssistantPage({ ownInput: true });
  const { space } = useCurrentSpace();
  const me = useMe().data;
  const spaceName = space?.name ?? "";
  const chats = (useSidebar(space?.id, "").data?.chats ?? []).filter((c) => !c.archived);
  const approvals = useWaiting().data?.approvals ?? [];
  const createChat = useCreateChat();
  const navigate = useNavigate();
  const composer = useRef<ComposerHandle>(null);
  const [choosing, setChoosing] = useState(false);
  const choices = useTurnChoices(space?.id, () => setChoosing(true));
  const [error, setError] = useState<string | null>(null);
  // The same list as the studio's start page: where each wizard runs comes with it.
  const wizards = usePublishedWizards(space?.id).slice(0, WIZARDS);

  const titles = new Map(chats.map((c) => [c.id, c.title || t("work.untitled")]));
  const unread = chats.filter((c) => c.unread && c.last);
  const answering = chats.filter((c) => c.answeringSince);
  const shown = new Set([...unread, ...answering].map((c) => c.id));
  const recent = [...chats]
    .filter((c) => !shown.has(c.id))
    .sort((a, b) => (lastAt(b) > lastAt(a) ? 1 : -1))
    .slice(0, RECENT);
  const needs = approvals.length + unread.length;
  const name = me?.user.name.split(" ")[0] ?? "";

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl gap-10 px-6 pt-14 pb-16">
        <header className="grid gap-1.5">
          <p className="text-[0.8125rem] text-ink-3">
            {new Date().toLocaleDateString(lang, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <h1 className="font-display font-semibold text-[2rem] text-ink leading-tight">
            {greeting(name)}
          </h1>
          <p className="text-[0.9375rem] text-ink-2">
            {needs ? t("work.home.needs", { count: needs }) : t("work.waitingEmpty")}
          </p>
        </header>

        <div className="grid gap-1.5">
          <Composer
            ref={composer}
            tall
            autoFocus
            placeholder={t("work.home.ask", { name: spaceName })}
            chooser={choices.chooser}
            plus={choices.plus}
            onSend={async (raw, files, _later, picked = []) => {
              const text = raw.trim();
              if ((!text && !files.length && !picked.length) || !space) {
                return false;
              }
              setError(null);
              try {
                const chat = await createChat.mutateAsync({ spaceId: space.id });
                const added = await uploadFiles(chat.id, files);
                navigate(`/work/c/${chat.id}`, {
                  state: { ask: text, files: [...picked, ...added], choice: choices.choice },
                });
                return true;
              } catch (err) {
                setError((err as Error).message);
                return false;
              }
            }}
          />
          <p className={cn("px-3 text-[0.75rem]", error ? "text-danger" : "text-ink-4")}>
            {error ? t("work.files.uploadFailed", { message: error }) : t("work.home.askHint")}
          </p>
          {space ? (
            <SpaceFilesDialog
              spaceId={space.id}
              open={choosing}
              onClose={() => setChoosing(false)}
              onPick={(files) => composer.current?.pick(files)}
            />
          ) : null}
        </div>

        {needs ? (
          <Part label={t("work.home.needsYou")}>
            <div className="grid gap-3 sm:grid-cols-2">
              {approvals.map((a) => (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  chat={titles.get(a.chatId) ?? t("work.untitled")}
                  may={
                    me?.tenant.role !== "member" ||
                    (a.heldFor === "asker" && a.askedBy === me?.user.id)
                  }
                />
              ))}
              {unread.map((c) => (
                <UnreadCard key={c.id} chat={c} />
              ))}
            </div>
          </Part>
        ) : null}

        {answering.length ? (
          <Part label={t("work.home.running")}>
            <ul className="grid">
              {answering.map((c) => (
                <ChatLine
                  key={c.id}
                  chat={c}
                  note={
                    <span className="flex items-center gap-1.5 text-ember">
                      <span className="size-1.5 animate-pulse rounded-full bg-ember" />
                      {t("work.home.answering", { name: spaceName })}
                    </span>
                  }
                />
              ))}
            </ul>
          </Part>
        ) : null}

        {wizards.length && me ? (
          <Part label={t("work.home.wizards")}>
            <div className="grid gap-3 sm:grid-cols-2">
              {wizards.map((w) => (
                <WizardCard key={w.id} wizard={w} me={me} />
              ))}
            </div>
          </Part>
        ) : null}

        {recent.length ? (
          <Part label={t("work.home.recent")}>
            <ul className="grid">
              {recent.map((c) => (
                <ChatLine key={c.id} chat={c} />
              ))}
            </ul>
          </Part>
        ) : null}
      </div>
    </div>
  );
}

const lastAt = (c: SidebarChat) => c.last?.at ?? c.updatedAt;

function greeting(name: string) {
  const hour = new Date().getHours();
  const key = hour < 11 ? "work.home.morning" : hour < 18 ? "work.home.day" : "work.home.evening";
  return t(key, { name });
}

/** Today at its time, yesterday as such, else the date. */
function when(iso: string) {
  const day = new Date(iso);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) {
    return day.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  }
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) {
    return t("work.yesterday");
  }
  return day.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold text-[0.75rem] text-ink-3 uppercase tracking-wide">{label}</h2>
      {children}
    </section>
  );
}

const card = "grid content-start gap-3 rounded-2xl border border-border bg-card p-4";

/** A call held for approval: decided right here, or opened in its chat. */
function ApprovalCard({ approval, chat, may }: { approval: Approval; chat: string; may: boolean }) {
  const decide = useDecide(approval.chatId);
  return (
    <div className={cn(card, "border-ember/40")}>
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-ember" />
        <div className="grid min-w-0 gap-0.5">
          <p className="truncate text-[0.75rem] text-ink-3">{chat}</p>
          <p className="font-medium text-[0.9375rem] text-ink">
            {t(
              approval.heldFor === "admins"
                ? "work.approval.waitingAdmins"
                : "work.approval.waiting",
              { name: approval.toolName },
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {may ? (
          <>
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, approve: true })}
            >
              {t("work.approval.approve")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: approval.id, approve: false })}
            >
              {t("work.approval.deny")}
            </Button>
          </>
        ) : null}
        <NavLink
          to={`/work/c/${approval.chatId}`}
          className="ml-auto text-[0.8125rem] text-ink-3 hover:text-ink"
        >
          {t("work.home.open")}
        </NavLink>
      </div>
    </div>
  );
}

/**
 * A published wizard of the space: it opens in its own chat (the chat runner, `/w/<token>/chat`)
 * in a new tab, where it runs. Work's chats don't run wizards yet (docs/plans/work-chats.md,
 * piece 7).
 */
function WizardCard({ wizard: w, me }: { wizard: WizardSummary; me: Me }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(wizardChatLink(w, me))}
      title={t("work.home.wizardOpen")}
      className={cn(card, "grid-cols-[auto_1fr] items-start text-left hover:bg-ink/5")}
    >
      <Mascot kind={w.avatar} costume={w.costume} size={40} />
      <div className="grid min-w-0 gap-0.5">
        <p className="truncate font-medium text-[0.9375rem] text-ink">{w.title}</p>
        <p className="line-clamp-2 text-[0.8125rem] text-ink-3">{w.description}</p>
      </div>
    </button>
  );
}

/** A chat with something new: its last message, and the way in. */
function UnreadCard({ chat }: { chat: SidebarChat }) {
  const byline = useByline(chat);
  return (
    <NavLink to={`/work/c/${chat.id}`} className={cn(card, "hover:bg-ink/5")}>
      <div className="flex items-start gap-2.5">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="grid min-w-0 gap-0.5">
          <p className="truncate text-[0.75rem] text-ink-3">
            {chat.title || t("work.untitled")} · {when(lastAt(chat))}
          </p>
          <p className="line-clamp-3 text-[0.9375rem] text-ink">
            <span className="font-medium">{byline}</span>
            {chat.last?.text}
          </p>
        </div>
      </div>
    </NavLink>
  );
}

/** Who wrote a chat's last message, before its text: the person themselves as "You". */
function useByline(chat: SidebarChat) {
  const name = useMe().data?.user.name;
  const author = chat.last?.author;
  return author ? `${author === name ? t("work.you") : author}: ` : "";
}

function ChatLine({ chat, note }: { chat: SidebarChat; note?: ReactNode }) {
  const byline = useByline(chat);
  return (
    <li>
      <NavLink
        to={`/work/c/${chat.id}`}
        className="-mx-3 flex items-baseline gap-3 rounded-xl px-3 py-2.5 hover:bg-ink/5"
      >
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-medium text-[0.9375rem] text-ink">
            {chat.title || t("work.untitled")}
          </p>
          <div className="truncate text-[0.8125rem] text-ink-3">
            {note ??
              (chat.last ? (
                <>
                  {byline}
                  {chat.last.text}
                </>
              ) : (
                t("work.emptyChat")
              ))}
          </div>
        </div>
        <span className="shrink-0 text-[0.75rem] text-ink-4">{when(lastAt(chat))}</span>
      </NavLink>
    </li>
  );
}
