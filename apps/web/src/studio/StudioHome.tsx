import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, Check, ChevronRight, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Mascot } from "../brand";
import type { EngentyKind } from "../engenty/colors";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { type Me, type Space, useCurrentSpace, useIsAdmin, useMe } from "../lib/session";
import { Button, cn, Textarea } from "../ui";
import { useCrumbs } from "./AppFrame";
import { useSpaceConnections } from "./capabilities/ConnectorsSection";
import { useKnowledge } from "./space/Knowledge";
import { useResults } from "./space/Results";
import { useSkills } from "./space/Skills";
import { useWaiting } from "./work/chats";
import { greeting, RunCard } from "./work/WorkHome";

/*
 * The studio's Home (docs/plans/org-spaces.md, the Studio Home design): what waits, what finished
 * and which wizards run. While a new organization is not set up, a card on it walks the admin
 * through the setup: first the organization's name or website, then one step at a time, each
 * leading to the page where it is done. Behind `orgSpaces`, at `/`; the wizards list is at
 * `/wizards`. The first wizard is no step: the field under the card builds it.
 */

type PageId = "info" | "knowledge" | "connections" | "skills" | "team";

const PAGES: PageId[] = ["info", "knowledge", "connections", "skills", "team"];

/** The engenty beside each step; the team is three of them. */
const FIGURE: Record<Exclude<PageId, "team">, EngentyKind> = {
  info: "round",
  knowledge: "dome",
  connections: "bean",
  skills: "drop",
};

const TEAM: EngentyKind[] = ["flame", "oval", "pebble"];

/** Where each step is done; on a local install the last one signs in instead. */
const GO: Record<Exclude<PageId, "info">, string> = {
  knowledge: "/space/knowledge",
  connections: "/capabilities/connectors",
  skills: "/capabilities/skills",
  team: "/settings/organization",
};

interface Organization {
  members: { userId: string }[];
  invitations: { id: string }[];
}

/** The steps there are: Skills only behind its switch. */
function usePages(): PageId[] {
  const skills = useFeature("skills");
  return skills ? PAGES : PAGES.filter((p) => p !== "skills");
}

/** The steps the person put off, kept in this browser per organization. */
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

/** Which steps are done, from what the studio holds. Null: not known yet. */
function useDone(me: Me | null | undefined, space: Space | null) {
  const knowledge = useKnowledge(space?.id);
  const connections = useSpaceConnections(space?.id ?? "");
  const skills = useSkills(space?.id);
  const managed = me?.mode === "managed";
  const organization = useQuery({
    queryKey: ["organization", me?.tenant.id],
    queryFn: () => api.get<Organization>("/api/studio/organization"),
    enabled: managed,
  });
  if (
    !me ||
    !space ||
    knowledge.isPending ||
    connections.isPending ||
    skills.isPending ||
    (managed && organization.isPending)
  ) {
    return null;
  }
  const people =
    (organization.data?.members.length ?? 1) + (organization.data?.invitations.length ?? 0);
  return {
    info: Boolean(space.brand.name?.trim()) || space.brandFrom === "root",
    knowledge: (knowledge.data?.items.length ?? 0) > 0,
    connections: (connections.data?.connections.length ?? 0) > 0,
    skills: (skills.data?.skills.length ?? 0) > 0,
    team: managed ? people > 1 : Boolean(me.account?.signedIn),
  } satisfies Record<PageId, boolean>;
}

export function StudioHome() {
  const me = useMe().data;
  const admin = useIsAdmin();
  const { space, spaces } = useCurrentSpace();
  const pages = usePages();
  const done = useDone(me, space);
  const [skipped, setSkipped] = useSkipped(me);
  const [at, setAt] = useState<PageId | null>(null);
  useCrumbs([{ label: t("start.title") }]);
  if (!me || !space || !done) {
    return <div className="min-h-[60vh]" />;
  }
  // Only an admin sets the organization up; everyone else sees the dashboard alone.
  const open = admin ? pages.filter((p) => !done[p]) : [];
  const ahead = open.filter((p) => !skipped.includes(p));
  const current = at && ahead.includes(at) ? at : (ahead[0] ?? null);
  // A step picked again counts as not put off.
  const pick = (page: PageId) => {
    setSkipped(skipped.filter((p) => p !== page));
    setAt(page);
  };
  return (
    <Dashboard
      me={me}
      space={space}
      setup={
        current
          ? {
              pages,
              done,
              current,
              onPick: pick,
              // Before the first step Later puts the whole setup off, after it only this step.
              onLater: () => {
                setSkipped([...new Set([...skipped, ...(current === "info" ? open : [current])])]);
                setAt(null);
              },
            }
          : null
      }
      left={current ? [] : open}
      first={spaces.every((s) => s.wizardCount === 0)}
      onResume={pick}
    />
  );
}

