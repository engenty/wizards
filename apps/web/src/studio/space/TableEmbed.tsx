import { formatTableCell } from "@engenty/wizards-shared/engenty/data-tables";
import type { SpaceTable } from "@engenty/wizards-shared/space-data";
import { useQuery } from "@tanstack/react-query";
import { Table } from "lucide-react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Spinner } from "../../ui";

const SHOWN = 12;

/**
 * A table of Wissen inside a page, where the page links to it alone on a line
 * (`[Preise 2026](tables/preise-2026)`): its first rows as they are now, opened with a click.
 */
export function TableEmbed({
  spaceId,
  href,
  onOpen,
}: {
  spaceId: string;
  href: string;
  onOpen?: (key: string) => void;
}) {
  const found = useQuery({
    queryKey: ["space-resolve", spaceId, href],
    queryFn: () =>
      api.get<{ kind: "page" | "table" | "file"; id: string }>(
        `/api/studio/spaces/${spaceId}/resolve?path=${encodeURIComponent(href)}`,
      ),
    retry: false,
    staleTime: 60_000,
  });
  const id = found.data?.kind === "table" ? found.data.id : null;
  const table = useQuery({
    queryKey: keys.table(id ?? ""),
    queryFn: () => api.get<SpaceTable>(`/api/studio/tables/${id}`),
    enabled: Boolean(id),
  });
  if (found.isError || (found.data && !id)) {
    return <p className="text-[0.8125rem] text-ink-3">{t("blocks.tableGone")}</p>;
  }
  if (!table.data) {
    return <Spinner className="size-4 text-ink-3" />;
  }
  const { columns, rows, title } = table.data;
  const more = rows.length - SHOWN;
  return (
    <div className="overflow-hidden rounded-xl border border-border-soft text-[0.8125rem]">
      <button
        type="button"
        onClick={() => id && onOpen?.(`t:${id}`)}
        className="flex w-full items-center gap-2 border-border-soft border-b bg-paper-2 px-3 py-2 text-left font-medium text-ink-2 hover:text-ink"
      >
        <Table className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 font-normal text-ink-3">{t("blocks.tableFrom")}</span>
      </button>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className="border-border-soft border-b px-3 py-1.5 font-medium text-ink-3"
                  style={c.type === "number" ? { textAlign: "right" } : undefined}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((r) => (
              <tr key={r.id} className="border-border-soft border-b last:border-b-0">
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className="px-3 py-1.5 text-ink-2 tabular-nums"
                    // Inline: the text it stands in aligns every cell to the left.
                    style={c.type === "number" ? { textAlign: "right" } : undefined}
                  >
                    {formatTableCell(c, r.cells[c.id], lang)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more > 0 ? (
        <p className="border-border-soft border-t px-3 py-1.5 text-ink-3">
          {t("blocks.moreRows", { n: more })}
        </p>
      ) : null}
    </div>
  );
}
