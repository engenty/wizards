import { Markdown } from "@engenty/wizards-runner";
import {
  parseSkillMd,
  SKILL_LIMITS,
  type SkillDetail,
  type SkillFile,
  type SkillMode,
  type SkillPreview,
  skillMd,
  skillPathOk,
} from "@engenty/wizards-shared/skills";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Code2,
  Copy,
  Download,
  Eye,
  FileArchive,
  FileText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import {
  askConfirm,
  Button,
  Card,
  cn,
  Dialog,
  IconButton,
  Input,
  Label,
  Spinner,
  Switch,
} from "../../ui";
import { CodeEditor } from "../../ui/code-editor";
import { frontmatterLines } from "../../ui/code-editor/frontmatter";
import { useAutosave } from "./data";
import { InlineText } from "./Section";
import { FileNotes, MODE_ICON, SideHead, SourceChip } from "./Skills";

/**
 * One skill, opened (docs/plans/skills.md): its name and description in the header, its
 * instructions as text or as the `SKILL.md` they are, when it counts, whether its scripts run,
 * and its files in a dialog. A skill of the space's own saves as it is typed; one from skills.sh
 * is read only, offers a newer version when skills.sh has one, and is copied to be changed.
 */

const MODES: SkillMode[] = ["always", "demand", "off"];
const FRONTMATTER = frontmatterLines();

function useSkill(id: string) {
  return useQuery({
    queryKey: keys.skill(id),
    queryFn: () => api.get<SkillDetail>(`/api/studio/skills/${id}`),
  });
}

/** When a skill counts: three cards with an icon and what each means. */
function ModeCards({
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
      className="m-0 min-w-0 border-0 p-0 flex flex-col gap-2"
    >
      {MODES.map((m) => {
        const on = m === value;
        const Icon = MODE_ICON[m];
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(m)}
            className={cn(
              "flex items-start gap-3 rounded-xl bg-card p-3 text-left ring-1 transition disabled:pointer-events-none",
              on
                ? "ring-ember shadow-[0_0_0_3px] shadow-ember-tint"
                : "ring-border-soft hover:ring-ink-4",
              disabled && !on && "opacity-60",
            )}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                on ? "bg-ember-tint text-ember-strong" : "bg-paper-2 text-ink-3",
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-[0.8125rem]">{t(`skills.mode.${m}`)}</span>
              <span className="block text-[0.75rem] text-ink-3 leading-snug">
                {t(`skills.modeHint.${m}`)}
              </span>
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * Whether the skill's scripts run in the sandbox of a step that has one. A skill nobody checked
 * (uploaded, or from a source skills.sh does not list as official) says so beside the switch.
 */
function ScriptsCard({ skill }: { skill: SkillDetail }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (next: boolean) =>
      api.patch(`/api/studio/skills/${skill.id}`, { runScripts: next }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.skill(skill.id) });
      await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
    },
  });
  const unchecked = skill.source !== "own" && !skill.official;
  return (
    <div className="flex flex-col gap-2">
      <SideHead title={t("skills.scriptsTitle")} />
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-3">
          <span className="flex-1 font-medium text-[0.8125rem]">{t("skills.runScripts")}</span>
          <Switch
            checked={skill.runScripts}
            label={t("skills.runScripts")}
            disabled={skill.readOnly || set.isPending}
            onChange={(next) => set.mutate(next)}
          />
        </div>
        <p className="text-[0.75rem] text-ink-3 leading-snug">{t("skills.runScriptsHint")}</p>
        {unchecked ? (
          <p className="rounded-lg bg-amber-tint px-3 py-2 text-[0.75rem] text-ink-2 leading-snug">
            {t("skills.runScriptsWarn")}
          </p>
        ) : null}
        {set.error ? (
          <p className="text-[0.75rem] text-rose">{(set.error as Error).message}</p>
        ) : null}
      </Card>
    </div>
  );
}

