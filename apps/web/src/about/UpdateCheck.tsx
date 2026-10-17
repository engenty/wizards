import { Download, RefreshCw } from "lucide-react";
import { lang, t } from "../lib/i18n";
import type { Me } from "../lib/session";
import { useUpdate } from "../lib/update";
import { Button, cn, IconButton, Spinner } from "../ui";
import { AboutLinks } from "./AboutLinks";

/**
 * On a runtime that runs alone: whether a newer release is out, checked now on a word, and
 * installed from here where install.sh put it. The About dialog shows it centred under the
 * mark, the account settings at the start of their card.
 */
export function UpdateCheck({
  enabled = true,
  align = "center",
}: {
  enabled?: boolean;
  align?: "center" | "start";
}) {
  const { status, data, latest, check, apply, busy, progress } = useUpdate(enabled);
  const checkedAt = data?.checkedAt
    ? new Date(data.checkedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })
    : null;
  const centre = align === "center";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 text-[0.875rem] text-ink-2",
        centre ? "items-center text-center" : "items-start",
      )}
    >
      {status.isPending || check.isPending ? (
        <div className="flex items-center gap-2.5">
          <Spinner className="size-4 text-ember-strong" />
          {t("about.update.checking")}
        </div>
      ) : progress ? (
        <div className="flex items-center gap-2.5">
          {busy ? <Spinner className="size-4 text-ember-strong" /> : null}
          {progress}
        </div>
      ) : data?.newer && latest ? (
        <>
          <div className="flex items-center gap-2.5 font-medium text-ink">
            <Download className="size-4 shrink-0 text-ember-strong" />
            {t("about.update.available", { v: latest })}
          </div>
          {data.canApply ? null : <p className="text-ink-3">{t("about.update.manual")}</p>}
        </>
      ) : !data?.enabled ? (
        <p>{t("about.update.off")}</p>
      ) : data.latest === null ? (
        <p>{t("about.update.unknown")}</p>
      ) : (
        <p>
          {t("about.update.upToDate")}
          {checkedAt ? (
            <span className="text-ink-4">
              {" "}
              · {t("about.update.checkedAt", { when: checkedAt })}
            </span>
          ) : null}
        </p>
      )}
      {busy || status.isPending ? null : (
        <div className={cn("flex flex-wrap gap-2", centre && "justify-center")}>
          {data?.newer && data.canApply && data.applying !== "running" ? (
            <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
              <Download className="size-4" /> {t("about.update.install")}
            </Button>
          ) : null}
          {data?.enabled === false ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshCw className={cn("size-4", check.isPending && "animate-spin")} />{" "}
              {t("about.update.check")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The same in one line, for the top of the account settings: this version, which opens the
 * About dialog with what is new, then how it got here — or, on a runtime that runs alone, whether
 * it is the newest, the newer one with its update button, and the check again beside it.
 */
export function UpdateLine({ me }: { me: Me }) {
  const local = me.mode === "local";
  const { status, data, latest, check, apply, busy, progress } = useUpdate(local);
  const checking = status.isPending || check.isPending;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.8125rem] text-ink-3">
      <AboutLinks me={me} />
      <span aria-hidden>·</span>
      {!local ? (
        <span>{t("about.kind.cloud")}</span>
      ) : checking ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="size-3.5 text-ember-strong" /> {t("about.update.checking")}
        </span>
      ) : progress ? (
        <span className="inline-flex items-center gap-1.5">
          {busy ? <Spinner className="size-3.5 text-ember-strong" /> : null}
          {progress}
        </span>
      ) : data?.newer && latest ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-ink">
          <Download className="size-3.5 shrink-0 text-ember-strong" />
          {t("about.update.available", { v: latest })}
        </span>
      ) : !data?.enabled ? (
        <span>{t("about.update.off")}</span>
      ) : data.latest === null ? (
        <span>{t("about.update.unknown")}</span>
      ) : (
        <span>{t("about.update.upToDate")}</span>
      )}
      {!local || checking || busy ? null : data?.newer && data.canApply ? (
        <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
          <Download className="size-4" /> {t("about.update.install")}
        </Button>
      ) : data?.enabled ? (
        <IconButton
          label={t("about.update.check")}
          className="size-7 coarse:size-9"
          onClick={() => check.mutate()}
        >
          <RefreshCw className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  );
}
