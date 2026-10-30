import { featureOn } from "@engenty/wizards-shared/features";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Building2,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Cloud,
  CloudOff,
  CreditCard,
  Flag,
  Folder,
  Laptop,
  LogOut,
  Pencil,
  Plus,
  Settings,
  UserRound,
  WandSparkles,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ImpersonationBanner } from "../impersonation";
import { api } from "../lib/api";
import { type AppBarPosition, besideBar, useAppBar, useAppBarLabels } from "../lib/appbar";
import { useFeature } from "../lib/features";
import { lang, t } from "../lib/i18n";
import { acceptInstall, standalone, useInstallPrompt } from "../lib/install";
import { keys } from "../lib/keys";
import {
  initialsOf,
  type Me,
  type Space,
  signOut,
  useCurrentSpace,
  useMayCreate,
} from "../lib/session";
import { openReport } from "../report/ReportDialog";
import { Button, cn, Dialog, Input } from "../ui";
import { AppRail, PhoneBar } from "./AppRail";
import {
  AssistantDock,
  AssistantSidebar,
  HighlightLayer,
  useAssistantInSidebar,
} from "./assistant/StudioAssistant";
import { CloudSyncBar } from "./CloudSync";
import { NewSpaceDialog } from "./HomePage";
import { InstallBanner, InstallDialog } from "./InstallBanner";
import { LangSwitch } from "./LangSwitch";
import { useLiveFeed } from "./live/index";
import { ModeSwitch } from "./ModeSwitch";
import {
  currentOrganization,
  OrganizationFace,
  OrganizationList,
  OrganizationMenu,
  OrganizationSheet,
  switchable,
  useManageOrganization,
} from "./Organizations";
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

/** `alone`: nothing stands before the trail (the person's Konto), so it starts without a slash. */
function Trail({ alone = false }: { alone?: boolean }) {
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
          {alone && i === 0 ? null : (
            <span className={cn("mr-2 text-ink-4", i === 0 ? "-ml-1 sm:-ml-2" : "ml-2")}>/</span>
          )}
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
    // Pointer, not mouse: a touch screen does not always send a mouse press for a tap.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        closeRef.current();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
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
  space,
  name,
  size = "md",
}: {
  space: Space | null;
  /** The initials' name where the tile stands for the organization (useOneSpace). */
  name?: string;
  size?: "xs" | "sm" | "md";
}) {
  const color = space?.brand.colors?.[0]?.value;
  const initials = initialsOf(name ?? space?.name ?? "");
  const face = (
    <span
      className={cn(
        "grid shrink-0 place-items-center font-semibold tracking-wide",
        size === "md"
          ? "size-10 rounded-lg text-[0.8125rem]"
          : size === "sm"
            ? "size-9 rounded-lg text-[0.75rem]"
            : "size-6 rounded-md text-[0.5625rem]",
        color ? null : "bg-paper-3 text-ink ring-1 ring-border",
      )}
      style={color ? { background: color, color: onFill(color) } : undefined}
    >
      {initials || <Folder className="size-4" />}
    </span>
  );
  if (space?.origin !== "local") {
    return face;
  }
  // A space a local install sent: a laptop on its corner, as the note on its pages says.
  return (
    <span className="relative shrink-0" title={t("readonly.space")}>
      {face}
      <span className="-right-1 -bottom-1 absolute grid size-4 place-items-center rounded-full bg-amber ring-2 ring-paper">
        <Laptop className="size-2.5 text-paper" />
      </span>
    </span>
  );
}

/**
 * An organization whose plan holds one space: the space is the organization, so the studio
 * names the organization only and its menu has no spaces to list.
 */
export function useOneSpace(me: Me): boolean {
  const { spaces } = useCurrentSpace();
  return (
    me.mode === "managed" && Boolean(me.tenant.name) && me.limits.spaces === 1 && spaces.length <= 1
  );
}

