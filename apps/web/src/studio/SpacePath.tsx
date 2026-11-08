import { ChevronsUpDown, PanelLeft, Plus, Search, UserRound, UserSquare2 } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { t } from "../lib/i18n";
import { initialsOf, type Me, type Space, useCurrentSpace, useMayCreate } from "../lib/session";
import { cn, Dialog, Input } from "../ui";
import { SpaceFace, useDismiss } from "./AppFrame";
import { NewSpaceDialog } from "./HomePage";

/*
 * The path's first step (docs/plans/org-spaces.md, behind `orgSpaces`): the space the studio is
 * in, and its menu, the one place spaces are listed. The organization's own space first ("alle"),
 * then the person's Mein Space ("nur du"), then the spaces used last; the rest through a list
 * with search. One space alone shows its name and no menu.
 */

/** How many spaces the menu lists before "Alle n Spaces". */
const SHOWN = 7;

/** A space's name as people read it: the root under the organization's, Mein Space as theirs. */
export function spaceLabel(me: Me, space: Space): string {
  if (space.root) {
    return me.tenant.name || space.name;
  }
  if (space.personal) {
    return t("nav.mySpace");
  }
  return space.name;
}

/** A space's face in the path and the menu: Mein Space as a person in a frame, else its tile. */
function Face({ me, space }: { me: Me; space: Space }) {
  if (space.personal) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-paper-3 text-ink-2 ring-1 ring-border">
        <UserSquare2 className="size-4" />
      </span>
    );
  }
  if (space.clients > 0) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-violet-500/10 font-semibold text-[0.5625rem] text-violet-700 ring-1 ring-violet-500/30 dark:text-violet-300">
        {initialsOf(space.name)}
      </span>
    );
  }
  return (
    <SpaceFace
      space={space}
      name={space.root ? me.tenant.name || undefined : undefined}
      size="xs"
    />
  );
}

/** The sidebar's switch, at the start of the path where a page has a sidebar (Work). */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={t("nav.sidebar")}
      title={t("nav.sidebar")}
      className={cn(
        "-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition hover:bg-accent hover:text-ink",
        !open && "bg-accent text-ink",
      )}
    >
      <PanelLeft className="size-4" />
    </button>
  );
}

/** The path's first step: the space, with its menu where there is more than one. */
export function SpacePath({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { space, spaces, select } = useCurrentSpace();
  const mayCreate = useMayCreate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  if (!space) {
    return null;
  }
  const name = spaceLabel(me, space);
  const limit = me.limits.spaces;
  const full = limit !== null && spaces.filter((s) => !s.personal).length >= limit;
  // Alone, there is nothing to switch to: the name stands without a menu.
  const alone = spaces.length <= 1 && !(mayCreate && !full);
  const root = spaces.find((s) => s.root);
  const mine = spaces.find((s) => s.personal);
  const shared = spaces.filter((s) => !s.root && !s.personal);
  const go = (id: string) => {
    setOpen(false);
    setAll(false);
    if (id === space.id) {
      navigate("/");
    } else {
      select(id);
    }
  };
  const row = (s: Space, note?: string) => (
    <button
      key={s.id}
      type="button"
      role="menuitemradio"
      aria-checked={s.id === space.id}
      onClick={() => go(s.id)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.875rem] transition hover:bg-accent",
        s.id === space.id ? "bg-background font-medium text-ink shadow-soft" : "text-ink-2",
      )}
    >
      <Face me={me} space={s} />
      <span className="min-w-0 flex-1 truncate">{spaceLabel(me, s)}</span>
      {s.clients > 0 ? (
        <span className="flex shrink-0 items-center gap-0.5 text-[0.75rem] text-violet-700 dark:text-violet-300">
          <UserRound className="size-3" />
          {s.clients}
        </span>
      ) : note ? (
        <span className="shrink-0 text-[0.75rem] text-ink-4">{note}</span>
      ) : null}
    </button>
  );
  const face = <Face me={me} space={space} />;
  if (alone) {
    return (
      <span className="flex min-w-0 items-center gap-2 px-1 font-medium text-[0.9375rem] text-ink">
        {face}
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("nav.switchSpace")}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex max-w-[18rem] items-center gap-2 rounded-lg px-1.5 py-1 font-medium text-[0.9375rem] text-ink transition hover:bg-accent",
          open && "bg-accent",
        )}
      >
        {face}
        <span className="truncate">{name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-10 left-0 z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {/* "alle" says the root is shared: only where others are, in an organization. */}
          {root ? row(root, me.mode === "managed" ? t("nav.spaceAll") : undefined) : null}
          {mine ? row(mine, t("nav.spaceMine")) : null}
          {shared.length ? (
            <div className="px-2 pt-2 pb-1 text-[0.75rem] text-ink-3">{t("nav.spacesHeading")}</div>
          ) : null}
          {shared.slice(0, SHOWN).map((s) => row(s))}
          {shared.length > SHOWN ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setAll(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.875rem] text-ink-3 transition hover:bg-accent hover:text-ink"
            >
              <Search className="size-4 shrink-0" />
              {t("nav.allSpaces", { n: shared.length })}
            </button>
          ) : null}
          {mayCreate && !full ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.875rem] text-ink-3 transition hover:bg-accent hover:text-ink"
            >
              <Plus className="size-4 shrink-0" />
              {t("nav.newSpace")}
            </button>
          ) : null}
        </div>
      ) : null}
      <NewSpaceDialog open={creating} onClose={() => setCreating(false)} />
      <AllSpacesDialog me={me} open={all} onClose={() => setAll(false)} pick={go} />
    </div>
  );
}

/** Every space, with a search: where the menu would list too many. */
function AllSpacesDialog({
  me,
  open,
  onClose,
  pick,
}: {
  me: Me;
  open: boolean;
  onClose: () => void;
  pick: (id: string) => void;
}) {
  const { space, spaces } = useCurrentSpace();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const found = spaces.filter((s) => !needle || spaceLabel(me, s).toLowerCase().includes(needle));
  return (
    <Dialog open={open} onClose={onClose} title={t("nav.spacesHeading")} height="tall">
      <Input
        autoFocus
        value={q}
        placeholder={t("nav.searchSpaces")}
        aria-label={t("nav.searchSpaces")}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-3 flex flex-col gap-0.5">
        {found.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => pick(s.id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[0.875rem] transition hover:bg-accent",
              s.id === space?.id ? "font-medium text-ink" : "text-ink-2",
            )}
          >
            <Face me={me} space={s} />
            <span className="min-w-0 flex-1 truncate">{spaceLabel(me, s)}</span>
            {s.clients > 0 ? (
              <span className="text-[0.75rem] text-violet-700 dark:text-violet-300">
                {t("nav.spaceClients", { n: s.clients })}
              </span>
            ) : null}
          </button>
        ))}
        {found.length ? null : (
          <p className="px-2 py-6 text-center text-[0.875rem] text-ink-3">
            {t("nav.noSpaceFound")}
          </p>
        )}
      </div>
    </Dialog>
  );
}
