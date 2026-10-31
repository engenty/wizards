import type { SkillSummary } from "@engenty/wizards-shared/skills";
import {
  ChevronDown,
  ChevronRight,
  Compass,
  type LucideIcon,
  Plug,
  Plus,
  ScrollText,
  Search,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useFeature } from "../../lib/features";
import { t } from "../../lib/i18n";
import { useCurrentSpace, useIsAdmin } from "../../lib/session";
import { Button, Card, Chip, cn, Empty, Tabs } from "../../ui";
import { Section } from "../space/Section";
import { SourceChip, useSkills } from "../space/Skills";
import {
  ConnectionRow,
  unusedBuiltins,
  useConnectors,
  useSpaceConnections,
} from "./ConnectorsSection";

/** How many skills and connections the overview shows before „Alle“ leads on. */
const SHOWN = { skills: 4, connections: 5 };

/**
 * Fähigkeiten › Übersicht (mockup 1 of „Fähigkeiten in the Studio“): what the space's wizards,
 * chats and Goose may use, on one page. The skills that count, the space's connections and the
 * built-in connectors nobody has set up yet; each part leads on to its section. The search finds
 * among them here; under „Entdecken“ it searches the directories.
 */
export function OverviewSection() {
  const { space } = useCurrentSpace();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const skillsOn = useFeature("skills");
  const unsetConnectors = useFeature("unsetConnectors");
  const [query, setQuery] = useState("");
  const spaceId = space?.id ?? "";
  const skills = useSkills(skillsOn ? space?.id : undefined);
  const connections = useSpaceConnections(spaceId);
  const connectors = useConnectors(spaceId);
  if (!space) {
    return null;
  }
  const writable = admin && !space.readOnly;
  const q = query.trim().toLowerCase();
  const allSkills = skills.data?.skills ?? [];
  const allConnections = connections.data?.connections ?? [];
  // The skills that count, the ones always on first.
  const counting = allSkills
    .filter((s) => s.mode !== "off")
    .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "always" ? -1 : 1));
  const foundSkills = q
    ? allSkills.filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
    : counting;
  const foundConnections = q
    ? allConnections.filter((c) =>
        `${c.name} ${c.connector?.name ?? c.connectorId}`.toLowerCase().includes(q),
      )
    : allConnections;
  const builtin = unusedBuiltins(connectors.data ?? [], allConnections, unsetConnectors);
  const discover = (asked: string) =>
    navigate(
      asked.trim()
        ? `/capabilities/discover?q=${encodeURIComponent(asked.trim())}`
        : "/capabilities/discover",
    );

  return (
    <div className="flex flex-col gap-9 pb-20">
      <Section
        title={t("nav.capabilities")}
        hint={t("capabilities.overview.hint")}
        plain
        action={
          <AddMenu
            entries={[
              ...(skillsOn && !skills.data?.readOnly
                ? [
                    {
                      icon: ScrollText,
                      label: t("capabilities.overview.addSkill"),
                      hint: t("capabilities.overview.addSkillHint"),
                      to: "/capabilities/skills",
                    },
                  ]
                : []),
              ...(writable
                ? [
                    {
                      icon: Plug,
                      label: t("capabilities.overview.addConnection"),
                      hint: t("capabilities.overview.addConnectionHint"),
                      to: "/capabilities/connectors?setup=",
                    },
                  ]
                : []),
              {
                icon: Compass,
                label: t("capabilities.discover"),
                hint: t("capabilities.overview.discoverHint"),
                to: "/capabilities/discover",
              },
            ]}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value="space"
            onChange={(next) => (next === "discover" ? discover(query) : undefined)}
            options={[
              { id: "space", label: t("capabilities.inSpace") },
              { id: "discover", label: t("capabilities.discover") },
            ]}
            label={t("nav.capabilities")}
          />
          <form
            className="flex h-10 min-w-0 flex-1 basis-60 items-center gap-2 rounded-full border border-input bg-card px-4 focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow"
            onSubmit={(e) => {
              e.preventDefault();
              // Nothing here: the directories may have it.
              if (q && !foundSkills.length && !foundConnections.length) {
                discover(query);
              }
            }}
          >
            <Search className="size-4 shrink-0 text-ink-3" />
            <input
              type="search"
              value={query}
              aria-label={t("capabilities.overview.search")}
              placeholder={t("capabilities.overview.search")}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[0.875rem] text-ink outline-none placeholder:text-ink-4"
            />
          </form>
        </div>
      </Section>

      {skillsOn ? (
        <Part
          icon={ScrollText}
          title={t("space.skills")}
          all={allSkills.length}
          to="/capabilities/skills"
        >
          {skills.error ? (
            <p className="px-1 text-[0.875rem] text-rose">{(skills.error as Error).message}</p>
          ) : foundSkills.length ? (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {foundSkills.slice(0, SHOWN.skills).map((s) => (
                <SkillCard
                  key={s.id}
                  skill={s}
                  onOpen={() => navigate(`/capabilities/skills?show=k:${s.id}`)}
                />
              ))}
            </div>
          ) : skills.isPending ? null : (
            <Card>
              <Empty>
                {q
                  ? t("capabilities.overview.nothing", { q: query.trim() })
                  : t("capabilities.overview.noSkills")}
              </Empty>
            </Card>
          )}
        </Part>
      ) : null}

      <Part
        icon={Plug}
        title={t("capabilities.connectors")}
        all={allConnections.length}
        to="/capabilities/connectors"
      >
        {connections.error ? (
          <p className="px-1 text-[0.875rem] text-rose">{(connections.error as Error).message}</p>
        ) : foundConnections.length ? (
          <Card className="flex flex-col divide-y divide-border-soft p-0">
            {foundConnections.slice(0, SHOWN.connections).map((c) => (
              <ConnectionRow
                key={c.id}
                connection={c}
                onOpen={() => navigate(`/capabilities/connectors?show=${encodeURIComponent(c.id)}`)}
              />
            ))}
          </Card>
        ) : connections.isPending ? null : (
          <Card>
            <Empty>
              {q
                ? t("capabilities.overview.nothing", { q: query.trim() })
                : t("capabilities.overview.noConnections")}
            </Empty>
          </Card>
        )}
        {builtin.length && !q ? (
          <p className="px-1 text-[0.8125rem] text-ink-3">
            {t("capabilities.connectors.builtin")}:{" "}
            {builtin.map((c, i) => (
              <span key={c.id}>
                {i ? " · " : null}
                {writable && c.usable ? (
                  <Link
                    to={`/capabilities/connectors?setup=${encodeURIComponent(c.id)}`}
                    className="text-ink-2 hover:text-ink hover:underline"
                  >
                    {c.name}
                  </Link>
                ) : (
                  <span className="text-ink-2">{c.name}</span>
                )}
              </span>
            ))}
          </p>
        ) : null}
      </Part>
    </div>
  );
}

