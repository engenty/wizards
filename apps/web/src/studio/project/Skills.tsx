import { Markdown } from "@engenty/wizards-runner";
import {
  SKILL_LIMITS,
  type SkillHit,
  type SkillMode,
  type SkillPreview,
  type SkillSummary,
  type SkillsList,
  skillNameOf,
  skillScript,
} from "@engenty/wizards-shared/skills";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  CircleCheck,
  CircleOff,
  type LucideIcon,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Button, Card, Chip, cn, Dialog, Empty, Input, Label, Spinner, Switch } from "../../ui";
import { Section } from "./Section";

/**
 * The skills of a space (docs/plans/skills.md): instructions its wizards follow, always or when
 * a step reads one. Added from skills.sh, uploaded as a `SKILL.md` or a zip, or written here.
 * The part is there only behind the `skills` switch.
 */

export function useSkills(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.skills(projectId),
    queryFn: () => api.get<SkillsList>(`/api/studio/projects/${projectId}/skills`),
    enabled: Boolean(projectId),
  });
}

export const MODE_ICON: Record<SkillMode, LucideIcon> = {
  always: CircleCheck,
  demand: Sparkles,
  off: CircleOff,
};

const MODES: SkillMode[] = ["always", "demand", "off"];

/** When a skill counts, as three pills in a row. */
export function ModeSwitch({
  value,
  onChange,
  disabled,
}: {
  value: SkillMode;
  onChange: (mode: SkillMode) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={t("skills.modeLabel")}
      className="m-0 min-w-0 border-0 p-0 inline-flex shrink-0 rounded-full bg-paper-2 p-0.5 text-[0.75rem]"
    >
      {MODES.map((m) => {
        const on = m === value;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(m)}
            className={cn(
              "h-7 rounded-full px-2.5 transition disabled:pointer-events-none coarse:h-9",
              on ? "bg-card font-medium text-ink shadow-soft" : "text-ink-3 hover:text-ink",
              disabled && !on && "opacity-60",
            )}
          >
            {t(`skills.mode.${m}`)}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Where a skill came from, as a chip: written here, uploaded, or its address on skills.sh. */
export function SourceChip({
  skill,
}: {
  skill: Pick<SkillSummary, "source" | "origin" | "official">;
}) {
  if (skill.source === "skills.sh" && skill.origin) {
    const source = skill.origin.split("/").slice(0, 2).join("/");
    return skill.official ? (
      <Chip tone="live" icon={<BadgeCheck className="size-3" />}>
        {source}
      </Chip>
    ) : (
      <Chip tone="warn">{source}</Chip>
    );
  }
  return <Chip>{skill.source === "upload" ? t("skills.uploaded") : t("skills.own")}</Chip>;
}

const countFiles = (n: number) => (n ? t("skills.files", { n }) : "");

function SkillRow({
  skill,
  readOnly,
  onOpen,
  onMode,
}: {
  skill: SkillSummary;
  readOnly: boolean;
  onOpen: (key: string) => void;
  onMode: (mode: SkillMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:flex-nowrap">
      <button
        type="button"
        onClick={() => onOpen(`k:${skill.id}`)}
        className="min-w-0 flex-1 rounded-lg text-left max-sm:basis-full"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "font-medium font-mono text-[0.8125rem] hover:underline",
              skill.mode === "off" && "text-ink-3",
            )}
          >
            {skill.name}
          </span>
          <SourceChip skill={skill} />
          {skill.files ? (
            <span className="text-[0.75rem] text-ink-3">{countFiles(skill.files)}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-3">
          {skill.description}
        </span>
      </button>
      <ModeSwitch value={skill.mode} onChange={onMode} disabled={readOnly} />
    </div>
  );
}

/** One of the menu's ways to add a skill. */
function AddEntry({
  icon: Icon,
  label,
  hint,
  onPick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span className="min-w-0">
        <span className="block font-medium text-[0.8125rem]">{label}</span>
        <span className="block text-[0.75rem] text-ink-3">{hint}</span>
      </span>
    </button>
  );
}

function AddSkillMenu({
  onRegistry,
  onWrite,
  onUpload,
}: {
  onRegistry: () => void;
  onWrite: () => void;
  onUpload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="size-4" /> {t("skills.add")}
        <ChevronDown className="-mr-1 size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-10 right-0 z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <AddEntry
            icon={Search}
            label={t("skills.fromRegistry")}
            hint={t("skills.fromRegistryHint")}
            onPick={pick(onRegistry)}
          />
          <AddEntry
            icon={Pencil}
            label={t("skills.write")}
            hint={t("skills.writeHint")}
            onPick={pick(onWrite)}
          />
          <AddEntry
            icon={Upload}
            label={t("skills.upload")}
            hint={t("skills.uploadHint")}
            onPick={pick(onUpload)}
          />
        </div>
      ) : null}
    </div>
  );
}

const UPLOAD_ACCEPT = ".md,.zip,.skill";

/** Uploads a skill and says what it left out. */
function useSkillUpload(projectId: string, onOpen: (key: string) => void) {
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) =>
      api.upload<{ id: string; name: string; skipped: { path: string }[] }>(
        `/api/studio/projects/${projectId}/skills/upload`,
        file,
      ),
    onSuccess: async (made) => {
      await qc.invalidateQueries({ queryKey: keys.skills(projectId) });
      setNote(
        made.skipped.length
          ? t("skills.uploadedSkipped", {
              name: made.name,
              paths: made.skipped.map((s) => s.path).join(", "),
            })
          : null,
      );
      onOpen(`k:${made.id}`);
    },
  });
  return { upload, note };
}

