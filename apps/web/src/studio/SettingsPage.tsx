import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { t } from "../lib/i18n";
import { useCurrentSpace, useManySpaces, useMe } from "../lib/session";
import { useStudioPlugins } from "../plugins/host";
import { PluginsSettings } from "../plugins/PluginsSettings";
import { cn, Empty } from "../ui";
import { Account } from "./Account";
import { useCrumbs } from "./AppFrame";
import { useAssistantPage } from "./assistant/page";
import { CloudSyncSection } from "./CloudSync";
import { Connectors } from "./Connectors";
import { SpaceSwitcher } from "./HomePage";
import { Integrate } from "./Integrate";
import { Models } from "./Models";
import { Organization } from "./Organization";
import {
  OrganizationCredits,
  OrganizationInvoices,
  OrganizationUsage,
} from "./OrganizationCredits";
import { OrganizationGeneral, OrganizationKeys, OrganizationMembers } from "./OrganizationSettings";
import { PersonApps, PersonOrganizations, PersonProfile } from "./PersonAccount";
import { PersonSignInsPage } from "./PersonSignIns";
import { ReadOnlyNote, spaceReadOnlyText } from "./ReadOnly";
import { RuntimeSetup } from "./RuntimeSettings";
import {
  BackRow,
  LevelHead,
  LevelList,
  SettingsMenuContext,
  stepClass,
  useNarrow,
  useStepDirection,
} from "./settings-menu";
import { accountSections, settingsSections } from "./settings-sections";

const AboutPanel = lazy(() =>
  import("../about/AboutDialog").then((m) => ({ default: m.AboutPanel })),
);

/** The About section's tab named in the address (`?tab=credits`), else its first. */
const aboutTab = (tab: string | null): "new" | "earlier" | "credits" =>
  tab === "earlier" || tab === "credits" ? tab : "new";

/** The sections whose menu goes one level down in the left container. */
const MENUS = new Set(["models", "integrate", "plugins", "setup"]);

/**
 * Settings at /settings/<section>. One container on the left shows one level at a time: the
 * sections, or — for Models, Integrate, Plugins and Setup — the section's own menu one level down, with the way
 * back at its top. On a phone the levels and the page take turns: the sections, a section's
 * menu, then the page, each with the way back.
 */
