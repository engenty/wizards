import { lazy, Suspense, useEffect } from "react";
import { useSearchParams } from "react-router";
import { t } from "../../lib/i18n";
import { useCurrentSpace } from "../../lib/session";
import { PluginFrame, useStudioPlugins } from "../../plugins/host";
import { scrollRoot } from "../AppFrame";
import { useDetail, useSettingsMenu } from "../settings-menu";
import { Anchor, Section } from "../space/Section";
import { SkillsOverview, useSkills } from "../space/Skills";
import { spaceSections } from "../space-sections";

// The skill editor brings CodeMirror's pieces with it: loaded when a skill opens.
const SkillEditor = lazy(() =>
  import("../space/SkillEditor").then((m) => ({ default: m.SkillEditor })),
);

/**
 * Fähigkeiten › Skills: all skills, or one opened (`?show=k:<id>`), then what plugins add. No
 * menu of its own: the list of sections stays beside it. The body Skills had at /skills.
 */
export function SkillsSection() {
  const [params, setParams] = useSearchParams();
  const { space } = useCurrentSpace();
  const plugins = useStudioPlugins();
  const { narrow } = useSettingsMenu();
  const show = params.get("show");
  const skillPick = show?.startsWith("k:") ? show : null;
  const skills = useSkills(space?.id);
  const added = spaceSections("skills", plugins).filter((g) => g.plugin);
  useDetail(skills.data?.skills.find((k) => `k:${k.id}` === skillPick)?.name ?? null);

  // What is picked takes the page's place: it starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick is what scrolls up.
  useEffect(() => {
    if (!narrow) {
      scrollRoot().scrollTo({ top: 0 });
    }
  }, [narrow, skillPick]);

  // On a phone a step deeper, beside the menu in place.
  const pick = (id: string) =>
    narrow
      ? setParams({ show: id })
      : setParams(id === "all" ? {} : { show: id }, { replace: true });
  return (
    <>
      {space ? (
        <div className="flex flex-col gap-9 pb-20">
          {skillPick ? (
            <Suspense fallback={null}>
              <SkillEditor
                key={skillPick}
                skillId={skillPick.slice(2)}
                onGone={() => pick("all")}
                onOpen={pick}
                filesFirst
              />
            </Suspense>
          ) : skills.data ? (
            <>
              <SkillsOverview
                spaceId={space.id}
                data={skills.data}
                onOpen={pick}
                heading={t("capabilities.inSpace")}
              />
              {added
                .flatMap((g) => g.sections)
                .map((s) => plugins.spaceSections.find((x) => x.id === s.id))
                .filter((s) => s !== undefined)
                .map((section) => (
                  <Anchor key={section.serial} id={section.id}>
                    <Section title={section.label()} hint={section.hint?.()} plain>
                      <PluginFrame of={section}>
                        <section.component />
                      </PluginFrame>
                    </Section>
                  </Anchor>
                ))}
            </>
          ) : skills.error ? (
            <p className="text-[0.875rem] text-rose">{(skills.error as Error).message}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