/**
 * The skills of a space: the way to add one (skills.sh, written here, uploaded) and a search
 * in the middle, then the skills by when they count. A search filters the space's own at once;
 * Search asks skills.sh.
 */
export function SkillsOverview({
  projectId,
  data,
  onOpen,
}: {
  projectId: string;
  data: SkillsList;
  onOpen: (key: string) => void;
}) {
  const qc = useQueryClient();
  const readOnly = data.readOnly;
  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const { upload, note } = useSkillUpload(projectId, onOpen);
  const mode = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: SkillMode }) =>
      api.patch(`/api/studio/skills/${id}`, { mode }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.skills(projectId) }),
  });
  const q = query.trim().toLowerCase();
  const shown = q
    ? data.skills.filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
    : data.skills;
  const always = shown.filter((s) => s.mode === "always");
  const allAlways = data.skills.filter((s) => s.mode === "always");
  const chars = allAlways.reduce((n, s) => n + s.chars, 0);
  const groups: { mode: SkillMode; title: string; hint?: string; items: SkillSummary[] }[] = [
    {
      mode: "always",
      title: t("skills.mode.always"),
      hint: t("skills.alwaysCount", {
        n: allAlways.length,
        max: SKILL_LIMITS.always,
        chars: chars.toLocaleString(lang),
        maxChars: SKILL_LIMITS.alwaysChars.toLocaleString(lang),
      }),
      items: always,
    },
    {
      mode: "demand",
      title: t("skills.mode.demand"),
      hint: t("skills.demandHint"),
      items: shown.filter((s) => s.mode === "demand"),
    },
    { mode: "off", title: t("skills.mode.off"), items: shown.filter((s) => s.mode === "off") },
  ];
  const files = (picked: File[]) => {
    for (const f of picked.slice(0, 1)) {
      upload.mutate(f);
    }
  };
  return (
    <Section
      title={t("space.skills")}
      hint={t("skills.hint")}
      plain
      action={
        readOnly ? null : (
          <AddSkillMenu
            onRegistry={() => setRegistry(query)}
            onWrite={() => setWriting(true)}
            onUpload={() => picker.current?.click()}
          />
        )
      }
    >
      <div
        onDragOver={(e) => {
          if (!readOnly) {
            e.preventDefault();
            e.currentTarget.dataset.over = "1";
          }
        }}
        onDragLeave={(e) => {
          delete e.currentTarget.dataset.over;
        }}
        onDrop={(e) => {
          e.preventDefault();
          delete e.currentTarget.dataset.over;
          if (!readOnly) {
            files(Array.from(e.dataTransfer.files));
          }
        }}
        className="flex flex-col items-center gap-3 rounded-2xl border border-input border-dashed bg-paper px-4 py-5 transition data-[over]:border-focus data-[over]:bg-paper-2 sm:px-6"
      >
        <form
          className="flex h-11 w-full max-w-2xl items-center gap-2 rounded-full border border-input bg-card pr-1.5 pl-4 shadow-soft focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow"
          onSubmit={(e) => {
            e.preventDefault();
            setRegistry(query);
          }}
        >
          <Search className="size-4 shrink-0 text-ink-3" />
          <input
            type="search"
            value={query}
            aria-label={t("skills.search")}
            placeholder={t("skills.search")}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-ink outline-none placeholder:text-ink-4"
          />
          <Button type="submit" size="sm">
            {t("skills.searchButton")}
          </Button>
        </form>
        {readOnly ? null : (
          <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[0.8125rem] text-ink-3">
            {upload.isPending ? <Spinner className="size-4" /> : <Upload className="size-4" />}
            {t("skills.drop")}
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className="underline hover:text-ink"
            >
              {t("skills.pick")}
            </button>
          </span>
        )}
      </div>
      <input
        ref={picker}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          files(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {upload.error ? (
        <p className="px-1 text-[0.875rem] text-rose">{(upload.error as Error).message}</p>
      ) : null}
      {note ? <p className="px-1 text-[0.8125rem] text-ink-3">{note}</p> : null}
      {mode.error ? (
        <p className="px-1 text-[0.875rem] text-rose">{(mode.error as Error).message}</p>
      ) : null}

      {data.skills.length === 0 ? (
        <Card>
          <Empty>{t("skills.empty")}</Empty>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <Empty>{t("skills.noneHere")}</Empty>
        </Card>
      ) : (
        groups
          .filter((g) => g.items.length || (g.mode === "always" && !q))
          .map((g) => (
            <div key={g.mode} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-3 px-1">
                <h3 className="font-semibold text-[0.875rem]">{g.title}</h3>
                {g.hint ? <span className="text-[0.75rem] text-ink-3">{g.hint}</span> : null}
              </div>
              {g.items.length ? (
                <Card className="flex flex-col divide-y divide-border-soft">
                  {g.items.map((s) => (
                    <SkillRow
                      key={s.id}
                      skill={s}
                      readOnly={readOnly}
                      onOpen={onOpen}
                      onMode={(next) => mode.mutate({ id: s.id, mode: next })}
                    />
                  ))}
                </Card>
              ) : null}
            </div>
          ))
      )}

      <RegistryDialog
        projectId={projectId}
        query={registry}
        onClose={() => setRegistry(null)}
        onAdded={(id) => {
          setRegistry(null);
          onOpen(`k:${id}`);
        }}
      />
      <NewSkillDialog
        projectId={projectId}
        open={writing}
        onClose={() => setWriting(false)}
        onMade={(id) => {
          setWriting(false);
          onOpen(`k:${id}`);
        }}
      />
    </Section>
  );
}

