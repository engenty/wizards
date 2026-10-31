import { ChevronRight, File, FileText, Table2 } from "lucide-react";
import type { ComponentType } from "react";
import { useNavigate } from "react-router";
import { type Key, t } from "../../lib/i18n";
import type { Space } from "../../lib/session";
import { Chip } from "../../ui";
import { useAssistantPage } from "../assistant/page";
import { AssistantSlot } from "../assistant/StudioAssistant";
import { useSpaceFiles } from "./data";
import { Preview } from "./Files";
import { useKnowledge } from "./Knowledge";
import { Section } from "./Section";
import { useSpaceData } from "./SpaceData";

/** A part of the sources as the overview shows it. */
export interface OverviewPart {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  to: string;
}

/** What each of the space's own parts is for, in a line. */
const TEASER: Partial<Record<string, Key>> = {
  info: "space.teaser.info",
  brand: "space.teaser.brand",
  knowledge: "space.teaser.knowledge",
  data: "space.teaser.data",
  page: "space.teaser.page",
};

/**
 * Ressourcen › Übersicht at `/space`: Goose's introduction on top, then a card per part with what it
 * is for and how far it is filled, from the space's own data. A card opens its part.
 */
export function SpaceOverview({ space, parts }: { space: Space; parts: OverviewPart[] }) {
  const navigate = useNavigate();
  const files = useSpaceFiles(space.id);
  const knowledge = useKnowledge(space.id);
  const data = useSpaceData(space.id);
  useAssistantPage({
    title: t("space.overviewAssistantTitle"),
    hello: t("space.overviewAssistantHello"),
    suggestions: [
      { label: t("assistant.suggest.missing") },
      { label: t("assistant.suggest.readSite"), fill: true },
    ],
  });

  const logoFiles = files.data?.files.filter((f) => f.kind === "logo") ?? [];
  const logos = logoFiles.length;
  const colors = space.brand.colors?.length ?? 0;
  const entries = knowledge.data?.items.length ?? 0;
  const categories = knowledge.data?.categories.length ?? 0;
  const tables = data.data?.tables.length ?? 0;
  const pages = data.data?.pages.length ?? 0;
  // How far a part is filled: a line, and whether it holds anything yet. Null: nothing to say.
  const status = (id: string): { text: string; filled: boolean } | null => {
    const joined = (...bits: (string | false)[]) => bits.filter(Boolean).join(" · ");
    switch (id) {
      case "info": {
        const title = Boolean(space.brand.name?.trim());
        return {
          text:
            joined(
              !title && t("space.status.noTitle"),
              space.facts.length > 0 && t("space.status.facts", { n: space.facts.length }),
            ) || t("space.status.empty"),
          filled: title,
        };
      }
      case "brand":
        return files.isPending
          ? null
          : {
              text:
                joined(
                  logos > 0 && t("space.status.logos", { n: logos }),
                  colors > 0 && t("space.status.colors", { n: colors }),
                ) || t("space.status.empty"),
              filled: logos + colors > 0,
            };
      case "knowledge":
        return knowledge.isPending
          ? null
          : {
              text:
                joined(
                  entries > 0 && t("space.status.entries", { n: entries }),
                  categories > 0 && t("space.status.categories", { n: categories }),
                ) || t("space.status.empty"),
              filled: entries > 0,
            };
      case "data":
        return data.isPending
          ? null
          : {
              text:
                joined(
                  tables > 0 && t("space.status.tables", { n: tables }),
                  pages > 0 && t("space.pages", { n: pages }),
                ) || t("space.status.empty"),
              filled: tables + pages > 0,
            };
      default:
        return null;
    }
  };

  // A look at what a part holds: a few of its own things, small.
  const look = (id: string) => {
    const row = "flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink-2";
    switch (id) {
      case "info":
        return space.brand.name?.trim() || space.facts.length ? (
          <div className="flex flex-col gap-1">
            {space.brand.name?.trim() ? (
              <span className="truncate font-medium text-[0.875rem] text-ink">
                {space.brand.name}
              </span>
            ) : null}
            {space.facts.slice(0, 3).map((f) => (
              <span key={f.key} className={row}>
                <span className="shrink-0 text-ink-3">{f.label}</span>
                <span className="min-w-0 truncate">{f.value}</span>
              </span>
            ))}
          </div>
        ) : null;
      case "brand":
        return logos + colors ? (
          <div className="flex items-center gap-3">
            {logoFiles.slice(0, 3).map((f) => (
              <span
                key={f.id}
                className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-paper ring-1 ring-border-soft"
              >
                <Preview spaceId={space.id} file={f} small />
              </span>
            ))}
            <span className="flex flex-wrap gap-1">
              {(space.brand.colors ?? []).slice(0, 8).map((c) => (
                <span
                  key={`${c.name}${c.value}`}
                  title={`${c.name} ${c.value}`}
                  className="size-5 rounded-full ring-1 ring-border-soft"
                  style={{ background: c.value }}
                />
              ))}
            </span>
          </div>
        ) : null;
      case "knowledge":
        return entries ? (
          <div className="flex flex-col gap-1">
            {knowledge.data?.items.slice(0, 3).map((item) => {
              const Icon = item.kind === "page" ? FileText : item.kind === "table" ? Table2 : File;
              return (
                <span key={item.key} className={row}>
                  <Icon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 truncate">{item.title}</span>
                </span>
              );
            })}
            {categories ? (
              <span className="mt-1 flex flex-wrap gap-1">
                {knowledge.data?.categories.slice(0, 4).map((c) => (
                  <span
                    key={c.id}
                    className="rounded-full bg-paper-2 px-2 py-0.5 text-[0.75rem] text-ink-3"
                  >
                    {c.name}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        ) : null;
      case "data":
        return tables + pages ? (
          <div className="flex flex-col gap-1">
            {[
              ...(data.data?.tables ?? []).map((x) => ({
                key: `t:${x.id}`,
                title: x.title,
                rows: x.rows,
                Icon: Table2,
              })),
              ...(data.data?.pages ?? []).map((x) => ({
                key: `p:${x.id}`,
                title: x.title,
                rows: null,
                Icon: FileText,
              })),
            ]
              .slice(0, 3)
              .map((x) => (
                <span key={x.key} className={row}>
                  <x.Icon className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{x.title}</span>
                  {x.rows !== null ? (
                    <span className="shrink-0 text-[0.75rem] text-ink-3 tabular-nums">
                      {x.rows}
                    </span>
                  ) : null}
                </span>
              ))}
          </div>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-9 pb-20">
      <AssistantSlot />
      <Section title={t("nav.sources")} hint={t("space.overviewHint")} plain>
        <div className="grid gap-3 sm:grid-cols-2">
          {parts.map((part) => {
            const s = status(part.id);
            const teaser = TEASER[part.id];
            return (
              <button
                key={part.id}
                type="button"
                onClick={() => navigate(part.to)}
                className="group flex min-w-0 flex-col gap-2 rounded-xl bg-card p-4 text-left shadow-soft ring-1 ring-border-soft transition hover:ring-border"
              >
                <span className="flex items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-paper-2 text-ember-strong">
                    <part.icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-[0.9375rem]">
                    {part.label}
                  </span>
                  <ChevronRight className="size-4 text-ink-4 transition group-hover:translate-x-0.5 group-hover:text-ink-3" />
                </span>
                {teaser ? (
                  <span className="text-[0.8125rem] text-ink-3 leading-relaxed">{t(teaser)}</span>
                ) : null}
                {look(part.id) ? (
                  <span className="block rounded-lg bg-paper-2/50 p-3">{look(part.id)}</span>
                ) : null}
                {s ? (
                  <span className="mt-auto pt-1">
                    <Chip tone={s.filled ? "live" : "warn"}>{s.text}</Chip>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
