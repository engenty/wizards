import { featureOn } from "@engenty/wizards-shared/features";
import {
  Blocks,
  Building2,
  Cable,
  ChartColumn,
  CloudCog,
  Coins,
  Cpu,
  Info,
  KeyRound,
  type LucideIcon,
  Plug,
  Receipt,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { t } from "../lib/i18n";
import type { Me } from "../lib/session";
import type { StudioPlugins } from "../plugins/host";
import { cloudSyncOn } from "./CloudSync";
import { runtimeSettingsOn } from "./RuntimeSettings";

export interface SettingsSection {
  id: string;
  label: string;
  icon: LucideIcon | ComponentType<{ className?: string }>;
  /** The user menu links to it directly. */
  menu: boolean;
  /** The heading it stands under in the list; none for the rows above the first heading. */
  group?: string;
  /** A section a plugin added: what it draws, and whose it is. */
  plugin?: StudioPlugins["sections"][number];
}

/**
 * The sections of the settings, in the order of their list: the studio's own, then what the
 * plugins added, then the plugins themselves, then About.
 */
export function settingsSections(
  me: Me | null | undefined,
  plugins: StudioPlugins,
): SettingsSection[] {
  // In the cloud with organizationSettings on, the organization's settings come first, under their
  // heading, and the studio's own under theirs.
  const ownSettings = me?.mode === "managed" && featureOn(me.features, "organizationSettings");
  const organization = t("settings.groupOrganization");
  const studio = ownSettings ? t("settings.groupStudio") : undefined;
  const inStudio = (section: SettingsSection): SettingsSection =>
    studio ? { ...section, group: studio } : section;
  return [
    // With the organization's settings here, the person's own are behind the avatar (accountSections).
    ...(ownSettings
      ? []
      : [{ id: "account", label: t("account.title"), icon: UserRound, menu: true }]),
    ...(ownSettings
      ? [
          {
            id: "general",
            label: t("orgSettings.general"),
            icon: Building2,
            menu: false,
            group: organization,
          },
          {
            id: "members",
            label: t("orgSettings.members"),
            icon: Users,
            menu: true,
            group: organization,
          },
          {
            id: "credits",
            label: t("credits.title"),
            icon: Coins,
            menu: false,
            group: organization,
          },
          {
            id: "usage",
            label: t("credits.usage"),
            icon: ChartColumn,
            menu: false,
            group: organization,
          },
          {
            id: "invoices",
            label: t("credits.invoices"),
            icon: Receipt,
            menu: false,
            group: organization,
          },
          {
            id: "keys",
            label: t("orgSettings.keys"),
            icon: KeyRound,
            menu: false,
            group: organization,
          },
        ]
      : // In the cloud the studio is an organization's: who is in it, and its plan — once teamPlans is on.
        me?.mode === "managed" && featureOn(me.features, "teamPlans")
        ? [{ id: "organization", label: t("organization.title"), icon: Users, menu: true }]
        : []),
    // This computer's spaces kept the same as the organization's in the cloud, both ways.
    ...(cloudSyncOn(me)
      ? [inStudio({ id: "cloud", label: t("cloudSync.title"), icon: CloudCog, menu: false })]
      : []),
    inStudio({ id: "connectors", label: t("connectors.title"), icon: Plug, menu: true }),
    // Alone for this machine; in the cloud for the organization, on its credits unless it brings keys.
    inStudio({ id: "models", label: t("local.title"), icon: Cpu, menu: true }),
    inStudio({ id: "integrate", label: t("integrate.nav"), icon: Cable, menu: true }),
    ...plugins.sections.map((section) =>
      inStudio({
        id: section.id,
        label: section.label(),
        icon: section.icon,
        menu: section.menu ?? false,
        plugin: section,
      }),
    ),
    // Nothing to show where the runtime has no plugins, unless a linked account may bring its
    // plan's Pro modules (ProModulesSection).
    ...(plugins.plugins.length || plugins.problems.length || (plugins.canReload && me?.account)
      ? [inStudio({ id: "plugins", label: t("plugins.title"), icon: Blocks, menu: false })]
      : []),
    // What holds for the whole runtime: on this computer, or for the platform's admins.
    ...(runtimeSettingsOn(me)
      ? [inStudio({ id: "setup", label: t("runtime.setupNav"), icon: Wrench, menu: false })]
      : []),
    // Which release this is, its updates, what is new, the credits.
    { id: "about", label: t("about.nav"), icon: Info, menu: false },
  ];
}

/** The person's Konto behind the avatar: theirs in every organization, so it names none. */
export function accountSections(): SettingsSection[] {
  return [
    { id: "profile", label: t("konto.profile"), icon: UserRound, menu: true },
    { id: "orgs", label: t("konto.organizations"), icon: Building2, menu: false },
    { id: "apps", label: t("konto.apps"), icon: Plug, menu: false },
  ];
}
