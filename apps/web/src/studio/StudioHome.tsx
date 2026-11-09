import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUp, Check, ChevronRight, Sparkles, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Mascot } from "../brand";
import type { EngentyKind } from "../engenty/colors";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { type Me, type Space, useCurrentSpace, useIsAdmin, useMe } from "../lib/session";
import { Button, cn, Input, Textarea } from "../ui";
import { useCrumbs } from "./AppFrame";
import { useKnowledge } from "./space/Knowledge";
import { useResults } from "./space/Results";
import { useWaiting } from "./work/chats";
import { greeting, RunCard } from "./work/WorkHome";

/*
 * The studio's Home (docs/plans/org-spaces.md, the Studio Home design): what waits, what finished
 * and which wizards run. While a new organization is not set up, a card on it offers the setup, a
 * wizard with one question per page, which starts only when the admin asks for it. Behind
 * `orgSpaces`, at `/`; the wizards list is at `/wizards`.
 */

type PageId = "info" | "knowledge" | "wizard" | "team";

const PAGES: PageId[] = ["info", "knowledge", "wizard", "team"];

/** The engenty beside each page. */
const FIGURE: Record<PageId, EngentyKind> = {
  info: "round",
  knowledge: "dome",
  wizard: "drop",
  team: "bean",
};

interface Organization {
  members: { userId: string }[];
  invitations: { id: string }[];
}

/** The pages the person put off, kept in this browser per organization. */
function useSkipped(me: Me | null | undefined) {
  const key = me ? `wizards.home.skipped:${me.tenant.id}:${me.user.id}` : "";
  const read = (): PageId[] => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]") as PageId[];
    } catch {
      return [];
    }
  };
  const [skipped, setSkipped] = useState<PageId[]>(read);
  const write = (next: PageId[]) => {
    setSkipped(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // kept for this visit only
    }
  };
  return [skipped, write] as const;
}

/** Which of the first steps are done, from what the studio holds. Null: not known yet. */
function useDone(me: Me | null | undefined, space: Space | null, spaces: Space[]) {
  const knowledge = useKnowledge(space?.id);
  const managed = me?.mode === "managed";
  const organization = useQuery({
    queryKey: ["organization", me?.tenant.id],
    queryFn: () => api.get<Organization>("/api/studio/organization"),
    enabled: managed,
  });
  if (!me || !space || knowledge.isPending || (managed && organization.isPending)) {
    return null;
  }
  const people =
    (organization.data?.members.length ?? 1) + (organization.data?.invitations.length ?? 0);
  return {
    info: Boolean(space.brand.name?.trim()) || space.brandFrom === "root",
    knowledge: (knowledge.data?.items.length ?? 0) > 0,
    wizard: spaces.reduce((n, s) => n + s.wizardCount, 0) > 0,
    team: managed ? people > 1 : Boolean(me.account?.signedIn),
  } satisfies Record<PageId, boolean>;
}

export function StudioHome() {
  const me = useMe().data;
  const admin = useIsAdmin();
  const { space, spaces } = useCurrentSpace();
  const done = useDone(me, space, spaces);
  const [skipped, setSkipped] = useSkipped(me);
  const [at, setAt] = useState<PageId | null>(null);
  useCrumbs([{ label: t("start.title") }]);
  if (!me || !space || !done) {
    return <div className="min-h-[60vh]" />;
  }
  // Only an admin sets the organization up; everyone else sees the dashboard alone.
  const open = admin ? PAGES.filter((p) => !done[p]) : [];
  const ahead = open.filter((p) => !skipped.includes(p));
  const current = at && open.includes(at) ? at : null;
  if (current) {
    const next = () => {
      const after = ahead.filter((p) => PAGES.indexOf(p) > PAGES.indexOf(current));
      setAt(after[0] ?? null);
    };
    return (
      <SetupPage
        me={me}
        space={space}
        page={current}
        done={done}
        onLater={() => {
          setSkipped([...new Set([...skipped, current])]);
          next();
        }}
        onClose={() => setAt(null)}
        onBack={
          PAGES.indexOf(current) > 0 && open.some((p) => PAGES.indexOf(p) < PAGES.indexOf(current))
            ? () =>
                setAt(open.filter((p) => PAGES.indexOf(p) < PAGES.indexOf(current)).at(-1) ?? null)
            : undefined
        }
      />
    );
  }
  return (
    <Dashboard
      me={me}
      space={space}
      setup={
        ahead.length
          ? {
              open,
              done,
              onStart: setAt,
              onLater: () => setSkipped([...new Set([...skipped, ...open])]),
            }
          : null
      }
      left={ahead.length ? [] : open}
      onResume={(page) => {
        setSkipped(skipped.filter((p) => p !== page));
        setAt(page);
      }}
    />
  );
}

