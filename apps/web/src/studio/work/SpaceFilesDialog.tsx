import type { ProjectFileView } from "@engenty/wizards-shared/projects";
import { Check, FileText } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { Button, cn, Dialog, Input } from "../../ui";
import type { PickedFile } from "../../ui/composer";
import { fileUrl, useProjectFiles } from "../project/data";

/**
 * The space's files to choose from for a message: its documents and assets, newest first, found
 * by name. What is chosen goes with the message by its id, without being uploaded again.
 */
export function SpaceFilesDialog({
  spaceId,
  open,
  onClose,
  onPick,
}: {
  spaceId: string;
  open: boolean;
  onClose: () => void;
  onPick: (files: PickedFile[]) => void;
}) {
  const all = (useProjectFiles(spaceId).data?.files ?? []).filter(
    (f) => (f.kind === "document" || f.kind === "asset") && f.status !== "failed",
  );
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const q = query.trim().toLowerCase();
  const shown = all.filter((f) => !q || f.name.toLowerCase().includes(q)).reverse();
  const close = () => {
    setQuery("");
    setChosen([]);
    onClose();
  };
  const toggle = (id: string) =>
    setChosen((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));
  return (
    <Dialog open={open} onClose={close} title={t("work.files.title")} height="tall">
      <div className="grid gap-3">
        <Input
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("work.files.search")}
        />
        <ul className="-mx-2">
          {shown.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                aria-pressed={chosen.includes(f.id)}
                onClick={() => toggle(f.id)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-paper-2"
              >
                <FileIcon spaceId={spaceId} file={f} />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-[0.875rem] text-ink">{f.name}</span>
                  <span className="text-[0.75rem] text-ink-4">{size(f.size)}</span>
                </span>
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    chosen.includes(f.id)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input",
                  )}
                >
                  {chosen.includes(f.id) ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {shown.length ? null : (
          <p className="py-6 text-center text-[0.875rem] text-ink-3">
            {all.length ? t("work.files.noMatch") : t("work.files.none")}
          </p>
        )}
        <div className="sticky bottom-0 flex justify-end gap-2 bg-card py-3">
          <Button variant="secondary" onClick={close}>
            {t("work.files.cancel")}
          </Button>
          <Button
            disabled={!chosen.length}
            onClick={() => {
              onPick(
                chosen.flatMap((id) => {
                  const f = all.find((file) => file.id === id);
                  return f ? [{ id: f.id, name: f.name, mime: f.mime }] : [];
                }),
              );
              close();
            }}
          >
            {t("work.files.add")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function FileIcon({ spaceId, file }: { spaceId: string; file: ProjectFileView }) {
  return file.mime.startsWith("image/") ? (
    <img
      src={fileUrl(spaceId, file.id)}
      alt=""
      className="size-9 shrink-0 rounded-md bg-paper-2 object-cover ring-1 ring-border"
    />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-paper-2 text-ink-3">
      <FileText className="size-4" />
    </span>
  );
}

const size = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1e6).toFixed(1)} MB`;
