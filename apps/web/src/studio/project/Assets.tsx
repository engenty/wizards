import { formatBytes } from "@engenty-wizards/shared/numbers";
import {
  type AssetSection,
  PROJECT_LIMITS,
  type ProjectFileView,
} from "@engenty-wizards/shared/projects";
import {
  ExternalLink,
  Eye,
  FolderPlus,
  LayoutGrid,
  Link,
  List,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Button, Dialog, IconButton, Input, Label, Spinner, Tabs } from "../../ui";
import { fileUrl, type ProjectFiles, useAutosave, useFileActions, useLayout } from "./data";
import { type Actions, CHECKER, Description, FromUrl, type MoveTo, Preview, Tiles } from "./Files";
import {
  type AddEntry,
  AddMenu,
  DropArea,
  MoveButton,
  newId,
  SearchField,
  Section,
} from "./Section";

/** What an asset may be: pictures, clips, recordings, PDFs, fonts, Lottie animations, 3D models. */
const ASSET_ACCEPT =
  "image/*,video/*,audio/*,application/pdf,.pdf,.woff2,.woff,.ttf,.otf,.json,.glb,.gltf";

const assetMeta = (file: ProjectFileView) =>
  [
    (file.name.includes(".") ? file.name.split(".").pop() : file.mime.split("/").pop())
      ?.toUpperCase()
      .slice(0, 5),
    formatBytes(file.size),
  ]
    .filter(Boolean)
    .join(" · ");

/** An asset, opened: the picture large, a clip or a recording with its player. */
function AssetPreview({
  projectId,
  file,
  actions,
  onClose,
}: {
  projectId: string;
  file: ProjectFileView;
  actions: Actions;
  onClose: () => void;
}) {
  const src = fileUrl(projectId, file.id);
  return (
    <Dialog open onClose={onClose} wide="page" title={file.name}>
      <div className="-mt-2 mb-4 flex items-center justify-between gap-3">
        <span className="text-[0.8125rem] text-ink-3">{assetMeta(file)}</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label={t("project.openOriginal")}
          title={t("project.openOriginal")}
          className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>
      {file.mime.startsWith("image/") ? (
        <div className="overflow-hidden rounded-lg" style={CHECKER}>
          <img src={src} alt="" className="mx-auto max-h-[68dvh] object-contain" />
        </div>
      ) : file.mime.startsWith("video/") ? (
        // biome-ignore lint/a11y/useMediaCaption: the admin's own clip
        <video src={src} controls className="max-h-[68dvh] w-full rounded-lg bg-black" />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: the admin's own recording
        <audio src={src} controls className="w-full" />
      )}
      <div className="mt-4">
        <Description file={file} actions={actions} />
      </div>
    </Dialog>
  );
}

