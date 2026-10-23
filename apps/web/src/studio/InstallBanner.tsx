import { AppWindow, X } from "lucide-react";
import { useState } from "react";
import { t } from "../lib/i18n";
import { acceptInstall, installWay, standalone, useInstallPrompt } from "../lib/install";
import type { Me } from "../lib/session";
import { Button, Dialog, IconButton } from "../ui";

const DISMISSED_KEY = "wizards.install-banner";
const FIRST_DAY_KEY = "wizards.first-day";

const touch = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * How this device installs the studio: Chrome's offer, taken up right here, or the steps of the
 * browser's own menu — the share sheet on an iPhone, File → Add to Dock in Safari on a Mac.
 */
export function InstallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prompt = useInstallPrompt();
  const way = installWay(prompt);
  const how =
    way === "prompt"
      ? t("install.app.offer")
      : way === "none"
        ? t("install.app.browser")
        : t(`install.app.how.${way}`);
  return (
    <Dialog open={open} onClose={onClose} title={t("install.app.action")}>
      <p className="text-[0.9375rem] text-ink-2 leading-relaxed">{how}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("install.app.close")}
        </Button>
        {prompt ? (
          <Button
            onClick={() => {
              void acceptInstall(prompt);
              onClose();
            }}
          >
            {t("install.app.action")}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The day as this device counts it, `2026-10-23`. */
const today = () => new Date().toLocaleDateString("sv");

/**
 * The person came back on another day than their first here. The first day is kept on the
 * device; where storage refuses (a private window), every visit is a first one.
 */
function cameBack(): boolean {
  try {
    const first = localStorage.getItem(FIRST_DAY_KEY);
    if (!first) {
      localStorage.setItem(FIRST_DAY_KEY, today());
      return false;
    }
    return first !== today();
  } catch {
    return false;
  }
}

/**
 * The studio as an app of its own: where Chrome or Edge holds the offer, one click installs it
 * (its own window, its own icon). Not on the first visit: only once the organization has made a
 * wizard and the person comes back on another day. Gone once installed, in the app's own
 * window, or after the person closes it; the menu offers it always.
 */
export function InstallBanner({ me }: { me: Me }) {
  const prompt = useInstallPrompt();
  const [closed, setClosed] = useState(dismissed);
  const [back] = useState(cameBack);
  // A phone has the offer in the user menu instead.
  if (!(prompt && me.hasWizards && back) || closed || standalone() || touch()) {
    return null;
  }
  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private window: it shows again next time.
    }
    setClosed(true);
  };
  return (
    <div className="flex items-center gap-3 border-border-soft border-b bg-paper-2 px-4 py-2 text-[0.8125rem] text-ink-2 sm:px-6">
      <AppWindow className="size-4 shrink-0 text-ink-3" />
      <p className="min-w-0 flex-1">{t("install.app.offer")}</p>
      <Button size="sm" onClick={() => void acceptInstall(prompt)}>
        {t("install.app.action")}
      </Button>
      <IconButton label={t("install.app.close")} onClick={close} className="size-8">
        <X className="size-4" />
      </IconButton>
    </div>
  );
}
