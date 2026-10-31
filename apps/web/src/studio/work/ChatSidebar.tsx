import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  Eye,
  EyeOff,
  FolderInput,
  Home,
  Link2,
  ListFilter,
  Lock,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  type ComponentType,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "../../lib/i18n";
import { useCurrentSpace } from "../../lib/session";
import { cn } from "../../ui";
import {
  type Section,
  type SidebarChat,
  useChatState,
  useCreateChat,
  useCreateSection,
  useDeleteChat,
  useDeleteSection,
  useMoveSection,
  usePostMessage,
  useRenameSection,
  useSidebar,
  useUpdateChat,
} from "./chats";

/**
 * Chats' sidebar in Work: Work's start page on top, a new chat, the search, the pinned chats, the sections and the chats in
 * none, each chat with its sub-threads beneath it. A chat is pinned, archived, marked unread,
 * renamed, moved (also by dragging it onto a section) and deleted from its row: the buttons on
 * hover, the ⋯ menu, a right click, or a key while the row has focus.
 */

const DRAG_TYPE = "application/x-wizards-chat";

/** The sections and parents folded shut, kept in this browser. */
function useFolded(key: string) {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(id)) {
        next.add(id);
      }
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // folded for this page only then
      }
      return next;
    });
  return [folded, toggle] as const;
}

export function ChatSidebar() {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { space } = useCurrentSpace();
  const { data } = useSidebar(space?.id, query);
  const [foldedSections, toggleSection] = useFolded("wizards.work.folded-sections");
  const [foldedThreads, toggleThreads] = useFolded("wizards.work.folded-threads");
  const [addingSection, setAddingSection] = useState(false);
  const createChat = useCreateChat();
  const createSection = useCreateSection();
  const navigate = useNavigate();

  const sections = data?.sections ?? [];
  const all = (data?.chats ?? []).filter(
    (c) => (showArchived || !c.archived) && (!unreadOnly || c.unread),
  );
  const ids = new Set(all.map((c) => c.id));
  const top = all.filter((c) => !c.parentId || !ids.has(c.parentId));
  const threadsOf = (id: string) => all.filter((c) => c.parentId === id);
  const known = new Set(sections.map((s) => s.id));
  const live = top.filter((c) => !c.archived);
  const pinned = live.filter((c) => c.pinned);
  const inSection = (id: string) => live.filter((c) => !c.pinned && c.sectionId === id);
  const loose = live.filter((c) => !c.pinned && (!c.sectionId || !known.has(c.sectionId)));
  const archived = top.filter((c) => c.archived);

  const newChat = async (sectionId: string | null = null, parentId: string | null = null) => {
    const chat = await createChat.mutateAsync({ spaceId: space?.id, sectionId, parentId });
    navigate(`/work/c/${chat.id}`);
  };

  const row = (chat: SidebarChat) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      sections={sections}
      threads={threadsOf(chat.id)}
      threadsFolded={foldedThreads.has(chat.id)}
      onToggleThreads={() => toggleThreads(chat.id)}
      onNewThread={() => newChat(chat.sectionId, chat.id)}
      onNewSection={() => setAddingSection(true)}
    />
  );

  return (
    <TooltipProvider delay={500}>
      <aside
        aria-label={t("work.chats")}
        className="flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-border-soft border-r p-2 text-[0.875rem]"
      >
        <NavLink
          to="/work"
          end
          className={({ isActive }) =>
            cn(
              "mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 font-semibold text-ink hover:bg-ink/5",
              isActive && "bg-ink/10 hover:bg-ink/10",
            )
          }
        >
          <Home className="size-4 shrink-0" />
          {t("work.start")}
        </NavLink>
        <button
          type="button"
          onClick={() => newChat()}
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-ink/5"
        >
          <Plus className="size-4 shrink-0" />
          {t("work.newChat")}
        </button>
        <label className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-ink-3 focus-within:bg-ink/5 hover:bg-ink/5">
          <Search className="size-4 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("work.search")}
            aria-label={t("work.search")}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3"
          />
        </label>

        {pinned.length ? <Group title={t("work.pinned")}>{pinned.map(row)}</Group> : null}

        {sections.map((section, at) => (
          <SectionGroup
            key={section.id}
            section={section}
            first={at === 0}
            last={at === sections.length - 1}
            folded={foldedSections.has(section.id)}
            onToggle={() => toggleSection(section.id)}
            onNewChat={() => newChat(section.id)}
          >
            {inSection(section.id).map(row)}
          </SectionGroup>
        ))}
        {addingSection ? (
          <NameField
            placeholder={t("work.sectionName")}
            onDone={async (name) => {
              setAddingSection(false);
              if (name && space) {
                await createSection.mutateAsync({ spaceId: space.id, name });
              }
            }}
          />
        ) : null}

        <Group
          title={t("work.chats")}
          dropTo={null}
          actions={
            <>
              <DropdownMenu>
                <Hint label={t("work.filter")}>
                  <DropdownMenuTrigger className={ICON_BUTTON} aria-label={t("work.filter")}>
                    <ListFilter className="size-3.5" />
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuCheckboxItem
                    checked={unreadOnly}
                    onCheckedChange={(on) => setUnreadOnly(Boolean(on))}
                  >
                    {t("work.unreadOnly")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showArchived}
                    onCheckedChange={(on) => setShowArchived(Boolean(on))}
                  >
                    {t("work.showArchived")}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Hint label={t("work.newSection")}>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={t("work.newSection")}
                  onClick={() => setAddingSection(true)}
                >
                  <Plus className="size-3.5" />
                </button>
              </Hint>
            </>
          }
        >
          {loose.length ? (
            loose.map(row)
          ) : (
            <p className="px-2.5 py-1 text-[0.8125rem] text-ink-4">
              {query || unreadOnly ? t("work.noMatches") : t("work.noChats")}
            </p>
          )}
        </Group>

        {showArchived && archived.length ? (
          <Group title={t("work.archived")}>{archived.map(row)}</Group>
        ) : null}
      </aside>
    </TooltipProvider>
  );
}

