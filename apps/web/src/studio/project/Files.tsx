import type { ProjectFileView } from "@engenty-wizards/shared/projects";
import { Box, Check, Eye, FileText, Film, Music, Plus, Sparkles, Star, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Button, Chip, cn, Dialog, IconButton, Input, Label, Spinner } from "../../ui";
import { fileUrl, type useFileActions } from "./data";
import { DropArea, MoveButton } from "./Section";

export type Actions = ReturnType<typeof useFileActions>;

/** A grid both dark and light logos stand out on, as image editors show transparency. */
export const CHECKER = {
  backgroundImage: "repeating-conic-gradient(#c9c9c9 0% 25%, #dedede 0% 50%)",
  backgroundSize: "16px 16px",
};

/**
 * The file's description: the person's text, or what the model wrote once it had looked. It
 * reads as text and is edited in place; a click into it is all it takes.
 */
export function Description({ file, actions }: { file: ProjectFileView; actions: Actions }) {
  const [text, setText] = useState(file.description);
  const server = useRef(file.description);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (file.description !== server.current) {
      // What arrives from the server replaces the text unless the person is writing in it.
      setText((mine) => (mine === server.current ? file.description : mine));
      server.current = file.description;
    }
  }, [file.description]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(() => {
    const el = area.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [text]);
  const looking = file.status === "pending" && !text;
  // Where the project is not changed, the description reads as plain text; none is no line.
  if (actions.readOnly) {
    return text ? <p className="text-[0.8125rem] text-ink-2 leading-snug">{text}</p> : null;
  }
  return (
    <textarea
      ref={area}
      rows={1}
      value={text}
      maxLength={600}
      placeholder={looking ? t("project.describing") : t("project.description")}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() !== file.description) {
          server.current = text.trim();
          void actions.describe(file.id, text.trim());
        }
      }}
      className="-mx-1 block w-[calc(100%+0.5rem)] resize-none overflow-hidden rounded-md bg-transparent px-1 py-0.5 text-[0.8125rem] text-ink-2 leading-snug outline-none transition placeholder:text-ink-4 hover:bg-paper-2 focus:bg-card focus:text-ink focus:ring-1 focus:ring-border"
    />
  );
}

export function remove(file: ProjectFileView, actions: Actions) {
  if (confirm(t("project.removeConfirm", { name: file.name }))) {
    void actions.remove(file.id);
  }
}

export function Preview({
  projectId,
  file,
  small,
}: {
  projectId: string;
  file: ProjectFileView;
  /** A thumbnail in a list row: a clip shows its first frame without controls. */
  small?: boolean;
}) {
  const src = fileUrl(projectId, file.id);
  if (file.mime.startsWith("image/")) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className={cn("size-full", file.kind === "logo" ? "object-contain p-3" : "object-cover")}
      />
    );
  }
  if (file.mime.startsWith("video/")) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: a preview of the admin's own clip
      <video
        src={`${src}#t=0.1`}
        preload="metadata"
        controls={!small}
        className="size-full object-cover"
      />
    );
  }
  if (file.mime.startsWith("font/")) {
    return <FontPreview src={src} small={small} />;
  }
  const size = small ? "size-5" : "size-7";
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 text-ink-3">
      {file.mime.startsWith("audio/") ? (
        <Music className={size} />
      ) : file.mime === "application/pdf" ? (
        <FileText className={size} />
      ) : file.mime === "application/json" ? (
        <Sparkles className={size} />
      ) : file.mime.startsWith("model/") ? (
        <Box className={size} />
      ) : (
        <Film className={size} />
      )}
      {small ? null : (
        <span className="text-[0.6875rem] uppercase tracking-wide">
          {file.mime === "application/json" ? "Lottie / JSON" : file.mime.split("/").pop()}
        </span>
      )}
    </div>
  );
}