function AssetRow({
  projectId,
  file,
  actions,
  moveTo,
  onPreview,
  onRemove,
}: {
  projectId: string;
  file: ProjectFileView;
  actions: Actions;
  moveTo?: MoveTo;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group/row flex items-start gap-3 rounded-lg bg-paper p-2 ring-1 ring-border-soft">
      <button
        type="button"
        aria-label={`${t("project.preview")}: ${file.name}`}
        onClick={onPreview}
        className="size-14 shrink-0 cursor-zoom-in overflow-hidden rounded-md bg-paper-2"
      >
        <Preview projectId={projectId} file={file} small />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <button
            type="button"
            onClick={onPreview}
            title={file.name}
            className="min-w-0 truncate font-medium text-[0.875rem] hover:underline"
          >
            {file.name}
          </button>
          <span className="text-[0.75rem] text-ink-3">{assetMeta(file)}</span>
        </div>
        <Description file={file} actions={actions} />
      </div>
      <div className="flex shrink-0 items-start opacity-0 transition focus-within:opacity-100 group-hover/row:opacity-100 coarse:opacity-100">
        <IconButton label={t("project.preview")} onClick={onPreview}>
          <Eye className="size-4" />
        </IconButton>
        {moveTo && !actions.readOnly ? (
          <MoveButton
            options={moveTo.options}
            value={moveTo.current(file)}
            onChange={(value) => moveTo.onMove(file, value)}
            className="size-9"
          />
        ) : null}
        {actions.readOnly ? null : (
          <IconButton label={t("project.remove")} onClick={onRemove} className="hover:text-rose">
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** A section's name: a new one, or the open one renamed or removed. */
function SectionName({
  section,
  onSave,
  onRemove,
  onClose,
}: {
  section: AssetSection | null;
  onSave: (title: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(section?.title ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      title={section ? t("project.assetSectionRename") : t("project.assetSectionAdd")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) {
            onSave(title.trim());
            onClose();
          }
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <Label>{t("project.assetSectionName")}</Label>
          <Input
            autoFocus
            value={title}
            maxLength={80}
            placeholder={t("project.assetSectionTitle")}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          {onRemove ? (
            <Button variant="danger" onClick={onRemove}>
              {t("project.sectionRemove")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!title.trim()}>
            {section ? t("settings.save") : t("project.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Pictures, graphics, clips and recordings the wizards may use. Sections are optional: each is a
 * tab of one kind, named by its title ("Icons", "Background images"); the assets in none are the
 * general ones, in the first tab.
 */
export function Assets({
  projectId,
  data,
  readOnly,
  sections: savedSections,
  save,
}: {
  projectId: string;
  data: ProjectFiles;
  readOnly?: boolean;
  sections: AssetSection[];
  save: (patch: { assetSections: AssetSection[] }) => Promise<unknown>;
}) {
  const actions = useFileActions(projectId, readOnly);
  const [layout, toggleLayout] = useLayout("assets", "cards");
  const [filter, setFilter] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [sections, setSections] = useState(savedSections);
  const [tab, setTab] = useState("");
  /** The naming dialog: "new" for a new section, "current" for the open one. */
  const [naming, setNaming] = useState<"new" | "current" | null>(null);
  const [fromUrl, setFromUrl] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const status = useAutosave({ assetSections: sections }, save);

  const all = data.files.filter((f) => f.kind === "asset");
  const byId = new Map(all.map((f) => [f.id, f]));
  const grouped = new Set(sections.flatMap((s) => s.assets));
  const current = sections.find((s) => s.id === tab) ?? null;
  const inTab = current
    ? current.assets.map((id) => byId.get(id)).filter((f): f is ProjectFileView => !!f)
    : all.filter((f) => !grouped.has(f.id));
  const preview = all.find((f) => f.id === previewId);
  const words = filter.trim().toLowerCase();
  const files = words
    ? inTab.filter((f) => `${f.name} ${f.description}`.toLowerCase().includes(words))
    : inTab;

  /** Takes an asset out of every section and, with `to`, puts it at the end of that one. */
  const place = (fileId: string, to: string | null) =>
    setSections((list) =>
      list.map((s) => {
        const rest = s.assets.filter((id) => id !== fileId);
        return { ...s, assets: s.id === to ? [...rest, fileId] : rest };
      }),
    );
  const upload = async (picked: File[]) => {
    const to = current?.id ?? null;
    for (const file of await actions.upload("asset", picked)) {
      place(file.id, to);
    }
  };
  const drop = (file: ProjectFileView) => {
    if (confirm(t("project.removeConfirm", { name: file.name }))) {
      void actions.remove(file.id);
      place(file.id, null);
    }
  };
  const moveTo: MoveTo | undefined = sections.length
    ? {
        options: [
          { value: "", label: t("project.assetsGeneral") },
          ...sections.map((s) => ({ value: s.id, label: s.title || t("project.sectionUntitled") })),
        ],
        current: (file) => sections.find((s) => s.assets.includes(file.id))?.id ?? "",
        onMove: (file, value) => place(file.id, value || null),
      }
    : undefined;

  const add: AddEntry[] = [
    {
      label: t("project.assetUpload"),
      icon: <Upload className="size-4 shrink-0" />,
      onPick: () => picker.current?.click(),
    },
    {
      label: t("project.assetFromUrl"),
      icon: <Link className="size-4 shrink-0" />,
      onPick: () => setFromUrl(true),
    },
    ...(sections.length < PROJECT_LIMITS.logoSections
      ? [
          {
            label: t("project.assetSectionAdd"),
            icon: <FolderPlus className="size-4 shrink-0" />,
            onPick: () => setNaming("new"),
          },
        ]
      : []),
  ];

  // Above the card: the tabs, and on their right the search and the switch between list and cards.
  const tabs =
    sections.length || all.length ? (
      <div className="flex items-center gap-2">
        <div className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 pb-0.5">
          {sections.length ? (
            <Tabs
              value={tab}
              onChange={(id) => {
                setTab(id);
                setFilter("");
              }}
              label={t("project.assets")}
              options={[
                { id: "", label: t("project.assetsGeneral") },
                ...sections.map((s) => ({
                  id: s.id,
                  label: s.title || t("project.sectionUntitled"),
                })),
              ]}
            />
          ) : null}
          {current && !readOnly ? (
            <IconButton
              label={t("project.assetSectionRename")}
              onClick={() => setNaming("current")}
            >
              <Pencil className="size-4" />
            </IconButton>
          ) : null}
        </div>
        {inTab.length ? (
          <>
            <div className="w-56 max-w-[45%] shrink">
              <SearchField
                value={filter}
                onChange={setFilter}
                placeholder={t("project.assetSearch")}
              />
            </div>
            <IconButton
              label={layout === "list" ? t("project.viewCards") : t("project.viewList")}
              onClick={toggleLayout}
            >
              {layout === "list" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
            </IconButton>
          </>
        ) : null}
      </div>
    ) : null;

  return (
    <Section
      title={t("project.assets")}
      hint={t("project.assetsHint")}
      save={status}
      tabs={tabs}
      action={readOnly ? null : <AddMenu entries={add} />}
    >
      <input
        ref={picker}
        type="file"
        multiple
        accept={ASSET_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) {
            void upload(picked);
          }
        }}
      />
      {files.length ? (
        layout === "cards" ? (
          <Tiles
            projectId={projectId}
            kind="asset"
            files={files}
            actions={actions}
            moveTo={moveTo}
            onRemove={drop}
            onPreview={(file) => setPreviewId(file.id)}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {files.map((file) => (
              <AssetRow
                key={file.id}
                projectId={projectId}
                file={file}
                actions={actions}
                moveTo={moveTo}
                onPreview={() => setPreviewId(file.id)}
                onRemove={() => drop(file)}
              />
            ))}
          </ul>
        )
      ) : inTab.length ? null : readOnly ? (
        // A local install sends its wizards, not what the project keeps for them.
        <p className="text-[0.875rem] text-ink-3">{t("project.staysLocal")}</p>
      ) : (
        <DropArea
          accept={ASSET_ACCEPT}
          onFiles={(picked) => void upload(picked)}
          className="h-16 w-full"
        >
          {actions.busy ? <Spinner className="size-4" /> : <Upload className="size-4" />}
          {t("project.drop")} <span className="underline">{t("project.assetAdd")}</span>
        </DropArea>
      )}
      {actions.error ? <p className="mt-3 text-[0.875rem] text-rose">{actions.error}</p> : null}
      {preview ? (
        <AssetPreview
          projectId={projectId}
          file={preview}
          actions={actions}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
      {naming ? (
        <SectionName
          section={naming === "current" ? current : null}
          onClose={() => setNaming(null)}
          onSave={(title) => {
            if (naming === "current" && current) {
              setSections((list) => list.map((s) => (s.id === current.id ? { ...s, title } : s)));
            } else {
              const id = newId();
              setSections((list) => [...list, { id, title, assets: [] }]);
              setTab(id);
            }
          }}
          onRemove={
            naming === "current" && current
              ? () => {
                  if (
                    !current.assets.length ||
                    confirm(t("project.assetSectionRemoveConfirm", { name: current.title }))
                  ) {
                    setSections((list) => list.filter((s) => s.id !== current.id));
                    setTab("");
                    setNaming(null);
                  }
                }
              : undefined
          }
        />
      ) : null}
      {fromUrl ? (
        <FromUrl
          kind="asset"
          onClose={() => setFromUrl(false)}
          fetchUrl={(url) => actions.fromUrl("asset", url)}
          onAdded={(added) => {
            for (const file of added) {
              place(file.id, current?.id ?? null);
            }
          }}
        />
      ) : null}
    </Section>
  );
}
