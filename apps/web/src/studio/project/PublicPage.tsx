import {
  PAGE_LIMITS,
  PAGE_SLUG,
  type ProjectPage,
  pageSlugOf,
} from "@engenty/wizards-shared/projects";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, GripVertical, Monitor, Smartphone, Tablet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Mascot } from "../../brand";
import { api } from "../../lib/api";
import { type Key, lang as studioLang, t } from "../../lib/i18n";
import { type Project, useMe, type WizardSummary } from "../../lib/session";
import { Button, Card, cn, Input, Label, Select, Switch, Textarea } from "../../ui";
import { Pills } from "../editor/PreviewPane";
import { useAutosave } from "./data";
import { langOfVoice, type PageVoice, pageAddress, pageUrl, voiceOf } from "./page-address";
import { Anchor, Section } from "./Section";

/**
 * The space's public page at `<team>.wizards.page/<slug>` (the Manage repository's
 * docs/plans/wizards-page-launch.md), as one screen: its address with the way to copy and open
 * it, who can open it (off, public, later members), how it looks (name, address, headline, a
 * few words, language, the wizards on it in order), and beside the fields the page itself,
 * small, as Manage serves it right now. The page's words are the space's; a wizard's title and
 * description are changed in the wizard, and whether a wizard stands on the page in its share
 * dialog.
 */

type Words = Pick<ProjectPage, "slug" | "title" | "headline" | "intro"> & { voice: PageVoice };

const VOICES: { value: PageVoice; label: Key }[] = [
  { value: "de-du", label: "page.lang.deDu" },
  { value: "de-sie", label: "page.lang.deSie" },
  { value: "en", label: "page.lang.en" },
];

const hint = "text-[0.8125rem] text-ink-3 leading-snug";
const mono = "font-mono text-[0.875rem]";

/** `…wizards.page/`: the team's host without its first label, as the address field's prefix. */
const domainOf = (host: string) => host.slice(host.indexOf(".") + 1);

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

/** The address field: the team's domain as a grey prefix, the space's slug typed after it. */
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
        <span
          title={`${host}/`}
          className="flex max-w-[55%] items-center truncate bg-paper-2 px-3 font-mono text-[0.75rem] text-ink-3"
        >
          …{domainOf(host)}/
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

