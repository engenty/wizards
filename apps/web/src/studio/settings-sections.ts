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
  Link2,
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
}

/**
 * The sections of the settings, in the order of their list: the studio's own, then the plugins
 * (with the sections they add one level down), then Setup and About.
 */
export function settingsSections(
  me: Me | null | undefined,
  plugins: StudioPlugins,
): SettingsSection[] {
  // In the cloud with organizationSettings on, the organization's settings come first, under their
  // heading, and the studio's own under theirs.
  const ownSettings = me?.mode === "managed" && featureOn(me.features, "organizationSettings");
  // Behind `capabilities`, a member's Studio holds none of the organization's settings.
  const organizationShown = !(
    me?.mode === "managed" &&
    me.tenant.role === "member" &&
    featureOn(me.features, "capabilities")
  );
  const organization = t("settings.groupOrganization");
  const studio = ownSettings ? t("settings.groupStudio") : undefined;
  const inStudio = (section: SettingsSection): SettingsSection =>
    studio ? { ...section, group: studio } : section;
  return [
    // With the organization's settings here, the person's own are behind the avatar (accountSections).
    ...(ownSettings
      ? []
      : [{ id: "account", label: t("account.title"), icon: UserRound, menu: true }]),
    ...(ownSettings && organizationShown
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
        me?.mode === "managed" && featureOn(me.features, "teamPlans") && organizationShown
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
    // The plugins, with the settings each brings one level down. Behind its switch until a
    // plugin is installed, or an account may bring its plan's Pro modules (ProModulesSection).
    ...(featureOn(me?.features, "plugins") ||
    plugins.plugins.length ||
    plugins.problems.length ||
    (plugins.canReload && me?.account)
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
export function accountSections(features?: Record<string, boolean>): SettingsSection[] {
  return [
    { id: "profile", label: t("konto.profile"), icon: UserRound, menu: true },
    // The person's own sign-ins to their spaces' connections (docs/plans/capabilities.md).
    ...(featureOn(features, "capabilities")
      ? [{ id: "connections", label: t("konto.connections"), icon: Link2, menu: true }]
      : []),
    { id: "orgs", label: t("konto.organizations"), icon: Building2, menu: false },
    { id: "apps", label: t("konto.apps"), icon: Plug, menu: false },
  ];
}
