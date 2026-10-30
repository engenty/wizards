import {
  Bell,
  Check,
  ChevronsUpDown,
  Database,
  Ellipsis,
  Folder,
  Home,
  Inbox,
  Info,
  Layers,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  PanelTop,
  Plus,
  Settings,
  Sun,
} from "lucide-react";
import {
  lazy,
  type MouseEvent,
  type PointerEvent,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { BRAND } from "../brand";
import {
  APP_BAR_POSITIONS,
  type AppBarPosition,
  isHorizontal,
  setAppBar,
  useAppBar,
} from "../lib/appbar";
import { type Key, t } from "../lib/i18n";
import { useMode } from "../lib/mode";
import { type Me, useCurrentSpace, useMayCreate } from "../lib/session";
import { setTheme, type ThemeMode, useThemePick } from "../lib/theme";
import { PluginFrame, useStudioPlugins } from "../plugins/host";
import { cn } from "../ui";
import { SpaceFace, SpaceMenu, UserMenu, useDismiss, useOneSpace } from "./AppFrame";
import { EngentyMenu } from "./EngentyMenu";
import { ModeSwitch } from "./ModeSwitch";
import { type PrimaryAction, useCurrentPrimaryAction } from "./primary-action";
import { useWaiting } from "./work/chats";
import { EngentyGlyph, WORK_PLACES, type WorkPlace } from "./work/WorkPages";

const AboutDialog = lazy(() =>
  import("../about/AboutDialog").then((m) => ({ default: m.AboutDialog })),
);

/**
 * The app bar at an edge of the window: the engenty in the corner (its menu holds what belongs to
 * the app itself), the switch between the modes under it, the space (it switches between spaces), its home (the wizards), its sources
 * (Info, Brand, Knowledge, Data), its results, the apps the plugins added, and at its end the
 * settings and the person. A place is a filled tile, a tool a line glyph; the one that is open is
 * cut from the page's own paper. On a wide window a bar at a side names its places beside
 * their glyphs, unless another sidebar stands beside the page. A right click on the bar, or a
 * long press on a touch screen, picks its edge, the names and the colour scheme. A phone has a
 * bar of its own (`PhoneBar`).
 */

function glyph(active: boolean, labels = false): string {
  return cn(
    "shrink-0 rounded-lg transition",
    labels
      ? "flex h-10 w-full items-center gap-3 px-2.5 font-medium text-[0.875rem]"
      : "grid size-10 place-items-center",
    active
      ? "bg-paper text-ink shadow-soft dark:ring-1 dark:ring-border-soft"
      : "text-ink-3 hover:bg-ink/10 hover:text-ink",
  );
}

/** A place's name beside its glyph, in a bar that names its places. */
function Label({ children }: { children: string }) {
  return <span className="min-w-0 flex-1 truncate">{children}</span>;
}

/**
 * The space's tile: it opens the spaces to switch between; the ring says the menu is open. In a
 * bar that names its places, the space's name stands beside it.
 */
export function SpaceTile({ me, labels }: { me: Me; labels?: boolean }) {
  const { space } = useCurrentSpace();
  const one = useOneSpace(me);
  const name = one ? (me.tenant.name ?? undefined) : undefined;
  return (
    <SpaceMenu
      me={me}
      placement="bar-start"
      label={space?.name ?? t("nav.space")}
      className={(open) =>
        labels
          ? cn(
              "flex w-full items-center gap-3 rounded-lg p-0.5 pr-2 text-left transition hover:bg-ink/10",
              open && "bg-ink/10",
            )
          : cn(
              "block rounded-lg transition",
              open ? "ring-2 ring-ink/80 ring-offset-2 ring-offset-sidebar" : "hover:shadow-soft",
            )
      }
    >
      {/* One space: the tile stands for the organization. */}
      <SpaceFace space={space} name={name} />
      {labels ? (
        <>
          <span className="min-w-0 flex-1 truncate font-semibold text-[0.875rem] text-ink">
            {name ?? space?.name ?? t("nav.space")}
          </span>
          {one ? null : <ChevronsUpDown className="size-4 shrink-0 text-ink-4" />}
        </>
      ) : null}
    </SpaceMenu>
  );
}

const POSITION_ICON: Record<AppBarPosition, LucideIcon> = {
  left: PanelLeft,
  top: PanelTop,
  right: PanelRight,
  bottom: PanelBottom,
};

/** The colour schemes to pick from: light, branded, dark, or the OS's own. */
const SCHEMES: readonly { pick: ThemeMode | null; icon: LucideIcon; label: Key }[] = [
  { pick: "light", icon: Sun, label: "appbar.light" },
  { pick: "branded", icon: Palette, label: "appbar.branded" },
  { pick: "dark", icon: Moon, label: "appbar.dark" },
  { pick: null, icon: Monitor, label: "appbar.system" },
];

/**
 * The bar's own menu, at the pointer: its edge, whether it names its places, and the colour
 * scheme. The names can only be asked for where they have room (`room`), but always turned off.
 */
function BarMenu({
  at,
  room,
  onClose,
}: {
  at: { x: number; y: number };
  room: boolean;
  onClose: () => void;
}) {
  const { position, labels } = useAppBar();
  const picked = useThemePick();
  const edges: readonly AppBarPosition[] = APP_BAR_POSITIONS;
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose);
  // Drawn at the pointer, then moved back inside the window by as much as it stands out of it:
  // up from a bar along the bottom, left from one along the right.
  const [shift, setShift] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      setShift({
        x: Math.min(0, window.innerWidth - 8 - rect.right),
        y: Math.min(0, window.innerHeight - 8 - rect.bottom),
      });
    }
  }, []);
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink disabled:pointer-events-none disabled:opacity-50";
  const head = "px-3 pt-2 pb-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.07em]";
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
      style={{ left: Math.max(8, at.x + shift.x), top: Math.max(8, at.y + shift.y) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={head}>{t("appbar.position")}</div>
      {edges.map((edge) => {
        const Icon = POSITION_ICON[edge];
        return (
          <button
            key={edge}
            type="button"
            role="menuitemradio"
            aria-checked={edge === position}
            className={cn(item, edge === position && "text-ink")}
            onClick={() => {
              setAppBar({ position: edge });
              onClose();
            }}
          >
            <Icon className="size-4" />
            <span className="flex-1">{t(`appbar.${edge}`)}</span>
            {edge === position ? <Check className="size-4 text-ember-strong" /> : null}
          </button>
        );
      })}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={labels}
        disabled={!(labels || room)}
        className={cn(item, labels && "text-ink")}
        onClick={() => {
          setAppBar({ labels: !labels });
          onClose();
        }}
      >
        <PanelLeftOpen className="size-4" />
        <span className="flex-1">{t("appbar.labels")}</span>
        {labels ? <Check className="size-4 text-ember-strong" /> : null}
      </button>
      <div className="mx-2 my-1.5 h-px bg-border-soft" />
      <div className={head}>{t("appbar.theme")}</div>
      {SCHEMES.map(({ pick, icon: Icon, label }) => (
        <button
          key={label}
          type="button"
          role="menuitemradio"
          aria-checked={pick === picked}
          className={cn(item, pick === picked && "text-ink")}
          onClick={() => {
            setTheme(pick);
            onClose();
          }}
        >
          <Icon className="size-4" />
          <span className="flex-1">{t(label)}</span>
          {pick === picked ? <Check className="size-4 text-ember-strong" /> : null}
        </button>
      ))}
    </div>
  );
}

