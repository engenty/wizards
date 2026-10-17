import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Check,
  Cloud,
  CloudOff,
  CreditCard,
  Folder,
  Laptop,
  LogOut,
  PanelLeft,
  Pencil,
  Plus,
  WandSparkles,
} from "lucide-react";
import {
  type ComponentType,
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { api } from "../lib/api";
import { type AppBarPosition, besideBar, useAppBar } from "../lib/appbar";
import { useFeature } from "../lib/features";
import { lang, t } from "../lib/i18n";
import { acceptInstall, standalone, useInstallPrompt } from "../lib/install";
import {
  initialsOf,
  type Me,
  type Project,
  signOut,
  spendableCredits,
  useCurrentProject,
  useMayCreate,
} from "../lib/session";
import { useStudioPlugins } from "../plugins/host";
import { Button, cn, Dialog, Input } from "../ui";
import { AppRail } from "./AppRail";
import { AssistantDock, AssistantSidebar, HighlightLayer } from "./assistant/StudioAssistant";
import { NewSpaceDialog } from "./HomePage";
import { InstallBanner, InstallDialog } from "./InstallBanner";
import { LangSwitch } from "./LangSwitch";
import { spaceGroups, withParts } from "./project-sections";
import { settingsSections } from "./settings-sections";
import { setAreaSlot, setSpaceSidebar, useHasSideMenu, useSpaceSidebar } from "./side-menu";
import { ThemeSwitch } from "./ThemeSwitch";
import { UpdateBanner } from "./UpdateBanner";
import { hostOf } from "./where";

/** A step of the trail after the logo; the last one is the page itself. */
export interface Crumb {
  label: string;
  to?: string;
}

let crumbs: Crumb[] = [];
const crumbListeners = new Set<() => void>();

function setCrumbs(next: Crumb[]) {
  crumbs = next;
  for (const listener of crumbListeners) {
    listener();
  }
}

/**
 * Where in the studio a page stands, said once in the top bar instead of a heading of its own:
 * the content starts at the top. Set while the page is shown.
 */
export function useCrumbs(items: Crumb[]) {
  const key = JSON.stringify(items);
  useEffect(() => {
    setCrumbs(JSON.parse(key) as Crumb[]);
    return () => setCrumbs([]);
  }, [key]);
}

/** The trail as it stands now: the assistant names the page by it. */
export function currentCrumbs(): Crumb[] {
  return crumbs;
}

/** The trail, for a component that shows where the page stands. */
export function useTrail(): Crumb[] {
  return useSyncExternalStore(
    (listener) => {
      crumbListeners.add(listener);
      return () => crumbListeners.delete(listener);
    },
    () => crumbs,
  );
}

function Trail() {
  const trail = useTrail();
  if (!trail.length) {
    return null;
  }
  return (
    <nav
      aria-label={t("nav.breadcrumb")}
      className="flex min-w-0 items-center text-[0.9375rem] max-sm:hidden"
    >
      {trail.map((crumb, i) => (
        <Fragment key={`${i}:${crumb.label}`}>
          {/* The first follows the space's name as the others follow each other: the bar's gap
              and the name's own padding are taken back, so every slash stands alike. */}
          <span className={cn("mr-2 text-ink-4", i === 0 ? "-ml-1 sm:-ml-2" : "ml-2")}>/</span>
          {crumb.to && i < trail.length - 1 ? (
            <Link to={crumb.to} className="truncate text-ink-3 transition hover:text-ink">
              {crumb.label}
            </Link>
          ) : (
            <span aria-current="page" className="truncate font-medium text-ink">
              {crumb.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** Where the account lives: the Manage-App of the runtime, or of the linked account. */
const accountBase = (me: Me): string | null => me.manageUrl ?? me.account?.url ?? null;

/** Where credits are bought. */
export function billingUrl(me: Me): string | null {
  const base = accountBase(me);
  return base ? `${base}/billing` : null;
}

export function CreditsPill({ me }: { me: Me }) {
  const credits = spendableCredits(me);
  const url = billingUrl(me);
  if (credits === null || !url) {
    return null;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-3 font-medium text-[0.8125rem] tabular-nums transition",
        credits < 50 ? "bg-amber-tint text-ink" : "bg-paper-2 text-ink-2 hover:text-ink",
      )}
    >
      {/* Whole credits, rounded down: the pill never shows more than there is. */}
      {t("nav.credits", { n: Math.floor(credits).toLocaleString(lang) })}
    </a>
  );
}

/**
 * Where a local install stands with its account, at the avatar: linked (its cloud runs what is
 * published here), linked with the sign-in run out, or alone. Nothing for a managed runtime.
 */
function accountState(me: Me, account: boolean): "linked" | "expired" | "alone" | null {
  if (me.mode !== "local") {
    return null;
  }
  if (!me.account) {
    return account ? "alone" : null;
  }
  return me.account.signedIn ? "linked" : "expired";
}

/** Closes a menu on a click outside it or on Escape, while it is open. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        closeRef.current();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open]);
}

/**
 * Where a menu of the top bar or the app bar opens: below its trigger, or away from the bar at
 * its start (the space) or its end (the person), whichever edge the bar stands at.
 */
export type MenuPlacement = "below" | "bar-start" | "bar-end";

function placementClass(placement: MenuPlacement, position: AppBarPosition, below: string) {
  return placement === "below"
    ? below
    : besideBar(position, placement === "bar-start" ? "start" : "end");
}

/** Text light or dark by the fill's own lightness, as `--ember-on` is for the ember. */
const onFill = (color: string) =>
  `oklch(from ${color} calc(0.16 + 0.83 * clamp(0, (0.65 - l) * 1000, 1)) 0.01 h)`;

/** A space as a tile: its first brand colour behind its initials; without one, quiet paper. */
export function SpaceFace({
  project,
  size = "md",
}: {
  project: Project | null;
  size?: "sm" | "md";
}) {
  const color = project?.brand.colors?.[0]?.value;
  const initials = initialsOf(project?.name ?? "");
  const face = (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-lg font-semibold tracking-wide",
        size === "md" ? "size-10 text-[0.8125rem]" : "size-9 text-[0.75rem]",
        color ? null : "bg-paper-3 text-ink ring-1 ring-border",
      )}
      style={color ? { background: color, color: onFill(color) } : undefined}
    >
      {initials || <Folder className="size-4" />}
    </span>
  );
  if (project?.origin !== "local") {
    return face;
  }
  // A space a local install sent: a laptop on its corner, as the note on its pages says.
  return (
    <span className="relative shrink-0" title={t("readonly.project")}>
      {face}
      <span className="-right-1 -bottom-1 absolute grid size-4 place-items-center rounded-full bg-amber ring-2 ring-paper">
        <Laptop className="size-2.5 text-paper" />
      </span>
    </span>
  );
}

/**
 * The spaces, listed as Slack lists its workspaces: the one shown first (its row opens its
 * wizards; its page is behind the home in the bar), the others to switch to, and a row that adds one — not there at the plan's limit. The
 * trigger is the caller's: the space's tile in the app bar, its name in the top bar. `label`:
 * the trigger's name for a screen reader where it shows no text.
 */
export function SpaceMenu({
  me,
  placement,
  label,
  className,
  children,
}: {
  me: Me;
  placement: MenuPlacement;
  label?: string;
  className: string | ((open: boolean) => string);
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { position } = useAppBar();
  const { project, projects, select } = useCurrentProject();
  const mayCreate = useMayCreate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const limit = me.limits.projects;
  const full = limit !== null && projects.length >= limit;
  const row =
    "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent";
  // What the menu does, beside the spaces: a line glyph and a word, as in the person's menu.
  const action =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  return (
    <div className="shrink-0" ref={ref}>
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ top: r.bottom + 6, left: r.left });
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={label}
          title={t("nav.switchSpace")}
          className={typeof className === "function" ? className(open) : className}
        >
          {children}
        </button>
        {open ? (
          <div
            role="menu"
            // Below a name it stands fixed under it: the sidebar it may sit in clips what overflows.
            style={placement === "below" ? { position: "fixed", ...at } : undefined}
            className={cn(
              "z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
              placement === "below"
                ? null
                : cn("absolute", placementClass(placement, position, "top-10 left-0")),
            )}
          >
            {projects.map((p) => {
              const current = p.id === project?.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className={row}
                  onClick={() => {
                    setOpen(false);
                    if (current) {
                      navigate("/");
                    } else {
                      select(p.id);
                    }
                  }}
                >
                  <SpaceFace project={p} size="sm" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span
                      className={cn(
                        "truncate text-[0.875rem]",
                        current ? "font-semibold text-ink" : "font-medium text-ink-2",
                      )}
                    >
                      {p.name}
                    </span>
                    <span className="truncate text-[0.75rem] text-ink-4">
                      {t("nav.wizardCount", { n: p.wizardCount })}
                    </span>
                  </span>
                  {current ? <Check className="size-4 shrink-0 text-ember-strong" /> : null}
                </button>
              );
            })}
            <div className="mx-2 my-1.5 h-px bg-border-soft" />
            {[
              { to: "/", icon: WandSparkles, label: t("nav.wizardsInSpace"), show: true },
              { to: "/new", icon: Plus, label: t("nav.addWizard"), show: mayCreate },
            ]
              .filter((entry) => entry.show)
              .map((entry) => (
                <button
                  key={entry.to}
                  type="button"
                  role="menuitem"
                  className={action}
                  onClick={() => {
                    setOpen(false);
                    navigate(entry.to);
                  }}
                >
                  <entry.icon className="size-4 shrink-0 text-ink-3" />
                  <span className="truncate">{entry.label}</span>
                </button>
              ))}
            {project && !project.readOnly ? (
              <>
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
                <button
                  type="button"
                  role="menuitem"
                  className={action}
                  onClick={() => {
                    setOpen(false);
                    setRenaming(true);
                  }}
                >
                  <Pencil className="size-4 shrink-0 text-ink-3" />
                  <span className="truncate">{t("nav.renameSpace")}</span>
                </button>
              </>
            ) : null}
            {/* A tenant that builds nothing here makes no space here either; nor does a member; at the limit there is nothing to offer. */}
            {mayCreate && !full ? (
              <>
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
                <button
                  type="button"
                  role="menuitem"
                  className={action}
                  onClick={() => {
                    setOpen(false);
                    setCreating(true);
                  }}
                >
                  <Plus className="size-4 shrink-0 text-ink-3" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate">{t("nav.addSpace")}</span>
                  </span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <NewSpaceDialog open={creating} onClose={() => setCreating(false)} />
        {project ? (
          <RenameSpaceDialog project={project} open={renaming} onClose={() => setRenaming(false)} />
        ) : null}
      </div>
    </div>
  );
}

/** The space's name in the top bar; it opens the spaces to switch between and to add one. */
/** The space's name, changed in a dialog of its own. */
function RenameSpaceDialog({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  useEffect(() => {
    if (open) {
      setName(project.name);
    }
  }, [open, project.name]);
  const rename = useMutation({
    mutationFn: () => api.patch(`/api/studio/projects/${project.id}`, { name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("nav.renameSpace")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            rename.mutate();
          }
        }}
      >
        <Input
          autoFocus
          maxLength={80}
          aria-label={t("nav.renameSpace")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={rename.isPending} disabled={!name.trim()}>
            {t("settings.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Where the space lives: on this computer (a local install, or a space one sent here) or in the cloud. */
function SpacePlace({ me, project }: { me: Me; project: Project }) {
  const local = me.mode === "local" || project.origin === "local";
  const Icon = local ? Laptop : Cloud;
  const label = local ? t("nav.spaceLocal") : t("nav.spaceCloud");
  return (
    <span title={label} className="grid size-6 shrink-0 place-items-center text-ink-4">
      <Icon className="size-3.5" aria-label={label} />
    </span>
  );
}

function SpaceName({ me }: { me: Me }) {
  const { project } = useCurrentProject();
  if (!project) {
    return null;
  }
  return (
    <span className="flex min-w-0 items-center gap-1">
      <SpaceMenu
        me={me}
        placement="below"
        label={project.name}
        className={(open) =>
          cn(
            "-mx-1 max-w-[16rem] translate-y-[0.5px] truncate rounded-md px-2 py-0.5 text-left font-medium text-[0.9375rem] text-ink transition hover:bg-accent",
            open && "bg-accent",
          )
        }
      >
        {project.name}
      </SpaceMenu>
      <SpacePlace me={me} project={project} />
    </span>
  );
}

/** `placement`: where the menu opens — below the avatar in a top bar, away from the app bar. */
export function UserMenu({ me, placement = "below" }: { me: Me; placement?: MenuPlacement }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { position } = useAppBar();
  const plugins = useStudioPlugins();
  useDismiss(ref, open, () => setOpen(false));
  // The studio as an app on this device: Chrome's offer taken up at once, else how the browser does it.
  const installPrompt = useInstallPrompt();
  const [installOpen, setInstallOpen] = useState(false);
  const initials = initialsOf(me.user.name);
  const account = useFeature("account");
  const state = accountState(me, account);
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink";
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded-full bg-ember-tint font-semibold text-[0.8125rem] text-ember-strong ring-1 ring-border-soft",
          // In the app bar the avatar is as large as the tiles above it.
          placement === "below" ? "size-9" : "size-10",
        )}
        aria-label={me.user.name || "Menu"}
      >
        {me.user.image ? (
          <img src={me.user.image} alt="" className="size-full rounded-full object-cover" />
        ) : (
          initials
        )}
        {state === "linked" || state === "expired" ? (
          <span
            title={
              state === "linked"
                ? t("nav.connected", { host: hostOf(me.account?.cloudUrl ?? "") })
                : t("nav.expired")
            }
            className="-right-1 -bottom-1 absolute flex size-4 items-center justify-center rounded-full bg-card ring-1 ring-border-soft"
          >
            {state === "linked" ? (
              <Cloud className="size-2.5 text-moss" />
            ) : (
              <CloudOff className="size-2.5 text-amber" />
            )}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={cn(
            "absolute z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
            placementClass(placement, position, "top-11 right-0"),
          )}
        >
          <div className="px-3 pt-2 pb-2.5">
            <div className="truncate font-medium text-[0.875rem]">
              {me.user.name}
              {/* A local install without an account: the person is this computer's. */}
              {state === "alone" ? (
                <span className="font-normal text-ink-4"> ({t("nav.local")})</span>
              ) : null}
            </div>
            <div className="truncate text-[0.75rem] text-ink-3">{me.user.email}</div>
          </div>
          {state ? (
            // Whether what is published here runs for others: where it runs, and what to do.
            <button
              type="button"
              className="mx-1.5 mb-1.5 flex w-[calc(100%-0.75rem)] items-start gap-2.5 rounded-lg bg-paper-2 px-2.5 py-2 text-left text-[0.8125rem] text-ink-2 hover:text-ink"
              onClick={() => {
                setOpen(false);
                navigate("/settings/account");
              }}
            >
              {state === "linked" ? (
                <Cloud className="mt-0.5 size-4 shrink-0 text-moss" />
              ) : state === "expired" ? (
                <CloudOff className="mt-0.5 size-4 shrink-0 text-amber" />
              ) : (
                <Laptop className="mt-0.5 size-4 shrink-0 text-ink-3" />
              )}
              <span className="flex min-w-0 flex-1 flex-col leading-snug">
                <span className="break-words">
                  {state === "linked"
                    ? t("nav.connected", { host: hostOf(me.account?.cloudUrl ?? "") })
                    : state === "expired"
                      ? t("nav.expired")
                      : t("nav.onlyHere")}
                </span>
                <span className="font-medium text-ink tabular-nums">
                  {state === "linked"
                    ? me.account?.credits !== null && me.account?.credits !== undefined
                      ? t("nav.credits", { n: Math.floor(me.account.credits).toLocaleString(lang) })
                      : null
                    : state === "expired"
                      ? t("account.signInAgain")
                      : t("account.signIn")}
                </span>
              </span>
            </button>
          ) : null}
          <div className="px-3 pt-1.5 pb-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.07em]">
            {t("nav.settings")}
          </div>
          {settingsSections(me, plugins)
            .filter((s) => s.menu)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                className={item}
                onClick={() => {
                  setOpen(false);
                  navigate(`/settings/${s.id}`);
                }}
              >
                <s.icon className="size-4" /> {s.label}
              </button>
            ))}
          <div className="mx-2 my-1.5 h-px bg-border-soft" />
          {standalone() ? null : (
            <button
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                if (installPrompt) {
                  void acceptInstall(installPrompt);
                } else {
                  setInstallOpen(true);
                }
              }}
            >
              <AppWindow className="size-4" /> {t("install.app.action")}
            </button>
          )}
          {me.manageUrl ? (
            <a className={item} href={`${me.manageUrl}/account`} target="_blank" rel="noreferrer">
              <CreditCard className="size-4" /> {t("nav.account")}
            </a>
          ) : null}
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[0.875rem] text-ink-2">
            {t("nav.language")}
            <LangSwitch tone="surface" />
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[0.875rem] text-ink-2">
            {t("nav.theme")}
            <ThemeSwitch />
          </div>
          {me.mode === "managed" ? (
            <button type="button" className={item} onClick={() => void signOut()}>
              <LogOut className="size-4" /> {t("nav.logout")}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Beside the menu, not in it: the menu closes as the dialog opens. */}
      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  );
}

/** Left of the space's name: opens and closes the space's sidebar. */
function SpaceSidebarToggle() {
  const open = useSpaceSidebar();
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label={t("nav.spaceMenu")}
      title={t("nav.spaceMenu")}
      onClick={() => setSpaceSidebar(!open)}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-accent hover:text-ink max-lg:hidden",
        open ? "bg-accent text-ink" : "text-ink-3",
      )}
    >
      <PanelLeft className="size-[1.125rem]" />
    </button>
  );
}

type SidebarRow = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end: boolean;
};

/** The space's menu beside the page: its wizards, a new one, and the parts of its page. */
function SpaceSidebar() {
  const open = useSpaceSidebar();
  const inArea = useHasSideMenu();
  const { project } = useCurrentProject();
  const plugins = useStudioPlugins();
  const mayCreate = useMayCreate();
  if (!project) {
    return null;
  }
  // The rows of the areas' own menu, so both read alike.
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      "group flex items-center gap-2 rounded-lg px-2 py-1 text-[0.875rem] transition",
      isActive ? "bg-paper-2 font-medium text-ink" : "text-ink-2 hover:bg-accent hover:text-ink",
    );
  const icon = "size-4 transition-transform duration-200 ease-out group-hover:scale-110";
  const wizards: SidebarRow[] = [
    { to: "/", label: t("nav.wizards"), icon: WandSparkles, end: true },
    ...(mayCreate ? [{ to: "/new", label: t("home.new"), icon: Plus, end: false }] : []),
  ];
  // The space's own parts, under the heading the area menus give their groups.
  const parts = withParts(spaceGroups(), plugins).map((part) => ({
    to: `/space/${part.id}`,
    label: part.label,
    icon: part.icon,
    end: false,
  }));
  const list = (rows: SidebarRow[]) => (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <li key={row.to}>
          <NavLink to={row.to} end={row.end} className={item}>
            <span className="grid size-7 shrink-0 place-items-center">
              <row.icon className={icon} />
            </span>
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
  return (
    // The width animates; the content keeps its own, so it slides away instead of reflowing. Below
    // `lg` the window has no room for it and it stays closed, whatever was picked.
    <aside
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "shrink-0 overflow-hidden transition-[width] duration-300 ease-out motion-reduce:transition-none max-md:hidden",
        open ? "w-64 max-lg:w-0" : "w-0",
      )}
    >
      <div className="flex h-full w-64 flex-col overflow-y-auto px-4 pb-4">
        {/* In an area its own menu stands here (the page draws it in); else the space's. */}
        <div ref={setAreaSlot} className={inArea ? "pt-4 animate-rise sm:pt-6" : "hidden"} />
        {inArea ? null : (
          <div className="pt-4 animate-rise sm:pt-6">
            {list(wizards)}
            <p className="mt-5 mb-1 px-2 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
              {t("nav.project")}
            </p>
            {list(parts)}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * The row at the top of the page: the space's name, which switches between spaces, then the
 * trail and the credits. No wordmark: the mark stands in the app bar. A phone starts at the
 * space's name; the rest stands in its app bar along the bottom.
 */
export function TopBar({ me, children }: { me: Me; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-3 coarse:h-14 sm:gap-3 sm:px-4 md:px-5">
      <SpaceSidebarToggle />
      <SpaceName me={me} />
      <div className="flex min-w-0 flex-1 items-center">
        <Trail />
        {children}
      </div>
      <CreditsPill me={me} />
    </header>
  );
}

/** The studio's scroll container below the top bar; a page that watches the scroll asks for it. */
export const SCROLL_ROOT_ID = "studio-scroll";

export function scrollRoot(): HTMLElement {
  return document.getElementById(SCROLL_ROOT_ID) ?? document.documentElement;
}

/** The page's gap to the window's edges: on the three sides the bar does not stand at. */
const INSET: Record<AppBarPosition, string> = {
  left: "md:py-2 md:pr-2",
  right: "md:py-2 md:pl-2",
  top: "md:px-2 md:pb-2",
  bottom: "md:px-2 md:pt-2",
};

const DIRECTION: Record<AppBarPosition, string> = {
  left: "flex-row",
  right: "flex-row-reverse",
  top: "flex-col",
  bottom: "flex-col-reverse",
};

/**
 * The studio's frame: the app bar at an edge of the window and the page beside it, on a wide
 * screen set in from the window's edge with rounded corners, a card on the bar's ground. The
 * page scrolls inside; the bar and the top bar stay. `wide`: a page that lays out columns of its
 * own takes the screen's width. `full`: a page that fills the frame and draws its own top bar.
 */
export function AppFrame({
  me,
  wide,
  full,
  children,
}: {
  me: Me;
  wide?: boolean;
  full?: boolean;
  children: ReactNode;
}) {
  const { position } = useAppBar();
  const column = useRef<HTMLDivElement>(null);
  const goose = useFeature("goose");
  return (
    <div className={cn("flex h-dvh overflow-hidden bg-sidebar", DIRECTION[position])}>
      <AppRail me={me} />
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", INSET[position])}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-xl md:shadow-elevated md:dark:ring-1 md:dark:ring-border-soft">
          <UpdateBanner />
          <InstallBanner />
          {full ? (
            <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              {children}
            </main>
          ) : (
            // The top bar runs across, over the sidebar and the page, open or closed.
            <div className="flex min-h-0 flex-1 flex-col">
              <TopBar me={me} />
              <div className="flex min-h-0 flex-1">
                <SpaceSidebar />
                <div ref={column} className="relative flex min-w-0 flex-1 flex-col">
                  {/* `relative`: what a page places out of flow without a positioned parent (a
                    hidden file field) stays in the page's own scroll, not in a frame around it,
                    which a jump to a section would scroll as well. The assistant's dock keeps
                    its height free below the last section (`--assistant-dock`). */}
                  <main
                    id={SCROLL_ROOT_ID}
                    className="relative min-h-0 flex-1 overflow-y-auto"
                    style={{ paddingBottom: "var(--assistant-dock, 0px)" }}
                  >
                    <div
                      className={cn(
                        "mx-auto w-full px-3 pt-4 pb-12 sm:px-6 sm:pt-6",
                        wide ? "max-w-[88rem]" : "max-w-5xl",
                      )}
                    >
                      {children}
                    </div>
                  </main>
                  {goose && <AssistantDock column={column} />}
                </div>
                {goose && (
                  <>
                    <AssistantSidebar column={column} />
                    <HighlightLayer />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
