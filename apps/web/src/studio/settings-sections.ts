import { featureOn } from "@engenty-wizards/shared/features";
import { Blocks, Cable, Cpu, type LucideIcon, Plug, UserRound, Users } from "lucide-react";
import type { ComponentType } from "react";
import { t } from "../lib/i18n";
import type { Me } from "../lib/session";
import type { StudioPlugins } from "../plugins/host";

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon | ComponentType<{ className?: string }>;
  /** The user menu links to it directly. */
  menu: boolean;
  /** A section a plugin added: what it draws, and whose it is. */
  plugin?: StudioPlugins["sections"][number];
}

/**
 * The sections of the settings, in the order of their list: the studio's own, then what the
 * plugins added, then the plugins themselves.
 */
export function settingsSections(
  me: Me | null | undefined,
  plugins: StudioPlugins,
): SettingsSection[] {
  return [
    { id: "account", label: t("account.title"), icon: UserRound, menu: true },
    // In the cloud the studio is a team's: who is in it, and the plan it is on — once team plans are on.
    ...(me?.mode === "managed" && featureOn(me.features, "teamPlans")
      ? [{ id: "team", label: t("team.title"), icon: Users, menu: true }]
      : []),
    { id: "connectors", label: t("connectors.title"), icon: Plug, menu: true },
    // Alone for this machine; in the cloud for the team, on its credits unless it brings keys.
    { id: "models", label: t("local.title"), icon: Cpu, menu: true },
    { id: "integrate", label: t("integrate.nav"), icon: Cable, menu: true },
    ...plugins.sections.map((section) => ({
      id: section.id,
      label: section.label(),
      icon: section.icon,
      menu: section.menu ?? false,
      plugin: section,
    })),
    // Nothing to show where the runtime has no plugins, unless a linked account may bring its
    // plan's Pro modules (ProModulesSection).
    ...(plugins.plugins.length || plugins.problems.length || (plugins.canReload && me?.account)
      ? [{ id: "plugins", label: t("plugins.title"), icon: Blocks, menu: false }]
      : []),
  ];
}