/** The fields of the page's words: name and address side by side, then the rest one below the other. */
function WordFields({
  host,
  words,
  onChange,
  disabled,
}: {
  host: string;
  words: Words;
  onChange: (patch: Partial<Words>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[repeat(2,minmax(0,1fr))]">
      <div className="min-w-0">
        <Label>{t("page.title")}</Label>
        <Input
          value={words.title}
          disabled={disabled}
          maxLength={PAGE_LIMITS.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <p className={cn("mt-1.5", hint)}>{t("page.titleHint")}</p>
      </div>
      <div className="min-w-0">
        <Label>{t("page.address")}</Label>
        <SlugField
          host={host}
          value={words.slug}
          disabled={disabled}
          onChange={(slug) => onChange({ slug })}
        />
        <p className={cn("mt-1", hint)}>{t("page.addressChange")}</p>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <Label>{t("page.headline")}</Label>
        <Input
          value={words.headline ?? ""}
          disabled={disabled}
          maxLength={PAGE_LIMITS.headline}
          onChange={(e) => onChange({ headline: e.target.value })}
        />
      </div>
      <div className="min-w-0 sm:col-span-2">
        <Label>{t("page.words")}</Label>
        <Textarea
          value={words.intro ?? ""}
          disabled={disabled}
          minRows={3}
          maxLength={PAGE_LIMITS.intro}
          onChange={(e) => onChange({ intro: e.target.value })}
        />
      </div>
      <div className="min-w-0">
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
  disabled,
  onToggle,
  drag,
}: {
  wizard: WizardSummary;
  first: boolean;
  on: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
  /** The handle and the drag events of a listed row. */
  drag?: {
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
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
      <Switch
        checked={on}
        disabled={disabled || !wizard.published}
        label={t("page.showOnPage")}
        onChange={onToggle}
      />
    </li>
  );
}

/** One of the three ways the page can be opened, as a card; the picked one wears the accent. */
function WhoCard({
  title,
  text,
  picked,
  disabled,
  later,
  onPick,
}: {
  title: string;
  text: string;
  picked: boolean;
  disabled?: boolean;
  /** Not there yet: dashed, never pickable. */
  later?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      disabled={disabled || later}
      onClick={onPick}
      className={cn(
        "flex min-h-20 flex-col items-start gap-1 rounded-xl px-4 py-3 text-left transition",
        picked
          ? "bg-accent ring-2 ring-primary"
          : later
            ? "border border-border border-dashed opacity-60"
            : "ring-1 ring-border-soft hover:bg-paper-2",
        (disabled || later) && "cursor-not-allowed",
      )}
    >
      <span className="font-medium text-[0.9375rem]">{title}</span>
      <span className={hint}>{text}</span>
    </button>
  );
}

/** The widths the preview lays the page out at, as the devices people open it on. */
type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, number> = { desktop: 1280, tablet: 768, mobile: 390 };
const DEVICE_KEY = "wizards.pagePreviewDevice";

/** The device picked last time, kept with the browser. */
function storedDevice(): Device {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v && v in DEVICE_WIDTH ? (v as Device) : "desktop";
  } catch {
    return "desktop";
  }
}

function keepDevice(device: Device) {
  try {
    localStorage.setItem(DEVICE_KEY, device);
  } catch {
    // A private window: the choice lasts the visit.
  }
}

/**
 * The page as Manage serves it right now, laid out at the device's width and scaled down to fit
 * the card, in a frame of a fixed height the page scrolls inside. A phone gets a phone's frame.
 * A new `version` loads it again past Manage's minute of caching, after each change the runtime
 * sent.
 */
function PageFrame({ url, version, device }: { url: string; version: number; device: Device }) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, tall: true });
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const fit = () => setRoom({ width: el.clientWidth, tall: el.clientWidth >= 640 });
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const width = DEVICE_WIDTH[device];
  const height = room.tall ? 640 : 480;
  const phone = device === "mobile";
  // A phone's frame takes some of the room; the page inside stays as wide as a phone.
  const bezel = phone ? 12 : 0;
  const scale = room.width ? Math.min(1, (room.width - 2 * bezel) / width) : 1;
  const frame = (
    <div
      className={cn(
        "relative overflow-hidden bg-paper-2",
        phone ? "rounded-[1.5rem]" : "rounded-lg ring-1 ring-border-soft",
      )}
      style={{ width: Math.round(width * scale), height }}
    >
      {room.width ? (
        <iframe
          key={version}
          title={t("page.previewTitle")}
          src={`${url}${url.includes("?") ? "&" : "?"}v=${version}`}
          tabIndex={-1}
          className="absolute top-0 left-0 border-0"
          style={{
            width,
            height: Math.ceil(height / scale),
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      ) : null}
    </div>
  );
  return (
    <div ref={box} className="flex w-full justify-center">
      {phone ? <div className="rounded-[2.25rem] bg-ink p-3 shadow-soft">{frame}</div> : frame}
    </div>
  );
}

/** The page's words, saved as they are typed; the page is saved whole, so the rest rides along. */
function WordsFields({
  host,
  page,
  disabled,
  save,
  onState,
}: {
  host: string;
  page: ProjectPage;
  disabled: boolean;
  save: (page: ProjectPage) => Promise<unknown>;
  onState: (state: ReturnType<typeof useAutosave>) => void;
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
  const { state: saving, error } = state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the section's heading shows the save.
  useEffect(() => onState(state), [saving, error]);
  return (
    <WordFields
      host={host}
      words={words}
      disabled={disabled}
      onChange={(p) => setWords((w) => ({ ...w, ...p }))}
    />
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
  // The page is saved whole: every change goes out with the rest as it stands now. Each save
  // counts, so the preview loads the page again.
  const [version, setVersion] = useState(1);
  const [device, setDevice] = useState<Device>(storedDevice);
  const latest = useRef(page);
  latest.current = page;
  const save = async (next: ProjectPage) => {
    await api.patch(`/api/studio/projects/${project.id}`, { page: next });
    await qc.invalidateQueries({ queryKey: ["projects"] });
    setVersion((v) => v + 1);
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
  const [wordsState, setWordsState] = useState<ReturnType<typeof useAutosave>>({
    state: "idle",
    error: null,
  });
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

  // "Public" on a space without a page yet: the page starts from the brand's name and every
  // wizard that can show, and goes on at once; the fields below take it from there.
  const name = project.brand.name?.trim() || project.name;
  const start = useMutation({
    mutationFn: () =>
      save({
        on: true,
        slug: pageSlugOf(name) || "page",
        title: name,
        ...langOfVoice(studioLang === "de" ? "de-du" : "en"),
        wizards: all.filter((w) => w.published && w.shareEnabled).map((w) => w.id),
        examples: {},
      }),
  });
  const setOn = (next: boolean) => {
    if (page) {
      change.mutate({ on: next });
    } else if (next) {
      start.mutate();
    }
  };
  const busy = change.isPending || start.isPending;
  const failed = (change.error ?? start.error) as Error | null;

  if (!host) {
    return (
      <Anchor id="page">
        <Section title={t("space.page")} hint={t("page.intro")}>
          <p className="text-[0.875rem] text-ink-2">{t("page.cloudOnly")}</p>
        </Section>
      </Anchor>
    );
  }

  const slug = page?.slug || pageSlugOf(name) || "…";
  const address = pageAddress(host, slug);
  const url = pageUrl(host, slug, manageUrl);
  // The team's domain shows in grey, the space's part bold, as the person reads the address.
  const addressLine = (
    <span className={cn(mono, "min-w-0 truncate")}>
      <span className="text-ink-3">{host}/</span>
      <b className="text-ink">{slug}</b>
    </span>
  );
  const fieldsLocked = readOnly || !page;

  const previewCard = (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="@container flex items-center justify-between gap-3">
        <h3 className="font-medium text-[0.875rem]">{t("page.previewTitle")}</h3>
        {on ? (
          <Pills
            named
            label={t("editor.device")}
            value={device}
            onChange={(d) => {
              setDevice(d);
              keepDevice(d);
            }}
            options={[
              {
                id: "desktop",
                label: t("editor.deviceDesk"),
                icon: <Monitor className="size-3.5" />,
              },
              {
                id: "tablet",
                label: t("page.deviceTablet"),
                icon: <Tablet className="size-3.5" />,
              },
              {
                id: "mobile",
                label: t("editor.devicePhone"),
                icon: <Smartphone className="size-3.5" />,
              },
            ]}
          />
        ) : null}
      </div>
      {on ? (
        <PageFrame url={url} version={version} device={device} />
      ) : (
        <p className={hint}>{t("page.previewOff")}</p>
      )}
      {on ? <p className={hint}>{t("page.previewHint")}</p> : null}
    </Card>
  );
  const shareCard = (
    <Card className="flex flex-col gap-3 p-4">
      <h3 className="font-medium text-[0.875rem]">{t("page.inShare")}</h3>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-paper-2 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block truncate font-medium text-[0.875rem]">
            {t("share.onPage", { space: page?.title || name })}
          </span>
          <span className={cn("block truncate font-mono", hint)}>{address}</span>
        </span>
        <Switch checked disabled label={t("page.showOnPage")} onChange={() => {}} />
      </div>
      <p className={hint}>{t("page.inShareHint")}</p>
    </Card>
  );

  return (
    <div className="flex min-w-0 flex-col gap-9">
      <div className="contents">
        <Anchor id="page">
          <section className="flex flex-col gap-4">
            <div className="px-1">
              <h2 className="font-display font-semibold text-lg leading-tight">
                {t("space.page")}
              </h2>
              <p className="mt-1 text-[0.875rem] text-ink-3 leading-snug">{t("page.intro")}</p>
            </div>
            <Card className="flex flex-wrap items-center gap-3 p-3 sm:pl-4">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={cn("size-2 shrink-0 rounded-full", on ? "bg-moss" : "bg-ink-4")}
                  aria-hidden
                />
                {addressLine}
              </span>
              <span className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-sm:flex-1"
                  disabled={!on}
                  onClick={() => copy(url)}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {t(copied ? "share.copied" : "share.copyMain")}
                </Button>
                <Button
                  size="sm"
                  className="max-sm:flex-1"
                  disabled={!on}
                  onClick={() => window.open(url, "_blank", "noopener")}
                >
                  {t("page.open")} <ArrowUpRight className="size-3.5" />
                </Button>
              </span>
            </Card>
            <Section title={t("page.sectionPage")} locked={readOnly}>
              <fieldset
                aria-label={t("page.sectionPage")}
                className="grid min-w-0 gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))]"
              >
                <WhoCard
                  title={t("page.whoOff")}
                  text={t("page.whoOffHint")}
                  picked={!on}
                  disabled={readOnly || busy}
                  onPick={() => setOn(false)}
                />
                <WhoCard
                  title={t("page.whoPublic")}
                  text={t("page.whoPublicHint")}
                  picked={on}
                  disabled={readOnly || busy}
                  onPick={() => setOn(true)}
                />
                <WhoCard
                  title={t("page.whoMembers")}
                  text={t("page.whoMembersHint")}
                  picked={false}
                  later
                  onPick={() => {}}
                />
              </fieldset>
              {failed ? <p className="mt-3 text-[0.875rem] text-rose">{failed.message}</p> : null}
            </Section>
          </section>
        </Anchor>
        {previewCard}
        <Anchor id="page-words">
          <Section
            title={t("page.sectionWords")}
            hint={page ? undefined : t("page.notYet")}
            save={page ? wordsState : undefined}
            locked={fieldsLocked}
          >
            <div className="flex flex-col gap-6">
              {page ? (
                <WordsFields
                  key={`${project.id}:${page.slug}`}
                  host={host}
                  page={page}
                  disabled={readOnly}
                  save={save}
                  onState={setWordsState}
                />
              ) : (
                <WordFields
                  host={host}
                  disabled
                  words={{
                    slug,
                    title: name,
                    headline: "",
                    intro: "",
                    voice: studioLang === "de" ? "de-du" : "en",
                  }}
                  onChange={() => {}}
                />
              )}
              <div id="page-wizards" className="scroll-mt-6 border-border-soft border-t pt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className="font-medium text-[0.9375rem]">{t("page.sectionWizards")}</h3>
                  <span className={hint}>{t("page.wizardsHint")}</span>
                </div>
                <ul className="mt-2 flex flex-col">
                  {listed.map((w, i) => (
                    <WizardRow
                      key={w.id}
                      wizard={w}
                      first={i === 0}
                      on
                      disabled={fieldsLocked}
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
                      disabled={fieldsLocked}
                      onToggle={(show) => toggle(w.id, show)}
                    />
                  ))}
                </ul>
                {all.length ? null : <p className={cn("mt-2", hint)}>{t("page.noWizards")}</p>}
                <p className={cn("mt-4", hint)}>{t("page.wizardsNote")}</p>
              </div>
              <Sources />
            </div>
          </Section>
        </Anchor>
      </div>
      {shareCard}
    </div>
  );
}
