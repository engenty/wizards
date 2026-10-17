import {
  Check,
  Home,
  type LucideIcon,
  Monitor,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Settings,
  Sun,
} from "lucide-react";
import {
  lazy,
  type MouseEvent,
  type PointerEvent,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { NavLink } from "react-router";
import { BRAND } from "../brand";
import { EngentyLogoMark } from "../engenty/logo";
import {
  APP_BAR_POSITIONS,
  type AppBarPosition,
  isHorizontal,
  setAppBar,
  useAppBar,
} from "../lib/appbar";
import { type Key, t } from "../lib/i18n";
import { type Me, useCurrentProject } from "../lib/session";
import { setTheme, type Theme, useThemePick } from "../lib/theme";
import { PluginFrame, useStudioPlugins } from "../plugins/host";
import { cn } from "../ui";
import { SpaceFace, SpaceMenu, UserMenu, useDismiss } from "./AppFrame";

const AboutDialog = lazy(() =>
  import("../about/AboutDialog").then((m) => ({ default: m.AboutDialog })),
);

/**
 * The app bar at an edge of the window, as in engenty-pro: the mark (it opens the About dialog:
 * the version, updates, what is new), the space with its home (the space's page: Info & brand,
 * Knowledge, Data, Results), the apps the plugins added, and at its end the settings and the
 * person. A place is a filled tile, a tool a line glyph; the
 * one that is open is cut from the page's own paper. A right click on the bar picks its edge
 * and the colour scheme. A phone has it along the bottom, or the top (`useAppBar`); a long
 * press there opens the same menu with those two edges.
 */

function glyph(active: boolean): string {
  return cn(
    "grid size-10 shrink-0 place-items-center rounded-lg transition",
    active
      ? "bg-paper text-ink shadow-soft dark:ring-1 dark:ring-border-soft"
      : "text-ink-3 hover:bg-ink/10 hover:text-ink",
  );
}

/** The space's tile: it opens the spaces to switch between; the ring says the menu is open. */
function SpaceTile({ me }: { me: Me }) {
  const { project } = useCurrentProject();
  return (
    <SpaceMenu
      me={me}
      placement="bar-start"
      label={project?.name ?? t("nav.project")}
      className={(open) =>
        cn(
          "block rounded-lg transition",
          open ? "ring-2 ring-ink/80 ring-offset-2 ring-offset-sidebar" : "hover:shadow-soft",
        )
      }
    >
      <SpaceFace project={project} />
    </SpaceMenu>
  );
}

const POSITION_ICON: Record<AppBarPosition, LucideIcon> = {
  left: PanelLeft,
  top: PanelTop,
  right: PanelRight,
  bottom: PanelBottom,
};

/** The colour schemes to pick from: light, dark, or the OS's own. */
const SCHEMES: readonly { pick: Theme | null; icon: LucideIcon; label: Key }[] = [
  { pick: "light", icon: Sun, label: "appbar.light" },
  { pick: "dark", icon: Moon, label: "appbar.dark" },
  { pick: null, icon: Monitor, label: "appbar.system" },
];

/** The bar's own menu, at the pointer: its edge, and the colour scheme. */
function BarMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const { position, phone } = useAppBar();
  const picked = useThemePick();
  const edges: readonly AppBarPosition[] = phone ? ["top", "bottom"] : APP_BAR_POSITIONS;
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
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink";
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

export function AppRail({ me }: { me: Me }) {
  const plugins = useStudioPlugins();
  const { position } = useAppBar();
  const horizontal = isHorizontal(position);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [about, setAbout] = useState(false);
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
    <>
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
          "flex shrink-0 select-none items-center bg-sidebar [-webkit-touch-callout:none]",
          horizontal ? "w-full flex-row gap-1.5 px-2" : "h-full w-16 flex-col pt-2 pb-3",
          // Along a phone's edge, clear of the notch and the home indicator: the safe area
          // comes on top of the bar's own padding, so the items keep their place in it.
          position === "bottom" && "pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]",
          position === "top" && "pt-[calc(0.375rem+env(safe-area-inset-top))] pb-1.5",
        )}
      >
        {/* Beside the page, the mark's row is as tall as the page's top bar, so the two sit on
              one line. */}
        <button
          type="button"
          onClick={() => setAbout(true)}
          title={t("about.title")}
          aria-label={t("about.title")}
          className={cn(
            "grid shrink-0 place-items-center rounded-lg transition hover:bg-ink/10",
            horizontal ? "size-11" : "h-12 w-11",
          )}
        >
          <EngentyLogoMark size={32} />
        </button>
        <div className={horizontal ? "ml-1" : "mt-2"}>
          <SpaceTile me={me} />
        </div>
        {/* The space's home: its page with Info & brand, Knowledge, Data and Results. */}
        <NavLink
          to="/space"
          title={t("nav.project")}
          aria-label={t("nav.project")}
          className={({ isActive }) => cn(glyph(isActive), horizontal ? "ml-1.5" : "mt-2")}
        >
          <Home className="size-5" />
        </NavLink>
        {/* The pages plugins added, each behind its icon, after a divider. */}
        {plugins.nav.length ? (
          <div
            className={cn("shrink-0 bg-border", horizontal ? "mx-2 h-7 w-px" : "my-3 h-px w-7")}
          />
        ) : null}
        <nav
          className={cn(
            "flex min-h-0 min-w-0 flex-1 items-center gap-1.5",
            horizontal ? "flex-row overflow-x-auto" : "flex-col overflow-y-auto",
          )}
        >
          {plugins.nav.map((entry) => (
            <PluginFrame key={entry.serial} of={entry}>
              <NavLink
                to={entry.to}
                title={entry.label()}
                aria-label={entry.label()}
                className={({ isActive }) => glyph(isActive)}
              >
                <entry.icon className="size-5" />
              </NavLink>
            </PluginFrame>
          ))}
        </nav>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            horizontal ? "flex-row pl-3" : "flex-col pt-3",
          )}
        >
          <NavLink
            to="/settings"
            title={t("nav.settings")}
            aria-label={t("nav.settings")}
            className={({ isActive }) => glyph(isActive)}
          >
            <Settings className="size-5" />
          </NavLink>
          <UserMenu me={me} placement="bar-end" />
        </div>
        {menu ? <BarMenu at={menu} onClose={() => setMenu(null)} /> : null}
      </aside>
      {/* Outside the bar: its text may be selected, and a right click on it is the browser's. */}
      {about ? (
        <Suspense fallback={null}>
          <AboutDialog open me={me} onClose={() => setAbout(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
