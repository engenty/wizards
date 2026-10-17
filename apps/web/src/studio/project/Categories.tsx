import { Markdown } from "@engenty-wizards/runner";
import type {
  CategoryCell,
  CategoryType,
  ItemCategory,
  KnowledgeValue,
  SpaceCategory,
} from "@engenty-wizards/shared/knowledge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Hash,
  type LucideIcon,
  Plus,
  RefreshCw,
  Tags,
  ToggleLeft,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Empty,
  IconButton,
  Input,
  Label,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "../../ui";
import { Section } from "./Section";

export const CATEGORY_ICON: Record<CategoryType, LucideIcon> = {
  choice: Tags,
  date: Calendar,
  number: Hash,
  text: Type,
  boolean: ToggleLeft,
};

const knowledgeKey = (projectId: string) => ["knowledge", projectId];

/** "1 Eintrag", "3 Einträge". */
export function itemCount(n: number): string {
  return n === 1 ? t("know.item") : t("know.items", { n });
}

/** A value as people read it: a day in their format, a number with its unit, yes or no. */
export function shownValue(
  category: Pick<SpaceCategory, "type" | "unit">,
  value: CategoryCell,
): string {
  if (category.type === "boolean" || typeof value === "boolean") {
    return value ? t("know.yes") : t("know.no");
  }
  if (category.type === "date" && typeof value === "string") {
    const [day, time] = value.split(" ");
    const d = new Date(`${day}T00:00:00`);
    const shown = Number.isNaN(d.getTime())
      ? value
      : d.toLocaleDateString(lang, { day: "2-digit", month: "2-digit", year: "numeric" });
    return time ? `${shown} ${time}` : shown;
  }
  if (category.type === "number" && typeof value === "number") {
    return `${value.toLocaleString(lang)}${category.unit ? ` ${category.unit}` : ""}`;
  }
  return String(value);
}

/**
 * An item's categories in one line: "Graz Süd · 14.03.2026 · 38 h · Mängel festgestellt". A yes
 * shows as the category's name, a no not at all.
 */
export function categoryLine(categories: SpaceCategory[], has: ItemCategory[]): string {
  return categories
    .flatMap((c) => {
      const mine = has.find((h) => h.categoryId === c.id);
      if (!mine) {
        return [];
      }
      if (c.type === "boolean") {
        return mine.values[0] === true ? [c.name] : [];
      }
      return [mine.values.map((v) => shownValue(c, v)).join(", ")];
    })
    .join(" · ");
}

/** A small panel under its trigger, closed by a click outside or Escape. */
function Popover({
  trigger,
  open,
  onOpen,
  children,
}: {
  trigger: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        onOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open, onOpen]);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger}
      {open ? (
        <div className="absolute top-full left-0 z-30 mt-1.5 w-72 max-w-[calc(100vw-32px)] rounded-xl bg-card p-3 shadow-overlay ring-1 ring-border-soft">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// --- what an item has ------------------------------------------------------------------

/** Picks a value of one category: a choice's values, a day, a number, a text, yes or no. */
function ValuePicker({
  category,
  current,
  onSave,
}: {
  category: SpaceCategory;
  current: CategoryCell[];
  onSave: (values: CategoryCell[]) => void;
}) {
  const [text, setText] = useState(current[0] === undefined ? "" : String(current[0]));
  if (category.type === "choice") {
    const picked = current.map(String);
    return (
      <div className="flex flex-col gap-2.5">
        {category.values.length ? (
          <Segmented
            multi
            value={picked}
            options={category.values.map((v) => v.value)}
            onChange={(next: string[]) =>
              onSave(category.multiple ? next : next.filter((v) => !picked.includes(v)).slice(0, 1))
            }
          />
        ) : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) {
              onSave(category.multiple ? [...picked, text.trim()] : [text.trim()]);
            }
          }}
        >
          <Input
            data-autofocus
            value={picked.includes(text) ? "" : text}
            placeholder={t("know.addValue")}
            onChange={(e) => setText(e.target.value)}
            className="h-9"
          />
          <IconButton label={t("know.addValue")} type="submit">
            <Plus className="size-4" />
          </IconButton>
        </form>
      </div>
    );
  }
  if (category.type === "boolean") {
    return (
      <Segmented
        value={current[0] === true ? t("know.yes") : current[0] === false ? t("know.no") : ""}
        options={[t("know.yes"), t("know.no")]}
        onChange={(v: string) => onSave([v === t("know.yes")])}
      />
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(
          text.trim()
            ? [category.type === "number" ? Number(text.replace(",", ".")) : text.trim()]
            : [],
        );
      }}
    >
      <Input
        data-autofocus
        type={category.type === "date" ? "date" : category.type === "number" ? "number" : "text"}
        step="any"
        value={category.type === "date" ? text.slice(0, 10) : text}
        onChange={(e) => setText(e.target.value)}
        className="h-9"
      />
      <Button type="submit" size="sm">
        OK
      </Button>
    </form>
  );
}

