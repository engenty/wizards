import type { ItemFormat } from "@engenty/wizards-shared/marketplace";
import {
  PAGE_LIMITS,
  PAGE_SLUG,
  type PageLang,
  type ProjectPage,
  pageSlugOf,
} from "@engenty/wizards-shared/projects";
import type { RunTheme } from "@engenty/wizards-shared/run";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, GripVertical } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Mascot } from "../../brand";
import { api } from "../../lib/api";
import { type Key, lang as studioLang, t } from "../../lib/i18n";
import { type Project, useMe, type WizardSummary } from "../../lib/session";
import { Button, cn, Dialog, Input, Label, Select, Switch, Textarea } from "../../ui";
import { useAutosave } from "./data";
import { langOfVoice, type PageVoice, pageAddress, pageUrl, voiceOf } from "./page-address";
import { PAGE_WORDS } from "./page-words";
import { Anchor, Section } from "./Section";

/**
 * The space's public page at `<team>.wizards.page/<slug>` (the Manage repository's
 * docs/plans/wizards-page-launch.md): off, the way to set it up in two steps; on, its address,
 * its words, its language, the wizards on it in order, and beside them the teaser of the first
 * wizard as the page draws it. The page's words are the space's; a wizard's title and
 * description are changed in the wizard, and the teaser is read from its published version.
 */

/** What the runtime made of the team's page, for the preview (services/pages.ts). */
interface PagePreview {
  host: string | null;
  origin: string | null;
  team: {
    space: {
      slug: string;
      lang: PageLang;
      form?: "du" | "sie";
      brand: { name: string; logoUrl: string | null; theme: RunTheme };
      wizards: {
        title: string;
        description: string;
        avatar: string;
        results: { title: string; kind: ItemFormat; formats: string[] }[];
        effort: { fields: number; reviews: number; minutes: number; uploads: boolean };
        steps: { title: string; by: "you" | "ai" }[];
      }[];
    } | null;
  } | null;
}

type Words = Pick<ProjectPage, "slug" | "title" | "headline" | "intro"> & { voice: PageVoice };

const VOICES: { value: PageVoice; label: Key }[] = [
  { value: "de-du", label: "page.lang.deDu" },
  { value: "de-sie", label: "page.lang.deSie" },
  { value: "en", label: "page.lang.en" },
];

const hint = "text-[0.8125rem] text-ink-3 leading-snug";
const mono = "font-mono text-[0.875rem]";

function useCopied() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  return { copied, copy };
}

/** A sentence with links in it: `{brand}` and `{facts}` stand for their links. */
function Sources() {
  const parts = t("page.sources").split(/(\{brand\}|\{facts\})/);
  return (
    <p className={hint}>
      {parts.map((part, i) =>
        part === "{brand}" ? (
          <Link key={i} to="/space/info" className="text-ink underline-offset-2 hover:underline">
            {t("space.info")}
          </Link>
        ) : part === "{facts}" ? (
          <Link
            key={i}
            to="/space/info#facts"
            className="text-ink underline-offset-2 hover:underline"
          >
            {t("project.facts")}
          </Link>
        ) : (
          part
        ),
      )}{" "}
      {t("page.onlyShared")}
    </p>
  );
}

