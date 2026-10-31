import type { StudioSpaceGroup } from "@engenty/wizards/plugin/studio";
import {
  ALargeSmall,
  BookOpen,
  Database,
  FileText,
  Fingerprint,
  Globe,
  Images,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
  Palette,
  Shapes,
  SwatchBook,
  Type,
} from "lucide-react";
import type { ComponentType } from "react";
import { type Key, t } from "../lib/i18n";
import type { StudioPlugins } from "../plugins/host";

export type SpaceGroupId = StudioSpaceGroup;

/** A part of the space page: its own address, its entry in the upper level of the menu. */
export interface SpaceGroup {
  id: SpaceGroupId;
  label: string;
  icon: LucideIcon;
}

/**
 * The space page's own parts, in the order of the menu; plugins add theirs (`withParts`). Results
 * and Skills are groups of the page too, but stand behind their own places in the app bar. The public page is the last of the parts: what the space shows the world
 * (`space/PublicPage.tsx`).
 */
export function spaceGroups(): SpaceGroup[] {
  return [
    { id: "info", label: t("space.info"), icon: Fingerprint },
    { id: "brand", label: t("space.brand"), icon: SwatchBook },
    { id: "knowledge", label: t("space.knowledge"), icon: BookOpen },
    { id: "data", label: t("space.data"), icon: Database },
    { id: "page", label: t("space.page"), icon: Globe },
  ];
}

/** A part of the menu: the space page's own, or a plugin's. */
export interface SpacePartEntry {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** The parts with the plugins' among them: each after the part it names, else after Data. */
export function withParts(own: SpaceGroup[], plugins: StudioPlugins): SpacePartEntry[] {
  const out: SpacePartEntry[] = [...own];
  for (const part of plugins.spaceParts) {
    const after = out.findIndex((g) => g.id === (part.after ?? "data"));
    // Behind the plugin parts that follow the same part already.
    let at = after + 1;
    while (at < out.length && plugins.spaceParts.some((p) => p.id === out[at].id)) {
      at++;
    }
    out.splice(at, 0, { id: part.id, label: part.label(), icon: part.icon });
  }
  return out;
}

export function isSpaceGroup(id: string | undefined): id is SpaceGroupId {
  return (
    id === "info" ||
    id === "brand" ||
    id === "knowledge" ||
    id === "data" ||
    id === "page" ||
    id === "results" ||
    id === "skills"
  );
}

export interface SpaceSection {
  /** Its anchor on the space page: `/space/<group>#<id>`, set in `SpaceSettings` or by a plugin. */
  id: string;
  label: string;
  /** The space's own sections have one, and a plugin part's entries; a plugin's sections stand under the plugin's name. */
  icon?: ComponentType<{ className?: string }>;
}

export interface SpaceSectionGroup {
  /** The plugin's id and name; none for the space's own sections. */
  plugin: string | null;
  label: string | null;
  sections: SpaceSection[];
}

/** The space's own sections, in the order the page shows them. A plugin cannot take their ids. */
const OWN: { id: string; group: SpaceGroupId; label: Key; icon: LucideIcon }[] = [
  { id: "base", group: "info", label: "space.base", icon: Type },
  { id: "facts", group: "info", label: "space.facts", icon: ListChecks },
  { id: "logos", group: "brand", label: "space.logos", icon: Shapes },
  { id: "colors", group: "brand", label: "space.colors", icon: Palette },
  { id: "typography", group: "brand", label: "space.typography", icon: ALargeSmall },
  { id: "assets", group: "brand", label: "space.assets", icon: Images },
  { id: "documents", group: "knowledge", label: "space.documents", icon: FileText },
  { id: "page", group: "page", label: "page.sectionPage", icon: Globe },
  { id: "page-words", group: "page", label: "page.sectionWords", icon: Type },
  { id: "page-wizards", group: "page", label: "page.sectionWizards", icon: LayoutGrid },
];

export const OWN_SPACE_SECTIONS = OWN.map((s) => s.id);

/** The part a section of the space page stands in: its own, or the one its plugin chose. */
export function groupOfSection(id: string, plugins: StudioPlugins): SpaceGroupId | null {
  const added = plugins.spaceSections.find((s) => s.id === id);
  return OWN.find((s) => s.id === id)?.group ?? (added ? (added.group ?? "knowledge") : null);
}

/**
 * The sections of one part of the space page, in the order the page shows them: its own, then
 * each plugin's.
 */
export function spaceSections(
  group: SpaceGroupId,
  plugins: StudioPlugins,
  /** Own sections a feature switch keeps out. */
  off: string[] = [],
): SpaceSectionGroup[] {
  const own = OWN.filter((s) => s.group === group && !off.includes(s.id)).map((s) => ({
    id: s.id,
    label: t(s.label),
    icon: s.icon,
  }));
  const byPlugin = new Map<string, SpaceSection[]>();
  for (const section of plugins.spaceSections) {
    if ((section.group ?? "knowledge") !== group) {
      continue;
    }
    const list = byPlugin.get(section.plugin) ?? [];
    list.push({ id: section.id, label: section.label() });
    byPlugin.set(section.plugin, list);
  }
  return [
    ...(own.length ? [{ plugin: null, label: null, sections: own }] : []),
    ...[...byPlugin].map(([id, sections]) => ({
      plugin: id,
      label: plugins.plugins.find((p) => p.id === id)?.name ?? id,
      sections,
    })),
  ];
}