const ICON_BUTTON =
  "grid size-6 place-items-center rounded-md text-ink-3 hover:bg-ink/10 hover:text-ink data-popup-open:bg-ink/10";

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Takes a chat dragged from a row; `dropTo` is the section it lands in (null: none). */
function useDrop(dropTo: string | null | undefined) {
  const [over, setOver] = useState(false);
  const update = useUpdateChat();
  if (dropTo === undefined) {
    return { over: false, props: {} };
  }
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setOver(true);
        }
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) {
          e.preventDefault();
          update.mutate({ id, sectionId: dropTo });
        }
      },
    },
  };
}

function Group({
  title,
  actions,
  dropTo,
  children,
}: {
  title: string;
  actions?: ReactNode;
  dropTo?: string | null;
  children: ReactNode;
}) {
  const drop = useDrop(dropTo);
  return (
    <section
      {...drop.props}
      className={cn(
        "mt-3 flex min-w-0 flex-col gap-0.5 rounded-lg",
        drop.over && "bg-ink/5 ring-1 ring-ember/40",
      )}
    >
      <div className="group/heading flex h-7 items-center gap-1 px-2.5">
        <h2 className="min-w-0 flex-1 truncate font-medium text-[0.8125rem] text-ink-3">{title}</h2>
        {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SectionGroup({
  section,
  first,
  last,
  folded,
  onToggle,
  onNewChat,
  children,
}: {
  section: Section;
  first: boolean;
  last: boolean;
  folded: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  children: ReactNode;
}) {
  const drop = useDrop(section.id);
  const [renaming, setRenaming] = useState(false);
  const rename = useRenameSection();
  const move = useMoveSection();
  const remove = useDeleteSection();
  const count = Array.isArray(children) ? children.length : 0;
  return (
    <section
      {...drop.props}
      className={cn(
        "mt-3 flex min-w-0 flex-col gap-0.5 rounded-lg",
        drop.over && "bg-ink/5 ring-1 ring-ember/40",
      )}
    >
      <div className="group/heading flex h-7 items-center gap-1 rounded-lg px-1.5 hover:bg-ink/5">
        {renaming ? (
          <NameField
            initial={section.name}
            placeholder={t("work.sectionName")}
            onDone={async (name) => {
              setRenaming(false);
              if (name && name !== section.name) {
                await rename.mutateAsync({ id: section.id, name });
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!folded}
            className="flex min-w-0 flex-1 items-center gap-1 px-1 text-left font-medium text-[0.8125rem] text-ink-3"
          >
            <span className="truncate">{section.name}</span>
            <ChevronDown
              className={cn("size-3.5 shrink-0 transition-transform", folded && "-rotate-90")}
            />
            {folded && count ? <span className="text-ink-4 tabular-nums">{count}</span> : null}
          </button>
        )}
        <div className="flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/heading:opacity-100 has-data-popup-open:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger className={ICON_BUTTON} aria-label={t("work.more")}>
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil />
                {t("work.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={first}
                onClick={() => move.mutate({ id: section.id, direction: "up" })}
              >
                <ArrowUp />
                {t("work.moveUp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={last}
                onClick={() => move.mutate({ id: section.id, direction: "down" })}
              >
                <ArrowDown />
                {t("work.moveDown")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  if (confirm(t("work.deleteSectionConfirm", { name: section.name }))) {
                    remove.mutate(section.id);
                  }
                }}
              >
                <Trash2 />
                {t("work.deleteSection")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint label={t("work.newChatIn", { name: section.name })}>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={t("work.newChatIn", { name: section.name })}
              onClick={onNewChat}
            >
              <Plus className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>
      {folded ? null : count ? (
        children
      ) : (
        <p className="px-2.5 py-1 text-[0.8125rem] text-ink-4">{t("work.noChats")}</p>
      )}
    </section>
  );
}

/** A name typed in place: Enter keeps it, Escape or leaving the field without one drops it. */
function NameField({
  initial = "",
  placeholder,
  onDone,
}: {
  initial?: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (!done.current) {
      done.current = true;
      onDone(name);
    }
  };
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          finish(value.trim() || null);
        } else if (e.key === "Escape") {
          finish(null);
        }
      }}
      onBlur={() => finish(value.trim() || null)}
      className="h-7 min-w-0 flex-1 rounded-md bg-card px-2 text-[0.8125rem] text-ink outline-none ring-1 ring-ember/50"
    />
  );
}

/** The parts the two menus of a row are drawn with. */
interface MenuKit {
  Item: ComponentType<{
    onClick?: () => void;
    variant?: "default" | "destructive";
    children: ReactNode;
  }>;
  CheckboxItem: ComponentType<{
    checked: boolean;
    onCheckedChange: (on: boolean) => void;
    children: ReactNode;
  }>;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ children: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children: ReactNode }>;
  Separator: ComponentType;
  Shortcut: ComponentType<{ children: ReactNode }>;
}

const DROPDOWN: MenuKit = {
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

const CONTEXT: MenuKit = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

interface RowActions {
  rename: () => void;
  pin: () => void;
  read: () => void;
  archive: () => void;
  remove: () => void;
  move: (sectionId: string | null) => void;
  newSection: () => void;
  newThread: () => void;
  setPrivate: (on: boolean) => void;
  copyLink: () => void;
}

/** The keys a focused row answers, as its menus show them. */
const KEYS = { rename: "R", pin: "P", read: "U", thread: "T", archive: "A", remove: "D" };

function RowMenu({
  kit: K,
  chat,
  sections,
  act,
}: {
  kit: MenuKit;
  chat: SidebarChat;
  sections: Section[];
  act: RowActions;
}) {
  return (
    <>
      <K.Item onClick={act.rename}>
        <Pencil />
        {t("work.rename")}
        <K.Shortcut>{KEYS.rename}</K.Shortcut>
      </K.Item>
      <K.Item onClick={act.pin}>
        {chat.pinned ? <PinOff /> : <Pin />}
        {chat.pinned ? t("work.unpin") : t("work.pin")}
        <K.Shortcut>{KEYS.pin}</K.Shortcut>
      </K.Item>
      <K.Item onClick={act.read}>
        {chat.unread ? <EyeOff /> : <Eye />}
        {chat.unread ? t("work.markRead") : t("work.markUnread")}
        <K.Shortcut>{KEYS.read}</K.Shortcut>
      </K.Item>
      {chat.parentId ? null : (
        <K.Sub>
          <K.SubTrigger>
            <FolderInput />
            {t("work.moveTo")}
          </K.SubTrigger>
          <K.SubContent className="w-52">
            {sections.map((s) => (
              <K.CheckboxItem
                key={s.id}
                checked={chat.sectionId === s.id}
                onCheckedChange={() => act.move(s.id)}
              >
                {s.name}
              </K.CheckboxItem>
            ))}
            <K.CheckboxItem checked={!chat.sectionId} onCheckedChange={() => act.move(null)}>
              {t("work.noSection")}
            </K.CheckboxItem>
            <K.Separator />
            <K.Item onClick={act.newSection}>
              <Plus />
              {t("work.newSection")}
            </K.Item>
          </K.SubContent>
        </K.Sub>
      )}
      <K.Item onClick={act.newThread}>
        <MessageSquarePlus />
        {t("work.newThread")}
        <K.Shortcut>{KEYS.thread}</K.Shortcut>
      </K.Item>
      <K.Separator />
      <K.CheckboxItem checked={chat.private} onCheckedChange={act.setPrivate}>
        {t("work.private")}
      </K.CheckboxItem>
      <K.Item onClick={act.copyLink}>
        <Link2 />
        {t("work.copyLink")}
      </K.Item>
      <K.Separator />
      <K.Item onClick={act.archive}>
        {chat.archived ? <ArchiveRestore /> : <Archive />}
        {chat.archived ? t("work.unarchive") : t("work.archive")}
        <K.Shortcut>{KEYS.archive}</K.Shortcut>
      </K.Item>
      <K.Item variant="destructive" onClick={act.remove}>
        <Trash2 />
        {t("work.delete")}
        <K.Shortcut>{KEYS.remove}</K.Shortcut>
      </K.Item>
    </>
  );
}

function ChatRow({
  chat,
  sections,
  threads,
  threadsFolded,
  onToggleThreads,
  onNewThread,
  onNewSection,
  depth = 0,
  last = false,
}: {
  chat: SidebarChat;
  sections: Section[];
  threads: SidebarChat[];
  threadsFolded: boolean;
  onToggleThreads: () => void;
  onNewThread: () => void;
  onNewSection: () => void;
  depth?: number;
  /** The last sub-thread under its chat: its line ends in a curve. */
  last?: boolean;
}) {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const state = useChatState();
  const update = useUpdateChat();
  const remove = useDeleteChat();
  const title = chat.title || t("work.untitled");
  const active = chatId === chat.id;

  const act: RowActions = {
    rename: () => setRenaming(true),
    pin: () => state.mutate({ id: chat.id, pinned: !chat.pinned }),
    read: () => state.mutate({ id: chat.id, read: chat.unread }),
    archive: () => state.mutate({ id: chat.id, archived: !chat.archived }),
    remove: () => {
      if (confirm(t("work.deleteConfirm", { title }))) {
        remove.mutate(chat.id, {
          onSuccess: () => {
            if (active) {
              navigate("/work");
            }
          },
        });
      }
    },
    move: (sectionId) => update.mutate({ id: chat.id, sectionId }),
    newSection: onNewSection,
    newThread: onNewThread,
    setPrivate: (on) => update.mutate({ id: chat.id, private: on }),
    copyLink: () => {
      void navigator.clipboard?.writeText(new URL(`work/c/${chat.id}`, document.baseURI).href);
    },
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || renaming) {
      return;
    }
    const key = e.key.toUpperCase();
    const run = {
      [KEYS.rename]: act.rename,
      [KEYS.pin]: act.pin,
      [KEYS.read]: act.read,
      [KEYS.thread]: act.newThread,
      [KEYS.archive]: act.archive,
      [KEYS.remove]: act.remove,
    }[key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  const nested = threads.length > 0;

  return (
    <div className={cn(depth > 0 && "relative ml-4 pl-3")}>
      {depth > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 left-0 border-border border-l",
            last ? "h-4 w-2 rounded-bl-md border-b" : "bottom-0",
          )}
        />
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={rowRef}
              draggable={!renaming}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, chat.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              className={cn(
                "group/row relative flex h-8 items-center gap-1 rounded-lg pr-1 hover:bg-ink/5 has-data-popup-open:bg-ink/5",
                active && "bg-ink/10 hover:bg-ink/10",
              )}
            />
          }
        >
          {renaming ? (
            <div className="flex min-w-0 flex-1 px-1">
              <NameField
                initial={chat.title}
                placeholder={t("work.untitled")}
                onDone={(name) => {
                  setRenaming(false);
                  if (name && name !== chat.title) {
                    update.mutate({ id: chat.id, title: name });
                  }
                }}
              />
            </div>
          ) : (
            <HoverCard>
              <HoverCardTrigger
                delay={700}
                render={
                  <NavLink
                    to={`/work/c/${chat.id}`}
                    onKeyDown={onKeyDown}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <span
                  className={cn(
                    "truncate",
                    chat.unread ? "font-medium text-ink" : "text-ink-2",
                    !chat.title && "text-ink-3",
                  )}
                >
                  {title}
                </span>
                {chat.private ? (
                  <Lock className="size-3 shrink-0 text-ink-4" aria-label={t("work.private")} />
                ) : null}
              </HoverCardTrigger>
              <HoverCardContent
                anchor={rowRef}
                side="right"
                align="start"
                sideOffset={10}
                className="w-80 p-3"
              >
                <Preview chat={chat} />
              </HoverCardContent>
            </HoverCard>
          )}

          {nested ? (
            <Hint label={threadsFolded ? t("work.showThreads") : t("work.hideThreads")}>
              <button
                type="button"
                onClick={onToggleThreads}
                aria-expanded={!threadsFolded}
                aria-label={threadsFolded ? t("work.showThreads") : t("work.hideThreads")}
                className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-ink-4 hover:bg-ink/10 hover:text-ink"
              >
                <ChevronDown
                  className={cn("size-3.5 transition-transform", threadsFolded && "-rotate-90")}
                />
                {threadsFolded ? (
                  <span className="text-xs tabular-nums">{threads.length}</span>
                ) : null}
              </button>
            </Hint>
          ) : null}

          <div className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex has-data-popup-open:flex">
            <Hint label={chat.pinned ? t("work.unpinChat") : t("work.pinChat")}>
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={chat.pinned ? t("work.unpinChat") : t("work.pinChat")}
                onClick={act.pin}
              >
                {chat.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            </Hint>
            <Hint label={chat.archived ? t("work.unarchive") : t("work.archiveChat")}>
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={chat.archived ? t("work.unarchive") : t("work.archiveChat")}
                onClick={act.archive}
              >
                {chat.archived ? (
                  <ArchiveRestore className="size-3.5" />
                ) : (
                  <Archive className="size-3.5" />
                )}
              </button>
            </Hint>
            <DropdownMenu>
              <DropdownMenuTrigger className={ICON_BUTTON} aria-label={t("work.more")}>
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <RowMenu kit={DROPDOWN} chat={chat} sections={sections} act={act} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {chat.unread ? (
            <span
              role="img"
              aria-label={t("work.unread")}
              className="mr-1.5 size-2 shrink-0 rounded-full bg-ember group-hover/row:hidden"
            />
          ) : null}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <RowMenu kit={CONTEXT} chat={chat} sections={sections} act={act} />
        </ContextMenuContent>
      </ContextMenu>

      {nested && !threadsFolded
        ? threads.map((thread, at) => (
            <ChatRow
              key={thread.id}
              chat={thread}
              sections={sections}
              threads={[]}
              threadsFolded
              onToggleThreads={() => {}}
              onNewThread={onNewThread}
              onNewSection={onNewSection}
              depth={depth + 1}
              last={at === threads.length - 1}
            />
          ))
        : null}
    </div>
  );
}

/** The card a row shows on hover: the title, the last message, and a reply without opening it. */
function Preview({ chat }: { chat: SidebarChat }) {
  const [text, setText] = useState("");
  const post = usePostMessage();
  const send = () => {
    const body = text.trim();
    if (body) {
      post.mutate({ id: chat.id, text: body });
      setText("");
    }
  };
  return (
    <div className="grid gap-2">
      <p className="font-semibold text-ink">{chat.title || t("work.untitled")}</p>
      {chat.last ? (
        <p className="line-clamp-3 text-[0.8125rem] text-ink-3">
          <span className="text-ink-2">{chat.last.author}</span> · {chat.last.text}
        </p>
      ) : (
        <p className="text-[0.8125rem] text-ink-4">{t("work.emptyChat")}</p>
      )}
      <label className="flex items-center gap-2 rounded-lg bg-ink/5 px-2.5 py-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("work.reply")}
          aria-label={t("work.reply")}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-ink-4"
        />
        <CornerDownLeft className="size-3.5 shrink-0 text-ink-4" />
      </label>
    </div>
  );
}