/** A step's name and line as the list shows them; on a local install the team is the organization. */
function step(me: Me, page: PageId): { title: string; line: string } {
  const id = page === "team" && me.mode === "local" ? "connect" : page;
  return {
    title: t(`start.step.${id}` as Key),
    line: t(`start.step.${id}.line` as Key),
  };
}

interface Setup {
  pages: PageId[];
  done: Record<PageId, boolean>;
  current: PageId;
  onPick: (page: PageId) => void;
  onLater: () => void;
}

/** What a typed name looks like when it is a website: one word with a dot in it. */
function isWebsite(text: string): boolean {
  return /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(text);
}

/**
 * The setup on Home. Before the first step: what the studio is for, and one field for the
 * organization's name or website. After it: what came of it, and the next step with its button.
 * Beside both, the steps with what is done.
 */
function SetupCard({ me, space, setup }: { me: Me; space: Space; setup: Setup }) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] items-center gap-8 rounded-[1.75rem] bg-card p-6 shadow-soft ring-1 ring-border-soft md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:gap-11 md:p-10">
      {setup.current === "info" ? (
        <FirstStep space={space} onLater={setup.onLater} />
      ) : (
        <NextStep me={me} space={space} setup={setup} />
      )}
      <Steps me={me} setup={setup} />
    </section>
  );
}