/** A font file shown in itself: "Aa", loaded from the file. */
function FontPreview({ src, small }: { src: string; small?: boolean }) {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    const name = `asset-${src.split("/").slice(-2, -1)[0]}`;
    const face = new FontFace(name, `url("${src}")`);
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        setFamily(name);
      })
      .catch(() => setFamily(null));
  }, [src]);
  return (
    <div
      className={cn(
        "flex size-full items-center justify-center text-ink",
        small ? "text-[1.25rem]" : "text-[2.75rem]",
      )}
      style={family ? { fontFamily: `"${family}"` } : undefined}
    >
      Aa
    </div>
  );
}

/** Where a logo may go: no section, or one of the space's logo sections. */
export interface MoveTo {
  options: { value: string; label: string }[];
  current: (file: ProjectFileView) => string;
  onMove: (file: ProjectFileView, value: string) => void;
}

/** What a dragged logo tile carries, so a group of logos can take it. */
export const LOGO_DRAG = "application/x-wizards-logo";

export function Tiles({
  projectId,
  kind,
  files,
  actions,
  accept,
  addLabel,
  onUpload,
  onPreview,
  mainId,
  onMakeMain,
  moveTo,
  onRemove,
}: {
  projectId: string;
  kind: "logo" | "asset";
  files: ProjectFileView[];
  actions: Actions;
  /** With these, the grid ends in a tile that takes new files. */
  accept?: string;
  addLabel?: string;
  /** What the add tile does with a file; uploading it as `kind` without. */
  onUpload?: (files: File[]) => void;
  /** Opens a file large; without it the tiles are not clickable. */
  onPreview?: (file: ProjectFileView) => void;
  /** Logos: the main one, marked; every other one offers `onMakeMain`. */
  mainId?: string;
  onMakeMain?: (file: ProjectFileView) => void;
  /** Logos with sections: each tile can be moved, by its menu or by dragging. */
  moveTo?: MoveTo;
  onRemove?: (file: ProjectFileView) => void;
}) {
  const drop = (file: ProjectFileView) => (onRemove ? onRemove(file) : remove(file, actions));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-3">
      {files.map((file) => (
        <div
          key={file.id}
          draggable={moveTo && !actions.readOnly ? true : undefined}
          onDragStart={(e) => e.dataTransfer.setData(LOGO_DRAG, file.id)}
          className="group relative flex flex-col gap-1.5 rounded-lg bg-paper p-2 pb-2.5 ring-1 ring-border-soft"
        >
          {file.id === mainId ? (
            <span className="absolute -top-3 left-3 z-10 rounded-full ring-2 ring-card">
              <Chip tone="ember">{t("project.logoMain")}</Chip>
            </span>
          ) : null}
          <div
            className="relative h-28 overflow-hidden rounded-md bg-paper-2"
            style={kind === "logo" ? CHECKER : undefined}
          >
            {onPreview && file.mime.startsWith("image/") ? (
              <button
                type="button"
                aria-label={`${t("project.preview")}: ${file.name}`}
                onClick={() => onPreview(file)}
                className="block size-full cursor-zoom-in"
              >
                <Preview projectId={projectId} file={file} />
              </button>
            ) : (
              <Preview projectId={projectId} file={file} />
            )}
            <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100">
              {onPreview ? (
                <IconButton
                  label={t("project.preview")}
                  onClick={() => onPreview(file)}
                  className="size-8 bg-card shadow-soft"
                >
                  <Eye className="size-4" />
                </IconButton>
              ) : null}
              {onMakeMain && file.id !== mainId && !actions.readOnly ? (
                <IconButton
                  label={t("project.logoMakeMain")}
                  onClick={() => onMakeMain(file)}
                  className="size-8 bg-card shadow-soft"
                >
                  <Star className="size-4" />
                </IconButton>
              ) : null}
              {moveTo && !actions.readOnly ? (
                <MoveButton
                  options={moveTo.options}
                  value={moveTo.current(file)}
                  onChange={(value) => moveTo.onMove(file, value)}
                  className="bg-card shadow-soft"
                />
              ) : null}
              {actions.readOnly ? null : (
                <IconButton
                  label={t("project.remove")}
                  onClick={() => drop(file)}
                  className="size-8 bg-card shadow-soft hover:text-rose"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </div>
          </div>
          {kind === "asset" ? (
            <div className="truncate px-0.5 text-[0.75rem] text-ink-3" title={file.name}>
              {file.name}
            </div>
          ) : null}
          <Description file={file} actions={actions} />
        </div>
      ))}
      {addLabel && !actions.readOnly ? (
        <DropArea
          accept={accept}
          multiple={false}
          onFiles={(picked) => (onUpload ? onUpload(picked) : actions.upload(kind, picked))}
          className="min-h-28 flex-col p-3"
        >
          {actions.busy ? <Spinner className="size-5" /> : <Plus className="size-5" />}
          {addLabel}
        </DropArea>
      ) : null}
    </div>
  );
}

type Candidate = { url: string; hint: string };

/**
 * A logo or an asset from a web address. The address of a file adds it; the address of a web
 * page shows the logos or pictures found on it, to pick one or more.
 */
export function FromUrl({
  kind,
  fetchUrl,
  onAdded,
  onClose,
}: {
  kind: "logo" | "asset";
  fetchUrl: (url: string) => Promise<{ file?: ProjectFileView; candidates?: Candidate[] }>;
  onAdded: (files: ProjectFileView[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await fetchUrl(url.trim());
      if (answer.file) {
        onAdded([answer.file]);
        onClose();
      } else if (answer.candidates?.length) {
        setFound(answer.candidates);
        setPicked([answer.candidates[0].url]);
      } else {
        setError(t(kind === "logo" ? "project.logoNoneFound" : "project.assetNoneFound"));
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  const take = async () => {
    setBusy(true);
    setError(null);
    const added: ProjectFileView[] = [];
    try {
      for (const one of picked) {
        const answer = await fetchUrl(one);
        if (answer.file) {
          added.push(answer.file);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
    if (added.length) {
      onAdded(added);
    }
    if (added.length === picked.length) {
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      wide={found ? true : undefined}
      title={
        found
          ? t(kind === "logo" ? "project.logoFound" : "project.assetFound")
          : t(kind === "logo" ? "project.logoFromUrl" : "project.assetFromUrl")
      }
    >
      {found ? (
        <div className="flex flex-col gap-5">
          <p className="-mt-2 text-[0.875rem] text-ink-3">
            {t(kind === "logo" ? "project.logoFoundHint" : "project.assetFoundHint")}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {found.map((c) => {
              const on = picked.includes(c.url);
              return (
                <button
                  key={c.url}
                  type="button"
                  aria-pressed={on}
                  title={c.hint}
                  onClick={() =>
                    setPicked((all) => (on ? all.filter((u) => u !== c.url) : [...all, c.url]))
                  }
                  className={cn(
                    "relative h-28 overflow-hidden rounded-lg ring-1 transition",
                    on ? "ring-2 ring-ember" : "ring-border-soft hover:ring-ink-4",
                  )}
                  style={CHECKER}
                >
                  <img
                    src={c.url}
                    alt=""
                    className={cn(
                      "size-full",
                      kind === "logo" ? "object-contain p-3" : "object-cover",
                    )}
                  />
                  {on ? (
                    <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-ember text-white">
                      <Check className="size-3.5" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t("run.back")}
            </Button>
            <Button busy={busy} disabled={!picked.length} onClick={() => void take()}>
              {picked.length > 1 ? t("project.addMany", { n: picked.length }) : t("project.add")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
          className="flex flex-col gap-5"
        >
          <div>
            <Label>{t("project.logoUrl")}</Label>
            <Input
              autoFocus
              value={url}
              inputMode="url"
              placeholder="https://example.com"
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="mt-1.5 text-[0.8125rem] text-ink-3">
              {t(kind === "logo" ? "project.logoUrlHint" : "project.assetUrlHint")}
            </p>
          </div>
          {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={busy} disabled={!url.trim()}>
              {t("run.next")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
