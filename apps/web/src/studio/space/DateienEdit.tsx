import { type DiffLine, diffLines } from "@engenty/wizards-shared/text-merge";
import { useQueryClient } from "@tanstack/react-query";
import { Check, GitMerge, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { askConfirm, Button, Card, Chip, cn, IconButton, Spinner } from "../../ui";
import { CodeEditor } from "../../ui/code-editor";
import { mountFileUrl } from "./data";
import {
  type FileDraft,
  type Mount,
  type MountDraft,
  type MountFile,
  type PublishResult,
  publishMount,
  useDraftActions,
  useFileDraft,
  useMountFiles,
} from "./dateien-data";

const BlockEditor = lazy(() =>
  import("./blocks/BlockEditor").then((m) => ({ default: m.BlockEditor })),
);

/**
 * Editing a mounted file (docs/plans/media-and-files.md, section 3): an edit stays a draft in
 * engenty until „Veröffentlichen“ writes it to the source with the version it was read at
 * (runtime mounts/drafts.ts). Markdown is written in Wissen's block editor or as Markdown, plain
 * text as text; any other file is replaced by an upload. A change at the source to the same
 * lines is shown here: „Vergleichen“, „Meine behalten“, „Ihre übernehmen“.
 */

/** Edited as text: Markdown and plain text, as the runtime decides it (`editsAsText`). */
export function editsAsText(file: Pick<MountFile, "name" | "mime" | "size">): boolean {
  return (
    file.size <= 2 * 1024 * 1024 &&
    (/^text\/(markdown|plain|x-markdown)$/.test(file.mime) ||
      /\.(md|markdown|txt)$/i.test(file.name))
  );
}

const isMarkdown = (file: Pick<MountFile, "name" | "mime">) =>
  /markdown/.test(file.mime) || /\.(md|markdown)$/i.test(file.name);

/** What a publish says afterwards, under the file's name. */
export type Published = "published" | "merged" | null;

export function TextDraft({
  spaceId,
  mount,
  file,
  onPublished,
  onClose,
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  file: MountFile;
  onPublished: (how: Exclude<Published, null>) => void;
  onClose: () => void;
  onOpen: (show: string) => void;
}) {
  const draft = useFileDraft(spaceId, file.id, true);
  if (draft.isError) {
    return <p className="px-1 text-[0.875rem] text-rose">{(draft.error as Error).message}</p>;
  }
  if (!draft.data) {
    return (
      <div className="flex h-40 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  // Asked again after a publish or a resolution: the editor starts from what came back.
  return (
    <TextDraftEditor
      key={draft.dataUpdatedAt}
      spaceId={spaceId}
      mount={mount}
      file={file}
      draft={draft.data}
      onPublished={onPublished}
      onClose={onClose}
      onOpen={onOpen}
    />
  );
}

/** Saved this long after the last key. */
const SAVE_AFTER_MS = 600;

function TextDraftEditor({
  spaceId,
  mount,
  file,
  draft,
  onPublished,
  onClose,
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  file: MountFile;
  draft: FileDraft;
  onPublished: (how: Exclude<Published, null>) => void;
  onClose: () => void;
  onOpen: (show: string) => void;
}) {
  const actions = useDraftActions(spaceId, mount.id, file.id);
  const files = useMountFiles(spaceId, mount);
  const markdown = isMarkdown(file);
  const [text, setText] = useState(draft.text ?? "");
  const [view, setView] = useState<"write" | "markdown">(markdown ? "write" : "markdown");
  const [hasDraft, setHasDraft] = useState(draft.draft);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [busy, setBusy] = useState<"publish" | "discard" | "mine" | null>(null);
  const [compare, setCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The file as it was read: a first save, or one after the draft went, names it.
  const opened = { base: draft.base, baseText: draft.baseText ?? draft.text ?? "" };
  const drafted = useRef(draft.draft);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);

  const save = (next: string) => {
    chain.current = chain.current
      .then(async () => {
        setSaving("saving");
        const res = await actions.save(
          drafted.current ? { text: next } : { text: next, ...opened },
        );
        drafted.current = Boolean(res.draft);
        setHasDraft(drafted.current);
        setSaving("saved");
      })
      .catch((err: Error) => {
        setSaving("idle");
        setError(err.message);
      });
    return chain.current;
  };
  /** What is typed and not saved yet, saved now. */
  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
      return save(latest.current);
    }
    return chain.current;
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (next: string) => {
    setText(next);
    latest.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void save(next);
    }, SAVE_AFTER_MS);
  };

  const run = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const after = (result: PublishResult) => {
    if (result.ok) {
      onPublished(result.merged ? "merged" : "published");
    }
  };

  // Pictures and links in the text: paths next to the file, in the same mount.
  const folder = file.path.split("/").slice(0, -1);
  const pathOf = (href: string) => {
    const parts = href.startsWith("/") ? [] : [...folder];
    for (const part of decodeURI(href.split(/[?#]/)[0]).split("/")) {
      if (part === "..") {
        parts.pop();
      } else if (part && part !== ".") {
        parts.push(part);
      }
    }
    return parts.join("/");
  };
  const fileAt = (href: string) => files.data?.files.find((f) => f.path === pathOf(href));
  const external = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
  const resolve = (src: string) => {
    const found = external(src) ? null : fileAt(src);
    return found ? mountFileUrl(spaceId, found.id) : src;
  };
  const follow = (href: string) => {
    const found = external(href) ? null : fileAt(href);
    if (found) {
      void flush().then(() => onOpen(`m:${found.id}`));
    } else if (external(href)) {
      window.open(href, "_blank", "noreferrer");
    }
  };

  const conflict = draft.conflict;
  const tab = (id: typeof view, label: string) => (
    <button
      type="button"
      aria-pressed={view === id}
      onClick={() => setView(id)}
      className={cn(
        "rounded-full px-3 py-1 text-[0.8125rem] transition",
        view === id ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      {conflict ? (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-amber-tint px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <GitMerge className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">{t("dateien.conflict", { name: mount.name })}</span>
            {conflict.text !== null ? (
              <Button size="sm" variant="ghost" onClick={() => setCompare(!compare)}>
                {compare ? t("dateien.compareHide") : t("dateien.compare")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              busy={busy === "discard"}
              onClick={() => void run("discard", actions.discard)}
            >
              {t("dateien.takeTheirs")}
            </Button>
            <Button
              size="sm"
              busy={busy === "mine"}
              onClick={() =>
                void run("mine", async () => {
                  await flush();
                  after(await actions.keepMine());
                })
              }
            >
              {t("dateien.keepMine")}
            </Button>
          </div>
          {compare && conflict.text !== null ? (
            <Compare theirs={conflict.text} mine={text} />
          ) : null}
        </div>
      ) : hasDraft ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem]"
        >
          <Chip tone="warn">{t("dateien.draft")}</Chip>
          <span className="min-w-0 flex-1">{t("dateien.notThereYet", { name: mount.name })}</span>
          <SaveMark state={saving} />
          <Button
            size="sm"
            variant="ghost"
            busy={busy === "discard"}
            onClick={async () => {
              if (await askConfirm(t("dateien.discardConfirm"))) {
                clearTimeout(timer.current);
                timer.current = undefined;
                void run("discard", async () => {
                  await chain.current;
                  await actions.discard();
                  onClose();
                });
              }
            }}
          >
            {t("dateien.discard")}
          </Button>
          <Button
            size="sm"
            busy={busy === "publish"}
            onClick={() =>
              void run("publish", async () => {
                await flush();
                after(await actions.publish());
              })
            }
          >
            {t("dateien.publish")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-1 text-[0.8125rem] text-ink-3">
          <span className="min-w-0 flex-1">{t("dateien.draftHint")}</span>
          <SaveMark state={saving} />
          <Button size="sm" variant="ghost" onClick={() => void flush().then(onClose)}>
            {t("dateien.close")}
          </Button>
        </div>
      )}
      {error ? <p className="px-1 text-[0.875rem] text-rose">{error}</p> : null}
      <Card className="flex flex-col">
        {markdown ? (
          <div className="flex items-center gap-1 border-border-soft border-b px-2 py-1.5">
            {tab("write", t("data.write"))}
            {tab("markdown", t("blocks.markdown"))}
            <span className="ml-auto truncate px-2 text-[0.75rem] text-ink-4 max-sm:hidden">
              {view === "markdown" ? t("data.markdownHint") : null}
            </span>
          </div>
        ) : null}
        {markdown && view === "write" ? (
          <Suspense fallback={<Spinner className="m-5 size-4 text-ink-3" />}>
            <BlockEditor
              text={text}
              onChange={change}
              targets={[]}
              resolve={resolve}
              onOpen={follow}
              ariaLabel={file.name}
            />
          </Suspense>
        ) : (
          <CodeEditor
            value={text}
            onChange={change}
            onLink={follow}
            language="markdown"
            ariaLabel={file.name}
            className="min-h-[50vh] [&_.cm-editor]:min-h-[50vh] sm:[&_.cm-content]:py-5 sm:[&_.cm-line]:px-5"
          />
        )}
      </Card>
    </div>
  );
}

function SaveMark({ state }: { state: "idle" | "saving" | "saved" }) {
  return state === "saving" ? (
    <Spinner className="size-3.5 text-ink-3" />
  ) : state === "saved" ? (
    <Check className="size-4 text-moss" aria-label={t("settings.saved")} />
  ) : null;
}

/** The folder's version against the draft, line by line. */
function Compare({ theirs, mine }: { theirs: string; mine: string }) {
  const lines: DiffLine[] | null = diffLines(theirs, mine);
  if (!lines) {
    return <p className="text-[0.8125rem] text-ink-3">{t("dateien.compareTooFar")}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.8125rem] text-ink-3">{t("dateien.compareHint")}</p>
      <pre className="max-h-[50vh] overflow-auto rounded-md bg-card py-2 font-mono text-[0.75rem] leading-relaxed ring-1 ring-border-soft">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap px-3",
              line.kind === "add" && "bg-moss-tint",
              line.kind === "del" && "bg-rose-tint",
            )}
          >
            {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** „Ersetzen“: an upload that replaces the file, as a draft. */
export function ReplaceButton({
  spaceId,
  mount,
  file,
}: {
  spaceId: string;
  mount: Mount;
  file: MountFile;
}) {
  const actions = useDraftActions(spaceId, mount.id, file.id);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <IconButton
        label={t("dateien.replace")}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <Spinner className="size-4" /> : <Upload className="size-4" />}
      </IconButton>
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked) {
            setBusy(true);
            void actions
              .replace(picked)
              .catch((err: Error) => alert(err.message))
              .finally(() => setBusy(false));
          }
        }}
      />
    </>
  );
}

/** A replacement waiting for „Veröffentlichen“, or caught by a change at the source. */
export function ReplaceBar({
  spaceId,
  mount,
  file,
  draft,
  onPublished,
}: {
  spaceId: string;
  mount: Mount;
  file: MountFile;
  draft: MountDraft;
  onPublished: (how: Exclude<Published, null>) => void;
}) {
  const actions = useDraftActions(spaceId, mount.id, file.id);
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: typeof busy, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      const result = (await fn()) as PublishResult | undefined;
      if (result?.ok) {
        onPublished("published");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem]"
    >
      <Chip tone="warn">{t("dateien.draft")}</Chip>
      <span className="min-w-0 flex-1">
        {draft.conflict
          ? t("dateien.conflictFile", { name: mount.name })
          : t("dateien.replaceWaiting", { name: mount.name })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        busy={busy === "discard"}
        onClick={() => void run("discard", actions.discard)}
      >
        {draft.conflict ? t("dateien.takeTheirs") : t("dateien.discard")}
      </Button>
      <Button
        size="sm"
        busy={busy === "publish"}
        onClick={() => void run("publish", draft.conflict ? actions.keepMine : actions.publish)}
      >
        {draft.conflict ? t("dateien.keepMine") : t("dateien.publish")}
      </Button>
      {error ? <p className="w-full text-rose">{error}</p> : null}
    </div>
  );
}

/** A mount's drafts in its folder view: how many wait, and „Veröffentlichen“ for all of them. */
export function DraftsBar({
  spaceId,
  mount,
  drafts,
}: {
  spaceId: string;
  mount: Mount;
  drafts: MountDraft[];
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const conflicts = drafts.filter((d) => d.conflict).length;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem]"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          {t("dateien.drafts", { count: drafts.length, name: mount.name })}
        </span>
        {conflicts ? ` · ${t("dateien.draftConflicts", { count: conflicts })}` : null}
        {said ? ` · ${said}` : null}
      </span>
      {drafts.length > conflicts ? (
        <Button
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const done = await publishMount(spaceId, mount.id);
              setSaid(t("dateien.publishedAll", { count: done.published }));
            } catch (err) {
              setSaid((err as Error).message);
            } finally {
              setBusy(false);
              await qc.invalidateQueries({ queryKey: ["knowledge", spaceId, "dateien"] });
            }
          }}
        >
          {t("dateien.publish")}
        </Button>
      ) : null}
    </div>
  );
}
