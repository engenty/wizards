import { ChevronRight } from "lucide-react";
import type { ComponentType } from "react";
import { useNavigate } from "react-router";
import { type Key, t } from "../../lib/i18n";
import type { Space } from "../../lib/session";
import { Chip } from "../../ui";
import { useAssistantPage } from "../assistant/page";
import { AssistantSlot } from "../assistant/StudioAssistant";
import { useSpaceFiles } from "./data";
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

  const logos = files.data?.files.filter((f) => f.kind === "logo").length ?? 0;
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
                  <span className="text-[0.8125rem] text-ink-2 leading-relaxed">{t(teaser)}</span>
                ) : null}
                {s ? (
                  <span>
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