/** The dots of the setup: done green, the current one long, the rest waiting. */
function Dots({ page, done }: { page: PageId; done: Record<PageId, boolean> }) {
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {PAGES.map((p) => (
        <span
          key={p}
          className={cn(
            "block h-1.5 rounded-full",
            p === page ? "w-5 bg-ember-strong" : done[p] ? "w-1.5 bg-moss" : "w-1.5 bg-paper-3",
          )}
        />
      ))}
    </span>
  );
}

const QUESTION: Record<PageId, { q: Key; hint: Key }> = {
  info: { q: "start.info.q", hint: "start.info.hint" },
  knowledge: { q: "start.knowledge.q", hint: "start.knowledge.hint" },
  wizard: { q: "start.wizard.q", hint: "start.wizard.hint" },
  team: { q: "start.team.q", hint: "start.team.hint" },
};

/** A page's question; on a local install the last one asks to connect instead. */
function question(me: Me, page: PageId): string {
  return page === "team" && me.mode === "local"
    ? t("start.connect.q")
    : t(QUESTION[page].q, { organization: me.tenant.name ?? "" });
}

/** One page of the setup: one question, the engenty beside it, one button. */
function SetupPage({
  me,
  space,
  page,
  done,
  onLater,
  onBack,
  onClose,
}: {
  me: Me;
  space: Space;
  page: PageId;
  done: Record<PageId, boolean>;
  onLater: () => void;
  onBack?: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const local = me.mode === "local";
  const read = useMutation({
    mutationFn: (url: string) => api.post(`/api/studio/spaces/${space.id}/website`, { url, lang }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.spaces() }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (page === "info" && text) {
      read.mutate(text);
    } else if (page === "wizard" && text) {
      navigate(`/new?wish=${encodeURIComponent(text)}`);
    }
  };
  const q = question(me, page);
  const hint = page === "team" && local ? t("start.connect.hint") : t(QUESTION[page].hint);
  const later = (
    <button type="button" onClick={onLater} className="text-[0.875rem] text-ink-3 hover:text-ink">
      {t("start.later")}
    </button>
  );
  return (
    <div className="relative grid min-h-[min(36rem,70vh)] animate-rise place-items-center">
      <button
        type="button"
        onClick={onClose}
        aria-label={t("start.close")}
        title={t("start.close")}
        className="absolute top-0 right-0 grid size-9 place-items-center rounded-full text-ink-3 hover:bg-ink/5 hover:text-ink"
      >
        <X className="size-4" />
      </button>
      <div className="grid w-full max-w-3xl items-center gap-10 md:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="grid place-items-center max-md:hidden">
          <Mascot kind={FIGURE[page]} size={168} fluffy />
        </div>
        <form onSubmit={submit} className="grid max-w-md gap-4">
          <Dots page={page} done={done} />
          <h1 className="text-balance font-display font-semibold text-[1.875rem] leading-tight tracking-tight">
            {q}
          </h1>
          <p className="text-[0.9375rem] text-ink-2 leading-relaxed">{hint}</p>
          {page === "info" ? (
            <Input
              id="start-website"
              autoFocus
              value={value}
              maxLength={400}
              placeholder={t("start.info.placeholder")}
              aria-label={t("start.info.placeholder")}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : page === "wizard" ? (
            <Textarea
              id="start-wizard"
              autoFocus
              minRows={3}
              value={value}
              maxLength={2000}
              placeholder={t("start.wizard.placeholder")}
              aria-label={t("start.wizard.placeholder")}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : null}
          {read.error ? (
            <p className="text-[0.8125rem] text-rose">{(read.error as Error).message}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            {page === "info" ? (
              <>
                <Button type="submit" busy={read.isPending} disabled={!value.trim()}>
                  {t("start.next")}
                </Button>
                <Link to="/space/info" className="text-[0.875rem] text-ink-3 hover:text-ink">
                  {t("start.info.self")}
                </Link>
              </>
            ) : page === "knowledge" ? (
              <Button onClick={() => navigate("/space/knowledge")}>
                {t("start.knowledge.go")}
              </Button>
            ) : page === "wizard" ? (
              <Button type="submit" disabled={!value.trim()}>
                {t("start.wizard.go")}
              </Button>
            ) : local ? (
              <Button onClick={() => navigate("/settings/account")}>{t("start.connect.go")}</Button>
            ) : (
              <Button onClick={() => navigate("/settings/organization")}>
                {t("start.team.go")}
              </Button>
            )}
            {later}
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-[0.875rem] text-ink-3 hover:text-ink"
              >
                <ArrowLeft className="size-3.5" />
                {t("start.back")}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

const DAY = 86_400_000;

/** Runs per day over the last week, oldest first. */
function perDay(stamps: string[]): number[] {
  const today = new Date().setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, () => 0);
  for (const s of stamps) {
    const back = Math.floor((today - new Date(s).setHours(0, 0, 0, 0)) / DAY);
    if (back >= 0 && back < 7) {
      days[6 - back]++;
    }
  }
  return days;
}

/** A week of runs as a line with its last day marked. */
function Spark({ days }: { days: number[] }) {
  const w = 64;
  const h = 20;
  const top = Math.max(1, ...days);
  const x = (i: number) => (i / (days.length - 1)) * w;
  const y = (v: number) => h - 2 - (v / top) * (h - 4);
  const points = days.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-5 w-16 shrink-0 text-moss" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(days.length - 1)} cy={y(days.at(-1) ?? 0)} r={2.2} fill="currentColor" />
    </svg>
  );
}

/** Home once the setup is through: a new wizard, what waits, what finished, what runs. */
interface Setup {
  open: PageId[];
  done: Record<PageId, boolean>;
  onStart: (page: PageId) => void;
  onLater: () => void;
}

/**
 * What a new organization's Home shows first: the setup's questions with what is done, and a
 * button that starts it. Later hides the card; the questions left stay a line on the dashboard.
 */
function SetupCard({ me, setup }: { me: Me; setup: Setup }) {
  const first = setup.open[0];
  return (
    <section className="grid items-center gap-8 rounded-3xl bg-card p-6 shadow-soft ring-1 ring-border-soft md:grid-cols-[11rem_minmax(0,1fr)] md:p-10">
      <div className="grid place-items-center max-md:hidden">
        <Mascot kind="round" size={156} fluffy />
      </div>
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <h2 className="text-balance font-display font-semibold text-[1.5rem] leading-tight tracking-tight">
            {t("start.setup.title", { n: setup.open.length })}
          </h2>
          <p className="text-[0.9375rem] text-ink-2 leading-relaxed">{t("start.setup.hint")}</p>
        </div>
        <ol className="grid">
          {PAGES.map((p, i) => (
            <li key={p}>
              <button
                type="button"
                disabled={setup.done[p]}
                onClick={() => setup.onStart(p)}
                className="-mx-2 flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-[0.9375rem] enabled:hover:bg-ink/5"
              >
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full font-medium text-[0.75rem] tabular-nums",
                    setup.done[p]
                      ? "bg-moss text-white"
                      : "bg-paper-2 text-ink-3 ring-1 ring-border-soft",
                  )}
                >
                  {setup.done[p] ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1",
                    setup.done[p] ? "text-ink-3 line-through decoration-ink-4" : "text-ink",
                  )}
                >
                  {question(me, p)}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-5">
          {first ? (
            <Button onClick={() => setup.onStart(first)}>{t("start.setup.go")}</Button>
          ) : null}
          <button
            type="button"
            onClick={setup.onLater}
            className="text-[0.875rem] text-ink-3 hover:text-ink"
          >
            {t("start.later")}
          </button>
        </div>
      </div>
    </section>
  );
}

function Dashboard({
  me,
  space,
  setup,
  left,
  onResume,
}: {
  me: Me;
  space: Space;
  setup: Setup | null;
  left: PageId[];
  onResume: (page: PageId) => void;
}) {
  const navigate = useNavigate();
  const [wish, setWish] = useState("");
  const waiting = useWaiting().data;
  const week = useResults(space.id, null, { q: "", mode: "live", days: 7 }).data;
  const needs = waiting?.runs?.needs ?? [];
  const titles = new Map((week?.wizards ?? []).map((w) => [w.id, w.title]));
  const runs = week?.runs ?? [];
  const byWizard = [...new Set(runs.map((r) => r.wizardId))]
    .map((id) => ({
      id,
      title: titles.get(id) ?? "",
      stamps: runs.filter((r) => r.wizardId === id).map((r) => r.doneAt),
    }))
    .sort((a, b) => b.stamps.length - a.stamps.length)
    .slice(0, 4);
  const name = me.user.name.split(" ")[0] || me.user.name;
  const start = (e: FormEvent) => {
    e.preventDefault();
    if (wish.trim()) {
      navigate(`/new?wish=${encodeURIComponent(wish.trim())}`);
    }
  };
  return (
    <div className="mx-auto grid w-full max-w-4xl animate-rise gap-7">
      <div className="flex items-center gap-4">
        <Mascot kind="drop" size={56} />
        <div className="grid gap-0.5">
          <h1 className="font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
            {greeting(name)}
          </h1>
          <p className="text-[0.875rem] text-ink-3">{t("start.week", { n: runs.length })}</p>
        </div>
      </div>
      {setup ? <SetupCard me={me} setup={setup} /> : null}
      <form
        onSubmit={start}
        className="flex items-end gap-2 rounded-2xl bg-card p-3 pl-4 shadow-soft ring-1 ring-border-soft"
      >
        <Textarea
          id="start-wish"
          minRows={1}
          value={wish}
          maxLength={2000}
          placeholder={t("start.wish")}
          aria-label={t("start.wish")}
          onChange={(e) => setWish(e.target.value)}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent p-1 shadow-none ring-0 focus-visible:ring-0"
        />
        <button
          type="submit"
          aria-label={t("home.new")}
          disabled={!wish.trim()}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-ember-strong text-white transition disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
      {/* A new organization with nothing yet: the card alone, no empty lists below it. */}
      {setup && !needs.length && !runs.length ? null : (
        <div className="grid gap-7 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section className="grid content-start gap-3">
            <h2 className="font-semibold text-[0.875rem] text-ink">
              {t("start.waiting")}
              {needs.length ? (
                <span className="ml-2 font-normal text-ink-3">{needs.length}</span>
              ) : null}
            </h2>
            {needs.length ? (
              needs.slice(0, 3).map((run) => <RunCard key={run.runId} run={run} />)
            ) : (
              <p className="text-[0.875rem] text-ink-3">{t("start.nothingWaits")}</p>
            )}
            <h2 className="mt-4 flex items-baseline font-semibold text-[0.875rem] text-ink">
              {t("start.finished")}
              <Link
                to="/space/results"
                className="ml-auto font-normal text-[0.8125rem] text-ink-3 hover:text-ink"
              >
                {t("start.allResults")}
              </Link>
            </h2>
            {runs.length ? (
              <ul className="grid">
                {runs.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <Link
                      to="/space/results"
                      className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink/5"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-moss-tint text-moss">
                        <Sparkles className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[0.875rem] text-ink">
                        {titles.get(r.wizardId) ?? ""}
                      </span>
                      <span className="shrink-0 text-[0.75rem] text-ink-3 tabular-nums">
                        {new Date(r.doneAt).toLocaleDateString(lang, {
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.875rem] text-ink-3">{t("start.noResults")}</p>
            )}
          </section>
          <section className="grid content-start gap-3">
            <h2 className="flex items-baseline font-semibold text-[0.875rem] text-ink">
              {t("start.running")}
              <Link
                to="/wizards"
                className="ml-auto font-normal text-[0.8125rem] text-ink-3 hover:text-ink"
              >
                {t("start.allWizards")}
              </Link>
            </h2>
            {byWizard.length ? (
              <ul className="grid">
                {byWizard.map((w) => (
                  <li key={w.id}>
                    <Link
                      to={`/edit/${w.id}`}
                      className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink/5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[0.875rem] text-ink">
                        {w.title}
                      </span>
                      <Spark days={perDay(w.stamps)} />
                      <span className="w-7 shrink-0 text-right text-[0.8125rem] text-ink-3 tabular-nums">
                        {w.stamps.length}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.875rem] text-ink-3">{t("start.noRuns")}</p>
            )}
            {left.length ? (
              <button
                type="button"
                onClick={() => onResume(left[0])}
                className="mt-3 flex items-center gap-3 rounded-xl bg-card px-3.5 py-2.5 text-left text-[0.875rem] ring-1 ring-border-soft transition hover:ring-border"
              >
                <span className="min-w-0 flex-1">
                  {t("start.left", { n: left.length })}{" "}
                  <span className="font-medium">{question(me, left[0])}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-4" />
              </button>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