/** A part of the overview: its heading, „Alle n“ to its section, what it shows. */
function Part({
  icon: Icon,
  title,
  all,
  to,
  children,
}: {
  icon: LucideIcon;
  title: string;
  all: number;
  to: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="flex items-center gap-2 font-semibold text-[0.9375rem]">
          <Icon className="size-4 text-ember-strong" aria-hidden="true" />
          {title}
        </h3>
        <Link
          to={to}
          className="inline-flex items-center gap-0.5 text-[0.8125rem] text-ink-3 transition hover:text-ink"
        >
          {t("capabilities.overview.all", { n: all })}
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {children}
    </section>
  );
}

/** A skill as a card: its name, when it counts, what it does, where it came from. */
function SkillCard({ skill, onOpen }: { skill: SkillSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-3 text-left shadow-soft ring-1 ring-border-soft transition hover:ring-border"
    >
      <span className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate font-medium font-mono text-[0.8125rem]",
            skill.mode === "off" && "text-ink-3",
          )}
        >
          {skill.name}
        </span>
        <Chip tone={skill.mode === "always" ? "live" : "neutral"}>
          {t(`skills.mode.${skill.mode}`)}
        </Chip>
      </span>
      <span className="line-clamp-2 text-[0.8125rem] text-ink-2">{skill.description}</span>
      <span className="flex flex-wrap items-center gap-2 text-[0.75rem] text-ink-3">
        <SourceChip skill={skill} />
        {skill.runScripts ? t("capabilities.overview.scripts") : null}
      </span>
    </button>
  );
}

/** „Hinzufügen“: a skill, a connection, or a look into the directories. */
function AddMenu({
  entries,
}: {
  entries: { icon: LucideIcon; label: string; hint: string; to: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="size-4" /> {t("skills.add")}
        <ChevronDown className="-mr-1 size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-10 right-0 z-50 w-72 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {entries.map((e) => (
            <Link
              key={e.to}
              to={e.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent"
            >
              <e.icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <span className="min-w-0">
                <span className="block font-medium text-[0.875rem]">{e.label}</span>
                <span className="block text-[0.8125rem] text-ink-3">{e.hint}</span>
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
