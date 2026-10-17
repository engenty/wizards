import { Clock, Cloud, CloudOff, Laptop } from "lucide-react";
import { publicAddress } from "@/lib/base";
import { lang, t } from "../lib/i18n";
import type { CloudState, Me, WizardSummary } from "../lib/session";
import { Chip } from "../ui";

/** The host of an address, as one says it ("engenty.ai"); the address itself where it is none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Where a published wizard runs, and so which link others can open:
 * - `draft`: not published, nothing runs.
 * - `here`: a local install without an account; its link answers only on this computer.
 * - `live`: runs for everyone at `url` — this server's own link, or the copy in the cloud.
 * - `sending`: the version did not arrive in the cloud yet; the install tries again at `again`.
 * - `missing`: the cloud does not run this version, and only the person can change that; `why`.
 * - `unknown`: what the cloud holds is still being asked.
 * `url` and `runs` (the version that runs there) are the cloud's where an older version runs.
 */
export type WhereItRuns =
  | { kind: "draft" }
  | { kind: "here" }
  | { kind: "unknown" }
  | { kind: "live"; url: string; runs: number; notes: number; cloud: boolean }
  | { kind: "sending"; url: string | null; runs: number | null; again: string }
  | { kind: "missing"; url: string | null; runs: number | null; why: string };

type Wizard = Pick<WizardSummary, "published" | "publishedVersion" | "shareToken">;

/** The address of a wizard on this runtime: on its doors, which may be another origin. */
export const ownLink = (w: Pick<WizardSummary, "shareToken">) =>
  `${publicAddress()}/w/${w.shareToken}`;

/**
 * `cloud`: what the install knows of the linked account's cloud — undefined while it is asked,
 * null where no account is linked.
 */
export function whereItRuns(w: Wizard, me: Me, cloud: CloudState | null | undefined): WhereItRuns {
  if (!w.published) {
    return { kind: "draft" };
  }
  if (me.mode === "managed") {
    return { kind: "live", url: ownLink(w), runs: w.publishedVersion ?? 0, notes: 0, cloud: false };
  }
  if (!me.account || cloud === null) {
    return { kind: "here" };
  }
  if (cloud === undefined) {
    return { kind: "unknown" };
  }
  const { copy, error } = cloud;
  const runs = copy?.publishedVersion ?? null;
  const url = copy && runs !== null ? copy.shareUrl : null;
  if (error?.again) {
    return { kind: "sending", url, runs, again: error.again };
  }
  if (error) {
    return { kind: "missing", url, runs, why: error.message };
  }
  if (!copy || copy.version < (w.publishedVersion ?? 0)) {
    return { kind: "missing", url, runs, why: t("cloud.notSent") };
  }
  if (!copy.runnable || !url || runs === null) {
    const why = `${t("cloud.notRunnable", { v: copy.version })} ${
      runs === null ? t("cloud.nothingRuns") : t("cloud.keepsRunning", { v: runs })
    }`;
    return { kind: "missing", url, runs, why };
  }
  return {
    kind: "live",
    url,
    runs,
    notes: copy.problems.filter((p) => !p.blocking).length,
    cloud: true,
  };
}

/** The link others can open, where there is one. */
export function sharedLink(where: WhereItRuns): string | null {
  return where.kind === "live" || where.kind === "sending" || where.kind === "missing"
    ? where.url
    : null;
}

/**
 * The chip that says where a wizard runs: on cards, and in the editor's top bar with `version`,
 * the version published here. A draft shows nothing; the places that show this chip say "draft"
 * their own way.
 */
export function WhereChip({
  where,
  me,
  version,
}: {
  where: WhereItRuns;
  me: Me;
  version?: number | null;
}) {
  const host = hostOf(me.account?.cloudUrl ?? "");
  const icon = "size-3.5";
  switch (where.kind) {
    case "draft":
      return null;
    case "unknown":
      return <Chip tone="live">{t("home.live")}</Chip>;
    case "here":
      return (
        <Chip icon={<Laptop className={icon} />} title={t("where.hereHint")}>
          {version ? t("where.hereVersion", { v: version }) : t("where.here")}
        </Chip>
      );
    case "live": {
      const label = version ? t("editor.published", { v: where.runs }) : t("home.live");
      const notes =
        where.notes === 1
          ? t("where.note")
          : where.notes > 1
            ? t("where.notes", { n: where.notes })
            : null;
      return (
        <Chip
          tone="live"
          icon={where.cloud ? <Cloud className={icon} /> : undefined}
          title={where.cloud ? t("where.liveHint", { host }) : undefined}
        >
          {notes ? `${label} · ${notes}` : label}
        </Chip>
      );
    }
    case "sending":
      return (
        <Chip
          tone="warn"
          icon={<Clock className={icon} />}
          title={t("cloud.again", {
            when: new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(
              new Date(where.again),
            ),
          })}
        >
          {t("where.sending")}
        </Chip>
      );
    case "missing":
      return (
        <Chip tone="warn" icon={<CloudOff className={icon} />} title={where.why}>
          {where.runs === null ? t("where.missing") : t("editor.published", { v: where.runs })}
        </Chip>
      );
  }
}
