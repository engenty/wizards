import type { SpaceData } from "@engenty-wizards/shared/space-data";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { Button, Card, Dialog, Empty, Input, Label, Select } from "../../ui";
import { Section } from "./Section";

/** The space's tables and pages, and its wizards to name whose they are. */
export function useSpaceData(projectId: string | undefined) {
  return useQuery({
    queryKey: ["space-data", projectId],
    queryFn: () => api.get<SpaceData>(`/api/studio/projects/${projectId}/data`),
    enabled: Boolean(projectId),
  });
}

/** What the Data menu and overview show: `t:<id>` a table, `p:<id>` a page. */
export interface DataItem {
  key: string;
  kind: "table" | "page";
  title: string;
  /** How many rows a table has. */
  rows?: number;
}

/** The tables and pages by whose they are: the space's own first, then each wizard's. */
export function dataGroups(data: SpaceData): { key: string; label: string; items: DataItem[] }[] {
  const of = (wizardId: string | null): DataItem[] => [
    ...data.tables
      .filter((x) => x.wizardId === wizardId)
      .map((x) => ({ key: `t:${x.id}`, kind: "table" as const, title: x.title, rows: x.rows })),
    ...data.pages
      .filter((x) => x.wizardId === wizardId)
      .map((x) => ({ key: `p:${x.id}`, kind: "page" as const, title: x.title })),
  ];
  return [
    { key: "own", label: t("data.own"), items: of(null) },
    ...data.wizards.map((w) => ({ key: w.id, label: w.title, items: of(w.id) })),
  ].filter((g) => g.items.length);
}

export const DATA_ICON = { table: Table2, page: FileText };

/** A new table or page: its title and whose it is. */
function NewDialog({
  kind,
  projectId,
  data,
  onClose,
  onMade,
}: {
  kind: "table" | "page" | null;
  projectId: string;
  data: SpaceData;
  onClose: () => void;
  onMade: (key: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const make = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(
        `/api/studio/projects/${projectId}/${kind === "table" ? "tables" : "pages"}`,
        { title: title.trim(), wizardId: owner || null },
      ),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["space-data", projectId] });
      onMade(`${kind === "table" ? "t" : "p"}:${id}`);
      setTitle("");
      setOwner("");
    },
  });
  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={kind === "table" ? t("data.newTable") : t("data.newPage")}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) {
            make.mutate();
          }
        }}
      >
        <div>
          <Label>{t("data.title")}</Label>
          <Input
            data-autofocus
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("data.owner")}</Label>
          <Select
            value={owner}
            onChange={setOwner}
            options={[
              { value: "", label: t("data.own") },
              ...data.wizards.map((w) => ({ value: w.id, label: w.title })),
            ]}
          />
        </div>
        {make.error ? (
          <p className="text-[0.875rem] text-rose">{(make.error as Error).message}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={make.isPending} disabled={!title.trim()}>
            {t("data.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Data without a table or page picked: all of them by whose they are, and the way to add one. */
export function DataOverview({
  projectId,
  data,
  readOnly,
  onOpen,
}: {
  projectId: string;
  data: SpaceData;
  readOnly: boolean;
  onOpen: (key: string) => void;
}) {
  const [making, setMaking] = useState<"table" | "page" | null>(null);
  const groups = dataGroups(data);
  const updated = new Map<string, string>([
    ...data.tables.map((x) => [`t:${x.id}`, x.updatedAt] as const),
    ...data.pages.map((x) => [`p:${x.id}`, x.updatedAt] as const),
  ]);
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium" });
  return (
    <Section
      title={t("space.data")}
      hint={t("data.hint")}
      plain
      action={
        readOnly ? null : (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setMaking("table")}>
              <Plus className="size-4" /> {t("data.table")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMaking("page")}>
              <Plus className="size-4" /> {t("data.page")}
            </Button>
          </div>
        )
      }
    >
      {groups.length ? (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1.5">
              <p className="px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
                {group.label}
              </p>
              <Card className="flex flex-col p-1.5">
                {group.items.map((item) => {
                  const Icon = DATA_ICON[item.kind];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onOpen(item.key)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent"
                    >
                      <Icon className="size-4 shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1 truncate text-[0.875rem]">{item.title}</span>
                      <span className="shrink-0 text-[0.75rem] text-ink-3 tabular-nums">
                        {item.kind === "table" ? `${t("data.rows", { n: item.rows ?? 0 })} · ` : ""}
                        {fmt.format(new Date(updated.get(item.key) ?? Date.now()))}
                      </span>
                    </button>
                  );
                })}
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>{t("data.empty")}</Empty>
        </Card>
      )}
      <NewDialog
        kind={making}
        projectId={projectId}
        data={data}
        onClose={() => setMaking(null)}
        onMade={(key) => {
          setMaking(null);
          onOpen(key);
        }}
      />
    </Section>
  );
}
