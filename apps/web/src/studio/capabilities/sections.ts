import type { FeatureName } from "@engenty/wizards-shared/features";
import { History, LayoutGrid, type LucideIcon, Plug, ScrollText } from "lucide-react";
import type { ComponentType } from "react";
import type { Key } from "../../lib/i18n";
import { ConnectorsSection } from "./ConnectorsSection";
import { OverviewSection } from "./OverviewSection";
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
  /** Without a menu of its own: the list of sections stays beside its page. */
  menu?: false;
}

export const CAPABILITY_SECTIONS: CapabilitySection[] = [
  {
    id: "overview",
    label: "capabilities.overview",
    icon: LayoutGrid,
    element: OverviewSection,
    menu: false,
  },
  {
    id: "skills",
    label: "space.skills",
    icon: ScrollText,
    element: SkillsSection,
    feature: "skills",
    // Its page lists every skill: a menu of them beside it added nothing.
    menu: false,
  },
  {
    id: "connectors",
    label: "capabilities.connectors",
    icon: Plug,
    element: ConnectorsSection,
    // Its page lists every connection and has the button to add one.
    menu: false,
  },
  {
    id: "protocol",
    label: "capabilities.protocol",
    icon: History,
    element: ProtocolSection,
    admins: true,
  },
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