/** Before anything is set up: the engenty offers its help, the name or website starts it. */
function FirstStep({ space, onLater }: { space: Space; onLater: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const start = useMutation({
    mutationFn: (text: string) =>
      isWebsite(text)
        ? api.post(`/api/studio/spaces/${space.id}/website`, { url: text, lang })
        : api.patch(`/api/studio/spaces/${space.id}`, { brand: { name: text } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.spaces() }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      start.mutate(value.trim());
    }
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Mascot kind="round" size={88} fluffy />
      <h2 className="text-balance font-display font-semibold text-[2rem] leading-[1.08] tracking-tight md:text-[2.5rem]">
        {t("start.setup.title")}
      </h2>
      <p className="text-[1rem] text-ink-2 leading-relaxed">{t("start.setup.hint")}</p>
      <form onSubmit={submit} className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2.5">
        <div className="flex items-center gap-2 rounded-full bg-paper p-1.5 pl-4 ring-[1.5px] ring-ember-strong">
          <input
            id="start-organization"
            value={value}
            maxLength={400}
            placeholder={t("start.setup.placeholder")}
            aria-label={t("start.setup.field")}
            onChange={(e) => setValue(e.target.value)}
            className="h-10 min-w-0 flex-1 bg-transparent text-[1rem] text-ink outline-none placeholder:text-ink-3"
          />
          <Button
            type="submit"
            busy={start.isPending}
            disabled={!value.trim()}
            className="rounded-full"
          >
            {t("start.setup.go")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
        {start.error ? (
          <p className="pl-4 text-[0.8125rem] text-rose">{(start.error as Error).message}</p>
        ) : null}
        <p className="pl-4 text-[0.875rem] text-ink-3">
          {t("start.setup.example")} ·{" "}
          <button type="button" onClick={onLater} className="underline hover:text-ink">
            {t("start.later")}
          </button>
        </p>
      </form>
    </div>
  );
}

/** Up to three letters of a name, for the tile in place of a logo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** After the first step: what came of it, and the step that is next. */
function NextStep({ me, space, setup }: { me: Me; space: Space; setup: Setup }) {
  const navigate = useNavigate();
  const page = setup.current as Exclude<PageId, "info">;
  const local = page === "team" && me.mode === "local";
  const id = local ? "connect" : page;
  const name = space.brand.name?.trim() ?? "";
  const colors = (space.brand.colors ?? []).filter((c) => !c.section).slice(0, 3);
  const count = setup.pages.filter((p) => setup.done[p]).length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex items-center gap-2.5 text-[0.8125rem] text-ink-3">
        <span className="flex gap-1" aria-hidden>
          {setup.pages.map((p) => (
            <span
              key={p}
              className={cn(
                "block h-1.5 w-5 rounded-full",
                setup.done[p] ? "bg-moss" : "bg-paper-3",
              )}
            />
          ))}
        </span>
        {t("start.setup.progress", { done: count, all: setup.pages.length })}
      </div>
      {name ? (
        <div className="flex items-center gap-3.5 rounded-2xl bg-paper p-3 pr-4 ring-1 ring-border-soft">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-xl bg-ink font-display font-semibold text-[0.9375rem] text-paper"
            style={colors[0] ? { background: colors[0].value, color: "#fff" } : undefined}
            aria-hidden
          >
            {initials(name)}
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-[0.9375rem]">{name}</span>
          {colors.length ? (
            <span className="flex gap-1" aria-hidden>
              {colors.map((c) => (
                <span
                  key={c.value}
                  className="block size-[1.125rem] rounded-full ring-1 ring-ink/10"
                  style={{ background: c.value }}
                />
              ))}
            </span>
          ) : null}
          <Link to="/space/info" className="ml-1.5 text-[0.8125rem] text-ink-3 hover:text-ink">
            {t("start.setup.change")}
          </Link>
        </div>
      ) : null}
      <h2 className="mt-1.5 text-balance font-display font-semibold text-[1.875rem] leading-[1.1] tracking-tight md:text-[2.25rem]">
        {t(`start.now.${id}` as Key)}
      </h2>
      <p className="text-[1rem] text-ink-2 leading-relaxed">{t(`start.now.${id}.hint` as Key)}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button onClick={() => navigate(local ? "/settings/account" : GO[page])}>
          {t(`start.now.${id}.go` as Key)}
          <ArrowRight className="size-4" />
        </Button>
        <button
          type="button"
          onClick={setup.onLater}
          className="text-[0.875rem] text-ink-3 hover:text-ink"
        >
          {t("start.later")}
        </button>
      </div>
    </div>
  );
}

/** The steps beside the card: done ticked, the current one raised, the others to pick. */
function Steps({ me, setup }: { me: Me; setup: Setup }) {
  const left = setup.pages.filter((p) => !setup.done[p]).length;
  const all = left === setup.pages.length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <p className="pl-3.5 font-medium text-[0.8125rem] text-ink-3">
        {all ? t("start.setup.steps", { n: left }) : t("start.setup.left", { n: left })}
      </p>
      <ol className="grid gap-0.5">
        {setup.pages.map((p) => {
          const done = setup.done[p];
          const now = p === setup.current;
          const { title, line } = step(me, p);
          return (
            <li key={p}>
              <button
                type="button"
                disabled={done}
                aria-current={now ? "step" : undefined}
                onClick={() => setup.onPick(p)}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-2xl px-3.5 py-2 text-left transition",
                  now ? "bg-paper shadow-soft ring-1 ring-border-soft" : "enabled:hover:bg-ink/5",
                )}
              >
                <span className={cn("relative size-[3.25rem] shrink-0", done && "opacity-50")}>
                  {p === "team" ? (
                    <>
                      <span className="absolute top-3.5 -left-0.5">
                        <Mascot kind={TEAM[0]} size={30} interactive={false} />
                      </span>
                      <span className="absolute top-3.5 -right-0.5">
                        <Mascot kind={TEAM[1]} size={30} interactive={false} />
                      </span>
                      <span className="absolute top-0.5 left-2.5">
                        <Mascot kind={TEAM[2]} size={32} interactive={false} />
                      </span>
                    </>
                  ) : (
                    <Mascot kind={FIGURE[p]} size={52} interactive={false} />
                  )}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className={cn("font-semibold text-[1rem]", done && "text-ink-3")}>
                    {title}
                  </span>
                  <span className={cn("text-[0.875rem]", done ? "text-ink-3" : "text-ink-2")}>
                    {line}
                  </span>
                </span>
                <span
                  className={cn(
                    "grid size-[1.375rem] shrink-0 place-items-center rounded-md",
                    done
                      ? "bg-moss text-white"
                      : now
                        ? "ring-[1.5px] ring-ember-strong"
                        : "ring-[1.5px] ring-border",
                  )}
                  aria-hidden
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
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

/** Home: a new wizard, what waits, what finished, what runs; the setup above while it is open. */
function Dashboard({
  me,
  space,
  setup,
  left,
  first,
  onResume,
}: {
  me: Me;
  space: Space;
  setup: Setup | null;
  left: PageId[];
  /** No wizard yet: the field says it builds the first. */
  first: boolean;
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
    <div className="mx-auto grid w-full max-w-4xl animate-rise grid-cols-[minmax(0,1fr)] gap-7">
      <div className="flex items-center gap-4">
        {setup ? null : <Mascot kind="drop" size={56} />}
        <div className="grid gap-0.5">
          <h1 className="font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
            {greeting(name)}
          </h1>
          <p className="text-[0.875rem] text-ink-3">{t("start.week", { n: runs.length })}</p>
        </div>
      </div>
      {setup ? <SetupCard me={me} space={space} setup={setup} /> : null}
      <form onSubmit={start} className="grid gap-2.5">
        {first ? (
          <label htmlFor="start-wish" className="font-medium text-[0.9375rem]">
            {t("start.firstWizard")}
          </label>
        ) : null}
        <div className="flex items-end gap-2 rounded-2xl bg-card p-3 pl-4 shadow-soft ring-1 ring-border-soft">
          <Textarea
            id="start-wish"
            minRows={1}
            value={wish}
            maxLength={2000}
            placeholder={t(first ? "start.firstWish" : "start.wish")}
            aria-label={first ? undefined : t("start.wish")}
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
        </div>
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
                  <span className="font-medium">{step(me, left[0]).title}</span>
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