export function SettingsPage({ scope = "settings" }: { scope?: "settings" | "account" }) {
  const { section } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const { space, loading } = useCurrentSpace();
  const many = useManySpaces();
  const [key, setKey] = useState(space?.id);
  useEffect(() => setKey(space?.id), [space?.id]);
  const plugins = useStudioPlugins();
  const narrow = useNarrow();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // Back up to the sections on a wide page, while the section's page stays; another section
  // opens its own menu again.
  const [upAt, setUpAt] = useState<string | null>(null);
  // The gear's list, or the person's Konto behind the avatar: the same frame, another list.
  const sections =
    scope === "account" ? accountSections(me.data?.features) : settingsSections(me.data, plugins);
  const base = scope === "account" ? "/account" : "/settings";
  const title = scope === "account" ? t("konto.title") : t("settings.title");
  const first =
    scope === "account"
      ? "profile"
      : sections.some((s) => s.id === "general")
        ? "general"
        : "account";
  const current = sections.find((s) => s.id === section);
  const entries = sections.map((s) => ({ ...s, to: `${base}/${s.id}` }));
  const entry = entries.find((e) => e.id === section);
  const hasMenu = current ? MENUS.has(current.id) : false;
  // A phone: 0 the sections, 1 the section's menu, 2 the page.
  const phone = !current ? 0 : hasMenu && !params.get("show") ? 1 : 2;
  const level = narrow ? Math.min(phone, 1) : hasMenu && upAt !== section ? 1 : 0;
  const levelStep = useStepDirection(level);
  const pageStep = useStepDirection(phone);
  const menu = useMemo(() => ({ slot, narrow, setDetail }), [slot, narrow]);
  useAssistantPage(
    current?.id === "models"
      ? {
          suggestions: [
            { label: t("assistant.suggest.modelsNow") },
            { label: t("assistant.suggest.modelsMissing") },
            { label: t("assistant.suggest.modelsCost") },
          ],
        }
      : current?.id === "account"
        ? {
            suggestions: [
              { label: t("assistant.suggest.credits") },
              { label: t("assistant.suggest.accountWhy") },
              { label: t("assistant.suggest.plans") },
            ],
          }
        : current?.id === "integrate"
          ? {
              suggestions: [
                { label: t("assistant.suggest.integrateWhat") },
                { label: t("assistant.suggest.integrateClaude") },
                { label: t("assistant.suggest.what") },
              ],
            }
          : current?.id === "connectors"
            ? {
                suggestions: [
                  { label: t("assistant.suggest.connectorsWhat") },
                  { label: t("assistant.suggest.connectorsAdd"), fill: true },
                  { label: t("assistant.suggest.what") },
                ],
              }
            : {},
  );
  // The page's name stands in the top bar: the section's content starts right at the top.
  useCrumbs([
    { label: title, to: base },
    ...(current ? [{ label: current.label, to: `${base}/${current.id}` }] : []),
    ...(current && detail ? [{ label: detail }] : []),
  ]);
  if (!current) {
    // The person's switches decide some of their sections: those wait for them.
    if (scope === "account" && !me.data) {
      return null;
    }
    // The page for AI clients was /settings/build before it became "Integrate".
    if (section === "build") {
      return <Navigate to="/settings/integrate" replace />;
    }
    // A plugin's settings stand one level down in Plugins.
    if (plugins.sections.some((s) => s.id === section)) {
      return <Navigate to={`${base}/plugins?show=${section}`} replace />;
    }
    // A plugin's section is there once the plugin loaded. A phone starts at the sections.
    if (section !== undefined || !narrow) {
      return plugins.status === "ready" || section === undefined ? (
        <Navigate to={`${base}/${first}`} replace />
      ) : null;
    }
  }
  // Connectors belong to a space: with several, the switcher stands above them.
  const scoped = current?.id === "connectors" && many;
  // The settings' menu, at the page's left.
  const menuBody = (
    <>
      <LevelHead
        title={title}
        open={level === 1 ? (entry ?? null) : null}
        onBack={() => (narrow ? navigate(base) : setUpAt(section ?? null))}
      />
      <div key={level} className={cn(stepClass(levelStep))}>
        {level === 0 ? (
          <LevelList
            entries={entries}
            current={narrow ? undefined : entry}
            onPick={() => setUpAt(null)}
          />
        ) : (
          <div ref={setSlot} />
        )}
      </div>
    </>
  );
  return (
    <SettingsMenuContext.Provider value={menu}>
      <div className="animate-rise">
        <div
          className={cn(
            "grid gap-6",
            "md:grid-cols-[10.5rem_minmax(0,1fr)] md:gap-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10",
          )}
        >
          {
            <aside
              className={cn(
                "min-w-0 md:sticky md:top-6 md:self-start",
                narrow && phone === 2 && "hidden",
                narrow && pageStep === "back" && stepClass("back"),
              )}
            >
              {menuBody}
            </aside>
          }
          {current ? (
            <div
              className={cn(
                "min-w-0",
                !["integrate", "models"].includes(current.id) && "max-w-2xl",
                narrow && phone < 2 && "hidden",
                narrow && pageStep === "deeper" && stepClass("deeper"),
              )}
            >
              {narrow ? (
                <div className="mb-3">
                  <BackRow
                    label={hasMenu ? current.label : title}
                    onBack={() => navigate(hasMenu ? `${base}/${current.id}` : base)}
                  />
                </div>
              ) : null}
              {scoped ? (
                <div className="mb-6">
                  <SpaceSwitcher />
                </div>
              ) : null}
              {current.id === "connectors" && space ? (
                <div className="flex flex-col gap-6">
                  {space.readOnly ? <ReadOnlyNote>{spaceReadOnlyText(space)}</ReadOnlyNote> : null}
                  <Connectors key={key} spaceId={space.id} readOnly={space.readOnly} />
                </div>
              ) : null}
              {/* No space yet: nothing is built here, and no local install has sent one. */}
              {current.id === "connectors" && !space && !loading ? (
                <Empty>{t("settings.noSpace")}</Empty>
              ) : null}
              {current.id === "models" ? <Models /> : null}
              {current.id === "integrate" ? <Integrate /> : null}
              {current.id === "account" && me.data ? <Account me={me.data} /> : null}
              {current.id === "cloud" ? <CloudSyncSection /> : null}
              {current.id === "setup" && me.data ? <RuntimeSetup me={me.data} /> : null}
              {current.id === "about" ? (
                <Suspense fallback={null}>
                  <AboutPanel me={me.data} active initialTab={aboutTab(params.get("tab"))} />
                </Suspense>
              ) : null}
              {current.id === "organization" && me.data ? <Organization me={me.data} /> : null}
              {current.id === "general" && me.data ? <OrganizationGeneral me={me.data} /> : null}
              {current.id === "members" && me.data ? <OrganizationMembers me={me.data} /> : null}
              {current.id === "keys" && me.data ? <OrganizationKeys me={me.data} /> : null}
              {current.id === "profile" && me.data ? <PersonProfile me={me.data} /> : null}
              {current.id === "orgs" && me.data ? <PersonOrganizations me={me.data} /> : null}
              {current.id === "apps" && me.data ? <PersonApps /> : null}
              {current.id === "connections" ? <PersonSignInsPage /> : null}
              {current.id === "credits" && me.data ? <OrganizationCredits me={me.data} /> : null}
              {current.id === "usage" && me.data ? <OrganizationUsage me={me.data} /> : null}
              {current.id === "invoices" && me.data ? <OrganizationInvoices me={me.data} /> : null}
              {current.id === "plugins" ? <PluginsSettings /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </SettingsMenuContext.Provider>
  );
}
