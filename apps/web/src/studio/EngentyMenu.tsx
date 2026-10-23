import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import {
  currentOrganization,
  OrganizationFace,
  OrganizationList,
  switchable,
  useManageOrganization,
} from "./Organizations";

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
  labels,
}: {
  me: Me;
  position: AppBarPosition;
  horizontal: boolean;
  /** In a bar that names its places, the name stands beside the engenty. */
  labels?: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [flyout, setFlyout] = useState(false);
  // The cloud studio's organization; a local install names none here (it has one, no switch).
  const organization = me.mode === "managed" ? currentOrganization(me) : null;
  const canSwitch = switchable(me);
  const manage = useManageOrganization(me);
  const installPrompt = useInstallPrompt();
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  // The flyout closes with the menu.
  useEffect(() => {
    if (!open) {
      setFlyout(false);
    }
  }, [open]);
  // Only a runtime that runs alone has updates of its own; in the cloud they come by themselves.
  const local = me.mode === "local";
  const { data, check } = useUpdate(local);
  // The settings from anywhere, as an app opens its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "," && (MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        navigate("/settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
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
    <div ref={ref} className={cn("relative shrink-0", labels && "w-full")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("about.title")}
        aria-label={t("about.title")}
        className={cn(
          "shrink-0 rounded-lg transition hover:bg-ink/10",
          open && "bg-ink/10",
          labels
            ? "flex h-12 w-full items-center gap-2 px-1.5"
            : cn("grid place-items-center", horizontal ? "size-11" : "h-12 w-11"),
        )}
      >
        <EngentyLogoMark size={32} />
        {labels ? (
          <span className="truncate font-display font-semibold text-[1rem] tracking-tight">
            engenty<span className="text-ember">.</span>
            <span className="ml-1 font-normal text-ink-3">wizards</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
            besideBar(position, "start"),
          )}
        >
          <div className="flex items-baseline gap-2 px-3 pt-2 pb-2.5">
            <span className="font-display font-semibold text-[1rem] tracking-tight">
              engenty<span className="text-ember">.</span>
              <span className="ml-1 font-normal text-ink-3">wizards</span>
            </span>
            <span className={cn(aside, "tabular-nums")}>{APP_VERSION}</span>
          </div>
          {organization ? (
            <>
              {/* The organization the studio is in, and its plan. Someone who can switch gets
                  the organizations beside the menu; everyone else its settings. */}
              <button
                type="button"
                role="menuitem"
                aria-haspopup={canSwitch ? "menu" : undefined}
                aria-expanded={canSwitch ? flyout : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-accent",
                  flyout && "bg-accent",
                )}
                onClick={() => {
                  if (canSwitch) {
                    setFlyout((f) => !f);
                  } else {
                    setOpen(false);
                    manage();
                  }
                }}
              >
                <OrganizationFace org={organization} size="xs" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate font-medium text-[0.875rem] text-ink">
                    {organization.name}
                  </span>
                  <span className="truncate text-[0.75rem] text-ink-4">
                    {organization.plan
                      ? `${t("organization.title")} · ${organization.plan.name}`
                      : t("organization.title")}
                  </span>
                </span>
                {canSwitch ? <ChevronRight className="size-4 shrink-0 text-ink-4" /> : null}
              </button>
              {flyout ? (
                <div
                  role="menu"
                  className={cn(
                    "absolute top-12 z-50 w-80 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft",
                    position === "right" ? "right-full mr-1.5" : "left-full ml-1.5",
                  )}
                >
                  <div className="px-2 pt-1.5 pb-1 text-[0.75rem] text-ink-3">
                    {t("organizations.switch")}
                  </div>
                  <OrganizationList me={me} onDone={() => setOpen(false)} />
                </div>
              ) : null}
              {rule}
            </>
          ) : null}
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
          <button type="button" role="menuitem" className={item} onClick={() => go("/settings")}>
            {t("nav.settings")} …<span className={aside}>{MAC ? "⌘ ," : "Ctrl ,"}</span>
          </button>
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
