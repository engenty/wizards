import type {
  DurationUnit,
  NumberStyle,
  TableColumn,
} from "@engenty-wizards/shared/engenty/data-tables";
import {
  columnIdOf,
  type SpaceTable,
  type SpaceTableRow,
} from "@engenty-wizards/shared/space-data";
import { cellValue } from "@engenty-wizards/shared/store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { type Key, t } from "../../lib/i18n";
import {
  Button,
  Card,
  cn,
  Dialog,
  IconButton,
  Input,
  Label,
  Select,
  Switch,
  Textarea,
} from "../../ui";
import { KnowledgeHeader } from "./Knowledge";

const MS: Record<DurationUnit, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const TYPES: TableColumn["type"][] = ["text", "number", "date", "duration", "select", "boolean"];

/** What a person types for a cell, from what is stored: dates for the browser's pickers. */
function draftOf(column: TableColumn, value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (column.type === "duration" && typeof value === "number") {
    return String(value / MS[column.format.inputUnit]);
  }
  if (column.type === "date" && column.format.kind === "datetime" && typeof value === "string") {
    const d = new Date(value);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  return String(value);
}

const cellField =
  "w-full min-w-0 rounded-md bg-transparent px-2 py-1.5 text-[0.875rem] outline-none transition placeholder:text-ink-4 hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring disabled:hover:bg-transparent";

/** One cell: typed into in place, saved when the person leaves it. */
function Cell({
  column,
  value,
  readOnly,
  invalid,
  onSave,
}: {
  column: TableColumn;
  value: unknown;
  readOnly: boolean;
  /** The runtime refused what was typed: it stays, marked, to be corrected. */
  invalid: boolean;
  onSave: (value: unknown) => void;
}) {
  const stored = draftOf(column, value);
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const commit = (next = draft) => {
    if (next !== stored) {
      onSave(cellValue(column, next));
    }
  };
  if (column.type === "boolean") {
    return (
      <div className="px-2 py-1.5">
        <input
          type="checkbox"
          checked={value === true}
          disabled={readOnly}
          onChange={(e) => onSave(e.target.checked)}
          aria-label={column.name}
          className="size-4 accent-[var(--ember)]"
        />
      </div>
    );
  }
  if (column.type === "select" && column.format.multiple) {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    const label = (id: string) => column.format.options.find((o) => o.id === id)?.label ?? id;
    return (
      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
        {picked.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full bg-paper-2 py-0.5 pr-1 pl-2 text-[0.75rem]"
          >
            {label(id)}
            {readOnly ? null : (
              <button
                type="button"
                aria-label={t("data.removeOption")}
                onClick={() => onSave(picked.filter((x) => x !== id))}
                className="rounded-full text-ink-3 hover:text-ink"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {readOnly ? null : (
          <select
            value=""
            onChange={(e) => e.target.value && onSave([...picked, e.target.value])}
            aria-label={column.name}
            className="h-7 rounded-md bg-transparent px-1 text-[0.75rem] text-ink-3 outline-none hover:bg-accent"
          >
            <option value="">+</option>
            {column.format.options
              .filter((o) => !picked.includes(o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
        )}
      </div>
    );
  }
  if (column.type === "select") {
    return (
      <select
        value={typeof value === "string" ? value : ""}
        disabled={readOnly}
        onChange={(e) => onSave(e.target.value || null)}
        aria-label={column.name}
        className={cellField}
      >
        <option value="" />
        {column.format.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (column.type === "text" && column.format?.style && column.format.style !== "single") {
    return (
      <textarea
        value={draft}
        rows={1}
        disabled={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        aria-label={column.name}
        className={cn(cellField, "field-sizing-content max-h-40 resize-none")}
      />
    );
  }
  const type =
    column.type === "date"
      ? { date: "date", datetime: "datetime-local", time: "time" }[column.format.kind]
      : "text";
  return (
    <input
      type={type}
      inputMode={column.type === "number" || column.type === "duration" ? "decimal" : undefined}
      value={draft}
      disabled={readOnly}
      onChange={(e) => {
        setDraft(e.target.value);
        // The pickers have no moment of leaving: a date is saved as it is chosen.
        if (column.type === "date") {
          commit(e.target.value);
        }
      }}
      onBlur={() => column.type !== "date" && commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(stored);
        }
      }}
      aria-label={column.name}
      className={cn(
        cellField,
        (column.type === "number" || column.type === "duration") && "text-right tabular-nums",
        invalid && "ring-1 ring-rose",
      )}
    />
  );
}

/** What a column's heading says besides its name: the currency, the unit. */
function columnNote(column: TableColumn): string | null {
  if (column.type === "number" && column.format.style === "currency") {
    return column.format.currency ?? null;
  }
  if (column.type === "number" && column.format.style === "percent") {
    return "%";
  }
  if (column.type === "duration") {
    return t(`data.unit.${column.format.inputUnit}` as Key);
  }
  return null;
}

type Draft = {
  name: string;
  type: TableColumn["type"];
  required: boolean;
  textStyle: "single" | "multiline";
  numberStyle: NumberStyle;
  currency: string;
  dateKind: "date" | "datetime" | "time";
  unit: "minutes" | "hours" | "days";
  options: string;
  multiple: boolean;
};

function draftOfColumn(column: TableColumn | null): Draft {
  return {
    name: column?.name ?? "",
    type: column?.type ?? "text",
    required: column?.required ?? false,
    textStyle:
      column?.type === "text" && (column.format?.style ?? "single") !== "single"
        ? "multiline"
        : "single",
    numberStyle: column?.type === "number" ? column.format.style : "decimal",
    currency: column?.type === "number" ? (column.format.currency ?? "EUR") : "EUR",
    dateKind: column?.type === "date" ? column.format.kind : "date",
    unit:
      column?.type === "duration" && ["minutes", "hours", "days"].includes(column.format.inputUnit)
        ? (column.format.inputUnit as Draft["unit"])
        : "minutes",
    options: column?.type === "select" ? column.format.options.map((o) => o.label).join("\n") : "",
    multiple: column?.type === "select" ? Boolean(column.format.multiple) : false,
  };
}

/** The column a draft describes; a select keeps the ids of options whose label stayed. */
function columnOf(draft: Draft, id: string, before: TableColumn | null): TableColumn {
  const base = { id, name: draft.name.trim(), ...(draft.required ? { required: true } : {}) };
  switch (draft.type) {
    case "number":
      return {
        ...base,
        type: "number",
        format:
          draft.numberStyle === "currency"
            ? { style: "currency", currency: draft.currency.trim().toUpperCase() }
            : { style: draft.numberStyle },
      };
    case "date":
      return { ...base, type: "date", format: { kind: draft.dateKind } };
    case "duration":
      return { ...base, type: "duration", format: { inputUnit: draft.unit, display: "hms" } };
    case "select": {
      const known = before?.type === "select" ? before.format.options : [];
      const taken: string[] = [];
      const options = draft.options
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((label) => {
          const kept = known.find((o) => o.label === label);
          const optionId = kept?.id ?? columnIdOf(label, taken);
          taken.push(optionId);
          return { id: optionId, label };
        });
      return {
        ...base,
        type: "select",
        format: { allowCustom: false, options, ...(draft.multiple ? { multiple: true } : {}) },
      };
    }
    case "boolean":
      return { ...base, type: "boolean" };
    default:
      return {
        ...base,
        type: "text",
        ...(draft.textStyle === "multiline" ? { format: { style: "multiline" as const } } : {}),
      };
  }
}

/** A column added or changed: its name, its type and what the type needs. */
function ColumnDialog({
  open,
  column,
  columns,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The column changed; null: a new one. */
  column: TableColumn | null;
  columns: TableColumn[];
  onClose: () => void;
  onSave: (columns: TableColumn[]) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => draftOfColumn(column));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(draftOfColumn(column));
      setError(null);
    }
  }, [open, column]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async (next: TableColumn[]) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const id =
      column?.id ??
      columnIdOf(
        draft.name,
        columns.map((c) => c.id),
      );
    const made = columnOf(draft, id, column);
    return save(column ? columns.map((c) => (c.id === column.id ? made : c)) : [...columns, made]);
  };
  return (
    <Dialog open={open} onClose={onClose} title={column ? column.name : t("data.newColumn")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.name.trim()) {
            void submit();
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t("data.columnName")}</Label>
            <Input
              data-autofocus
              value={draft.name}
              maxLength={128}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("data.columnType")}</Label>
            <Select
              value={draft.type}
              onChange={(type) => set({ type: type as Draft["type"] })}
              options={TYPES.map((type) => ({ value: type, label: t(`data.type.${type}` as Key) }))}
            />
          </div>
        </div>
        {draft.type === "text" ? (
          <Select
            value={draft.textStyle}
            onChange={(textStyle) => set({ textStyle: textStyle as Draft["textStyle"] })}
            options={[
              { value: "single", label: t("data.text.single") },
              { value: "multiline", label: t("data.text.multiline") },
            ]}
          />
        ) : null}
        {draft.type === "number" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              value={draft.numberStyle}
              onChange={(numberStyle) => set({ numberStyle: numberStyle as NumberStyle })}
              options={(["integer", "decimal", "percent", "currency"] as const).map((s) => ({
                value: s,
                label: t(`data.number.${s}`),
              }))}
            />
            {draft.numberStyle === "currency" ? (
              <Input
                value={draft.currency}
                maxLength={3}
                aria-label={t("data.currency")}
                placeholder="EUR"
                onChange={(e) => set({ currency: e.target.value })}
              />
            ) : null}
          </div>
        ) : null}
        {draft.type === "date" ? (
          <Select
            value={draft.dateKind}
            onChange={(dateKind) => set({ dateKind: dateKind as Draft["dateKind"] })}
            options={(["date", "datetime", "time"] as const).map((k) => ({
              value: k,
              label: t(`data.date.${k}`),
            }))}
          />
        ) : null}
        {draft.type === "duration" ? (
          <div>
            <Label>{t("data.unit")}</Label>
            <Select
              value={draft.unit}
              onChange={(unit) => set({ unit: unit as Draft["unit"] })}
              options={(["minutes", "hours", "days"] as const).map((u) => ({
                value: u,
                label: t(`data.unit.${u}`),
              }))}
            />
          </div>
        ) : null}
        {draft.type === "select" ? (
          <div className="flex flex-col gap-3">
            <div>
              <Label>{t("data.options")}</Label>
              <Textarea
                minRows={3}
                value={draft.options}
                onChange={(e) => set({ options: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-3 text-[0.875rem]">
              <Switch checked={draft.multiple} onChange={(multiple) => set({ multiple })} />
              {t("data.multiple")}
            </label>
          </div>
        ) : null}
        <label className="flex items-center gap-3 text-[0.875rem]">
          <Switch checked={draft.required} onChange={(required) => set({ required })} />
          {t("data.required")}
        </label>
        {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
        <div className="flex items-center gap-2">
          {column && columns.length > 1 ? (
            <Button
              variant="ghost"
              className="text-rose"
              disabled={busy}
              onClick={() =>
                confirm(t("data.confirmDelete", { title: column.name })) &&
                void save(columns.filter((c) => c.id !== column.id))
              }
            >
              {t("data.deleteColumn")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={!draft.name.trim()}>
            {t("settings.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A table of the space: its columns across the top, a row per line, every cell typed into in
 * place and saved when the person leaves it. The heading of a column opens what it is.
 */
export function TableEditor({
  tableId,
  onGone,
}: {
  tableId: string;
  /** The table was deleted. */
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const key = ["space-table", tableId];
  const table = useQuery({
    queryKey: key,
    queryFn: () => api.get<SpaceTable>(`/api/studio/tables/${tableId}`),
  });
  const [editing, setEditing] = useState<TableColumn | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(table.data?.title ?? ""), [table.data?.title]);
  const listed = async () => {
    await qc.invalidateQueries({ queryKey: ["space-data", table.data?.projectId] });
    await qc.invalidateQueries({ queryKey: ["knowledge", table.data?.projectId] });
  };
  const put = (rows: (rows: SpaceTableRow[]) => SpaceTableRow[]) =>
    qc.setQueryData<SpaceTable>(key, (old) => (old ? { ...old, rows: rows(old.rows) } : old));
  const failed = (err: unknown) => {
    setError((err as Error).message);
    void table.refetch();
  };
  const patchTable = async (patch: { title?: string; columns?: TableColumn[] }) => {
    await api.patch(`/api/studio/tables/${tableId}`, patch);
    await table.refetch();
    await listed();
  };
  const saveCell = useMutation({
    mutationFn: ({ row, column, value }: { row: string; column: string; value: unknown }) =>
      api.patch<SpaceTableRow>(`/api/studio/tables/${tableId}/rows/${row}`, {
        cells: { [column]: value },
      }),
    onSuccess: (saved, { row, column }) => {
      setError(null);
      setBad((b) => (b === `${row}:${column}` ? null : b));
      put((rows) => rows.map((r) => (r.id === saved.id ? { ...r, cells: saved.cells } : r)));
    },
    onError: (err, { row, column }) => {
      if (err instanceof ApiError && err.body?.column === column) {
        const name = table.data?.columns.find((c) => c.id === column)?.name ?? column;
        setBad(`${row}:${column}`);
        setError(t("data.badCell", { column: name }));
        return;
      }
      failed(err);
    },
  });
  const addRow = useMutation({
    mutationFn: () => api.post<SpaceTableRow>(`/api/studio/tables/${tableId}/rows`, {}),
    onSuccess: async (row) => {
      put((rows) => [...rows, { ...row, updatedAt: new Date().toISOString() }]);
      await listed();
    },
    onError: failed,
  });
  const removeRow = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/studio/tables/${tableId}/rows/delete`, { ids: [id] }),
    onSuccess: async (_, id) => {
      put((rows) => rows.filter((r) => r.id !== id));
      await listed();
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/tables/${tableId}`),
    onSuccess: async () => {
      await listed();
      onGone();
    },
  });
  if (!table.data) {
    return table.isError ? (
      <p className="text-[0.875rem] text-rose">{(table.error as Error).message}</p>
    ) : null;
  }
  const { columns, rows, readOnly } = table.data;
  // A shared list of a wizard: its columns come from the wizard, its rows from every run.
  const fromList = Boolean(table.data.list);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <input
          value={title}
          disabled={readOnly}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() =>
            title.trim() && title !== table.data?.title && void patchTable({ title }).catch(failed)
          }
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label={t("data.title")}
          className="-ml-1 min-w-0 flex-1 rounded-md bg-transparent px-1 font-display font-semibold text-lg outline-none hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring disabled:hover:bg-transparent"
        />
        {readOnly ? null : (
          <IconButton
            label={t("data.deleteTable")}
            onClick={() =>
              confirm(t("data.confirmDelete", { title: table.data.title })) && remove.mutate()
            }
            className="hover:text-rose"
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      {fromList ? (
        <p className="-mt-1.5 px-1 text-[0.8125rem] text-ink-3">{t("data.fromList")}</p>
      ) : null}
      {table.data.knowledge ? (
        <KnowledgeHeader
          projectId={table.data.projectId}
          itemKey={`t:${table.data.id}`}
          has={table.data.knowledge.categories}
          originLabel={table.data.knowledge.originLabel}
          kept={table.data.knowledge.kept}
          review={table.data.knowledge.review}
          file={table.data.knowledge.file}
          readOnly={readOnly}
          onReviewed={() =>
            void api
              .patch(`/api/studio/tables/${tableId}`, { review: null })
              .then(() => table.refetch())
              .catch(failed)
          }
        />
      ) : null}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-border-soft border-b">
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className="min-w-36 border-border-soft border-l p-1 font-medium first:border-l-0"
                  >
                    <button
                      type="button"
                      disabled={readOnly || fromList}
                      onClick={() => setEditing(c)}
                      className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink disabled:hover:bg-transparent"
                    >
                      <span className="truncate">{c.name}</span>
                      {c.required ? <span className="text-ember">*</span> : null}
                      {columnNote(c) ? (
                        <span className="font-normal text-ink-4">{columnNote(c)}</span>
                      ) : null}
                    </button>
                  </th>
                ))}
                <th className="w-10 p-1">
                  {readOnly || fromList ? null : (
                    <IconButton
                      label={t("data.newColumn")}
                      onClick={() => setEditing("new")}
                      className="size-8"
                    >
                      <Plus className="size-4" />
                    </IconButton>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="group border-border-soft border-b last:border-b-0">
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className="border-border-soft border-l p-1 align-top first:border-l-0"
                    >
                      <Cell
                        column={c}
                        value={row.cells[c.id]}
                        readOnly={readOnly}
                        invalid={bad === `${row.id}:${c.id}`}
                        onSave={(value) => saveCell.mutate({ row: row.id, column: c.id, value })}
                      />
                    </td>
                  ))}
                  <td className="w-10 p-1 align-top">
                    {readOnly ? null : (
                      <IconButton
                        label={t("data.deleteRow")}
                        onClick={() => removeRow.mutate(row.id)}
                        className="size-8 opacity-0 hover:text-rose focus:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length ? null : (
          <p className="px-4 py-6 text-center text-[0.875rem] text-ink-3">{t("data.noRows")}</p>
        )}
        {readOnly ? null : (
          <div className="border-border-soft border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              busy={addRow.isPending}
              onClick={() => addRow.mutate()}
            >
              <Plus className="size-4" /> {t("data.addRow")}
            </Button>
          </div>
        )}
      </Card>
      {error ? <p className="px-1 text-[0.875rem] text-rose">{error}</p> : null}
      <ColumnDialog
        open={editing !== null}
        column={editing === "new" ? null : editing}
        columns={columns}
        onClose={() => setEditing(null)}
        onSave={(next) => patchTable({ columns: next })}
      />
    </section>
  );
}