// --- a new skill --------------------------------------------------------------------------------

function NewSkillDialog({
  projectId,
  open,
  onClose,
  onMade,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onMade: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const make = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/studio/projects/${projectId}/skills`, {
        name: skillNameOf(name),
        description: description.trim(),
        body: `# ${name.trim()}\n\n`,
      }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: keys.skills(projectId) });
      setName("");
      setDescription("");
      onMade(id);
    },
  });
  const ready = skillNameOf(name) && description.trim();
  return (
    <Dialog open={open} onClose={onClose} title={t("skills.newTitle")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) {
            make.mutate();
          }
        }}
      >
        <div>
          <Label>{t("skills.name")}</Label>
          <Input
            data-autofocus
            value={name}
            maxLength={SKILL_LIMITS.name}
            placeholder={t("skills.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
          />
          <p className="mt-1 text-[0.75rem] text-ink-3">
            {skillNameOf(name) && skillNameOf(name) !== name
              ? skillNameOf(name)
              : t("skills.nameHint")}
          </p>
        </div>
        <div>
          <Label>{t("skills.description")}</Label>
          <Input
            value={description}
            maxLength={SKILL_LIMITS.description}
            placeholder={t("skills.descPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="mt-1 text-[0.75rem] text-ink-3">{t("skills.descHint")}</p>
        </div>
        {make.error ? (
          <p className="text-[0.875rem] text-rose">{(make.error as Error).message}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={make.isPending} disabled={!ready}>
            {t("skills.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// --- skills.sh ----------------------------------------------------------------------------------

/** Files a skill brings, and the ones left out, in one list. */
export function FileNotes({
  files,
  skipped,
}: {
  files: { path: string }[];
  skipped: SkillPreview["skipped"];
}) {
  const scripts = files.filter((f) => skillScript(f.path));
  if (!(scripts.length || skipped.length)) {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1 text-[0.75rem] text-ink-3">
      {scripts.map((f) => (
        <li key={f.path}>{t("skills.scriptNote", { path: f.path })}</li>
      ))}
      {skipped.map((f) => (
        <li key={f.path}>
          {t(
            f.reason === "binary"
              ? "skills.skippedBinary"
              : f.reason === "size"
                ? "skills.skippedSize"
                : "skills.skippedOther",
            { path: f.path },
          )}
        </li>
      ))}
    </ul>
  );
}

const kb = (bytes: number) =>
  `${(bytes / 1000).toLocaleString(lang, { maximumFractionDigits: 1 })} KB`;

/**
 * skills.sh in a dialog: a search, official sources first, and a skill read whole before it is
 * added. It keeps its height while it switches between the results and a skill.
 */
function RegistryDialog({
  projectId,
  query,
  onClose,
  onAdded,
}: {
  projectId: string;
  /** The words to search for; null: closed. */
  query: string | null;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const [onlyOfficial, setOnlyOfficial] = useState(true);
  const [ref, setRef] = useState<string | null>(null);
  const [mode, setMode] = useState<SkillMode>("demand");
  const [tab, setTab] = useState<"skill" | "files">("skill");
  useEffect(() => {
    if (query !== null) {
      setText(query);
      setAsked(query.trim());
      setRef(null);
    }
  }, [query]);
  const hits = useQuery({
    queryKey: ["skills-registry", projectId, asked],
    queryFn: () =>
      api.get<{ hits: SkillHit[] }>(
        `/api/studio/projects/${projectId}/skills/registry?q=${encodeURIComponent(asked)}`,
      ),
    enabled: query !== null && asked.length >= 2,
    staleTime: 60_000,
  });
  const preview = useQuery({
    queryKey: ["skills-preview", projectId, ref],
    queryFn: () =>
      api.get<SkillPreview>(
        `/api/studio/projects/${projectId}/skills/registry/preview?ref=${encodeURIComponent(ref ?? "")}`,
      ),
    enabled: Boolean(ref),
  });
  const add = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/studio/projects/${projectId}/skills/registry`, {
        ref,
        mode,
      }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: keys.skills(projectId) });
      setRef(null);
      onAdded(id);
    },
  });
  const list = (hits.data?.hits ?? []).filter((h) => !onlyOfficial || h.official);
  const p = preview.data;
  return (
    <Dialog
      open={query !== null}
      onClose={onClose}
      wide
      height="tall"
      title={t("skills.registryTitle")}
    >
      {ref ? (
        <div className="flex flex-col gap-3">
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3"
              onClick={() => {
                setRef(null);
                add.reset();
              }}
            >
              <ArrowLeft className="size-4" /> {t("skills.results")}
            </Button>
          </div>
          {!p ? (
            preview.error ? (
              <p className="text-[0.875rem] text-rose">{(preview.error as Error).message}</p>
            ) : (
              <div className="flex justify-center py-16">
                <Spinner className="size-5" />
              </div>
            )
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-medium font-mono text-lg">{p.name}</h2>
                {p.official ? (
                  <Chip tone="live" icon={<BadgeCheck className="size-3" />}>
                    {t("skills.official")}
                  </Chip>
                ) : (
                  <Chip tone="warn">{t("skills.unchecked")}</Chip>
                )}
              </div>
              <p className="text-[0.8125rem] text-ink-3">
                <a
                  href={`https://github.com/${p.ref.split("/").slice(0, 2).join("/")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-ink"
                >
                  {p.ref.split("/").slice(0, 2).join("/")}
                </a>{" "}
                {t("skills.onGithub")}
              </p>
              <p className="text-[0.875rem] text-ink-2">{p.description}</p>
              {p.official ? null : (
                <p className="rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem] text-ink-2">
                  {t("skills.uncheckedWarn")}
                </p>
              )}
              <div className="flex gap-1 border-border-soft border-b" role="tablist">
                {(["skill", "files"] as const).map((x) => (
                  <button
                    key={x}
                    type="button"
                    role="tab"
                    aria-selected={tab === x}
                    onClick={() => setTab(x)}
                    className={cn(
                      "-mb-px h-9 border-b-2 px-2.5 text-[0.8125rem]",
                      tab === x
                        ? "border-ink font-medium text-ink"
                        : "border-transparent text-ink-3 hover:text-ink",
                    )}
                  >
                    {x === "skill" ? "SKILL.md" : t("skills.tabFiles", { n: p.fileList.length })}
                  </button>
                ))}
              </div>
              <div>
                {tab === "skill" ? (
                  <div className="rounded-lg bg-paper-2 p-4">
                    <Markdown text={p.body} />
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y divide-border-soft rounded-lg ring-1 ring-border-soft">
                    {p.fileList.map((f) => (
                      <li key={f.path} className="flex items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
                          {f.path}
                        </span>
                        <span className="text-[0.75rem] text-ink-3">{kb(f.text.length)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <FileNotes files={p.fileList} skipped={p.skipped} />
              {add.error ? (
                <p className="text-[0.875rem] text-rose">{(add.error as Error).message}</p>
              ) : null}
              <div className="-mx-5 sm:-mx-7 -mb-5 sm:-mb-7 -bottom-5 sm:-bottom-7 sticky flex flex-wrap items-center gap-3 border-border-soft border-t bg-card px-5 pt-3 pb-5 sm:px-7 sm:pb-7">
                <ModeSwitch value={mode === "off" ? "demand" : mode} onChange={setMode} />
                <span className="flex-1 text-[0.75rem] text-ink-3">
                  {[kb(p.bytes), countFiles(p.fileList.length)].filter(Boolean).join(" · ")}
                </span>
                <Button busy={add.isPending} onClick={() => add.mutate()}>
                  {t("skills.add")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="-mt-3 text-[0.875rem] text-ink-3">{t("skills.registryHint")}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(text.trim());
            }}
          >
            <div className="relative">
              <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-ink-4" />
              <Input
                data-autofocus
                type="search"
                value={text}
                aria-label={t("skills.searchButton")}
                placeholder={t("skills.registrySearch")}
                onChange={(e) => setText(e.target.value)}
                className="pl-9"
              />
            </div>
          </form>
          <label className="flex items-center gap-2.5 text-[0.8125rem] text-ink-2">
            <Switch checked={onlyOfficial} onChange={setOnlyOfficial} />
            {t("skills.onlyOfficial")}
            <span className="flex-1" />
            {hits.data ? (
              <span className="text-ink-3">{t("skills.hits", { n: list.length })}</span>
            ) : null}
          </label>
          <div className="-mx-2">
            {asked.length < 2 ? (
              <Empty>{t("skills.registryStart")}</Empty>
            ) : hits.isLoading ? (
              <div className="flex justify-center py-16">
                <Spinner className="size-5" />
              </div>
            ) : hits.error ? (
              <p className="px-2 text-[0.875rem] text-rose">{(hits.error as Error).message}</p>
            ) : list.length ? (
              <ul className="flex flex-col">
                {list.map((h) => (
                  <li key={h.ref} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium font-mono text-[0.8125rem]">{h.name}</span>
                        {h.official ? (
                          <Chip tone="live" icon={<BadgeCheck className="size-3" />}>
                            {t("skills.official")}
                          </Chip>
                        ) : (
                          <Chip tone="warn">{t("skills.unchecked")}</Chip>
                        )}
                      </span>
                      <span className="block truncate text-[0.75rem] text-ink-3">
                        {h.source} · {t("skills.installs", { n: h.installs.toLocaleString(lang) })}
                      </span>
                    </span>
                    {h.added ? (
                      <span className="text-[0.75rem] text-ink-3">{t("skills.inSpace")}</span>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setTab("skill");
                        setMode("demand");
                        setRef(h.ref);
                      }}
                    >
                      {t("skills.open")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t("skills.registryNone")}</Empty>
            )}
          </div>
          <p className="flex items-start gap-2 border-border-soft border-t pt-3 text-[0.75rem] text-ink-3">
            <BadgeCheck className="mt-0.5 size-3.5 shrink-0" />
            {t("skills.officialNote")}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** A heading of the editor's side column, with something at its right. */
export function SideHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-1">
      <h3 className="flex-1 font-semibold text-[0.875rem]">{title}</h3>
      {children}
    </div>
  );
}
