import type { FeatureName } from "@engenty/wizards-shared/features";
import { Compass, History, type LucideIcon, Plug, ScrollText } from "lucide-react";
import type { ComponentType } from "react";
import type { Key } from "../../lib/i18n";
import { ConnectorsSection } from "./ConnectorsSection";
import { DiscoverSection } from "./DiscoverSection";
import { ProtocolSection } from "./ProtocolSection";
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
  /** For the owners and admins alone: a member's menu leaves it out. */
  admins?: boolean;
}

export const CAPABILITY_SECTIONS: CapabilitySection[] = [
  {
    id: "skills",
    label: "space.skills",
    icon: ScrollText,
    element: SkillsSection,
    feature: "skills",
  },
  { id: "connectors", label: "capabilities.connectors", icon: Plug, element: ConnectorsSection },
  {
    id: "protocol",
    label: "capabilities.protocol",
    icon: History,
    element: ProtocolSection,
    admins: true,
  },
  { id: "discover", label: "capabilities.discover", icon: Compass, element: DiscoverSection },
];

/** The sections the page shows: built, on where they wait behind a switch, and the admins' to an admin. */
export function shownSections(
  on: (name: FeatureName) => boolean,
  admin = true,
): CapabilitySection[] {
  return CAPABILITY_SECTIONS.filter(
    (s) => s.element && (!s.feature || on(s.feature)) && (admin || !s.admins),
  );
}
