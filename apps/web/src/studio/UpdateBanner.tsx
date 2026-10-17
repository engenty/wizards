import { Download, X } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { t } from "../lib/i18n";
import { useUpdate } from "../lib/update";
import { Button, IconButton, Spinner } from "../ui";

const ChangelogDialog = lazy(() =>
  import("../about/ChangelogDialog").then((m) => ({ default: m.ChangelogDialog })),
);

const DISMISSED_KEY = "wizards.update-banner";

function dismissedFor(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * A newer release is out. A runtime installed by install.sh installs it from here and starts
 * the new version; the page waits for it and loads again. One that cannot (npm, a checkout)
 * only says so. "Was ist neu" opens the changelog of the new release. Closing it hides this
 * release; the next one shows again — and the About dialog behind the mark keeps saying it.
 * An update that came by itself waits for the next start; then this says "Updated to …".
 */
export function UpdateBanner() {
  const [closed, setClosed] = useState(dismissedFor);
  const [notes, setNotes] = useState(false);
  const { data, latest: newest, apply, busy, progress } = useUpdate();
  // After an update (by itself or from here): "Updated to …", until it is closed.
  const updated = data && !data.newer ? (data.updated?.to ?? null) : null;
  const latest = updated ?? (data?.newer ? newest : null);
  if (!(data && latest) || (closed === latest && data.applying === "idle")) {
    return null;
  }
  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, latest);
    } catch {
      // Private window: it shows again next time.
    }
    setClosed(latest);
  };
  const line =
    progress ??
    (updated
      ? t("about.update.updated", { v: latest })
      : data.pending?.version === latest
        ? t("about.update.ready", { v: latest })
        : t("about.update.available", { v: latest }));
  return (
    <div className="flex items-center gap-3 border-border-soft border-b bg-ember-tint px-4 py-2 text-[0.8125rem] text-ink-2 sm:px-6">
      {busy ? (
        <Spinner className="size-4 shrink-0 text-ember-strong" />
      ) : (
        <Download className="size-4 shrink-0 text-ember-strong" />
      )}
      <p className="min-w-0 flex-1">{line}</p>
      {busy ? null : (
        <button
          type="button"
          onClick={() => setNotes(true)}
          className="shrink-0 underline transition hover:text-ink"
        >
          {t("about.update.notes")}
        </button>
      )}
      {notes ? (
        <Suspense fallback={null}>
          <ChangelogDialog open version={latest} onClose={() => setNotes(false)} />
        </Suspense>
      ) : null}
      {data.canApply && !updated && (data.applying === "idle" || data.applying === "failed") ? (
        <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
          {t("about.update.install")}
        </Button>
      ) : null}
      {busy ? null : (
        <IconButton label={t("install.app.close")} onClick={close} className="size-8">
          <X className="size-4" />
        </IconButton>
      )}
    </div>
  );
}
