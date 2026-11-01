import type { Knowledge, KnowledgeValue, SpaceCategory } from "@engenty/wizards-shared/knowledge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { askConfirm, Button, Chip, cn, Dialog, IconButton } from "../../ui";
import { useDismiss } from "../AppFrame";
import { useSettingsMenu } from "../settings-menu";
import { CATEGORY_ICON, CategoryView, itemCount, ValueView } from "./Categories";
import { CategoryItems } from "./Knowledge";
import { ItemCards } from "./KnowledgeTree";

/**
 * Kategorien as a tab of Wissen's menu, behind `knowledgeTree`: each Kategorie opens to its
 * values, a value to the items that have it as cards with its summary on top. A Kategorie's
 * settings stand behind ⋯ › Bearbeiten.
 */

/** How many of a choice's values the tree lists before „n weitere“. */
const SHOWN_VALUES = 8;

/** The two tabs at the top of Wissen's menu. */
export function KnowledgeTabs({
  tab,
  onTab,
}: {
  tab: "folders" | "categories";
  onTab: (tab: "folders" | "categories") => void;
}) {
  const button = (id: "folders" | "categories", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => onTab(id)}
      className={cn(
        "flex-1 rounded-md px-2 py-1 text-[0.8125rem] transition",
        tab === id ? "bg-card font-medium text-ink shadow-soft" : "text-ink-2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" className="mb-2 flex gap-0.5 rounded-lg bg-paper-2 p-0.5">
      {button("folders", t("know.tabFolders"))}
      {button("categories", t("know.tabCategories"))}
    </div>
  );
}

/**
 * The Kategorien tab: each Kategorie with how many items have it, a choice opening to its values;
 * a proposed one waits with its chip. Empty, two sentences on what they are for.
 */
export function CategoryTree({
  categories,
  picked,
  pickedCategory,
  readOnly,
  onPick,
  onNew,
}: {
  categories: SpaceCategory[];
  /** What is open beside the menu: `c:<id>` or `v:<id>`. */
  picked: string | null;
  /** The Kategorie of the value open. */
  pickedCategory: string | null;
  readOnly: boolean;
  onPick: (key: string) => void;
  onNew: () => void;
}) {
  const { filter } = useSettingsMenu();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // A value picked opens its Kategorie once; closed again by hand, it stays closed.
  useEffect(() => {
    if (pickedCategory) {
      setOpen((now) => (now.has(pickedCategory) ? now : new Set([...now, pickedCategory])));
    }
  }, [pickedCategory]);
  const toggle = (id: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  if (!categories.length) {
    return (
      <div className="flex flex-col gap-3 px-2 py-1">
        <p className="text-[0.8125rem] text-ink-3 leading-relaxed">{t("know.categoriesEmpty")}</p>
        {readOnly ? null : (
          <Button variant="secondary" size="sm" className="self-start" onClick={onNew}>
            <Plus className="size-4" /> {t("know.category")}
          </Button>
        )}
      </div>
    );
  }
  const rowClass = (selected: boolean) =>
    cn(
      "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-[0.875rem]",
      selected ? "font-medium text-ink" : "text-ink-2 group-hover/row:text-ink",
    );
  const shown = filter
    ? categories.filter(
        (c) =>
          c.name.toLowerCase().includes(filter) ||
          c.values.some((v) => v.value.toLowerCase().includes(filter)),
      )
    : categories;
  return (
    <div className="flex flex-col gap-0.5">
      <ul className="flex flex-col gap-0.5">
        {shown.map((c) => {
          const Icon = CATEGORY_ICON[c.type];
          const values = filter
            ? c.values.filter((v) => v.value.toLowerCase().includes(filter))
            : c.values;
          const isOpen = open.has(c.id) || Boolean(filter && values.length);
          // Closed over the value that is open, the Kategorie stands for it.
          const selected =
            picked === `c:${c.id}` || (!isOpen && pickedCategory === c.id && picked !== null);
          return (
            <li key={c.id}>
              <div
                className={cn(
                  "group/row flex items-center rounded-lg transition",
                  selected ? "bg-paper-2" : "hover:bg-accent",
                )}
              >
                <button
                  type="button"
                  tabIndex={values.length ? 0 : -1}
                  aria-label={isOpen ? t("know.collapse") : t("know.expand")}
                  aria-expanded={values.length ? isOpen : undefined}
                  onClick={() => values.length && toggle(c.id)}
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-md text-ink-4",
                    values.length ? "hover:text-ink" : "invisible",
                  )}
                >
                  <ChevronRight
                    className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => onPick(`c:${c.id}`)}
                  aria-current={selected ? "page" : undefined}
                  className={rowClass(selected)}
                >
                  <Icon
                    className={cn("size-4 shrink-0", selected ? "text-ember-strong" : "text-ink-3")}
                  />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.proposed ? (
                    <Chip tone="ember">{t("know.proposed")}</Chip>
                  ) : (
                    <span className="text-[0.75rem] text-ink-4 tabular-nums">{c.count}</span>
                  )}
                </button>
              </div>
              {isOpen && values.length ? (
                <ul className="flex flex-col gap-0.5 pt-0.5">
                  {values.slice(0, filter ? undefined : SHOWN_VALUES).map((v) => {
                    const on = picked === `v:${v.id}`;
                    return (
                      <li key={v.id}>
                        <button
                          type="button"
                          onClick={() => onPick(`v:${v.id}`)}
                          aria-current={on ? "page" : undefined}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-9 text-left text-[0.875rem] transition",
                            on
                              ? "bg-paper-2 font-medium text-ink"
                              : "text-ink-2 hover:bg-accent hover:text-ink",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{v.value}</span>
                          <span className="text-[0.75rem] text-ink-4 tabular-nums">{v.count}</span>
                        </button>
                      </li>
                    );
                  })}
                  {!filter && values.length > SHOWN_VALUES ? (
                    <li>
                      <button
                        type="button"
                        onClick={() => onPick(`c:${c.id}`)}
                        className="w-full rounded-lg py-1.5 pr-2 pl-9 text-left text-[0.8125rem] text-ink-3 transition hover:bg-accent hover:text-ink"
                      >
                        {t("know.moreValues", { n: values.length - SHOWN_VALUES })}
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {readOnly ? null : (
        <button
          type="button"
          onClick={onNew}
          className="mt-2 flex items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[0.8125rem] text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <span className="grid size-6 place-items-center">
            <Plus className="size-4" />
          </span>
          {t("know.category")}
        </button>
      )}
    </div>
  );
}

/** A Kategorie's ⋯: its settings, deleting it. */
function CategoryMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const entry =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div ref={ref} className="relative">
      <IconButton
        label={t("know.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="size-8"
      >
        <MoreHorizontal className="size-4" />
      </IconButton>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <button type="button" role="menuitem" className={entry} onClick={pick(onEdit)}>
            <Pencil className="size-4 shrink-0" /> {t("know.edit")}
          </button>
          <div className="mx-2 my-1.5 h-px bg-border-soft" />
          <button
            type="button"
            role="menuitem"
            className={cn(entry, "text-rose hover:bg-rose-tint hover:text-rose")}
            onClick={pick(onDelete)}
          >
            <Trash2 className="size-4 shrink-0" /> {t("know.deleteCategory")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The head of a Kategorie's or a value's page: what it is above, its name, how much it holds. */
function Head({
  eyebrow,
  title,
  line,
  action,
}: {
  eyebrow: string;
  title: string;
  line: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-1">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
          <Tag className="size-3.5" /> {eyebrow}
        </p>
        <h2 className="mt-0.5 font-display font-semibold text-lg leading-tight">{title}</h2>
        {line ? <p className="mt-1 text-[0.875rem] text-ink-3">{line}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A Kategorie opened from the tab: a choice's values as cards, the items of any other type in
 * groups (days by month, numbers in ranges, yes and no). Its settings behind ⋯ › Bearbeiten.
 */
export function CategoryHome({
  spaceId,
  data,
  category,
  readOnly,
  onOpen,
  onGone,
}: {
  spaceId: string;
  data: Knowledge;
  category: SpaceCategory;
  readOnly: boolean;
  onOpen: (key: string) => void;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  const call = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    onSuccess: refresh,
  });
  const Icon = CATEGORY_ICON[category.type];
  return (
    <div className="flex flex-col gap-6">
      <Head
        eyebrow={t(`know.type.${category.type}`)}
        title={category.name}
        line={[itemCount(category.count), category.unit, category.hint].filter(Boolean).join(" · ")}
        action={
          readOnly ? null : (
            <CategoryMenu
              onEdit={() => setEditing(true)}
              onDelete={async () =>
                (await askConfirm(t("know.confirmCategory", { name: category.name }))) &&
                call.mutate(async () => {
                  await api.del(`/api/studio/categories/${category.id}`);
                  onGone();
                })
              }
            />
          )
        }
      />
      {category.proposed && !readOnly ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ember-tint px-4 py-3">
          <span className="flex-1 text-[0.875rem] text-ink-2">{t("know.proposedHint")}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => call.mutate(() => api.del(`/api/studio/categories/${category.id}`))}
          >
            {t("know.dismiss")}
          </Button>
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
        </div>
      ) : null}
      {category.type === "choice" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {category.values.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onOpen(`v:${v.id}`)}
              className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3.5 text-left shadow-soft ring-1 ring-border-soft transition hover:ring-border"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Icon className="size-4 shrink-0 text-ink-3" />
                <span className="truncate font-medium text-[0.875rem]">{v.value}</span>
              </span>
              <span className="text-[0.75rem] text-ink-3">
                {[itemCount(v.count), v.summary ? t("know.summary") : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <CategoryItems
          spaceId={spaceId}
          category={category}
          categories={data.categories}
          onOpen={onOpen}
        />
      )}
      {call.error ? (
        <p className="text-[0.875rem] text-rose">{(call.error as Error).message}</p>
      ) : null}
      <Dialog open={editing} onClose={() => setEditing(false)} wide>
        <CategoryView
          spaceId={spaceId}
          category={category}
          readOnly={readOnly}
          onOpen={(key) => {
            setEditing(false);
            onOpen(key);
          }}
          onGone={() => {
            setEditing(false);
            onGone();
          }}
        />
      </Dialog>
    </div>
  );
}

/**
 * A value opened from the tab: its Kategorie above, its summary, and the items that have it as
 * cards with their other Kategorien as chips; rows of tables that have it, by table.
 */
export function ValueHome({
  data,
  value,
  readOnly,
  onOpen,
}: {
  data: Knowledge;
  value: KnowledgeValue;
  readOnly: boolean;
  onOpen: (key: string) => void;
}) {
  const rows = value.rows.reduce((n, r) => n + r.count, 0);
  return (
    <div className="flex flex-col gap-6">
      <Head
        eyebrow={value.category.name}
        title={value.value}
        line={[
          itemCount(value.items.length),
          ...value.rows.map((r) => t("know.tocRows", { n: r.count, table: r.title })),
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      <ValueView value={value} readOnly={readOnly}>
        <div className="flex flex-col gap-3">
          {value.items.length ? (
            <ItemCards
              items={value.items}
              categories={data.categories.filter((c) => c.id !== value.category.id)}
              onOpen={onOpen}
            />
          ) : null}
          {rows
            ? value.rows.map((r) => (
                <button
                  key={r.tableId}
                  type="button"
                  onClick={() => onOpen(`t:${r.tableId}`)}
                  className="px-1 text-left text-[0.8125rem] text-ink-3 hover:text-ink"
                >
                  {t("know.tocRows", { n: r.count, table: r.title })}
                </button>
              ))
            : null}
        </div>
      </ValueView>
    </div>
  );
}
