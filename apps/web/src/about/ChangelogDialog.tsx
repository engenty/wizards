import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { cn, Dialog, Empty, Input, Spinner } from "../ui";

interface ChangelogCommit {
  id: string;
  message: string;
  group: string | null;
  scope: string | null;
  breaking: boolean;
}

export interface ChangelogRelease {
  /** Null: not released yet. */
  version: string | null;
  timestamp: number | null;
  commits: ChangelogCommit[];
}

/**
 * The groups of cliff.toml: their name on the page and the colour of their dot. The names stay
 * English in every language, like the entries they stand before.
 */
function groupOf(commit: ChangelogCommit): { label: string; dot: string } {
  switch (commit.group) {
    case "Added":
      return { label: "NEW", dot: "bg-moss" };
    case "Fixed":
      return { label: "FIXED", dot: "bg-amber" };
    case "Changed":
      return { label: "CHANGED", dot: "bg-cobalt" };
    case "Performance":
      return { label: "PERFORMANCE", dot: "bg-ember" };
    case "Deploy":
      return { label: "DEPLOY", dot: "bg-ink-4" };
    case "Docs":
      return { label: "DOCS", dot: "bg-ink-4" };
    default:
      return { label: "OTHER", dot: "bg-ink-4" };
  }
}

export const releaseLabel = (release: ChangelogRelease) =>
  release.version ? release.version.replace(/^v/, "") : t("about.unreleased");

export const releaseDate = (release: ChangelogRelease) =>
  release.timestamp ? new Date(release.timestamp * 1000).toISOString().slice(0, 10) : "";

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The releases a search leaves: a hit on the version or date keeps the release whole. */
function filterReleases(releases: ChangelogRelease[], query: string): ChangelogRelease[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return releases;
  }
  const out: ChangelogRelease[] = [];
  for (const release of releases) {
    if (`${releaseLabel(release)} ${releaseDate(release)}`.toLowerCase().includes(q)) {
      out.push(release);
      continue;
    }
    const commits = release.commits.filter((commit) =>
      `${groupOf(commit).label} ${commit.scope ?? ""} ${commit.message}`.toLowerCase().includes(q),
    );
    if (commits.length > 0) {
      out.push({ ...release, commits });
    }
  }
  return out;
}

/**
 * The changelog as a release newer than this build has it: the file at its tag on GitHub. Offline,
 * the bundled one, which ends at this build.
 */
export async function loadReleases(version?: string): Promise<ChangelogRelease[]> {
  if (version) {
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/engenty/wizards/v${version}/apps/web/src/about/changelog.json`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (response.ok) {
        return (await response.json()) as ChangelogRelease[];
      }
    } catch {
      // offline: the bundled changelog
    }
  }
  return (await import("./changelog.json")).default as ChangelogRelease[];
}

/** A release's entries: a dot in the colour of its group, the group's name, the change. */
export function ReleaseNotes({ release }: { release: ChangelogRelease }) {
  return (
    <ul className="flex flex-col gap-2">
      {release.commits.map((commit) => {
        const group = groupOf(commit);
        return (
          <li key={commit.id} className="flex items-start gap-2.5 text-[0.875rem]">
            <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", group.dot)} />
            <span className="min-w-0 text-ink-2">
              <span className="font-semibold text-[0.75rem] text-ink tracking-wide">
                {group.label}
                {commit.scope ? ` [${commit.scope}]` : ""}
              </span>{" "}
              {upperFirst(commit.message)}
              {commit.breaking ? (
                <span className="ml-1.5 rounded-full bg-rose-tint px-1.5 py-0.5 font-medium text-[0.75rem] text-rose">
                  {t("about.breaking")}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What changed from release to release: apps/web/src/about/changelog.json, written by `pnpm release`.
 * With `version`, the changelog of that release instead of this build's.
 */
export function ChangelogDialog({
  open,
  onClose,
  version,
}: {
  open: boolean;
  onClose: () => void;
  version?: string;
}) {
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null);
  const [query, setQuery] = useState("");

  // The data is its own chunk, fetched when the dialog first opens.
  useEffect(() => {
    if (!open || releases) {
      return;
    }
    let cancelled = false;
    void loadReleases(version).then((next) => {
      if (!cancelled) {
        setReleases(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, releases, version]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const visible = releases ? filterReleases(releases, query) : [];

  return (
    <Dialog open={open} onClose={onClose} title={t("about.changelog")} wide height="tall">
      <p className="-mt-3 mb-4 text-[0.875rem] text-ink-3">{t("about.changelogHint")}</p>
      {releases === null ? (
        <div className="flex justify-center py-10 text-ink-3">
          <Spinner />
        </div>
      ) : releases.length === 0 ? (
        <Empty>{t("about.changelogEmpty")}</Empty>
      ) : (
        <>
          <Input
            type="search"
            value={query}
            placeholder={t("about.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {visible.length === 0 ? <Empty>{t("about.noMatches")}</Empty> : null}
          {visible.map((release) => (
            <section key={release.version ?? "unreleased"} className="mt-6">
              <h3 className="flex items-baseline gap-3 border-border-soft border-b pb-2 font-display font-semibold text-[1rem]">
                {releaseLabel(release)}
                <span className="font-normal font-sans text-[0.8125rem] text-ink-3 tabular-nums">
                  {releaseDate(release)}
                </span>
              </h3>
              <div className="mt-3">
                <ReleaseNotes release={release} />
              </div>
            </section>
          ))}
        </>
      )}
    </Dialog>
  );
}
