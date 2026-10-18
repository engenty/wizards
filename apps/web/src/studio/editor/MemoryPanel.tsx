import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { cn, Spinner } from "../../ui";
import { PageEditor } from "../project/PageEditor";
import { DATA_ICON, useSpaceData } from "../project/SpaceData";
import { TableEditor } from "../project/TableEditor";

/**
 * What the wizard remembers across all its runs: its part of the space's data – the pages AI
 * steps with the "pages" tool read and write, and the tables its shared lists keep. A few items,
 * so a short list; one opens in place with the space's own editors. Test runs write into a copy
 * of their own.
 */
export function MemoryPanel({
  wizardId,
  projectId,
  def,
  readOnly,
}: {
  wizardId: string;
  projectId: string;
  def: WizardDefinition;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const data = useSpaceData(projectId);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = [
    ...(data.data?.pages ?? [])
      .filter((p) => p.wizardId === wizardId)
      .map((p) => ({ key: `p:${p.id}`, kind: "page" as const, title: p.title, at: p.updatedAt })),
    ...(data.data?.tables ?? [])
      .filter((x) => x.wizardId === wizardId)
      .map((x) => ({
        key: `t:${x.id}`,
        kind: "table" as const,
        title: x.title,
        at: x.updatedAt,
        rows: x.rows,
      })),
  ];
  const usesPages = def.steps.some((s) => s.type === "agent" && s.tools.includes("pages"));
  const sharesLists = (def.lists ?? []).some((l) => l.shared);
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["space-data", projectId] });

  if (open) {
    const id = open.slice(2);
    return (
      <div className="flex flex-col gap-3 px-5 py-5">
        <button
          type="button"
          onClick={() => {
            setOpen(null);
            void refresh();
          }}
          className="inline-flex h-8 items-center gap-1.5 self-start rounded-full px-2.5 text-[0.8125rem] text-ink-2 hover:bg-accent"
        >
          <ArrowLeft className="size-4" /> {t("memory.back")}
        </button>
        {open.startsWith("p:") ? (
          <PageEditor
            pageId={id}
            onGone={() => {
              setOpen(null);
              void refresh();
            }}
          />
        ) : (
          <TableEditor
            tableId={id}
            onGone={() => {
              setOpen(null);
              void refresh();
            }}
          />
        )}
      </div>
    );
  }

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const { id } = await api.post<{ id: string }>(`/api/studio/projects/${projectId}/pages`, {
        title: t("memory.newNote"),
        wizardId,
      });
      await refresh();
      setOpen(`p:${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-4 px-5 py-5">
      {usesPages || sharesLists ? null : (
        <p className="rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem] text-ink-2">
          {t("memory.unused")}
        </p>
      )}
      {data.isLoading ? (
        <Spinner className="size-4 text-ink-4" />
      ) : items.length ? (
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const Icon = DATA_ICON[item.kind];
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => setOpen(item.key)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-paper-2"
                >
                  <Icon className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[0.875rem]">{item.title}</span>
                  <span className="shrink-0 text-[0.75rem] text-ink-4 tabular-nums">
                    {item.kind === "table" ? `${t("data.rows", { n: item.rows ?? 0 })} · ` : ""}
                    {fmt.format(new Date(item.at))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-border border-dashed px-4 py-8 text-center text-[0.8125rem] text-ink-4">
          {t("memory.none")}
        </div>
      )}
      {error ? <p className="text-[0.75rem] text-rose">{error}</p> : null}
      {readOnly ? null : (
        <button
          type="button"
          disabled={adding}
          onClick={() => void add()}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 self-start rounded-full bg-paper-2 px-3.5 font-medium text-[0.8125rem] text-ink-2 hover:bg-paper-3 hover:text-ink",
            adding && "opacity-60",
          )}
        >
          {adding ? <Spinner className="size-3.5" /> : <Plus className="size-3.5" />}
          {t("memory.add")}
        </button>
      )}
      {/* What the tab is, at the foot of the pane: there to read once, not in the way. */}
      <div className="mt-auto flex flex-col gap-1.5 pt-6 text-[0.6875rem] text-ink-4 leading-relaxed">
        <p>{t("memory.explain")}</p>
        <p>{t("memory.testCopy")}</p>
      </div>
    </div>
  );
}
