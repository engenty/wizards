import { Blocks } from "lucide-react";
import { useSearchParams } from "react-router";
import { t } from "../lib/i18n";
import { MenuRow, SubMenu, useDetail, useSettingsMenu } from "../studio/settings-menu";
import { PluginFrame, useStudioPlugins } from "./host";
import { PluginList } from "./PluginList";
import { PluginsSection } from "./PluginsSection";

/**
 * Settings › Plugins. Its menu one level down: the overview of what is installed, then the
 * settings each plugin brings (`?show=<section id>`), as Contacts does.
 */
export function PluginsSettings() {
  const plugins = useStudioPlugins();
  const [params, setParams] = useSearchParams();
  const { narrow } = useSettingsMenu();
  const shown = params.get("show");
  const section = plugins.sections.find((s) => s.id === shown) ?? null;
  const picked = Boolean(shown || !narrow);
  useDetail(picked ? (section?.label() ?? t("plugins.overview")) : null);
  const open = (id: string) => setParams({ show: id }, { replace: !narrow });
  return (
    <>
      <SubMenu>
        <ul className="flex flex-col gap-0.5">
          <MenuRow
            icon={Blocks}
            label={t("plugins.overview")}
            selected={picked && !section}
            onPick={() => open("overview")}
          />
          {plugins.sections.map((s) => (
            <MenuRow
              key={s.id}
              icon={s.icon}
              label={s.label()}
              selected={s.id === section?.id}
              onPick={() => open(s.id)}
            />
          ))}
        </ul>
      </SubMenu>
      {section ? (
        <PluginFrame key={section.id} of={section}>
          <section.component />
        </PluginFrame>
      ) : // On this computer every plugin can be switched, added and removed; in the cloud the plan says.
      plugins.canReload ? (
        <PluginList />
      ) : (
        <PluginsSection />
      )}
    </>
  );
}
