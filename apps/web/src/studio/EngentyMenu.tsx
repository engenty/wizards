import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { APP_VERSION } from "../about/AboutLinks";
import { EngentyLogoMark } from "../engenty/logo";
import { type AppBarPosition, besideBar } from "../lib/appbar";
import { t } from "../lib/i18n";
import { acceptInstall, standalone, useInstallPrompt } from "../lib/install";
import type { Me } from "../lib/session";
import { useUpdate } from "../lib/update";
import { cn } from "../ui";
import { useDismiss } from "./AppFrame";
import { InstallDialog } from "./InstallBanner";

/** ⌘ on a Mac, Ctrl elsewhere: the key the settings' shortcut is pressed with. */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The engenty in the corner of the app bar, and its menu, as the Apple menu is the computer's:
 * what belongs to engenty wizards itself, not to a space or a person. Which release this is and
 * whether a newer one is out, what is new, the settings (also ⌘ ,), the app on this device, and
 * the credits. Look and language are the person's: they stand in the person's menu.
 */
export function EngentyMenu({
  me,
  position,
  horizontal,
  more,
  trigger,
}: {
  me: Me;
  position: AppBarPosition;
  horizontal: boolean;
  /**
   * A phone's bar: the menu opens from "⋯" at the bar's end and holds, first, the places the bar
   * has no room for (`go` follows one and closes the menu).
   */
  more?: (go: (to: string) => void) => ReactNode;
  /** What the button looks like where the bar draws its own (a phone's tab). */
  trigger?: { className: (open: boolean) => string; children: ReactNode };
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const installPrompt = useInstallPrompt();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  // Only a runtime that runs alone has updates of its own; in the cloud they come by themselves.
  const local = me.mode === "local";
  const { data, check } = useUpdate(local);
  // The settings from anywhere, as an app opens its own; a phone has no keys for it.
  useEffect(() => {
    if (more) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "," && (MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        navigate("/settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, more]);
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  const aside = "ml-auto shrink-0 text-[0.75rem] text-ink-4";
  const rule = <div className="mx-2 my-1.5 h-px bg-border-soft" />;
  const update = check.isPending
    ? { text: t("about.update.checking"), tone: aside }
    : data?.newer && data.latest
      ? { text: data.latest, tone: "ml-auto shrink-0 text-[0.75rem] font-medium text-ember-strong" }
      : data
        ? {
            text: t("about.update.upToDateShort"),
            tone: "ml-auto shrink-0 text-[0.75rem] text-moss",
          }
        : null;
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={more ? t("nav.more") : t("about.title")}
        aria-label={more ? t("nav.more") : t("about.title")}
        className={
          trigger
            ? trigger.className(open)
            : cn(
                "grid shrink-0 place-items-center rounded-lg transition hover:bg-ink/10",
                open && "bg-ink/10",
                horizontal ? "size-11" : "h-12 w-11",
              )
        }
      >
        {trigger ? trigger.children : <EngentyLogoMark size={32} />}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
            besideBar(position, more ? "end" : "start"),
          )}
        >
          {more ? (
            <>
              {more(go)}
              {rule}
            </>
          ) : null}
          <div className="flex items-baseline gap-2 px-3 pt-2 pb-2.5">
            <span className="font-display font-semibold text-[1rem] tracking-tight">
              engenty<span className="text-ember">.</span>
              <span className="ml-1 font-normal text-ink-3">wizards</span>
            </span>
            <span className={cn(aside, "tabular-nums")}>{APP_VERSION}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => go("/settings/about")}
          >
            {t("about.title")}
          </button>
          {local ? (
            <button
              type="button"
              role="menuitem"
              className={item}
              // A newer release: its notes and the update are on the About page; else ask now.
              onClick={() => (data?.newer ? go("/settings/about") : check.mutate())}
            >
              {t("about.update.check")}
              {update ? <span className={update.tone}>{update.text}</span> : null}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => go("/settings/about?tab=new")}
          >
            {t("about.tab.new")}
          </button>
          {rule}
          {/* A phone's More has the settings among its places already. */}
          {more ? null : (
            <button type="button" role="menuitem" className={item} onClick={() => go("/settings")}>
              {t("nav.settings")} …
              {more ? null : <span className={aside}>{MAC ? "⌘ ," : "Ctrl ,"}</span>}
            </button>
          )}
          {standalone() ? null : (
            <button
              type="button"
              role="menuitem"
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
              {t("install.app.action")}
            </button>
          )}
          {rule}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => go("/settings/about?tab=credits")}
          >
            {t("about.creditsMenu")}
          </button>
        </div>
      ) : null}
      {/* Beside the menu, not in it: the menu closes as the dialog opens. */}
      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  );
}
