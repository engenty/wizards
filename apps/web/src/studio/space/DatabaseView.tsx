import type { WizardDatabase, WizardDatabaseRows } from "@engenty/wizards-shared/space-data";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { t } from "../../lib/i18n";
import { Button, Card, Empty, Select, Spinner } from "../../ui";

/**
 * A wizard's shared database (docs/plans/wizard-data.md, step 3): its tables, read-only, a page of
 * rows at a time, each table as CSV. What each person keeps for themselves is theirs and is only
 * counted.
 */
export function DatabaseView({ databaseId, people }: { databaseId: string; people: number }) {
  const db = useQuery({
    queryKey: ["wizard-database", databaseId],
    queryFn: () => api.get<WizardDatabase>(`/api/studio/databases/${databaseId}`),
  });
  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const tables = db.data?.tables ?? [];
  const current = table ?? tables[0]?.name ?? null;
  const rows = useQuery({
    queryKey: ["wizard-database", databaseId, current, offset],
    queryFn: () =>
      api.get<WizardDatabaseRows>(
        `/api/studio/databases/${databaseId}/tables/${encodeURIComponent(current ?? "")}?offset=${offset}`,
      ),
    enabled: Boolean(current),
  });
  if (!db.data) {
    return db.error ? (
      <p className="px-1 text-[0.875rem] text-rose">{(db.error as Error).message}</p>
    ) : (
      <div className="flex justify-center py-12">
        <Spinner className="text-ink-3" />
      </div>
    );
  }
  const page = rows.data;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 px-1">
        <h2 className="font-display font-semibold text-lg">
          {t("data.database.title", { wizard: db.data.title })}
        </h2>
        <p className="text-[0.8125rem] text-ink-3">
          {t("data.database.hint")} {people ? t("data.database.people", { n: people }) : ""}
        </p>
      </div>
      {tables.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2 px-1">
            <div className="min-w-48">
              <Select
                value={current ?? ""}
                onChange={(name) => {
                  setTable(name);
                  setOffset(0);
                }}
                options={tables.map((x) => ({
                  value: x.name,
                  label: `${x.name} · ${t("data.rows", { n: x.rows })}`,
                }))}
              />
            </div>
            {current ? (
              <a
                href={withBase(
                  `/api/studio/databases/${databaseId}/tables/${encodeURIComponent(current)}/csv`,
                )}
                download
              >
                <Button variant="secondary" size="sm">
                  <Download className="size-4" /> {t("data.database.csv")}
                </Button>
              </a>
            ) : null}
          </div>
          <Card className="overflow-hidden">
            {page?.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[0.8125rem]">
                  <thead>
                    <tr className="border-border-soft border-b">
                      {page.columns.map((c) => (
                        <th key={c} className="px-3 py-2 font-medium text-ink-3">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((r, i) => (
                      <tr
                        // Rows of a database have no id of their own here.
                        // biome-ignore lint/suspicious/noArrayIndexKey: a page's rows are in a fixed order
                        key={i}
                        className="border-border-soft border-b last:border-b-0"
                      >
                        {page.columns.map((c) => (
                          <td key={c} className="max-w-80 truncate px-3 py-2 tabular-nums">
                            {r[c] === null || r[c] === undefined ? "" : String(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>{rows.isPending ? t("common.loading") : t("data.database.noRows")}</Empty>
            )}
          </Card>
          {page && page.total > page.rows.length ? (
            <div className="flex items-center justify-between px-1 text-[0.8125rem] text-ink-3">
              <span>
                {t("data.database.range", {
                  from: page.offset + 1,
                  to: page.offset + page.rows.length,
                  total: page.total,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page.offset === 0}
                  onClick={() => setOffset(Math.max(0, page.offset - page.rows.length))}
                >
                  {t("data.database.previous")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page.offset + page.rows.length >= page.total}
                  onClick={() => setOffset(page.offset + page.rows.length)}
                >
                  {t("data.database.next")}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <Card>
          <Empty>{t("data.database.noTables")}</Empty>
        </Card>
      )}
    </section>
  );
}