/**
 * The spaces, listed as Slack lists its workspaces: the one shown first (its row opens its
 * wizards), the others to switch to, its wizards and a new one, a row that renames it and one
 * that adds a space — not there at the plan's limit. The
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
  const { position, phone } = useAppBar();
  const { space, spaces, select } = useCurrentSpace();
  const one = useOneSpace(me);
  const manage = useManageOrganization(me);
  const mayCreate = useMayCreate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const organization = currentOrganization(me);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const limit = me.limits.spaces;
  const full = limit !== null && spaces.length >= limit;
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
          title={one ? undefined : t("nav.switchSpace")}
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
            {/* One space: the organizations to switch between stand in the menu itself (a
                phone opens them as a sheet); there are no spaces to list. */}
            {one && switchable(me) && !phone ? (
              <>
                <div className="px-2 pt-1.5 pb-1 text-[0.75rem] text-ink-3">
                  {t("organizations.mine")}
                </div>
                <OrganizationList me={me} onDone={() => setOpen(false)} />
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
              </>
            ) : null}
            {/* The organization heads its spaces; someone who can switch switches here. */}
            {one && !(switchable(me) && phone) ? null : organization && switchable(me) ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    setSwitching(true);
                  }}
                >
                  <OrganizationFace org={organization} size="xs" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-semibold text-[0.875rem] text-ink">
                      {organization.name}
                    </span>
                    {organization.plan ? (
                      <span className="truncate text-[0.75rem] text-ink-4">
                        {organization.plan.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[0.8125rem] text-ink-3">
                    {t("organizations.switchShort")}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-ink-4" />
                </button>
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
              </>
            ) : me.tenant.name ? (
              <div className="truncate px-2 pt-1.5 pb-1 text-[0.75rem] text-ink-3">
                {me.tenant.name}
              </div>
            ) : null}
            {(one ? [] : spaces).map((p) => {
              const current = p.id === space?.id;
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
                  <SpaceFace space={p} size="sm" />
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
            {one ? null : <div className="mx-2 my-1.5 h-px bg-border-soft" />}
            {[
              {
                to: "/",
                icon: WandSparkles,
                label: one ? t("nav.allWizards") : t("nav.wizardsInSpace"),
                show: true,
              },
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
            {/* One space, one organization: its settings, where the list would offer them. */}
            {one && !switchable(me) ? (
              <>
                <div className="mx-2 my-1.5 h-px bg-border-soft" />
                <button
                  type="button"
                  role="menuitem"
                  className={action}
                  onClick={() => {
                    setOpen(false);
                    manage();
                  }}
                >
                  <Settings className="size-4 shrink-0 text-ink-3" />
                  <span className="truncate">{t("organizations.manage")}</span>
                </button>
              </>
            ) : null}
            {space && !space.readOnly && !one ? (
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
        {switchable(me) ? (
          <OrganizationSheet me={me} open={switching} onClose={() => setSwitching(false)} />
        ) : null}
        {space ? (
          <RenameSpaceDialog space={space} open={renaming} onClose={() => setRenaming(false)} />
        ) : null}
      </div>
    </div>
  );
}

/** The space's name in the top bar; it opens the spaces to switch between and to add one. */
/** The space's name, changed in a dialog of its own. */
function RenameSpaceDialog({
  space,
  open,
  onClose,
}: {
  space: Space;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(space.name);
  useEffect(() => {
    if (open) {
      setName(space.name);
    }
  }, [open, space.name]);
  const rename = useMutation({
    mutationFn: () => api.patch(`/api/studio/spaces/${space.id}`, { name: name.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.spaces() });
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
function SpacePlace({ me, space }: { me: Me; space: Space }) {
  const local = me.mode === "local" || space.origin === "local";
  const Icon = local ? Laptop : Cloud;
  const label = local ? t("nav.spaceLocal") : t("nav.spaceCloud");
  return (
    <span title={label} className="grid size-6 shrink-0 place-items-center text-ink-4">
      <Icon className="size-3.5" aria-label={label} />
    </span>
  );
}

function SpaceName({ me }: { me: Me }) {
  const { space } = useCurrentSpace();
  // A phone's bar holds no space: its tile stands here, in the top left corner, before its name.
  const { phone } = useAppBar();
  const one = useOneSpace(me);
  if (!space) {
    return null;
  }
  // One space: the organization's name opens the menu, the space's name would only repeat it.
  if (one && me.tenant.name) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <SpaceMenu
          me={me}
          placement="below"
          label={me.tenant.name}
          className={(open) =>
            cn(
              phone
                ? "-ml-1 flex max-w-[16rem] items-center gap-2.5 rounded-xl py-1 pr-2 pl-1"
                : "-mx-1 flex max-w-[16rem] items-center gap-1 rounded-md px-2 py-0.5",
              "text-left font-medium text-[0.9375rem] text-ink transition hover:bg-accent",
              open && "bg-accent",
            )
          }
        >
          {phone ? <SpaceFace space={space} name={me.tenant.name} size="sm" /> : null}
          <span className="truncate">{me.tenant.name}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-4" />
        </SpaceMenu>
        <SpacePlace me={me} space={space} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1">
      {/* The organization the space belongs to, before it, where the bar has room: a menu for
          someone who can switch, its name for everyone else. */}
      {me.tenant.name && !phone ? (
        <>
          <OrganizationMenu me={me} className="max-lg:hidden" />
          <span className="text-ink-4 max-lg:hidden" aria-hidden="true">
            /
          </span>
        </>
      ) : null}
      <SpaceMenu
        me={me}
        placement="below"
        label={space.name}
        className={(open) =>
          phone
            ? cn(
                "-ml-1 flex max-w-[16rem] items-center gap-2.5 rounded-xl py-1 pr-2 pl-1 text-left font-medium text-[0.9375rem] text-ink transition hover:bg-accent",
                open && "bg-accent",
              )
            : cn(
                "-mx-1 max-w-[16rem] translate-y-[0.5px] truncate rounded-md px-2 py-0.5 text-left font-medium text-[0.9375rem] text-ink transition hover:bg-accent",
                open && "bg-accent",
              )
        }
      >
        {phone ? (
          <>
            <SpaceFace space={space} size="sm" />
            {/* The organization as a small line above the space: a phone's bar has no room beside it. */}
            <span className="flex min-w-0 flex-col leading-tight">
              {me.tenant.name ? (
                <span className="truncate font-normal text-[0.75rem] text-ink-3">
                  {me.tenant.name}
                </span>
              ) : null}
              <span className="truncate">{space.name}</span>
            </span>
          </>
        ) : (
          space.name
        )}
      </SpaceMenu>
      <SpacePlace me={me} space={space} />
    </span>
  );
}

/**
 * `placement`: where the menu opens — below the avatar in a top bar, away from the app bar.
 * `named`: in a bar that names its places, the person's name stands beside the avatar.
 */
export function UserMenu({
  me,
  placement = "below",
  named,
}: {
  me: Me;
  placement?: MenuPlacement;
  named?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { position, phone } = useAppBar();
  useDismiss(ref, open, () => setOpen(false));
  // A phone's bar has no engenty menu: the studio as an app on this device is offered here.
  const installPrompt = useInstallPrompt();
  const [installOpen, setInstallOpen] = useState(false);
  const initials = initialsOf(me.user.name);
  const account = useFeature("account");
  const state = accountState(me, account);
  // The person's own settings are behind the avatar where the organization has its own.
  const ownSettings = me.mode === "managed" && featureOn(me.features, "organizationSettings");
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink";
  return (
    <div className={cn("relative", named && "w-full")} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          named
            ? cn(
                "flex w-full items-center gap-3 rounded-lg p-0.5 pr-2 text-left transition hover:bg-ink/10",
                open && "bg-ink/10",
              )
            : "block shrink-0 rounded-full"
        }
        aria-label={me.user.name || "Menu"}
      >
        <span
          className={cn(
            "relative flex shrink-0 items-center justify-center rounded-full bg-ember-tint font-semibold text-[0.8125rem] text-ember-strong ring-1 ring-border-soft",
            // In the app bar the avatar is as large as the tiles above it.
            placement === "below" ? "size-9" : "size-10",
          )}
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
        </span>
        {named ? (
          <span className="min-w-0 flex-1 truncate font-medium text-[0.875rem] text-ink-2">
            {me.user.name}
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
            {me.tenant.name ? (
              <div className="mt-1.5 flex items-center gap-1.5 text-[0.75rem] text-ink-2">
                <Building2 className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
                <span className="truncate">{me.tenant.name}</span>
              </div>
            ) : null}
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
          {/* The person's own settings: behind the avatar, apart from the organization's where
              there are both, else Settings › Account. */}
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              navigate(ownSettings ? "/account" : "/settings/account");
            }}
          >
            <UserRound className="size-4" /> {t("konto.title")}
          </button>
          {!ownSettings && me.manageUrl ? (
            <a className={item} href={`${me.manageUrl}/account`} target="_blank" rel="noreferrer">
              <CreditCard className="size-4" /> {t("nav.account")}
            </a>
          ) : null}
          {phone && !standalone() ? (
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
          ) : null}
          {/* The person's own look and language (Settings › Account has both too). */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[0.875rem] text-ink-2">
            {t("nav.theme")}
            <ThemeSwitch />
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-[0.875rem] text-ink-2">
            {t("nav.language")}
            <LangSwitch tone="surface" />
          </div>
          {me.mode === "managed" ? (
            <button
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                openReport({ where: "studio" });
              }}
            >
              <Flag className="size-4" /> {t("report.open")}
            </button>
          ) : null}
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

/**
 * The row at the top of the page: the space's name, which switches between spaces, then the
 * trail. No wordmark: the app bar holds the places. A phone starts at the space's name; the rest
 * stands in its app bar along the bottom, and where the person has more than one mode, their
 * switch stands up here.
 */
export function TopBar({ me, children }: { me: Me; children?: ReactNode }) {
  const { phone } = useAppBar();
  // The person's Konto is theirs in every organization: no space, no organization's credits.
  const personal = useLocation().pathname.startsWith("/account");
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-3 coarse:h-14 sm:gap-3 sm:px-4 md:px-5">
      {personal ? null : <SpaceName me={me} />}
      <div className="flex min-w-0 flex-1 items-center">
        <Trail alone={personal} />
        {children}
      </div>
      {/* A phone has no app bar beside the page: the switch between the modes stands up here. */}
      {personal || !phone ? null : <ModeSwitch me={me} look="row" stack />}
      {/* A phone's bar keeps the places: the person stands up here. */}
      {phone ? <UserMenu me={me} /> : null}
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
  const { position, phone } = useAppBar();
  const column = useRef<HTMLDivElement>(null);
  // A phone's bar floats over the page: the page keeps its height free below the last line. A
  // page that fills the frame (the editor) has its own way back and its own bar at the bottom:
  // there the phone's bar steps aside, as a tab bar does on a screen pushed onto it.
  const clear = phone && !full ? "calc(4.75rem + env(safe-area-inset-bottom))" : "0px";
  const goose = useFeature("goose");
  // The bar folds to its glyphs beside another sidebar: the editor's panels, the assistant's.
  const assistantBeside = useAssistantInSidebar() && goose && !full;
  const labels = useAppBarLabels(Boolean(full) || assistantBeside);
  // What changed elsewhere shows here without a reload (docs/plans/live-changes.md).
  useLiveFeed(me.tenant.id);
  return (
    <div className={cn("flex h-dvh overflow-hidden bg-sidebar", DIRECTION[position])}>
      {phone ? (
        full ? null : (
          <PhoneBar me={me} />
        )
      ) : (
        <AppRail me={me} labels={labels.shown} room={labels.room} />
      )}
      {/* The page's card, and beside it Goose's sidebar as a pane of its own. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 md:gap-2", INSET[position])}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:rounded-xl md:shadow-elevated md:dark:ring-1 md:dark:ring-border-soft">
          {me.impersonation ? (
            <ImpersonationBanner
              name={me.user.name || me.user.email}
              until={me.impersonation.until}
            />
          ) : null}
          <UpdateBanner />
          <InstallBanner me={me} />
          <CloudSyncBar me={me} />
          {full ? (
            <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              {children}
            </main>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <TopBar me={me} />
              <div ref={column} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {/* `relative`: what a page places out of flow without a positioned parent (a
                    hidden file field) stays in the page's own scroll, not in a frame around it,
                    which a jump to a section would scroll as well. The page runs to the frame's
                    edge and scrolls under the assistant's docked card; it keeps that card's
                    height (`--assistant-dock`) free below its last section, or the phone's bar,
                    whichever is higher. */}
                <main
                  id={SCROLL_ROOT_ID}
                  className="relative min-h-0 flex-1 overflow-y-auto"
                  style={{ paddingBottom: `max(var(--assistant-dock, 0px), ${clear})` }}
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
                {goose && (
                  <>
                    <AssistantDock column={column} />
                    <HighlightLayer />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {goose && !full ? <AssistantSidebar /> : null}
      </div>
    </div>
  );
}
