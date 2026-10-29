import { t } from "../lib/i18n";
import { Section } from "../studio/space/Section";
import { Chip } from "../ui";
import { useStudioPlugins } from "./host";

/**
 * The plugins this organization has in the cloud, and what became of each when it loaded. Its
 * plan says which; on a computer PluginList shows them, with ways to change them.
 */
export function PluginsSection() {
  const plugins = useStudioPlugins();
  return (
    <Section title={t("plugins.title")} hint={t("plugins.hintManaged")}>
      {plugins.plugins.length ? null : (
        <p className="text-[0.875rem] text-ink-3">{t("plugins.none")}</p>
      )}
      <ul className="divide-y divide-border-soft">
        {plugins.plugins.map((plugin) => {
          const studioError = plugins.failed[plugin.id];
          return (
            <li key={plugin.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-medium text-[0.9375rem]">{plugin.name}</span>
                {plugin.name !== plugin.id ? (
                  <span className="font-mono text-[0.75rem] text-ink-4">
                    {plugin.id} · {plugin.version}
                  </span>
                ) : null}
              </div>
              {plugin.description ? (
                <p className="mt-0.5 text-[0.875rem] text-ink-3">{plugin.description}</p>
              ) : null}
              {plugin.tools.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.75rem] text-ink-3">
                  {t("plugins.tools")}
                  {plugin.tools.map((tool) => (
                    <Chip key={tool.id}>{tool.id}</Chip>
                  ))}
                </div>
              ) : null}
              {plugin.error ? (
                <p className="mt-2 text-[0.8125rem] text-rose">
                  {t("plugins.serverFailed", { error: plugin.error })}
                </p>
              ) : null}
              {studioError ? (
                <p className="mt-2 text-[0.8125rem] text-rose">
                  {t("plugins.studioFailed", { error: studioError })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