/** The address field: the team's host as a fixed prefix, the space's slug typed after it. */
function SlugField({
  host,
  value,
  onChange,
  disabled,
}: {
  host: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const ok = PAGE_SLUG.test(value);
  return (
    <div>
      <div className="flex h-11 items-stretch overflow-hidden rounded-lg border border-input bg-card focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow">
        <span className="flex max-w-[55%] items-center truncate bg-paper-2 px-3 font-mono text-[0.75rem] text-ink-3">
          {host}/
        </span>
        <input
          value={value}
          disabled={disabled}
          aria-label={t("page.address")}
          maxLength={PAGE_LIMITS.slug}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
          className={cn("min-w-0 flex-1 bg-transparent px-3 outline-none", mono)}
        />
      </div>
      <p className={cn("mt-1.5", hint, !ok && value && "text-rose")}>{t("page.addressRules")}</p>
    </div>
  );
}

/** The fields of the page's words, in the setup and in the settings alike. */
function WordFields({
  host,
  words,
  onChange,
  disabled,
  setup,
}: {
  host: string;
  words: Words;
  onChange: (patch: Partial<Words>) => void;
  disabled?: boolean;
  /** The first step of the setup: the fields explain themselves a little more. */
  setup?: boolean;
}) {
  // Two columns in the settings; the setup's dialog is narrow and takes one.
  const wide = setup ? "" : "sm:col-span-2";
  return (
    <div className={cn("grid gap-5", !setup && "sm:grid-cols-[repeat(2,minmax(0,1fr))]")}>
      <div>
        <Label>{t("page.title")}</Label>
        <Input
          value={words.title}
          disabled={disabled}
          maxLength={PAGE_LIMITS.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <p className={cn("mt-1.5", hint)}>{t("page.titleHint")}</p>
      </div>
      <div>
        <Label>{t("page.address")}</Label>
        <SlugField
          host={host}
          value={words.slug}
          disabled={disabled}
          onChange={(slug) => onChange({ slug })}
        />
        {setup ? null : <p className={cn("mt-1", hint)}>{t("page.addressChange")}</p>}
      </div>
      <div className={wide}>
        <Label>{t("page.headline")}</Label>
        <Input
          value={words.headline ?? ""}
          disabled={disabled}
          maxLength={PAGE_LIMITS.headline}
          onChange={(e) => onChange({ headline: e.target.value })}
        />
      </div>
      <div className={wide}>
        <Label>{t("page.words")}</Label>
        <Textarea
          value={words.intro ?? ""}
          disabled={disabled}
          minRows={3}
          maxLength={PAGE_LIMITS.intro}
          onChange={(e) => onChange({ intro: e.target.value })}
        />
      </div>
      <div>
        <Label>{t("page.lang")}</Label>
        <Select
          value={words.voice}
          onChange={(v) => onChange({ voice: v as PageVoice })}
          options={VOICES.map((v) => ({ value: v.value, label: t(v.label) }))}
        />
        <p className={cn("mt-1.5", hint)}>{t("page.langHint")}</p>
      </div>
    </div>
  );
}

/** What a row says under a wizard's title: its state when it cannot show, else its description. */
function wizardNote(w: WizardSummary, first: boolean): string {
  if (!w.published) {
    return t("page.draftNote");
  }
  if (!w.shareEnabled) {
    return t("page.notSharedNote");
  }
  const text = w.description.trim();
  return first ? [text, t("page.first")].filter(Boolean).join(" · ") : text;
}

function WizardRow({
  wizard,
  first,
  on,
  onToggle,
  drag,
  children,
}: {
  wizard: WizardSummary;
  first: boolean;
  on: boolean;
  onToggle: (on: boolean) => void;
  /** The handle and the drag events of a listed row. */
  drag?: {
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
  children?: ReactNode;
}) {
  return (
    <li
      draggable={drag ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={cn(
        "flex items-center gap-3 border-border-soft border-t py-2.5 first:border-t-0",
        !wizard.published && "opacity-60",
      )}
    >
      {drag ? (
        <button
          type="button"
          aria-label={`${t("page.moveUp")} / ${t("page.moveDown")}`}
          onKeyDown={drag.onKeyDown}
          className="grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-ink-4 hover:text-ink focus:text-ink"
        >
          <GripVertical className="size-4" />
        </button>
      ) : (
        <span className="size-7 shrink-0" />
      )}
      <Mascot kind={wizard.avatar} costume={wizard.costume} size={36} interactive={false} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[0.9375rem]">{wizard.title}</div>
        <p className={cn("truncate", hint)}>{wizardNote(wizard, first)}</p>
      </div>
      {children}
      <Switch
        checked={on}
        disabled={!wizard.published}
        label={t("page.showOnPage")}
        onChange={onToggle}
      />
    </li>
  );
}

/** The teaser of the first listed wizard, in the page's colours and words. */
function Teaser({ preview }: { preview: PagePreview }) {
  const space = preview.team?.space;
  const w = space?.wizards[0];
  if (!(space && w)) {
    return <p className={hint}>{t("page.previewNone")}</p>;
  }
  const words = PAGE_WORDS[voiceOf(space)];
  const theme = space.brand.theme;
  const ink = theme.dark ? "#f6f2ea" : "#1d1a17";
  const accent = theme.accent ?? "#c4470f";
  const effort = [
    w.effort.uploads ? words.uploads : null,
    w.effort.fields ? words.fields(w.effort.fields) : null,
    w.effort.reviews ? words.reviews(w.effort.reviews) : null,
  ]
    .filter(Boolean)
    .join(", ");
  const label = "text-[0.6875rem] uppercase tracking-[0.12em] opacity-60";
  return (
    <div
      className="flex flex-col gap-3 rounded-xl p-4"
      style={{
        background: theme.background ?? (theme.dark ? "#1b1b1f" : "#f3efe6"),
        color: ink,
        fontFamily: theme.body ? `${theme.body}, system-ui, sans-serif` : undefined,
      }}
    >
      <div className="flex items-center gap-3">
        <Mascot kind={w.avatar} size={40} interactive={false} />
        <h3
          className="font-semibold text-[1.125rem] leading-tight"
          style={{ fontFamily: theme.display ? `${theme.display}, sans-serif` : undefined }}
        >
          {w.title}
        </h3>
      </div>
      {w.description ? (
        <p className="text-[0.8125rem] leading-snug opacity-85">{w.description}</p>
      ) : null}
      <div>
        <div className={label}>{words.youDo}</div>
        <div className="text-[0.8125rem]">
          {[effort, words.minutes(w.effort.minutes)].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div>
        <div className={label}>{words.howItGoes}</div>
        <ul className="mt-1 flex flex-col gap-1 text-[0.8125rem]">
          {w.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <Check className="size-3.5 shrink-0" style={{ color: theme.second ?? accent }} />
              <span className="truncate">{s.title}</span>
            </li>
          ))}
        </ul>
      </div>
      {w.results.length ? (
        <div>
          <div className={label}>{words.youGet}</div>
          <ul className="mt-1 flex flex-col gap-1 text-[0.8125rem]">
            {w.results.map((r) => (
              <li key={r.title} className="flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
                  style={{ background: `${accent}22`, color: ink }}
                >
                  {words.kinds[r.kind]}
                </span>
                <span className="truncate">{r.title}</span>
                <span className="text-[0.6875rem] uppercase opacity-50">{r.formats.join(" ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <span
        className="inline-flex h-8 items-center self-start rounded-full px-3.5 font-semibold text-[0.8125rem]"
        style={{ background: accent, color: "#fff" }}
      >
        {words.start}
      </span>
    </div>
  );
}

/** The team's address, with where it is changed. */
function TeamAddress({ host, manageUrl }: { host: string; manageUrl: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium text-[0.875rem]">{t("page.teamAddress")}</span>
      <span className={mono}>{host}</span>
      <p className={hint}>
        {manageUrl ? (
          <a
            href={`${manageUrl}/team`}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline-offset-2 hover:underline"
          >
            {t("page.teamAddressHint")}
          </a>
        ) : (
          t("page.teamAddressHint")
        )}
      </p>
    </div>
  );
}

/** Setting the page up: its address and words, then the wizards on it; it goes on at the end. */
function Setup({
  project,
  host,
  wizards,
  open,
  onClose,
  onSave,
}: {
  project: Project;
  host: string;
  wizards: WizardSummary[];
  open: boolean;
  onClose: () => void;
  onSave: (page: ProjectPage) => Promise<unknown>;
}) {
  const kept = project.page;
  const name = project.brand.name?.trim() || project.name;
  const [step, setStep] = useState<1 | 2>(1);
  const [words, setWords] = useState<Words>(() => ({
    slug: kept?.slug || pageSlugOf(name),
    title: kept?.title || name,
    headline: kept?.headline ?? "",
    intro: kept?.intro ?? "",
    voice: kept ? voiceOf(kept) : studioLang === "de" ? "de-du" : "en",
  }));
  // The wizards that are on from the start: the kept list, else every one that can show. The
  // list may arrive after the dialog opened; until the person touches it, it follows.
  const suggested = (list: WizardSummary[]) =>
    kept?.wizards.filter((id) => list.some((w) => w.id === id)) ??
    list.filter((w) => w.published && w.shareEnabled).map((w) => w.id);
  const [picked, setPicked] = useState<string[]>(() => suggested(wizards));
  const touched = useRef(false);
  const ids = wizards.map((w) => w.id).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the list until it is touched.
  useEffect(() => {
    if (!touched.current) {
      setPicked(suggested(wizards));
    }
  }, [ids]);
  const pick = (id: string, on: boolean) => {
    touched.current = true;
    setPicked((all) => (on ? [...all, id] : all.filter((x) => x !== id)));
  };
  const save = useMutation({
    mutationFn: () =>
      onSave({
        on: true,
        slug: words.slug,
        title: words.title.trim(),
        headline: words.headline?.trim() || undefined,
        intro: words.intro?.trim() || undefined,
        ...langOfVoice(words.voice),
        wizards: picked,
        examples: kept?.examples ?? {},
      }),
    onSuccess: onClose,
  });
  const ready = PAGE_SLUG.test(words.slug) && words.title.trim().length > 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      height="tall"
      title={t(step === 1 ? "page.step1" : "page.step2")}
    >
      <div className="-mt-2 flex flex-col gap-5">
        <span className={hint}>{t("page.stepOf", { n: step })}</span>
        {step === 1 ? (
          <WordFields
            host={host}
            words={words}
            setup
            onChange={(p) => setWords((w) => ({ ...w, ...p }))}
          />
        ) : (
          <>
            <p className="text-[0.875rem] text-ink-2">{t("page.step2Hint")}</p>
            <ul className="flex flex-col">
              {wizards.map((w) => (
                <WizardRow
                  key={w.id}
                  wizard={w}
                  first={picked[0] === w.id}
                  on={picked.includes(w.id)}
                  onToggle={(on) => pick(w.id, on)}
                />
              ))}
            </ul>
            {wizards.length ? null : <p className={hint}>{t("page.noWizards")}</p>}
          </>
        )}
        {save.error ? (
          <p className="text-[0.875rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={() => (step === 1 ? onClose() : setStep(1))}>
            {t(step === 1 ? "common.cancel" : "common.back")}
          </Button>
          {step === 1 ? (
            <Button disabled={!ready} onClick={() => setStep(2)}>
              {t("page.next")}
            </Button>
          ) : (
            <Button busy={save.isPending} onClick={() => save.mutate()}>
              {t("page.publish")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The page's words, saved as they are typed; the page is saved whole, so the rest rides along. */
function WordsSection({
  host,
  page,
  readOnly,
  save,
}: {
  host: string;
  page: ProjectPage;
  readOnly: boolean;
  save: (page: ProjectPage) => Promise<unknown>;
}) {
  const latest = useRef(page);
  latest.current = page;
  const [words, setWords] = useState<Words>(() => ({
    slug: page.slug,
    title: page.title,
    headline: page.headline ?? "",
    intro: page.intro ?? "",
    voice: voiceOf(page),
  }));
  const state = useAutosave(words, async (w) => {
    if (!(PAGE_SLUG.test(w.slug) && w.title.trim())) {
      return;
    }
    const { lang, form } = langOfVoice(w.voice);
    await save({
      ...latest.current,
      slug: w.slug,
      title: w.title.trim(),
      headline: w.headline?.trim() || undefined,
      intro: w.intro?.trim() || undefined,
      lang,
      form,
    });
  });
  return (
    <Section title={t("page.sectionWords")} save={state} locked={readOnly}>
      <div className="flex flex-col gap-5">
        <WordFields
          host={host}
          words={words}
          disabled={readOnly}
          onChange={(p) => setWords((w) => ({ ...w, ...p }))}
        />
        <div className="rounded-lg bg-paper-2 px-3.5 py-3">
          <Sources />
        </div>
      </div>
    </Section>
  );
}

export function PublicPage({ project }: { project: Project }) {
  const qc = useQueryClient();
  const me = useMe();
  const host = me.data?.tenant.pagesHost ?? null;
  const manageUrl = me.data?.manageUrl ?? null;
  const readOnly = project.readOnly;
  const page = project.page;
  const on = Boolean(page?.on);
  const wizards = useQuery({
    queryKey: ["project-wizards", project.id],
    queryFn: () => api.get<WizardSummary[]>(`/api/studio/projects/${project.id}/wizards`),
  });
  const preview = useQuery({
    queryKey: ["page-preview", project.id],
    queryFn: () => api.get<PagePreview>(`/api/studio/projects/${project.id}/page`),
    enabled: on && Boolean(host),
  });
  // The page is saved whole: every change goes out with the rest as it stands now.
  const latest = useRef(page);
  latest.current = page;
  const save = async (next: ProjectPage) => {
    await api.patch(`/api/studio/projects/${project.id}`, { page: next });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["projects"] }),
      qc.invalidateQueries({ queryKey: ["page-preview", project.id] }),
    ]);
  };
  const change = useMutation({
    mutationFn: (patch: Partial<ProjectPage>) => {
      const current = latest.current;
      if (!current) {
        return Promise.resolve();
      }
      return save({ ...current, ...patch });
    },
  });
  const [settingUp, setSettingUp] = useState(false);
  const { copied, copy } = useCopied();

  // The wizards on the page in their order, then the rest of the space's.
  const all = wizards.data ?? [];
  const listed = (page?.wizards ?? [])
    .map((id) => all.find((w) => w.id === id))
    .filter((w) => w !== undefined);
  const rest = all.filter((w) => !page?.wizards.includes(w.id));
  const [dragging, setDragging] = useState<number | null>(null);
  const reorder = (from: number, to: number) => {
    const ids = [...(page?.wizards ?? [])];
    if (to < 0 || to >= ids.length || from === to) {
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    change.mutate({ wizards: ids });
  };
  const toggle = (id: string, show: boolean) =>
    change.mutate({
      wizards: show
        ? [...(page?.wizards ?? []), id]
        : (page?.wizards ?? []).filter((x) => x !== id),
    });

  if (!host) {
    return (
      <Anchor id="page">
        <Section title={t("space.page")} hint={t("page.intro")}>
          <p className="text-[0.875rem] text-ink-2">{t("page.cloudOnly")}</p>
        </Section>
      </Anchor>
    );
  }

  if (!on) {
    const suggested = page?.slug || pageSlugOf(project.brand.name?.trim() || project.name) || "…";
    return (
      <Anchor id="page">
        <Section title={t("space.page")} hint={t("page.intro")} locked={readOnly}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col items-start gap-3 rounded-xl bg-paper-2 p-5">
              <Mascot kind="round" size={56} interactive={false} />
              <h3 className="font-display font-semibold text-[1.0625rem]">{t("page.noneTitle")}</h3>
              <p className="text-[0.875rem] text-ink-2">
                {t("page.noneText", { address: "\u0000" })
                  .split("\u0000")
                  .flatMap((part, i) =>
                    i === 0
                      ? [part]
                      : [
                          <span key={i} className={cn(mono, "text-ink")}>
                            {pageAddress(host, suggested)}
                          </span>,
                          part,
                        ],
                  )}
              </p>
              {readOnly ? null : (
                <Button onClick={() => setSettingUp(true)}>
                  {t(page ? "page.switchOn" : "page.setUp")}
                </Button>
              )}
            </div>
            <TeamAddress host={host} manageUrl={manageUrl} />
            <div className="flex flex-col gap-1.5 border-border-soft border-t pt-4">
              <span className="font-medium text-[0.875rem]">{t("page.whatShows")}</span>
              <Sources />
            </div>
          </div>
        </Section>
        {settingUp ? (
          <Setup
            project={project}
            host={host}
            wizards={all}
            open={settingUp}
            onClose={() => setSettingUp(false)}
            onSave={save}
          />
        ) : null}
      </Anchor>
    );
  }

  const address = pageAddress(host, page!.slug);
  const url = pageUrl(host, page!.slug, manageUrl);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-start">
      <div className="flex min-w-0 flex-col gap-9">
        <Anchor id="page">
          <Section
            title={t("space.page")}
            hint={t("page.intro")}
            locked={readOnly}
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => copy(url)}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {t(copied ? "share.copied" : "share.copyMain")}
                </Button>
                <Button size="sm" onClick={() => window.open(url, "_blank", "noopener")}>
                  {t("page.open")} <ArrowUpRight className="size-3.5" />
                </Button>
              </div>
            }
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium text-[0.9375rem]">
                  <span className="size-2 shrink-0 rounded-full bg-moss" aria-hidden />
                  {t("page.on")}
                </div>
                <p className={cn("mt-0.5", hint)}>{t("page.onHint")}</p>
                <p className={cn("mt-2 truncate", mono)}>{address}</p>
              </div>
              <Switch
                checked
                label={t("page.on")}
                disabled={readOnly || change.isPending}
                onChange={() => change.mutate({ on: false })}
              />
            </div>
            {change.error ? (
              <p className="mt-3 text-[0.875rem] text-rose">{(change.error as Error).message}</p>
            ) : null}
          </Section>
        </Anchor>
        <Anchor id="page-words">
          <WordsSection host={host} page={page!} readOnly={readOnly} save={save} />
        </Anchor>
        <Anchor id="page-wizards">
          <Section title={t("page.sectionWizards")} hint={t("page.wizardsHint")} locked={readOnly}>
            <ul className="flex flex-col">
              {listed.map((w, i) => (
                <WizardRow
                  key={w.id}
                  wizard={w}
                  first={i === 0}
                  on
                  onToggle={(show) => toggle(w.id, show)}
                  drag={{
                    onDragStart: () => setDragging(i),
                    onDragOver: (e) => e.preventDefault(),
                    onDrop: () => {
                      if (dragging !== null) {
                        reorder(dragging, i);
                      }
                      setDragging(null);
                    },
                    onKeyDown: (e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        reorder(i, e.key === "ArrowUp" ? i - 1 : i + 1);
                      }
                    },
                  }}
                />
              ))}
              {rest.map((w) => (
                <WizardRow
                  key={w.id}
                  wizard={w}
                  first={false}
                  on={false}
                  onToggle={(show) => toggle(w.id, show)}
                />
              ))}
            </ul>
            {all.length ? null : <p className={hint}>{t("page.noWizards")}</p>}
            <p className={cn("mt-4", hint)}>{t("page.wizardsNote")}</p>
          </Section>
        </Anchor>
      </div>
      <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-6">
        <section className="flex flex-col gap-2.5 rounded-xl bg-card p-4 shadow-soft ring-1 ring-border-soft">
          <h3 className="font-medium text-[0.875rem]">{t("page.preview")}</h3>
          {preview.data ? <Teaser preview={preview.data} /> : null}
          {preview.isError ? (
            <p className="text-[0.8125rem] text-rose">{(preview.error as Error).message}</p>
          ) : null}
          <p className={hint}>{t("page.previewHint")}</p>
        </section>
        <section className="rounded-xl bg-card p-4 shadow-soft ring-1 ring-border-soft">
          <TeamAddress host={host} manageUrl={manageUrl} />
        </section>
      </aside>
    </div>
  );
}
