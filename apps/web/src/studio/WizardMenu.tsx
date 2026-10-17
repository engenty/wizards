import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, MoreVertical, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import { withBase } from "../lib/base";
import { t } from "../lib/i18n";
import { useIsAdmin } from "../lib/session";
import { Button, cn, Dialog } from "../ui";
import { useDismiss } from "./AppFrame";

/**
 * A wizard's ⋮ menu, in the editor's header and on its card: a copy of it, the package to keep,
 * and – for whoever manages the team – deleting it, behind a dialog that says what goes with it.
 */
export function WizardMenu({
  wizard,
  className,
  onDeleted,
}: {
  wizard: { id: string; title: string; published?: boolean };
  className?: string;
  /** Where to go once it is gone; the card's list just loses it. */
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const admin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const duplicate = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/api/studio/wizards/${wizard.id}/duplicate`),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      navigate(`/edit/${id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/wizards/${wizard.id}`),
    onSuccess: async () => {
      setAsking(false);
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onDeleted?.();
    },
  });
  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  return (
    // A click here is never the card's: it opens the wizard.
    <div ref={ref} className={cn("relative", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={t("wizardMenu.label")}
        title={t("wizardMenu.label")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "grid size-8 place-items-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink",
          open && "bg-accent text-ink",
        )}
      >
        <MoreVertical className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-60 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={duplicate.isPending}
            onClick={() => {
              setOpen(false);
              duplicate.mutate();
            }}
          >
            <Copy className="size-4 shrink-0" /> {t("wizardMenu.duplicate")}
          </button>
          <a
            role="menuitem"
            href={withBase(`/api/studio/wizards/${wizard.id}/export`)}
            download
            className={item}
            onClick={() => setOpen(false)}
          >
            <Download className="size-4 shrink-0" /> {t("editor.export")}
          </a>
          {admin ? (
            <>
              <div className="mx-2 my-1.5 h-px bg-border-soft" />
              <button
                type="button"
                role="menuitem"
                className={cn(item, "text-rose hover:bg-rose-tint hover:text-rose")}
                onClick={() => {
                  setOpen(false);
                  setAsking(true);
                }}
              >
                <Trash2 className="size-4 shrink-0" /> {t("wizardMenu.delete")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={t("wizardMenu.deleteTitle", { title: wizard.title })}
      >
        <p className="-mt-2 text-[0.875rem] text-ink-2">
          {wizard.published ? t("wizardMenu.deletePublished") : t("wizardMenu.deleteDraft")}
        </p>
        {remove.error ? (
          <p className="mt-3 text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAsking(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="size-4" /> {t("wizardMenu.delete")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