/**
 * The categories of an item as a row of chips: each opens its value to change, the last adds one
 * the item does not have yet. Where a value came from shows on hover.
 */
export function ItemCategories({
  projectId,
  itemKey,
  has,
  categories,
  readOnly,
}: {
  projectId: string;
  /** `p:<page>`, `t:<table>`, `f:<file>`. */
  itemKey: string;
  has: ItemCategory[];
  categories: SpaceCategory[];
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState(has);
  useEffect(() => setValues(has), [has]);
  const save = useMutation({
    mutationFn: ({ categoryId, next }: { categoryId: string; next: CategoryCell[] }) =>
      api.put(`/api/studio/projects/${projectId}/items/${itemKey}/categories/${categoryId}`, {
        values: next,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKey(projectId) }),
  });
  const taken = categories.filter((c) => !(c.proposed || c.tableId));
  const set = (category: SpaceCategory, next: CategoryCell[]) => {
    setValues((now) => [
      ...now.filter((h) => h.categoryId !== category.id),
      ...(next.length ? [{ categoryId: category.id, values: next, by: "person" as const }] : []),
    ]);
    save.mutate({ categoryId: category.id, next });
    setOpen(null);
  };
  const shown = taken.filter((c) => values.some((h) => h.categoryId === c.id));
  const missing = taken.filter((c) => !values.some((h) => h.categoryId === c.id));
  if (!taken.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((c) => {
        const mine = values.find((h) => h.categoryId === c.id) as ItemCategory;
        const Icon = CATEGORY_ICON[c.type];
        const chip = (
          <button
            key={c.id}
            type="button"
            disabled={readOnly}
            title={`${c.name} · ${t(`know.by.${mine.by}`)}`}
            onClick={() => setOpen(open === c.id ? null : c.id)}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-paper-2 px-2.5 text-[0.75rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink disabled:pointer-events-none"
          >
            <Icon className="size-3.5 text-ink-3" />
            <span className="text-ink-3">{c.name}</span>
            <span className="font-medium">
              {mine.values.map((v) => shownValue(c, v)).join(", ")}
            </span>
          </button>
        );
        return readOnly ? (
          <span key={c.id}>{chip}</span>
        ) : (
          <Popover
            key={c.id}
            trigger={chip}
            open={open === c.id}
            onOpen={(o) => setOpen(o ? c.id : null)}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-medium text-[0.8125rem]">{c.name}</span>
              <IconButton label={t("know.remove")} onClick={() => set(c, [])} className="size-7">
                <X className="size-3.5" />
              </IconButton>
            </div>
            <ValuePicker category={c} current={mine.values} onSave={(next) => set(c, next)} />
          </Popover>
        );
      })}
      {readOnly || !missing.length ? null : (
        <Popover
          open={open === "+"}
          onOpen={(o) => setOpen(o ? "+" : null)}
          trigger={
            <button
              type="button"
              onClick={() => setOpen(open === "+" ? null : "+")}
              className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[0.75rem] text-ink-3 ring-1 ring-border-soft transition hover:text-ink hover:ring-border"
            >
              <Plus className="size-3.5" /> {t("know.category")}
            </button>
          }
        >
          <AddCategory categories={missing} onSave={set} />
        </Popover>
      )}
    </div>
  );
}

function AddCategory({
  categories,
  onSave,
}: {
  categories: SpaceCategory[];
  onSave: (category: SpaceCategory, values: CategoryCell[]) => void;
}) {
  const [id, setId] = useState(categories[0]?.id ?? "");
  const category = categories.find((c) => c.id === id);
  return (
    <div className="flex flex-col gap-2.5">
      <Select
        value={id}
        onChange={setId}
        options={categories.map((c) => ({ value: c.id, label: c.name }))}
      />
      {category ? (
        <ValuePicker
          key={category.id}
          category={category}
          current={[]}
          onSave={(v) => onSave(category, v)}
        />
      ) : null}
    </div>
  );
}

// --- a new category --------------------------------------------------------------------------

export function NewCategoryDialog({
  projectId,
  open,
  onClose,
  onMade,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onMade: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<CategoryType>("choice");
  const [unit, setUnit] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [ordered, setOrdered] = useState(false);
  const [values, setValues] = useState("");
  const [hint, setHint] = useState("");
  const make = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/studio/projects/${projectId}/categories`, {
        name: name.trim(),
        type,
        unit: type === "number" ? unit.trim() || null : null,
        multiple: type === "choice" && multiple,
        ordered: type === "choice" && ordered,
        hint: hint.trim() || null,
        values:
          type === "choice"
            ? values
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean)
            : undefined,
      }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: knowledgeKey(projectId) });
      setName("");
      setValues("");
      setHint("");
      onMade(id);
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("know.newCategory")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            make.mutate();
          }
        }}
      >
        <div>
          <Label>{t("know.name")}</Label>
          <Input
            data-autofocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label>{t("know.type")}</Label>
          <Select
            value={type}
            onChange={(v) => setType(v as CategoryType)}
            options={(["choice", "date", "number", "text", "boolean"] as const).map((v) => ({
              value: v,
              label: t(`know.type.${v}`),
            }))}
          />
        </div>
        {type === "number" ? (
          <div>
            <Label hint={t("know.unitHint")}>{t("know.unit")}</Label>
            <Input value={unit} maxLength={20} onChange={(e) => setUnit(e.target.value)} />
          </div>
        ) : null}
        {type === "choice" ? (
          <>
            <div>
              <Label hint={t("know.valuesHint")}>{t("know.values")}</Label>
              <Textarea minRows={3} value={values} onChange={(e) => setValues(e.target.value)} />
            </div>
            <label className="flex items-center justify-between gap-3 text-[0.875rem]">
              {t("know.multiple")}
              <Switch checked={multiple} onChange={setMultiple} />
            </label>
            <label className="flex items-center justify-between gap-3 text-[0.875rem]">
              {t("know.ordered")}
              <Switch checked={ordered} onChange={setOrdered} />
            </label>
          </>
        ) : null}
        <div>
          <Label hint={t("know.hintFieldHint")}>{t("know.hintField")}</Label>
          <Input value={hint} maxLength={120} onChange={(e) => setHint(e.target.value)} />
        </div>
        {make.error ? (
          <p className="text-[0.875rem] text-rose">{(make.error as Error).message}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={make.isPending} disabled={!name.trim()}>
            {t("know.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// --- one category -----------------------------------------------------------------------------

/** A category opened: what it is, its values with how many items have each, merging, deleting. */
export function CategoryView({
  projectId,
  category,
  readOnly,
  onOpen,
  onGone,
}: {
  projectId: string;
  category: SpaceCategory;
  readOnly: boolean;
  onOpen: (key: string) => void;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: knowledgeKey(projectId) });
  const [adding, setAdding] = useState("");
  const call = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    onSuccess: refresh,
  });
  const Icon = CATEGORY_ICON[category.type];
  const byId = new Map(category.values.map((v) => [v.id, v]));
  return (
    <Section
      title={category.name}
      hint={[t(`know.type.${category.type}`), category.unit, category.hint]
        .filter(Boolean)
        .join(" · ")}
      plain
      action={
        readOnly ? null : (
          <IconButton
            label={t("know.deleteCategory")}
            className="hover:text-rose"
            onClick={() =>
              confirm(t("know.confirmCategory", { name: category.name })) &&
              call.mutate(async () => {
                await api.del(`/api/studio/categories/${category.id}`);
                onGone();
              })
            }
          >
            <Trash2 className="size-4" />
          </IconButton>
        )
      }
    >
      {category.proposed && !readOnly ? (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Chip tone="ember">{t("know.proposed")}</Chip>
          <span className="flex-1 text-[0.875rem] text-ink-2">{t("know.proposedHint")}</span>
          <Button
            size="sm"
            onClick={() =>
              call.mutate(() =>
                api.patch(`/api/studio/categories/${category.id}`, { proposed: false }),
              )
            }
          >
            {t("know.accept")}
          </Button>
        </Card>
      ) : null}
      {category.alike.map(([a, b]) => {
        const x = byId.get(a);
        const y = byId.get(b);
        if (!(x && y)) {
          return null;
        }
        // The one fewer items have goes into the other.
        const [from, into] = x.count < y.count ? [x, y] : [y, x];
        return (
          <Card key={`${a}:${b}`} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex-1 text-[0.875rem] text-ink-2">
              {t("know.alike", { a: from.value, b: into.value })}
            </span>
            {readOnly ? null : (
              <Button
                size="sm"
                variant="secondary"
                busy={call.isPending}
                onClick={() =>
                  call.mutate(() =>
                    api.post(`/api/studio/values/${from.id}/merge`, { into: into.id }),
                  )
                }
              >
                {t("know.merge")}
              </Button>
            )}
          </Card>
        );
      })}
      <Card className="flex flex-col p-1.5">
        {category.type === "choice" ? (
          category.values.length ? (
            category.values.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onOpen(`v:${v.id}`)}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent"
              >
                <Icon className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-[0.875rem]">{v.value}</span>
                {v.summary ? <Chip>{t("know.summary")}</Chip> : null}
                <span className="shrink-0 text-[0.75rem] text-ink-3 tabular-nums">
                  {itemCount(v.count)}
                </span>
              </button>
            ))
          ) : (
            <Empty>{t("know.empty")}</Empty>
          )
        ) : (
          <div className="flex items-center gap-3 px-3 py-2.5 text-[0.875rem]">
            <Icon className="size-4 shrink-0 text-ink-3" />
            <span className="flex-1 text-ink-2">
              {category.range
                ? t("know.range", {
                    min: shownValue(category, category.range.min),
                    max: shownValue(category, category.range.max),
                  })
                : t("know.unset")}
            </span>
            <span className="text-[0.75rem] text-ink-3 tabular-nums">
              {itemCount(category.count)}
            </span>
          </div>
        )}
        {category.type === "choice" && !readOnly ? (
          <form
            className="flex gap-2 border-border-soft border-t p-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = adding.trim();
              if (value) {
                setAdding("");
                call.mutate(() =>
                  api.post(`/api/studio/categories/${category.id}/values`, { value }),
                );
              }
            }}
          >
            <Input
              value={adding}
              placeholder={t("know.addValue")}
              onChange={(e) => setAdding(e.target.value)}
              className="h-9"
            />
            <IconButton label={t("know.addValue")} type="submit">
              <Plus className="size-4" />
            </IconButton>
          </form>
        ) : null}
      </Card>
      {call.error ? (
        <p className="text-[0.875rem] text-rose">{(call.error as Error).message}</p>
      ) : null}
    </Section>
  );
}

// --- one value: its summary and its table of contents ------------------------------------------

export function useValue(valueId: string) {
  return useQuery({
    queryKey: ["knowledge-value", valueId],
    queryFn: () => api.get<KnowledgeValue>(`/api/studio/values/${valueId}`),
    enabled: Boolean(valueId),
  });
}

export function ValueView({
  value,
  readOnly,
  children,
}: {
  value: KnowledgeValue;
  readOnly: boolean;
  /** The table of contents, drawn by the caller with the rows of Knowledge. */
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const write = useMutation({
    mutationFn: () => api.post(`/api/studio/values/${value.id}/summary`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge-value", value.id] }),
  });
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("know.summary")}
        hint={t("know.summaryHint")}
        plain
        action={
          readOnly ? null : (
            <Button
              variant="secondary"
              size="sm"
              busy={write.isPending}
              onClick={() => write.mutate()}
            >
              {value.summary ? <RefreshCw className="size-4" /> : null}
              {value.summary ? t("know.summaryAgain") : t("know.summaryWrite")}
            </Button>
          )
        }
      >
        <Card className="p-4 sm:p-5">
          {write.isPending ? (
            <div className="flex h-24 items-center justify-center text-ink-3">
              <Spinner />
            </div>
          ) : value.summary ? (
            <Markdown text={value.summary} className="text-[0.875rem]" />
          ) : (
            <p className="text-[0.875rem] text-ink-3">{t("know.summaryEmpty")}</p>
          )}
          {write.error ? (
            <p className="mt-3 text-[0.875rem] text-rose">{(write.error as Error).message}</p>
          ) : null}
        </Card>
      </Section>
      <Section title={t("know.toc")} plain>
        {children}
      </Section>
    </div>
  );
}