/** The place in the bar a page belongs to: Home (the wizards), the space's sources, its results. */
function usePlace(): "home" | "new" | "space" | "results" | "settings" | null {
  const { pathname } = useLocation();
  if (pathname === "/new") {
    return "new";
  }
  if (pathname === "/" || pathname.startsWith("/edit/")) {
    return "home";
  }
  if (pathname === "/space/results" || pathname.startsWith("/space/results/")) {
    return "results";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  return pathname === "/space" || pathname.startsWith("/space/") ? "space" : null;
}

const WORK_ICON: Record<WorkPlace, LucideIcon | typeof EngentyGlyph> = {
  chats: MessageSquare,
  engenties: EngentyGlyph,
  files: Folder,
  data: Database,
  results: Inbox,
  waiting: Bell,
};

/**
 * Work's places in the bar: Chats, Engenties, Files, Data, Results, then the bell with what waits
 * for the person (the calls held for their approval; its count shows from one on).
 */
function WorkRail({ labels, horizontal }: { labels: boolean; horizontal: boolean }) {
  const waiting = useWaiting().data?.approvals.length ?? 0;
  return (
    <nav
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        labels ? "items-stretch" : "items-center",
        horizontal ? "ml-1.5 flex-row gap-1.5 overflow-x-auto" : "mt-2 flex-col gap-2",
      )}
    >
      {WORK_PLACES.map(({ place, to, label }) => {
        const Icon = WORK_ICON[place];
        return (
          <NavLink
            key={place}
            to={to}
            end
            title={t(label)}
            aria-label={t(label)}
            className={({ isActive }) => cn(glyph(isActive, labels), "relative")}
          >
            <Icon className="size-5 shrink-0" />
            {labels ? <Label>{t(label)}</Label> : null}
            {place === "waiting" && waiting > 0 ? (
              <span className="absolute top-0.5 left-6 grid h-4 min-w-4 place-items-center rounded-full bg-ember px-1 font-bold text-[0.625rem] text-white">
                {waiting}
              </span>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );
}

/**
 * `labels`: the bar names its places now (`useAppBarLabels`); `room`: it could, so the menu
 * offers it.
 */
export function AppRail({ me, labels, room }: { me: Me; labels: boolean; room: boolean }) {
  const plugins = useStudioPlugins();
  const { position } = useAppBar();
  const horizontal = isHorizontal(position);
  const place = usePlace();
  const mode = useMode(me);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  // A finger resting on the bar for half a second opens the menu where it rests; the tap that
  // would follow the release is swallowed, so nothing under the finger opens as well.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallow = useRef(false);
  const endPress = () => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current = null;
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      return;
    }
    endPress();
    const { clientX: x, clientY: y } = e;
    press.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        press.current = null;
        swallow.current = true;
        window.setTimeout(() => {
          swallow.current = false;
        }, 700);
        setMenu({ x, y });
      }, 500),
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (
      press.current &&
      Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10
    ) {
      endPress();
    }
  };
  const onClickCapture = (e: MouseEvent) => {
    if (swallow.current) {
      swallow.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return (
    <aside
      aria-label={BRAND.name}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
      onClickCapture={onClickCapture}
      className={cn(
        // No text selection and no link callout while a finger rests on the bar.
        "flex shrink-0 select-none bg-sidebar [-webkit-touch-callout:none]",
        horizontal
          ? "w-full flex-row items-center gap-1.5 px-2"
          : cn(
              "h-full flex-col pt-2 pb-3 transition-[width] duration-200 ease-out",
              labels ? "w-56 items-stretch px-2.5" : "w-16 items-center",
            ),
        // Along a phone's edge, clear of the notch and the home indicator: the safe area
        // comes on top of the bar's own padding, so the items keep their place in it.
        position === "bottom" && "pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]",
        position === "top" && "pt-[calc(0.375rem+env(safe-area-inset-top))] pb-1.5",
      )}
    >
      {/* Beside the page, the engenty's row is as tall as the page's top bar, so the two sit on
          one line. */}
      <EngentyMenu me={me} position={position} horizontal={horizontal} labels={labels} />
      <div className={horizontal ? "ml-1" : "mt-1"}>
        <SpaceTile me={me} labels={labels} />
      </div>
      {/* The mode, always in sight: under the space, near the engenty that wears it. */}
      <ModeSwitch
        me={me}
        look={horizontal ? "row" : labels ? "named" : "stacked"}
        className={horizontal ? "ml-1" : "mt-2"}
      />
      {mode === "work" ? (
        <WorkRail labels={labels} horizontal={horizontal} />
      ) : mode === "client" ? (
        <div className="min-h-0 min-w-0 flex-1" />
      ) : (
        <>
          <Link
            to="/"
            title={t("nav.home")}
            aria-label={t("nav.home")}
            aria-current={place === "home" || place === "new" ? "page" : undefined}
            className={cn(
              glyph(place === "home" || place === "new", labels),
              horizontal ? "ml-1.5" : "mt-2",
            )}
          >
            <Home className="size-5 shrink-0" />
            {labels ? <Label>{t("nav.home")}</Label> : null}
          </Link>
          {/* The space's sources: Info, Brand, Knowledge and Data. */}
          <Link
            to="/space"
            title={t("nav.sources")}
            aria-label={t("nav.sources")}
            aria-current={place === "space" ? "page" : undefined}
            className={cn(glyph(place === "space", labels), horizontal ? "ml-1.5" : "mt-2")}
          >
            <Layers className="size-5 shrink-0" />
            {labels ? <Label>{t("nav.sources")}</Label> : null}
          </Link>
          {/* What the space's wizards made. */}
          <Link
            to="/space/results"
            title={t("space.results")}
            aria-label={t("space.results")}
            aria-current={place === "results" ? "page" : undefined}
            className={cn(glyph(place === "results", labels), horizontal ? "ml-1.5" : "mt-2")}
          >
            <Inbox className="size-5 shrink-0" />
            {labels ? <Label>{t("space.results")}</Label> : null}
          </Link>
          {/* The pages plugins added, each behind its icon, after a divider. */}
          {plugins.nav.length ? (
            <div
              className={cn(
                "shrink-0 bg-border",
                horizontal ? "mx-2 h-7 w-px" : cn("my-3 h-px", labels ? "mx-2.5" : "w-7"),
              )}
            />
          ) : null}
          <nav
            className={cn(
              "flex min-h-0 min-w-0 flex-1 gap-1.5",
              labels ? "items-stretch" : "items-center",
              horizontal ? "flex-row overflow-x-auto" : "flex-col overflow-y-auto",
            )}
          >
            {plugins.nav.map((entry) => (
              <PluginFrame key={entry.serial} of={entry}>
                <NavLink
                  to={entry.to}
                  title={entry.label()}
                  aria-label={entry.label()}
                  className={({ isActive }) => glyph(isActive, labels)}
                >
                  <entry.icon className="size-5 shrink-0" />
                  {labels ? <Label>{entry.label()}</Label> : null}
                </NavLink>
              </PluginFrame>
            ))}
          </nav>
        </>
      )}
      <div
        className={cn(
          "flex shrink-0 gap-2",
          horizontal ? "flex-row pl-3" : "flex-col pt-3",
          labels ? "items-stretch" : "items-center",
        )}
      >
        <NavLink
          to="/settings"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          className={({ isActive }) => glyph(isActive, labels)}
        >
          <Settings className="size-5 shrink-0" />
          {labels ? <Label>{t("nav.settings")}</Label> : null}
        </NavLink>
        <UserMenu me={me} placement="bar-end" named={labels} />
      </div>
      {menu ? <BarMenu at={menu} room={room} onClose={() => setMenu(null)} /> : null}
    </aside>
  );
}

/**
 * A phone's bar: always along the bottom, floating over the page as glass. It holds the space and
 * its two places to go every day, Home and the space's sources; "⋯" holds the rest (results, the
 * plugins' apps, then what the engenty's menu holds, the settings among it). The person sits at the top.
 */
/**
 * A tab of a phone's bar: its glyph alone, its name for a screen reader; the open one sits on a
 * capsule of lighter glass.
 */
function tab(active: boolean): string {
  return cn(
    "glass-press relative grid h-12 w-16 place-items-center rounded-full transition-colors",
    active ? "text-ink" : "text-ink-3",
  );
}

/** A tab's width and the gap after it: how far the capsule moves from one tab to the next. */
const TAB_STEP = 64 + 4;

/**
 * The capsule under the lit tab. It slides to the next one on a spring and stretches on the way,
 * as iOS's selection does; it jumps where less motion was asked for.
 */
function Capsule({ index }: { index: number | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(index);
  useEffect(() => {
    const prev = from.current;
    from.current = index;
    const el = ref.current;
    if (
      !el ||
      prev === null ||
      index === null ||
      prev === index ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const a = prev * TAB_STEP;
    const b = index * TAB_STEP;
    el.animate(
      [
        { transform: `translateX(${a}px)` },
        { transform: `translateX(${(a + b) / 2}px) scaleX(1.35) scaleY(0.92)`, offset: 0.45 },
        { transform: `translateX(${b}px)` },
      ],
      { duration: 420, easing: "cubic-bezier(0.34, 1.3, 0.64, 1)" },
    );
  }, [index]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute top-1 left-1 h-12 w-16 rounded-full bg-ink/12 transition-opacity"
      style={{
        transform: `translateX(${(index ?? 0) * TAB_STEP}px)`,
        opacity: index === null ? 0 : 1,
      }}
    />
  );
}

/**
 * A phone's bar: always along the bottom, a capsule of glass floating over the page. Three tabs:
 * the space's two places to go every day, Home and its sources, and "More" with the rest in a menu:
 * Results, the settings, the plugins' apps, then About (in a dialog). Beside it, on glass of its
 * own, the page's main action (`usePrimaryAction`), else a new wizard. The space and the person
 * sit in the top bar.
 */
export function PhoneBar({ me }: { me: Me }) {
  const plugins = useStudioPlugins();
  const place = usePlace();
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const named = useCurrentPrimaryAction();
  const mayCreate = useMayCreate();
  const { space } = useCurrentSpace();
  // The round button: what the page names, else a new wizard (not where one is being made).
  const action: PrimaryAction | null =
    named ??
    (mayCreate && !space?.readOnly && place !== "new"
      ? { icon: Plus, label: t("home.new"), run: () => navigate("/new") }
      : null);
  useDismiss(ref, open, () => setOpen(false));
  // Another page closes it, whichever way it was reached.
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page closes the menu
  useEffect(() => setOpen(false), [pathname]);
  // While "More" is open it is the one lit; the place it would leave goes dark meanwhile.
  const lit = (key: string) => (open ? false : place === key);
  const capsule = open
    ? 2
    : place === "home" || place === "new"
      ? 0
      : place === "space"
        ? 1
        : place === "results" || place === "settings"
          ? 2
          : null;
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[0.9375rem] transition",
      active ? "bg-accent text-ink" : "text-ink-2 hover:bg-accent hover:text-ink",
    );
  return (
    <div className="fixed inset-x-0 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-40 flex select-none justify-center gap-2.5 [-webkit-touch-callout:none]">
      <nav
        ref={ref}
        aria-label={BRAND.name}
        className="liquid-glass relative flex gap-1 rounded-full p-1"
      >
        <Capsule index={capsule} />
        <Link
          to="/"
          aria-label={t("nav.home")}
          aria-current={place === "home" ? "page" : undefined}
          onClick={() => setOpen(false)}
          className={tab(lit("home"))}
        >
          <Home className="size-[1.375rem]" />
        </Link>
        <Link
          to="/space"
          aria-label={t("nav.sources")}
          aria-current={place === "space" ? "page" : undefined}
          onClick={() => setOpen(false)}
          className={tab(lit("space"))}
        >
          <Layers className="size-[1.375rem]" />
        </Link>
        <button
          type="button"
          aria-label={t("nav.more")}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((o) => !o)}
          className={tab(open || place === "results" || place === "settings")}
        >
          <Ellipsis className="size-[1.375rem]" />
        </button>
        {open ? (
          // Above the bar, from its end: the places it has no room for, one under the other (the
          // plugins' apps join them), then About.
          <div
            role="menu"
            className="absolute right-0 bottom-full mb-3 flex w-60 animate-rise flex-col rounded-2xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
          >
            <button
              type="button"
              role="menuitem"
              className={row(place === "results")}
              onClick={() => go("/space/results")}
            >
              <Inbox className="size-[1.125rem] shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{t("space.results")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={row(place === "settings")}
              onClick={() => go("/settings")}
            >
              <Settings className="size-[1.125rem] shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{t("nav.settings")}</span>
            </button>
            {plugins.nav.map((entry) => (
              <PluginFrame key={entry.serial} of={entry}>
                <button
                  type="button"
                  role="menuitem"
                  className={row(false)}
                  onClick={() => go(entry.to)}
                >
                  <entry.icon className="size-[1.125rem] shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{entry.label()}</span>
                </button>
              </PluginFrame>
            ))}
            <div className="mx-2 my-1.5 h-px bg-border-soft" />
            <button
              type="button"
              role="menuitem"
              className={row(false)}
              onClick={() => {
                setOpen(false);
                setAbout(true);
              }}
            >
              <Info className="size-[1.125rem] shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{t("about.nav")}</span>
            </button>
          </div>
        ) : null}
        {about ? (
          <Suspense fallback={null}>
            <AboutDialog open me={me} onClose={() => setAbout(false)} />
          </Suspense>
        ) : null}
      </nav>
      {action ? (
        <button
          type="button"
          aria-label={action.label}
          title={action.label}
          onClick={action.run}
          className="liquid-glass glass-press relative grid size-14 shrink-0 place-items-center rounded-full text-ink"
        >
          <action.icon className="size-6" />
        </button>
      ) : null}
    </div>
  );
}
