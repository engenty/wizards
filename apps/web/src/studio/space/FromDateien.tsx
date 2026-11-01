import type { StudioKnowledgeSourceFormProps } from "@engenty/wizards/plugin/studio";
import { ChevronRight, Folder, FolderInput } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { lang, t } from "../../lib/i18n";
import { useCurrentSpace } from "../../lib/session";
import { Button, cn, Input, Label, Select, Spinner } from "../../ui";
import { type Node, treeOf } from "./Dateien";
import { useMountFiles, useMounts } from "./dateien-data";
import type { SourceKind } from "./sources";

/**
 * „Aus Dateien übernehmen“ (docs/plans/media-and-files.md, step 8): the core's kind of source on a
 * mount of Dateien. Its form picks a mount and one of its folders (or the whole mount); the source
 * copies that folder into Wissen and keeps it current.
 */

/** A source's address: the wizards' path of the folder, `dateien/<mount>/<folder>`. */
export const addressOf = (slug: string, folder: string) =>
  ["dateien", slug, ...folder.split("/").filter(Boolean)].join("/");

function FromDateienForm({ propose, busy, error }: StudioKnowledgeSourceFormProps) {
  const { space } = useCurrentSpace();
  const mounts = useMounts(space?.id);
  const list = mounts.data?.mounts ?? [];
  const [mountId, setMountId] = useState<string | null>(null);
  const mount = list.find((m) => m.id === mountId) ?? list[0];
  const files = useMountFiles(space?.id ?? "", mount);
  const tree = useMemo(() => treeOf(files.data?.files ?? []), [files.data]);
  const [folder, setFolder] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: another mount starts at its top.
  useEffect(() => {
    setFolder("");
    setOpen(new Set());
  }, [mount?.id]);
  if (!mounts.data) {
    return (
      <div className="flex h-32 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (!list.length) {
    return (
      <p className="text-[0.875rem] text-ink-2">
        {t("src.dateienNone")}{" "}
        <Link to="/space/files" className="text-ink underline underline-offset-2">
          {t("src.dateienOpen")}
        </Link>
      </p>
    );
  }
  const row = (node: Node, depth: number) => {
    const here = folder === node.path;
    const shut = node.folders.length > 0 && !open.has(node.path);
    return (
      <div key={node.path || "/"}>
        <div
          className={cn(
            "flex items-center gap-1 rounded-lg pr-3 text-[0.875rem]",
            here ? "bg-accent text-ink" : "hover:bg-accent",
          )}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          <button
            type="button"
            aria-label={shut ? t("know.expand") : t("know.collapse")}
            disabled={!node.folders.length}
            onClick={() =>
              setOpen((was) => {
                const next = new Set(was);
                next.has(node.path) ? next.delete(node.path) : next.add(node.path);
                return next;
              })
            }
            className="grid size-6 place-items-center text-ink-3 disabled:invisible"
          >
            <ChevronRight className={cn("size-3.5 transition", shut ? null : "rotate-90")} />
          </button>
          <button
            type="button"
            aria-pressed={here}
            onClick={() => setFolder(node.path)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          >
            <Folder className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{node.name || mount.name}</span>
            <span className="text-[0.75rem] text-ink-3">
              {t("dateien.count", { files: node.count.toLocaleString(lang) })}
            </span>
          </button>
        </div>
        {shut ? null : node.folders.map((f) => row(f, depth + 1))}
      </div>
    );
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void propose({
          address: addressOf(mount.slug, folder),
          label: label.trim() || undefined,
        }).catch(() => {});
      }}
    >
      {list.length > 1 ? (
        <div>
          <Label>{t("src.dateienMount")}</Label>
          <Select
            value={mount.id}
            onChange={(v) => setMountId(v)}
            options={list.map((m) => ({ value: m.id, label: m.name }))}
          />
        </div>
      ) : null}
      <div>
        <Label>{t("src.dateienFolder")}</Label>
        <div className="flex max-h-72 flex-col overflow-y-auto rounded-xl p-1 ring-1 ring-border-soft">
          {!files.data ? (
            <div className="flex h-24 items-center justify-center text-ink-3">
              <Spinner />
            </div>
          ) : (
            row(tree, 0)
          )}
        </div>
      </div>
      <div>
        <Label>{t("src.label")}</Label>
        <Input
          value={label}
          maxLength={120}
          placeholder={folder.split("/").pop() || mount.name}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
      <div className="flex justify-end">
        <Button type="submit" busy={busy}>
          {t("src.propose")}
        </Button>
      </div>
    </form>
  );
}

/** The core's kinds, beside what plugins register. */
export const CORE_KINDS: Omit<SourceKind, "manual">[] = [
  {
    kind: "dateien",
    plugin: "core",
    serial: 0,
    label: () => t("src.dateien"),
    hint: () => t("src.dateienHint"),
    icon: FolderInput,
    form: FromDateienForm,
  },
];
