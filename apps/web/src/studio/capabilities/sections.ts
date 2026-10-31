import type { FeatureName } from "@engenty/wizards-shared/features";
import { Compass, History, type LucideIcon, Plug, ScrollText } from "lucide-react";
import type { ComponentType } from "react";
import type { Key } from "../../lib/i18n";
import { DiscoverSection } from "./DiscoverSection";
import { SkillsSection } from "./SkillsSection";

/**
 * A section of Fähigkeiten (docs/plans/capabilities.md), at /capabilities/<id>: its row in the
 * page's menu and what it draws, its own menu (handed up with <SubMenu>) and its page. A section
 * whose `element` is null is not built yet: no menu shows it, and its address opens the first that is.
 */
export interface CapabilitySection {
  id: string;
  label: Key;
  icon: LucideIcon;
  element: ComponentType | null;
  /** The switch it waits behind, besides `capabilities`. */
  feature?: FeatureName;
}

export const CAPABILITY_SECTIONS: CapabilitySection[] = [
  {
    id: "skills",
    label: "space.skills",
    icon: ScrollText,
    element: SkillsSection,
    feature: "skills",
  },
  { id: "connectors", label: "capabilities.connectors", icon: Plug, element: null },
  { id: "protocol", label: "capabilities.protocol", icon: History, element: null },
  { id: "discover", label: "capabilities.discover", icon: Compass, element: DiscoverSection },
];

/** The sections the page shows: built, and on where they wait behind a switch. */
export function shownSections(on: (name: FeatureName) => boolean): CapabilitySection[] {
  return CAPABILITY_SECTIONS.filter((s) => s.element && (!s.feature || on(s.feature)));
}