/** One button that switches between the text as it reads and the code it is. */
function ViewToggle({ code, onChange }: { code: boolean; onChange: (code: boolean) => void }) {
  return (
    <Button variant="secondary" size="sm" aria-pressed={code} onClick={() => onChange(!code)}>
      {code ? <Eye className="size-4" /> : <Code2 className="size-4" />}
      {code ? t("skills.rendered") : t("skills.code")}
    </Button>
  );
}

const bytesKb = (bytes: number) =>
  `${(bytes / 1000).toLocaleString(lang, { maximumFractionDigits: 1 })} KB`;
const kb = (text: string) => bytesKb(new TextEncoder().encode(text).length);

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** A file of a skill in a dialog: as it reads or as code, edited when the skill is the space's own. */
function FileDialog({
  file,
  readOnly,
  onChange,
  onDelete,
  onClose,
}: {
  file: SkillFile | null;
  readOnly: boolean;
  onChange: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState(false);
  const md = file ? isMarkdown(file.path) : false;
  const showCode = code || !md;
  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      wide
      height="tall"
      title={
        file ? (
          <span className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-ink-3" />
            <span className="truncate font-mono text-[0.9375rem]">{file.path}</span>
          </span>
        ) : null
      }
    >
      {file ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[0.75rem] text-ink-3">{kb(file.text)}</span>
            {md ? <ViewToggle code={code} onChange={setCode} /> : null}
          </div>
          <Card className="overflow-hidden">
            {showCode ? (
              <CodeEditor
                value={file.text}
                onChange={onChange}
                readOnly={readOnly}
                language="markdown"
                ariaLabel={file.path}
                className="min-h-[50vh] [&_.cm-editor]:min-h-[50vh]"
              />
            ) : (
              <div className="p-5">
                <Markdown text={file.text} />
              </div>
            )}
          </Card>
          <div className="flex items-center gap-2">
            {readOnly ? null : (
              <Button variant="danger" size="sm" onClick={onDelete}>
                <Trash2 className="size-4" /> {t("skills.deleteFile")}
              </Button>
            )}
            <span className="flex-1" />
            <Button size="sm" onClick={onClose}>
              {t("skills.done")}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function NewFileDialog({
  open,
  taken,
  onClose,
  onMade,
}: {
  open: boolean;
  taken: string[];
  onClose: () => void;
  onMade: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const clean = path.trim().replace(/^\.?\//, "");
  const ok = skillPathOk(clean) && clean !== "SKILL.md" && !taken.includes(clean);
  return (
    <Dialog open={open} onClose={onClose} title={t("skills.newFile")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) {
            onMade(clean);
            setPath("");
          }
        }}
      >
        <div>
          <Label>{t("skills.filePath")}</Label>
          <Input
            data-autofocus
            value={path}
            placeholder={t("skills.filePathHint")}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!ok}>
            {t("skills.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A small menu of a few actions, behind “…”. */
function MoreMenu({ items }: { items: { label: string; danger?: boolean; onPick: () => void }[] }) {
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
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <IconButton
        label={t("skills.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ring-1 ring-border"
      >
        <MoreHorizontal className="size-4" />
      </IconButton>
      {open ? (
        <div
          role="menu"
          className="absolute top-11 right-0 z-50 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onPick();
              }}
              className={cn(
                "w-full rounded-lg px-2.5 py-2 text-left text-[0.8125rem] transition hover:bg-accent",
                i.danger && "text-rose",
              )}
            >
              {i.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What skills.sh has now for a skill added from it, and the way to take it. */
function UpdateBanner({ skill }: { skill: SkillDetail }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const check = useQuery({
    queryKey: ["skill-update", skill.id, skill.originHash],
    queryFn: () =>
      api.get<{
        update:
          | (Pick<SkillPreview, "description" | "body" | "skipped" | "hash"> & {
              fileList: { path: string; bytes: number }[];
            })
          | null;
      }>(`/api/studio/skills/${skill.id}/update`),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const take = useMutation({
    mutationFn: (hash: string) => api.post(`/api/studio/skills/${skill.id}/update`, { hash }),
    onSuccess: async () => {
      setOpen(false);
      await qc.invalidateQueries({ queryKey: keys.skill(skill.id) });
      await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
    },
  });
  const update = check.data?.update;
  if (!update || skill.readOnly) {
    return null;
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
      <RefreshCw className="size-4 shrink-0 text-ember" />
      <span className="min-w-0 flex-1 text-[0.8125rem]">{t("skills.updateAvailable")}</span>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t("skills.showChanges")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        wide
        height="tall"
        title={t("skills.updateTitle", { name: skill.name })}
      >
        <div className="flex flex-col gap-3">
          <p className="text-[0.875rem] text-ink-2">{update.description}</p>
          <div className="rounded-lg bg-paper-2 p-4">
            <Markdown text={update.body} />
          </div>
          <ul className="flex flex-col gap-0.5 text-[0.8125rem]">
            {update.fileList.map((f) => (
              <li key={f.path} className="font-mono">
                {f.path}
              </li>
            ))}
          </ul>
          <FileNotes files={update.fileList} skipped={update.skipped} />
          {take.error ? (
            <p className="text-[0.875rem] text-rose">{(take.error as Error).message}</p>
          ) : null}
          <div className="flex justify-end">
            <Button busy={take.isPending} onClick={() => take.mutate(update.hash)}>
              {t("skills.takeUpdate")}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

interface Draft {
  name: string;
  description: string;
  body: string;
  meta: Record<string, unknown>;
  files: SkillFile[];
}

export function SkillEditor({
  skillId,
  onGone,
  onOpen,
  filesFirst,
}: {
  skillId: string;
  onGone: () => void;
  onOpen: (key: string) => void;
  /** Dateien at the top of the right column, beside the instructions that point to them (Fähigkeiten). */
  filesFirst?: boolean;
}) {
  const skill = useSkill(skillId);
  if (skill.error) {
    return <p className="px-1 text-[0.875rem] text-rose">{(skill.error as Error).message}</p>;
  }
  if (!skill.data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <SkillForm
      key={skill.data.id}
      skill={skill.data}
      onGone={onGone}
      onOpen={onOpen}
      filesFirst={filesFirst}
    />
  );
}

function SkillForm({
  skill,
  onGone,
  onOpen,
  filesFirst,
}: {
  skill: SkillDetail;
  onGone: () => void;
  onOpen: (key: string) => void;
  filesFirst?: boolean;
}) {
  const qc = useQueryClient();
  const fromRegistry = skill.source === "skills.sh";
  const locked = skill.readOnly || fromRegistry;
  const [draft, setDraft] = useState<Draft>({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    meta: skill.meta,
    files: skill.fileList,
  });
  const [code, setCode] = useState(false);
  // The code view edits the whole SKILL.md: kept as typed until it reads as one again.
  const [md, setMd] = useState<string | null>(null);
  const [mdBad, setMdBad] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [newFile, setNewFile] = useState(false);
  const save = useAutosave(draft, async (value) => {
    if (locked) {
      return;
    }
    await api.patch(`/api/studio/skills/${skill.id}`, value);
    await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
  });
  const mode = useMutation({
    mutationFn: (next: SkillMode) => api.patch(`/api/studio/skills/${skill.id}`, { mode: next }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.skill(skill.id) });
      await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/skills/${skill.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
      onGone();
    },
  });
  const copy = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/api/studio/skills/${skill.id}/copy`),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: keys.skills(skill.spaceId) });
      onOpen(`k:${id}`);
    },
  });
  const opened = draft.files.find((f) => f.path === file) ?? null;
  const text = md ?? skillMd(draft);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const askDelete = async () => {
    const key = fromRegistry ? "skills.removeConfirm" : "skills.deleteConfirm";
    if (await askConfirm(t(key, { name: skill.name }))) {
      remove.mutate();
    }
  };
  const error = save.error ?? (mode.error as Error | null)?.message ?? null;
  const license = typeof skill.meta.license === "string" ? skill.meta.license : null;
  // The skill's files: last in the right column, or first (`filesFirst`).
  const files = (
    <div className="flex flex-col gap-2">
      <SideHead title={t("skills.filesTitle")}>
        {locked ? null : (
          <Button variant="secondary" size="sm" onClick={() => setNewFile(true)}>
            <Plus className="size-4" /> {t("skills.addFile")}
          </Button>
        )}
      </SideHead>
      {draft.files.length || skill.blobList.length ? (
        <Card className="flex flex-col divide-y divide-border-soft overflow-hidden">
          {draft.files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setFile(f.path)}
              className="flex items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-accent"
            >
              <FileText className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{f.path}</span>
              <span className="shrink-0 text-[0.75rem] text-ink-3">{kb(f.text)}</span>
            </button>
          ))}
          {skill.blobList.map((f) => (
            <div key={f.path} className="flex items-center gap-2.5 px-3 py-2.5">
              <FileArchive className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{f.path}</span>
              <span className="shrink-0 text-[0.75rem] text-ink-3">
                {t("skills.forScripts")} · {bytesKb(f.bytes)}
              </span>
            </div>
          ))}
        </Card>
      ) : (
        <p className="px-1 text-[0.8125rem] text-ink-3">{t("skills.noFiles")}</p>
      )}
      <p className="px-1 text-[0.75rem] text-ink-3">{t("skills.filesHint")}</p>
      {skill.blobList.length ? (
        <p className="px-1 text-[0.75rem] text-ink-3">{t("skills.blobHint")}</p>
      ) : null}
    </div>
  );
  return (
    <div className="flex flex-col gap-5 pb-20">
      <header className="flex flex-wrap items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-ember-tint text-ember-strong">
          <ScrollText className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {locked ? (
              <h1 className="font-medium font-mono text-2xl">{draft.name}</h1>
            ) : (
              <InlineText
                fit
                value={draft.name}
                label={t("skills.name")}
                placeholder={t("skills.namePlaceholder")}
                maxLength={SKILL_LIMITS.name}
                onChange={(name) => {
                  setMd(null);
                  set({ name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-") });
                }}
                className="font-medium font-mono text-2xl"
              />
            )}
            <SourceChip skill={skill} />
            {save.state === "saving" ? (
              <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                <Spinner className="size-3" /> {t("space.saving")}
              </span>
            ) : save.state === "saved" ? (
              <span className="text-[0.75rem] text-ink-3">{t("settings.saved")}</span>
            ) : null}
          </div>
          {locked ? (
            <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-2 leading-relaxed">
              {draft.description}
            </p>
          ) : (
            <textarea
              value={draft.description}
              aria-label={t("skills.description")}
              placeholder={t("skills.descPlaceholder")}
              maxLength={SKILL_LIMITS.description}
              rows={2}
              onChange={(e) => {
                setMd(null);
                set({ description: e.target.value });
              }}
              className="-mx-1 mt-1 block w-full max-w-3xl resize-none rounded-md bg-transparent px-1 py-0.5 text-[0.9375rem] text-ink-2 leading-relaxed outline-none transition placeholder:text-ink-4 hover:bg-paper-2 focus:bg-card focus:text-ink focus:ring-1 focus:ring-border"
            />
          )}
          <p className="mt-0.5 text-[0.75rem] text-ink-3">{t("skills.descHint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <a
            href={withBase(`/api/studio/skills/${skill.id}/zip`)}
            download
            className="inline-flex h-8 items-center gap-2 rounded-full bg-card px-3 font-medium text-[0.8125rem] ring-1 ring-border transition hover:bg-accent"
          >
            <Download className="size-4" /> {t("skills.download")}
          </a>
          {skill.readOnly ? null : (
            <MoreMenu
              items={[
                ...(fromRegistry ? [] : [{ label: t("skills.copy"), onPick: () => copy.mutate() }]),
                {
                  label: fromRegistry ? t("skills.remove") : t("skills.delete"),
                  danger: true,
                  onPick: askDelete,
                },
              ]}
            />
          )}
        </div>
      </header>

      {fromRegistry ? <UpdateBanner skill={skill} /> : null}
      {error ? <p className="px-1 text-[0.875rem] text-rose">{error}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-w-0 flex-col gap-2">
          <SideHead title={t("skills.instructions")}>
            <span className="text-[0.75rem] text-ink-3">
              {t("skills.chars", { n: draft.body.length.toLocaleString(lang) })}
            </span>
            <ViewToggle code={code} onChange={setCode} />
          </SideHead>
          <Card className="overflow-hidden">
            {code ? (
              <CodeEditor
                value={text}
                readOnly={locked}
                onChange={(next) => {
                  setMd(next);
                  try {
                    const read = parseSkillMd(next);
                    setMdBad(false);
                    set({ ...read, files: draft.files });
                  } catch {
                    setMdBad(true);
                  }
                }}
                language="markdown"
                ariaLabel="SKILL.md"
                extensions={FRONTMATTER}
                className="min-h-[55vh] [&_.cm-editor]:min-h-[55vh] sm:[&_.cm-content]:py-5 sm:[&_.cm-line]:px-5"
              />
            ) : (
              <div className="min-h-40 p-5 sm:px-8 sm:py-6">
                {draft.body.trim() ? (
                  <Markdown text={draft.body} />
                ) : (
                  <p className="text-[0.875rem] text-ink-3">{t("skills.emptyBody")}</p>
                )}
              </div>
            )}
          </Card>
          {code && mdBad ? (
            <p className="px-1 text-[0.8125rem] text-rose">{t("skills.mdError")}</p>
          ) : null}
          {fromRegistry ? (
            <p className="px-1 text-[0.8125rem] text-ink-3">{t("skills.readOnlyNote")}</p>
          ) : null}
        </section>

        <aside className="flex flex-col gap-6">
          {filesFirst ? files : null}
          <div className="flex flex-col gap-2">
            <SideHead title={t("skills.when")} />
            <ModeCards
              value={skill.mode}
              onChange={(next) => mode.mutate(next)}
              disabled={skill.readOnly || mode.isPending}
            />
          </div>

          <ScriptsCard skill={skill} />

          {fromRegistry ? (
            <div className="flex flex-col gap-2">
              <SideHead title={t("skills.origin")} />
              <Card className="p-4">
                <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2 text-[0.8125rem]">
                  <dt className="text-ink-3">{t("skills.source")}</dt>
                  <dd>
                    <a
                      href={`https://skills.sh/${skill.origin}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all underline hover:text-ink"
                    >
                      {skill.origin}
                    </a>
                  </dd>
                  {license ? (
                    <>
                      <dt className="text-ink-3">{t("skills.license")}</dt>
                      <dd className="break-words">{license}</dd>
                    </>
                  ) : null}
                  {skill.originHash ? (
                    <>
                      <dt className="text-ink-3">{t("skills.version")}</dt>
                      <dd className="font-mono text-[0.75rem]">{skill.originHash.slice(0, 12)}</dd>
                    </>
                  ) : null}
                </dl>
              </Card>
              {skill.readOnly ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  busy={copy.isPending}
                  onClick={() => copy.mutate()}
                >
                  <Copy className="size-4" /> {t("skills.copy")}
                </Button>
              )}
            </div>
          ) : null}

          {filesFirst ? null : files}
        </aside>
      </div>

      <FileDialog
        file={opened}
        readOnly={locked}
        onClose={() => setFile(null)}
        onChange={(next) =>
          set({ files: draft.files.map((f) => (f.path === file ? { ...f, text: next } : f)) })
        }
        onDelete={() => {
          set({ files: draft.files.filter((f) => f.path !== file) });
          setFile(null);
        }}
      />
      <NewFileDialog
        open={newFile}
        taken={draft.files.map((f) => f.path)}
        onClose={() => setNewFile(false)}
        onMade={(path) => {
          set({
            files: [...draft.files, { path, text: "" }].sort((a, b) =>
              a.path.localeCompare(b.path),
            ),
          });
          setNewFile(false);
          setFile(path);
        }}
      />
    </div>
  );
}
